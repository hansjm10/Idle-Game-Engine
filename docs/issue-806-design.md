---
title: "shell-desktop: Handle Sim Worker Exit + postMessage Failures (Issue 806)"
sidebar_position: 99
---

# shell-desktop: Handle Sim Worker Exit + postMessage Failures (Issue 806)

## Document Control
- **Title**: Prevent Electron main-process crashes when the sim worker exits
- **Authors**: Codex (AI)
- **Reviewers**: @hansjm10
- **Status**: Draft
- **Last Updated**: 2026-01-21
- **Related Issues**: https://github.com/hansjm10/Idle-Game-Engine/issues/806
- **Execution Mode**: AI-led

## 1. Summary
`@idle-engine/shell-desktop` runs the simulation in a Node `Worker` and pumps `tick` messages on a `setInterval`. Today, if the worker crashes/exits, the tick loop continues and `worker.postMessage(...)` can throw, taking down the Electron main process. This design introduces explicit sim-worker lifecycle handling: stop the tick loop on worker failure, treat `postMessage` exceptions as worker-fatal, and notify the renderer of a user-visible error (optionally with an automatic restart path) so the desktop app degrades gracefully instead of crashing.

## 2. Context & Problem Statement
- **Background**: The desktop shell architecture (Issue 778) isolates the deterministic runtime in a worker thread and streams `RenderCommandBuffer` frames to the renderer via IPC. In the current implementation, the main process (`packages/shell-desktop/src/main.ts`) creates `sim-worker.js`, sends `init`, starts a 16ms interval after a `ready` message, and forwards `frames` to the renderer on `IPC_CHANNELS.frame`.
- **Problem**: The tick loop does not handle the worker exiting/crashing. If the worker exits unexpectedly, `worker.postMessage(...)` can throw during the interval callback (or during control event forwarding), crashing the Electron main process and taking down the entire desktop app.
- **Forces**:
  - Main process must stay resilient: worker failure is expected in the wild (crashes, OS kill, dev hot reload).
  - Renderer should receive a clear, user-visible error and a recovery path without requiring developer tooling.
  - Avoid noisy/fragile behavior: no infinite restart loops and no console spam that obscures failures.

## 3. Goals & Non-Goals
- **Goals**:
  - If the sim worker exits unexpectedly, the Electron main process does not crash.
  - Tick loop stops cleanly when the worker is no longer usable.
  - Renderer receives a clear “sim stopped/crashed” status and a recovery path (restart/reload).
  - Add/extend unit tests in `packages/shell-desktop/src/main.test.ts` to cover worker exit and `postMessage` failure.
- **Non-Goals**:
  - Persisting/restoring sim state across worker restarts (worker restart may reset demo state).
  - Implementing full crash reporting/telemetry infrastructure (beyond structured logs/status messages).
  - Reworking the sim scheduling model (e.g., replacing `setInterval` with a more sophisticated cadence).

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**:
  - Desktop shell maintainers (`packages/shell-desktop`).
  - Runtime maintainers (worker isolation and determinism expectations from Issue 778).
- **Agent Roles**:
  - **Docs Agent**: Maintain design doc and open questions (this change).
  - **Runtime/Shell Implementation Agent**: Implement worker lifecycle hardening in `main.ts`.
  - **Test Agent**: Extend Vitest coverage in `main.test.ts` (and preload/renderer tests if IPC surface changes).
- **Affected Packages/Services**:
  - `packages/shell-desktop/src/main.ts` (worker lifecycle + tick loop)
  - `packages/shell-desktop/src/main.test.ts` (exit + `postMessage` failure coverage)
  - `packages/shell-desktop/src/ipc.ts` and `packages/shell-desktop/src/preload.cts` (if introducing a new sim-status IPC surface)
  - `packages/shell-desktop/src/renderer/index.ts` (user-visible sim status)
- **Compatibility Considerations**:
  - New IPC event(s) should be additive and versioned via TypeScript types in `ipc.ts`.
  - Avoid changing existing `IPC_CHANNELS.frame` payload (`RenderCommandBuffer`) to keep renderer contract stable.

## 5. Current State
`packages/shell-desktop/src/main.ts` creates a sim worker and drives it with an interval:
- Worker creation: `new Worker(new URL('./sim-worker.js', import.meta.url))`.
- `postMessage` wrapper calls `worker.postMessage(message)` with no `try/catch`.
- Tick loop uses `setInterval` to `postMessage({ kind: 'tick', deltaMs })` after receiving `{ kind: 'ready' }`.
- Main forwards frames (`{ kind: 'frames', frames }`) to the renderer via `mainWindow.webContents.send(IPC_CHANNELS.frame, frame)`.
- Worker `message.kind === 'error'` and worker `'error'` events are logged via `console.error`, but do not stop the tick loop or notify the renderer.
- No `'exit'` event handling exists for the worker.

