---
title: "shell-desktop: coalesce/backpressure sim frames over IPC (Issue 808)"
sidebar_position: 99
---

# shell-desktop: coalesce/backpressure sim frames over IPC (Issue 808)

## Document Control
- **Title**: Treat `idle-engine:frame` as a latest-snapshot stream (coalesce sim frames over IPC)
- **Authors**: Codex (AI)
- **Reviewers**: @hansjm10
- **Status**: Draft
- **Last Updated**: 2026-01-23
- **Related Issues**: https://github.com/hansjm10/Idle-Game-Engine/issues/808
- **Execution Mode**: AI-led

## 1. Summary
The desktop sim worker can generate multiple `RenderCommandBuffer` snapshots during a single main-process tick when it catches up (fixed-step sim with `deltaMs > stepSizeMs`, bounded by `maxStepsPerFrame`). The renderer only ever uses the most recent snapshot, but the main process currently forwards every intermediate snapshot over Electron IPC, wasting CPU/IPC bandwidth and creating latency spikes during catch-up bursts. This design defines `idle-engine:frame` as a latest-snapshot stream, coalesces frames as early as possible (worker -> main), and adds defense-in-depth (main forwards at most one frame per worker message). Optional ACK-based backpressure is included as a follow-up if profiling shows IPC backlog.

## 2. Context & Problem Statement
- **Background**: `@idle-engine/shell-desktop` runs the deterministic runtime in a Node `Worker` (`packages/shell-desktop/src/sim-worker.ts`). The main process ticks the worker and forwards `RenderCommandBuffer` frames to the renderer via `IPC_CHANNELS.frame` (`idle-engine:frame`). The renderer stores `latestRcb` and renders on `requestAnimationFrame` (`packages/shell-desktop/src/renderer/index.ts`).
- **Problem**: The worker emits `{ kind: 'frames', frames: RenderCommandBuffer[], nextStep }`, and the main process forwards *each* element of `frames` via IPC (`packages/shell-desktop/src/main.ts`). During catch-up, `frames.length` can be > 1, but the renderer drops intermediates and uses only the last snapshot—so those IPC sends are pure overhead.
- **Forces**:
  - Keep the sim deterministic: dropping intermediate render snapshots must not affect sim state progression.
  - Preserve renderer behavior: consumers should only rely on receiving “the newest available snapshot,” not every sim step.
  - Maintain responsiveness under stalls/jank: bound work and avoid bursty IPC traffic.

## 3. Goals & Non-Goals
- **Goals**:
  - Ensure the renderer receives **≤ 1** `idle-engine:frame` event per worker tick message, and it is the highest-step frame.
  - Do not emit `idle-engine:frame` for empty frame batches (`frames: []`).
  - Make IPC cost scale with renderer consumption (display rate / snapshot cadence) instead of sim catch-up bursts.
  - Provide lightweight observability for dropped intermediates (e.g., `droppedFrames` counters between worker and main).
- **Non-Goals**:
  - Rendering interpolation between sim steps.
  - Recording/streaming every sim step for capture/replay (would require a separate dev-only channel or file sink).
  - Changing core runtime stepping semantics (`maxStepsPerFrame`, accumulator behavior) in `@idle-engine/core`.

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**:
  - Desktop shell maintainers (`packages/shell-desktop`)
  - Renderer consumers of `idle-engine:frame` (desktop renderer and any future inspectors)
- **Agent Roles**:
  - **Docs Agent**: Maintain this design doc; track open questions and decisions.
  - **Shell Implementation Agent**: Implement worker/main coalescing and (optional) ACK backpressure.
  - **Test Agent**: Update/add Vitest coverage for coalescing and empty batches.
- **Affected Packages/Services**:
  - `packages/shell-desktop/src/sim-worker.ts` (worker outbound message shape)
  - `packages/shell-desktop/src/main.ts` (coalescing + forwarding behavior)
  - `packages/shell-desktop/src/sim/sim-runtime.ts` (optional: avoid allocating frame arrays)
  - `packages/shell-desktop/src/main.test.ts`, `packages/shell-desktop/src/sim-worker.test.ts` (tests)
- **Compatibility Considerations**:
  - `idle-engine:frame` payload type remains `RenderCommandBuffer` (`packages/shell-desktop/src/ipc.ts`).
  - Semantics change: intermediate frames may be dropped; consumers must treat the channel as “latest snapshot” not “every step.”
  - The worker ↔ main message protocol is internal to `@idle-engine/shell-desktop` and can be migrated in lockstep; during transition, main should tolerate `{ kind: 'frames' }` batches defensively.

