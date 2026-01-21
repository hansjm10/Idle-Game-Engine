---
title: "shell-desktop: Use Monotonic Clock + Clamp deltaMs in Tick Loop (Issue 807)"
sidebar_position: 99
---

# shell-desktop: Use Monotonic Clock + Clamp deltaMs in Tick Loop (Issue 807)

## Document Control
- **Title**: Use a monotonic clock and clamp `deltaMs` in the desktop shell tick loop
- **Authors**: Codex (AI)
- **Reviewers**: @hansjm10
- **Status**: Draft
- **Last Updated**: 2026-01-21
- **Related Issues**: https://github.com/hansjm10/Idle-Game-Engine/issues/807
- **Execution Mode**: AI-led

## 1. Summary
`@idle-engine/shell-desktop` drives the simulation worker via a 16ms `setInterval` tick loop that derives `deltaMs` from `Date.now()`. Wall-clock adjustments (NTP, manual time changes, sleep/resume) can produce non-monotonic or very large deltas, which can hitch the sim and flood frames to the renderer. This design switches the tick loop to a monotonic time source and clamps unusually large deltas (e.g. `MAX_TICK_DELTA_MS = 250`) so the sim stays stable even when the system clock jumps.

## 2. Context & Problem Statement
- **Background**: The Electron main process creates a Node `Worker` (`packages/shell-desktop/src/sim-worker.ts`) that runs the deterministic runtime and emits `RenderCommandBuffer` frames. The main process (`packages/shell-desktop/src/main.ts`) periodically sends `{ kind: 'tick', deltaMs }` messages to advance the sim and forwards frames to the renderer via IPC.
- **Problem**: The current tick loop uses `Date.now()` to compute `deltaMs` (`packages/shell-desktop/src/main.ts`). Because `Date.now()` is wall-clock time, it can jump backwards/forwards. Backwards jumps can create zero/negative deltas (currently clamped to 0), while forward jumps can create unexpectedly large deltas, causing the worker to attempt to simulate a large amount of time in one tick and potentially emit many frames in quick succession.
- **Forces**:
  - Preserve the existing worker protocol (`{ kind: 'tick', deltaMs: number }`) and avoid changes to the renderer contract.
  - Keep the desktop shell responsive and predictable under sleep/resume and clock adjustments.
  - Ensure tests remain deterministic and do not depend on real time.

## 3. Goals & Non-Goals
- **Goals**:
  - Compute `deltaMs` from a monotonic time source (unaffected by wall-clock adjustments).
  - Clamp `deltaMs` to a bounded maximum (target: `250ms`) and to a minimum of `0ms`.
  - Add a unit test that simulates a backwards jump and a large jump and asserts clamping behavior.
  - Preserve existing behavior for steady-state ticks (no functional changes beyond time source + clamp).
- **Non-Goals**:
  - Redesigning the sim scheduling model (e.g., switching away from `setInterval`).
  - Changing `SimRuntime` stepping behavior in `@idle-engine/core`.
  - Adding telemetry/analytics infrastructure (beyond optional dev-only diagnostics if needed).

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**:
  - Desktop shell maintainers (`packages/shell-desktop`).
  - Runtime maintainers (indirectly impacted by tick cadence quality).
- **Agent Roles**:
  - **Docs Agent**: Maintain this design doc and track open questions.
  - **Shell Implementation Agent**: Update the main-process tick loop to use a monotonic clock + clamp deltas.
  - **Test Agent**: Add deterministic unit coverage for clamping behavior.
- **Affected Packages/Services**:
  - `packages/shell-desktop/src/main.ts` (tick loop time source + clamping)
  - `packages/shell-desktop/src/main.test.ts` (new clamping test; updates to existing tick expectations if needed)
  - (Optional) `packages/shell-desktop/src/monotonic-time.ts` (shared monotonic clock helper for easy mocking)
- **Compatibility Considerations**:
  - Keep the tick message shape unchanged (`deltaMs: number`).
  - Prefer keeping `deltaMs` an integer millisecond value to avoid subtle downstream behavior differences and to keep tests stable.

## 5. Current State
The tick loop in `packages/shell-desktop/src/main.ts` is currently:
- `tickIntervalMs = 16`
- `lastTickMs = Date.now()`
- On each interval:
  - `nowMs = Date.now()`
  - `deltaMs = Math.max(0, nowMs - lastTickMs)`
  - `lastTickMs = nowMs`
  - `worker.postMessage({ kind: 'tick', deltaMs })`