Existing tests in `packages/shell-desktop/src/main.test.ts` validate:
- IPC ping handler setup.
- Tick loop start after `ready` and forwarding `frames` to the renderer.
- Control events enqueue commands.
- Logging of worker errors.

There is currently no test coverage for:
- Worker exit (`worker.on('exit', ...)`) behavior.
- `worker.postMessage` throwing (interval tick and/or control event path).

## 6. Proposed Solution
### 6.1 Architecture Overview
- Add a small sim-worker lifecycle state machine to the main process controller to model `starting → running → failed/stopped`.
- Harden all outbound messages (`init`, `tick`, `enqueueCommands`, and any future control messages) via a `safePostMessage` wrapper that catches exceptions and transitions the worker to a failed state.
- Subscribe to worker `'exit'` and treat unexpected exits as fatal:
  - stop the tick loop,
  - prevent further sends,
  - notify the renderer of an error state,
  - optionally attempt a bounded restart (dev-only or behind a flag).
- Introduce a renderer-visible status channel (additive IPC) so the UI can show “Sim crashed/stopped” and present a recovery instruction (reload or restart).

### 6.2 Detailed Design
- **Runtime Changes**:
  - In `createSimWorkerController(...)`:
    - Track lifecycle flags: `isDisposing`, `hasFailed`, and `tickTimer`.
    - Implement `stopTickLoop()` and call it from all failure paths.
    - Wrap `worker.postMessage`:
      - `safePostMessage(message)` uses `try/catch`.
      - On exception: stop tick loop, mark the worker failed, and (best-effort) `terminate()` it.
    - Handle worker `'exit'`:
      - If `isDisposing` is true, treat as expected shutdown.
      - Otherwise, treat as failure and perform the same stop/notify steps.
    - Continue to handle worker `'error'`:
      - Prefer one unified `handleWorkerFailure(source, details)` path so logs, renderer status, and restarts are consistent.
  - Optional: also handle `'messageerror'` to catch structured-clone failures explicitly.

- **Data & Schemas**:
  - Keep `RenderCommandBuffer` payloads unchanged.
  - Add a new “sim status” payload type in `packages/shell-desktop/src/ipc.ts`, for example:
    - `starting | running | stopped | crashed` plus a human-readable `reason` and (if available) `exitCode`.

- **APIs & Contracts**:
  - Extend `IPC_CHANNELS` with an additive event channel (example): `idle-engine:sim-status`.
  - Extend `IdleEngineApi` with an additive subscription method (example): `onSimStatus(handler)`.
  - Recovery path options (choose one for implementation):
    1. **Minimal**: Renderer displays error and instructs the user to use the existing app menu `View → Reload`.
    2. **Better UX**: Add an IPC-invoked `restartSim()` API and a small renderer affordance (e.g., a keybind like `R` or a button) to restart the worker.
    3. **Dev ergonomics**: Auto-restart worker with backoff (e.g., 1s, capped attempts) when `isDev` is true or `IDLE_ENGINE_SIM_AUTO_RESTART=1` is set.

- **Tooling & Automation**:
  - No new tooling is required; changes remain within the `packages/shell-desktop` Vitest suite.

### 6.3 Operational Considerations
- **Deployment**: Additive behavior-only change; no migration required. Ensure that production builds do not enter infinite restart loops (cap attempts or require explicit user action).
- **Telemetry & Observability**: Keep `console.error` for now, but ensure it is emitted once per failure path (avoid spamming per tick).
- **Security & Compliance**: Only send sanitized, user-safe error strings to the renderer (avoid leaking stack traces unless in dev mode).

## 7. Work Breakdown & Delivery Plan
### 7.1 Issue Map
| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| `fix(shell-desktop): stop tick loop on sim-worker exit` | Add worker `exit` handling + tick stop | Runtime/Shell Implementation Agent | None | Worker exit does not crash main; tick loop stops |
| `fix(shell-desktop): treat postMessage failures as worker-fatal` | Wrap `postMessage` and route to unified failure handler | Runtime/Shell Implementation Agent | Exit handling | No thrown exception from interval/control path |
| `feat(shell-desktop): surface sim status to renderer` | Add IPC status event + renderer output update | Runtime/Shell Implementation Agent | Failure handler | Renderer shows sim stopped/crashed state and recovery hint |
| `test(shell-desktop): cover worker exit + postMessage throw` | Extend `main.test.ts` worker mock and add tests | Test Agent | Implementation | Vitest covers exit and throw scenarios |

### 7.2 Milestones
- **Phase 1**: Stop tick loop on worker failure; catch `postMessage` exceptions; tests added.
- **Phase 2**: Add renderer-visible status channel and (optional) restart affordance.

### 7.3 Coordination Notes
- **Hand-off Package**:
  - `packages/shell-desktop/src/main.ts`
  - `packages/shell-desktop/src/main.test.ts`
  - `packages/shell-desktop/src/ipc.ts`
  - `packages/shell-desktop/src/preload.cts`
  - `packages/shell-desktop/src/renderer/index.ts`