## 5. Current State
Data flow today:

```text
main.ts tick loop
  -> worker.postMessage({ kind: 'tick', deltaMs })
  -> sim-worker.ts calls SimRuntime.tick(deltaMs)
    -> IdleEngineRuntime.tick(deltaMs) may run N fixed steps (N <= maxStepsPerFrame)
    -> demo "frame-producer" system produces a RenderCommandBuffer each step
  -> sim-worker.ts emits { kind: 'frames', frames: [frame0..frameN-1], nextStep }
  -> main.ts forwards every element in frames via IPC_CHANNELS.frame
  -> renderer receives multiple idle-engine:frame events and keeps only the last (latestRcb)
```

Key characteristics:
- In `packages/shell-desktop/src/sim/sim-runtime.ts`, `frame-producer` pushes one frame per executed sim step into a queue, and `tick()` returns `frames: Array.from(frameQueue)`.
- In `packages/shell-desktop/src/main.ts`, the worker message handler does:
  - `nextStep = message.nextStep`
  - `for (const frame of message.frames) mainWindow.webContents.send(IPC_CHANNELS.frame, frame)`
- In `packages/shell-desktop/src/renderer/index.ts`, `onFrame` assigns `latestRcb = frame` and rendering is driven by `requestAnimationFrame`, so intermediate frames are overwritten before they can be displayed.

## 6. Proposed Solution
### 6.1 Architecture Overview
- **Narrative**: Treat `idle-engine:frame` as a latest-snapshot stream. Coalesce intermediate frames in the producer chain so that at most one snapshot crosses each boundary (worker → main, main → renderer). Keep `nextStep` updates intact so command stamping remains correct. If needed later, add explicit ACK-based backpressure so main never has more than one in-flight frame to the renderer.
- **Diagram**:

```text
Worker tick (may run N sim steps)
  -> produces N internal snapshots
  -> coalesce to last snapshot (highest step)
  -> main forwards at most 1 snapshot per worker message
  -> renderer stores latest snapshot and renders on rAF
```

### 6.2 Detailed Design
#### 6.2.1 Define the contract: `idle-engine:frame` is latest-snapshot
- The `idle-engine:frame` channel delivers a complete snapshot representing the most recent available sim state.
- Intermediate sim-step snapshots may be dropped.
- Consumers must not assume they will receive a frame for every sim step.
- If frames arrive out of order, the highest `frame.frame.step` wins; older steps are ignored.

#### 6.2.2 Coalesce as early as possible: worker emits only the last frame
Update the sim worker outbound message protocol to avoid sending arrays of frames across the worker boundary:

- **New outbound message shape (worker → main)**:
  - `{ kind: 'frame', frame?: RenderCommandBuffer, nextStep: number, droppedFrames: number }`
  - `frame` is omitted when no frames were produced.
  - `droppedFrames` is `max(0, producedFrames - (frame ? 1 : 0))`.

Implementation notes:
- The worker should still update `nextStep` every tick message, even when `frame` is omitted, because `packages/shell-desktop/src/main.ts` uses `nextStep` to stamp control-event commands.
- To compute `droppedFrames` without allocating arrays, `packages/shell-desktop/src/sim/sim-runtime.ts` can be refactored to track:
  - `latestFrame: RenderCommandBuffer | undefined`
  - `producedFrames: number`
  and return `{ frame: latestFrame, nextStep, droppedFrames: Math.max(0, producedFrames - (latestFrame ? 1 : 0)) }`.
  - This is optional for correctness; it primarily reduces allocation and clone cost inside the worker.

#### 6.2.3 Defense-in-depth: main forwards at most one frame per worker message
Even if the worker still sends `{ kind: 'frames', frames: [...] }` during a migration window, the main process should coalesce:

- If `frames.length === 0`: do not call `webContents.send(IPC_CHANNELS.frame, ...)`.
- Otherwise: forward only `frames.at(-1)` (the highest-step frame, assuming ordered generation).

For the new `{ kind: 'frame' }` message:
- If `frame` is present: forward it.
- If `frame` is absent: do nothing (but still update `nextStep`).

Optional robustness:
- Track `lastForwardedStep` in the main process and ignore frames where `frame.frame.step <= lastForwardedStep` to guard against out-of-order delivery or duplicate messages.

#### 6.2.4 Optional: explicit renderer ACK backpressure
If profiling shows IPC backlog (e.g., renderer event queue or `webContents.send` contention), introduce a simple ACK:

- Add IPC channels:
  - `idle-engine:frame` (existing): main → renderer, payload `RenderCommandBuffer`
  - `idle-engine:frame-ack` (new): renderer → main, payload `{ step: number }` (or empty)
- Main process behavior:
  - Maintain `inFlight: boolean` and `pendingLatest: RenderCommandBuffer | undefined`.
  - When a new frame arrives:
    - If not in flight: send immediately and set `inFlight = true`.
    - If in flight: replace `pendingLatest` with the newest frame (drop older pending frames).
  - On ACK:
    - If `pendingLatest` exists: send it and keep `inFlight = true`.
    - Else: set `inFlight = false`.

This makes “frames delivered” scale with renderer consumption and prevents unbounded in-flight snapshots.

### 6.3 Operational Considerations
- **Deployment**: Standard workspace build; no migration scripts. Worker/main/renderer changes ship together in `@idle-engine/shell-desktop`.
- **Telemetry & Observability**:
  - Dev-only counters in main: `framesReceived`, `framesForwarded`, `framesDropped` (from `droppedFrames`).
  - Optionally display counters in the renderer debug text output (if desired).
- **Security & Compliance**: No new external inputs; frame payload remains structured-cloneable data already sent over IPC.

## 7. Work Breakdown & Delivery Plan
### 7.1 Issue Map
| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| `feat(shell-desktop): coalesce frames forwarded to renderer` | Forward only the highest-step frame per worker message; skip empty batches | Shell Implementation Agent | None | `idle-engine:frame` is emitted ≤ 1 time per `{ kind:'frames' }` message; empty batches emit none |
| `feat(shell-desktop): emit latest frame from sim worker` | Change worker outbound protocol to `{ kind:'frame', frame?, droppedFrames, nextStep }` | Shell Implementation Agent | Coalescing in main (recommended) | Worker no longer posts frame arrays; `droppedFrames` is correct; `nextStep` updates preserved |
| `test(shell-desktop): cover coalescing + empty batch` | Update `main.test.ts` and `sim-worker.test.ts` for new behavior | Test Agent | Implementation merged or mocked | Tests assert only last frame forwarded; empty batch sends nothing |
| `feat(shell-desktop): optional frame ACK backpressure` | Add `frame-ack` channel + gating if needed | Shell Implementation Agent | Profiling data / decision | Main never has >1 in-flight frame; pending frames coalesce to newest |

### 7.2 Milestones
- **Phase 1**: Implement main-process coalescing (defense-in-depth) + update tests.
- **Phase 2**: Switch sim worker to emit latest-frame messages (+ optional sim-runtime allocation reduction) + update tests.
- **Phase 3 (Optional)**: Add ACK backpressure if IPC backlog is still observable in profiling.

### 7.3 Coordination Notes
- **Hand-off Package**:
  - Worker protocol: `packages/shell-desktop/src/sim-worker.ts`
  - Frame forwarding: `packages/shell-desktop/src/main.ts`
  - Renderer consumption: `packages/shell-desktop/src/renderer/index.ts`
  - IPC contract: `packages/shell-desktop/src/ipc.ts` / `packages/shell-desktop/src/preload.cts`
  - Tests: `packages/shell-desktop/src/main.test.ts`, `packages/shell-desktop/src/sim-worker.test.ts`
- **Communication Cadence**: One review after Phase 1; a second review if ACK backpressure is introduced.

## 8. Agent Guidance & Guardrails
- **Context Packets**:
  - Issue 808: https://github.com/hansjm10/Idle-Game-Engine/issues/808
  - Shell desktop main: `packages/shell-desktop/src/main.ts`
  - Worker: `packages/shell-desktop/src/sim-worker.ts`
- **Prompting & Constraints**:
  - Keep `idle-engine:frame` payload type as `RenderCommandBuffer` (no renderer-contract change required).
  - Preserve deterministic stamping for control events (`step = nextStep`, `timestamp = nextStep * stepSizeMs`).
  - Preserve type-only imports/exports (`import type` / `export type`).
- **Safety Rails**:
  - Do not introduce per-frame console logging on hot paths unless it is dev-only and rate-limited.
  - Do not edit generated `dist/**` outputs by hand.
  - Ensure coalescing logic never forwards older-step frames over newer-step frames.
- **Validation Hooks**:
  - `pnpm test --filter @idle-engine/shell-desktop`
  - `pnpm lint --filter @idle-engine/shell-desktop` (if types change)