This partially guards against a backwards clock jump (negative delta becomes `0`) but does not bound large deltas. The worker (`packages/shell-desktop/src/sim-worker.ts`) only checks `Number.isFinite(deltaMs)` and forwards `deltaMs` into `SimRuntime.tick(deltaMs)` (`packages/shell-desktop/src/sim/sim-runtime.ts`), which ultimately calls `IdleEngineRuntime.tick(deltaMs)` and can emit a frame per sim step via a demo `frame-producer` system.

The current tests in `packages/shell-desktop/src/main.test.ts` use `vi.useFakeTimers()` and `vi.setSystemTime(...)` to assert tick cadence and expect exact `deltaMs` values derived from `Date.now()`. There is currently no coverage for large deltas or clamping behavior.

## 6. Proposed Solution
### 6.1 Architecture Overview
- **Narrative**: Replace wall-clock time in the main-process tick loop with a monotonic clock, and clamp computed deltas before posting tick messages to the sim worker. This is a localized change: the worker protocol and runtime remain unchanged, but receive more stable inputs.
- **Diagram**: N/A (small localized change to the existing main-process scheduler).

### 6.2 Detailed Design
- **Runtime Changes**:
  - Update `packages/shell-desktop/src/main.ts` tick loop to use one of:
    - `process.hrtime.bigint()` converted to integer milliseconds (preferred for integer deltas), or
    - `performance.now()` with explicit rounding to integer milliseconds.
  - Add `MAX_TICK_DELTA_MS = 250` (constant local to `main.ts`, or exported from a helper module).
  - Compute `rawDeltaMs = nowMs - lastTickMs` and clamp:
    - `deltaMs = clamp(rawDeltaMs, 0, MAX_TICK_DELTA_MS)`
    - Always update `lastTickMs = nowMs` (even when clamped) to prevent repeated clamping for a single jump.
  - Optional hardening: if `rawDeltaMs` is not finite, treat as `0` and reset `lastTickMs` (defensive only).
- **Data & Schemas**: N/A (no schema changes).
- **APIs & Contracts**:
  - No changes to `SimWorkerTickMessage` (`deltaMs: number`) or IPC surfaces.
  - Keep `deltaMs` as an integer ms value to preserve existing expectations and avoid float-driven drift in accumulation logic.
- **Tooling & Automation**:
  - If introducing a helper module (e.g. `src/monotonic-time.ts`), keep it as a tiny pure utility so tests can `vi.mock(...)` it without involving Electron mocks.

### 6.3 Operational Considerations
- **Deployment**: N/A (no service rollout; shipped with the desktop shell build).
- **Telemetry & Observability**: Optional dev-only diagnostic log when `rawDeltaMs` is clamped (rate-limited) to aid debugging. Default behavior should avoid console noise.
- **Security & Compliance**: N/A.

## 7. Work Breakdown & Delivery Plan
### 7.1 Issue Map
| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| `bug(shell-desktop): use monotonic clock + clamp tick deltaMs` | Replace `Date.now()` tick timing with monotonic source; clamp `deltaMs` | Shell Implementation Agent | Design doc approved | `deltaMs` is non-negative and `<= 250ms`; existing behavior intact for normal ticks |
| `test(shell-desktop): cover backwards/large clock jump clamping` | Add deterministic unit test for clamping | Test Agent | Tick loop change merged or mocked | Test simulates backwards + large jumps and asserts clamping; `pnpm test --filter @idle-engine/shell-desktop` passes |

### 7.2 Milestones
- **Phase 1**: Implement monotonic time + clamp in `main.ts`, update existing tick-loop tests for deterministic behavior.
- **Phase 2**: Add explicit clamping tests and optional dev-only diagnostic logging (if desired).

### 7.3 Coordination Notes
- **Hand-off Package**:
  - Issue 807: https://github.com/hansjm10/Idle-Game-Engine/issues/807
  - Files: `packages/shell-desktop/src/main.ts`, `packages/shell-desktop/src/main.test.ts`, `packages/shell-desktop/src/sim-worker.ts`
- **Communication Cadence**: Single reviewer pass once Phase 1+2 land together; clamping value decision confirmed in review.

## 8. Agent Guidance & Guardrails
- **Context Packets**:
  - Issue 807: https://github.com/hansjm10/Idle-Game-Engine/issues/807
  - Tick loop: `packages/shell-desktop/src/main.ts`
  - Worker tick handling: `packages/shell-desktop/src/sim-worker.ts`
  - Existing tests: `packages/shell-desktop/src/main.test.ts`
- **Prompting & Constraints**:
  - Do not edit generated `packages/shell-desktop/dist/**` outputs by hand.
  - Preserve type-only imports/exports (`import type` / `export type`).
  - Keep tests deterministic: avoid real-time waits; use fake timers and/or mock the monotonic clock helper.