- **Communication Cadence**: Single reviewer pass once Phase 1 is complete; follow-up review if IPC surface is extended.

## 8. Agent Guidance & Guardrails
- **Context Packets**:
  - Issue 806: https://github.com/hansjm10/Idle-Game-Engine/issues/806
  - Related design: `docs/desktop-shell-webgpu-renderer-replay-design-issue-778.md`
  - Implementation entrypoints: `packages/shell-desktop/src/main.ts`, `packages/shell-desktop/src/sim-worker.ts`
- **Prompting & Constraints**:
  - Do not edit generated `packages/shell-desktop/dist/**` by hand.
  - Preserve type-only imports/exports (`import type` / `export type`).
- **Safety Rails**:
  - Ensure worker shutdown during app quit does not surface as a “crash” (use an explicit disposing flag).
  - Avoid unbounded auto-restart loops; cap attempts or gate behind dev/flag.
- **Validation Hooks**:
  - `pnpm test --filter @idle-engine/shell-desktop`
  - `pnpm lint --filter @idle-engine/shell-desktop` (if IPC surface/types change)

## 9. Alternatives Considered
- **Do nothing**: Leaves an easy main-process crash vector when worker exits unexpectedly.
- **Let the main process crash and rely on OS/app restart**: Poor UX and loses diagnostic context.
- **Run the sim in the renderer process**: Reduces isolation and reintroduces UI thread contention; contradicts the worker-isolated direction from Issue 778.
- **Encode errors into `RenderCommandBuffer`**: Pollutes the renderer contract and conflates “presentation frames” with control-plane status.

## 10. Testing & Validation Plan
- **Unit / Integration**:
  - Add a `worker.emitExit(code)` helper to the `Worker` mock in `main.test.ts` and validate:
    - tick timer is cleared / stops issuing `tick` messages after exit,
    - renderer receives a sim status update (if implemented),
    - no uncaught exceptions occur.
  - Make `worker.postMessage` throw (once or always) and validate:
    - exception is caught,
    - tick loop stops,
    - failure is logged/forwarded once.
- **Performance**: N/A (behavioral hardening only).
- **Tooling / A11y**: N/A for the current minimal renderer output view.

## 11. Risks & Mitigations
- **Risk**: Worker exit during normal shutdown is misclassified as a crash.  
  **Mitigation**: Track `isDisposing` and ignore `'exit'` when disposing.
- **Risk**: Auto-restart can loop forever if the worker always crashes.  
  **Mitigation**: Cap retries; add exponential backoff; disable by default in production.
- **Risk**: Renderer doesn’t show the failure, making the app appear frozen.  
  **Mitigation**: Add explicit sim-status IPC event and render it prominently (same output block as IPC/WebGPU status).

## 12. Rollout Plan
- **Milestones**:
  - Land Phase 1 behavior hardening + tests.
  - Land Phase 2 UI/status improvements (or combine if the IPC change is small).
- **Migration Strategy**: None.
- **Communication**: Document in the PR description that main-process crash-on-worker-exit is fixed and include the new failure-mode tests.

## 13. Open Questions
- Should the default recovery path be “manual reload” or “restart sim” (via IPC) for production builds?
- If we auto-restart, what retry policy should be used (attempt count, backoff schedule), and should it differ between dev and packaged builds?
- Should sim-worker failures surface a stack trace in dev mode (for diagnosis) while keeping production messages user-friendly?
- Should `dispose()` request a graceful worker shutdown (send `{ kind: 'shutdown' }`) before `terminate()`, or is `terminate()` sufficient?

## 14. Follow-Up Work
- Add a small in-renderer UI affordance (button) for restarting the sim worker instead of relying on keybinds or app reload.
- Add structured, machine-parseable error events for future crash reporting (without spamming logs).

## 15. References
- Issue 806: https://github.com/hansjm10/Idle-Game-Engine/issues/806
- Related architecture: `docs/desktop-shell-webgpu-renderer-replay-design-issue-778.md`
- Worker tick loop + `postMessage`: `packages/shell-desktop/src/main.ts`
- IPC surface: `packages/shell-desktop/src/ipc.ts`, `packages/shell-desktop/src/preload.cts`
- Worker implementation: `packages/shell-desktop/src/sim-worker.ts`
- Renderer output loop: `packages/shell-desktop/src/renderer/index.ts`
- Existing tests: `packages/shell-desktop/src/main.test.ts`

## Appendix A — Glossary
- **Main process**: Electron process that owns app lifecycle and creates BrowserWindows; runs Node APIs.
- **Renderer process**: Chromium process that runs the web UI and WebGPU renderer.
- **Sim worker**: Node `Worker` thread running the deterministic runtime and emitting frames.
- **Tick loop**: The main-process scheduler that periodically sends `{ kind: 'tick', deltaMs }` to the sim worker.

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2026-01-21 | Codex (AI) | Initial draft for Issue 806 |