## 9. Alternatives Considered
- **Keep forwarding every frame**: Simple but wastes CPU/IPC bandwidth and creates latency spikes under catch-up.
- **Coalesce only in the renderer**: Renderer already keeps only the latest, but does not reduce main-process IPC traffic or worker->main structured clone overhead.
- **Switch sim to render-interpolated frames**: Higher UX quality but requires substantial runtime/renderer changes and is out of scope for issue-808.
- **Backpressure only (ACK) without coalescing**: Prevents in-flight growth but still sends unnecessary intermediate frames within a tick burst; coalescing first yields the biggest win.

## 10. Testing & Validation Plan
- **Unit / Integration**:
  - Update `packages/shell-desktop/src/main.test.ts` to:
    - Emit `{ kind: 'frames', frames: [A, B], nextStep }` from the worker and assert **only** `B` is forwarded via `IPC_CHANNELS.frame`.
    - Emit `{ kind: 'frames', frames: [], nextStep }` and assert no `IPC_CHANNELS.frame` send occurs.
  - Update `packages/shell-desktop/src/sim-worker.test.ts` to match the worker outbound protocol (either still `frames` during Phase 1, or `frame` in Phase 2).
- **Performance**:
  - Manual verification: induce a large `deltaMs` (e.g., by pausing the process or clamping clock) and confirm renderer receives one frame per tick message and IPC does not spike proportional to `maxStepsPerFrame`.
- **Tooling / A11y**: N/A.

## 11. Risks & Mitigations
- **Risk**: Some consumer assumes per-step frame delivery and breaks when frames are dropped.\
  **Mitigation**: Explicitly document `idle-engine:frame` as latest-snapshot; if per-step capture is needed, add a separate dev-only channel.
- **Risk**: Main/worker protocol changes cause mismatches during partial updates.\
  **Mitigation**: Implement defense-in-depth in main to support both `{ kind:'frames' }` and `{ kind:'frame' }` shapes for a short transition window.
- **Risk**: ACK backpressure introduces deadlocks if ACK is not emitted.\
  **Mitigation**: Make ACK optional and only gate when enabled; consider a timeout fallback or “send newest after X ms” if ACK is adopted.

## 12. Rollout Plan
- **Milestones**:
  - Merge Phase 1 coalescing + tests.
  - Merge Phase 2 worker protocol update + tests.
  - Consider Phase 3 ACK backpressure based on profiling.
- **Migration Strategy**: None (internal protocol within the desktop shell; renderer payload unchanged).
- **Communication**: Note in the PR description that `idle-engine:frame` is now a latest-snapshot stream and intermediate sim-step snapshots may be dropped.

## 13. Open Questions
- Do we need ACK backpressure now, or is per-message coalescing sufficient for observed workloads?
- Should `droppedFrames` be surfaced to the renderer/UI (debug overlay), or kept as main-process-only diagnostics?
- Should main enforce a monotonic step guarantee (`lastForwardedStep`) or rely on message ordering assumptions?

## 14. Follow-Up Work
- If later needed, add a separate dev-only “all-steps” frame channel for capture/replay tooling.
- Explore render interpolation/extrapolation for smoother visuals under catch-up (separate feature).

## 15. References
- Issue 808: https://github.com/hansjm10/Idle-Game-Engine/issues/808
- Worker emits frames batches: `packages/shell-desktop/src/sim-worker.ts:88`
- Main forwards each frame today: `packages/shell-desktop/src/main.ts:234`
- Renderer keeps only latest: `packages/shell-desktop/src/renderer/index.ts:64`
- IPC channel identifiers: `packages/shell-desktop/src/ipc.ts:5`
- Existing test that expects multiple forwards (to update): `packages/shell-desktop/src/main.test.ts:313`

## Appendix A — Glossary
- **RenderCommandBuffer (RCB)**: A render snapshot payload consumed by renderers (`@idle-engine/renderer-contract`).
- **Fixed-step sim**: The runtime advances in discrete steps of `stepSizeMs` rather than variable timesteps.
- **Catch-up / backlog**: When a large `deltaMs` requires multiple sim steps to run in a single tick.
- **Coalescing**: Collapsing multiple intermediate frames into a single “latest” frame for downstream consumers.
- **Backpressure (ACK)**: A mechanism to bound in-flight work by requiring consumers to acknowledge receipt/processing.

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2026-01-23 | Codex (AI) | Initial draft design doc for Issue 808 |