- **Safety Rails**:
  - Ensure clamp logic does not accidentally “freeze” the sim (e.g., by producing `NaN` deltas).
  - Avoid logging on every tick; only log when clamping occurs and only in dev/flagged mode (optional).
- **Validation Hooks**:
  - `pnpm test --filter @idle-engine/shell-desktop`
  - `pnpm lint --filter @idle-engine/shell-desktop` (if changing imports/modules)

## 9. Alternatives Considered
- **Continue using `Date.now()` and only clamp large deltas**: Still vulnerable to backwards jumps and wall-clock discontinuities; “monotonic” acceptance criterion not satisfied.
- **Clamp inside the worker/runtime only**: Helps limit damage but still lets wall-clock discontinuities into the system; better to sanitize at the source.
- **Drive the sim from renderer timing (`requestAnimationFrame`)**: Ties sim cadence to UI and loses isolation benefits of the worker.
- **Catch-up loop instead of clamp**: Attempting to simulate “all missed time” increases worst-case work and frame flooding; clamping is intentionally lossy to preserve responsiveness.

## 10. Testing & Validation Plan
- **Unit / Integration**:
  - Add a unit test that controls the clock values and asserts:
    - backwards jump produces `deltaMs = 0`,
    - large jump produces `deltaMs = MAX_TICK_DELTA_MS` (250).
  - Recommended test strategy:
    - If `main.ts` imports a helper like `monotonicNowMs()` from `src/monotonic-time.ts`, use `vi.mock('./monotonic-time.js', ...)` to return a scripted sequence of times per tick.
    - Use `vi.useFakeTimers()` and `vi.advanceTimersByTimeAsync(...)` to trigger interval callbacks without waiting.
  - Update existing “starts the sim tick loop” test to avoid depending on wall-clock `Date.now()` behavior (use the same mocked monotonic clock).
- **Performance**: N/A (small scheduling change; no new hot path allocations).
- **Tooling / A11y**: N/A.

## 11. Risks & Mitigations
- **Risk**: Switching to a high-resolution clock introduces fractional deltas that change sim behavior.\
  **Mitigation**: Use integer millisecond deltas (e.g., hrtime conversion or explicit rounding) to preserve current semantics.
- **Risk**: Clamp value too low causes the sim to run “slow” after long stalls (lost time).\
  **Mitigation**: Confirm `MAX_TICK_DELTA_MS` (250ms) is desired for UX; consider tying clamp to `stepSizeMs`/`maxStepsPerFrame` if needed.
- **Risk**: Tests become flaky if they depend on real time (hrtime/performance).\
  **Mitigation**: Mock the monotonic clock source in tests; do not rely on real elapsed time.

## 12. Rollout Plan
- **Milestones**:
  - Land the tick-loop clock + clamping change with updated tests.
  - Land the explicit clamping test (and optional dev-only diagnostics).
- **Migration Strategy**: None (internal behavior change only; no persisted data).
- **Communication**: Note in the PR description that the desktop sim tick loop is now monotonic and bounded, preventing frame floods after clock jumps/sleep.

## 13. Open Questions
- Is `MAX_TICK_DELTA_MS = 250` the preferred clamp value for the desktop shell, or should it be derived from `stepSizeMs * maxStepsPerFrame` (or made configurable)?
- Should we also clamp inside the worker (`sim-worker.ts`) as a defense-in-depth measure, even if the main process clamps?
- Should clamping emit a dev-only warning (rate-limited) to help diagnose sleep/resume behavior?

## 14. Follow-Up Work
- Consider a more robust scheduling model if frame flooding is still observed under heavy load (e.g., tick acknowledgements or adaptive cadence).
- If needed, expose max delta as a debug setting/env var for experimentation.

## 15. References
- Issue 807: https://github.com/hansjm10/Idle-Game-Engine/issues/807
- Tick loop implementation: `packages/shell-desktop/src/main.ts`
- Worker tick handler: `packages/shell-desktop/src/sim-worker.ts`
- Sim runtime tick: `packages/shell-desktop/src/sim/sim-runtime.ts`
- Desktop shell tests: `packages/shell-desktop/src/main.test.ts`

## Appendix A — Glossary
- **`deltaMs`**: The elapsed-time input (in milliseconds) sent from the main process to the sim worker each tick.
- **Monotonic clock**: A time source that never goes backwards and is not affected by wall-clock adjustments (e.g., `process.hrtime.bigint()`, `performance.now()`).
- **Tick loop**: The main-process `setInterval` loop that advances the sim worker by posting tick messages.

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2026-01-21 | Codex (AI) | Initial draft for Issue 807 |
