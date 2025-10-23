# Tick Accumulator Edge Case Coverage

**Issue:** #10  
**Workstream:** Runtime Core  
**Status:** Design  
**Last Updated:** 2025-10-18

## 1. Problem Statement
- The fixed-step accumulator in `IdleEngineRuntime.tick` (packages/core/src/index.ts) keeps the simulation deterministic when host frame timings jitter, yet only basic happy-path behaviour is currently exercised.
- Existing tests confirm command execution order and simple fractional carry-over, but they never validate the backlog telemetry or precision guarantees that `docs/idle-engine-design.md` §9.1 depends on.
- Without explicit coverage of clamp and drift scenarios, scheduler or diagnostics changes could silently break offline catch-up, spiral-of-death protections, or the devtools timeline consumers rely on.

## 2. Goals
- Assert that when `maxStepsPerFrame` clamps execution, the accumulator remainder reported through diagnostics matches the mathematical expectation.
- Prove that backlog debt drains deterministically once host delta stabilises, preventing unbounded carry-over.
- Verify that fractional step sizes (e.g., 1000 / 60 ms) do not accumulate floating-point drift across many frames and keep backlog within a tight tolerance.
- Exercise the diagnostics delta reader so regressions in timeline metadata emission are caught by the unit suite.

## 3. Non-Goals
- Introduce new runtime configuration knobs or observable API changes.
- Cover worker bridge, shell UI integration, or command queue correctness beyond what is required for accumulator checks.
- Benchmark performance or profile timeline overhead; this effort is test-only.

## 4. Current State
- `packages/core/src/index.test.ts` already verifies step clamping, command scheduling, and a basic `"accumulates fractional time"` scenario, but never inspects accumulator state or diagnostics output.
- `packages/core/src/devtools/diagnostics.test.ts` formats backlog metadata with mocked entries; no test ensures the runtime actually emits that data.
- The diagnostics controller (`packages/core/src/diagnostics/runtime-diagnostics-controller.ts`) forwards `setAccumulatorBacklogMs`, yet no assertion fails if the value drifts or disappears.

## 5. Proposed Tests

### 5.1 Clamp backlog telemetry
Instantiate an `IdleEngineRuntime` with `stepSizeMs: 10`, `maxStepsPerFrame: 2`, and the diagnostics timeline enabled (capacity ≥ 8, deterministic `clock.now`). Call `tick(45)` once. Expect `currentStep` and `nextExecutableStep` to advance to 2, and `readDiagnosticsDelta(previousHead).entries` to contain two records whose `metadata.accumulatorBacklogMs` equals `25` while queue metrics remain zero. This exercises the clamp path and confirms the remainder surfaces through diagnostics.

### 5.2 Backlog drain sequence
Using a fresh runtime configured as above, invoke ticks with deltas `[45, 10, 10, 5]`, capturing the timeline delta after each frame. The recorded backlog sequence should be `[25, 15, 5, 0]`, and `currentStep` should advance by `[2, 2, 2, 1]` for a total of 7. This demonstrates deterministic debt reduction once the host stops overshooting and ensures the accumulator never underflows.

### 5.3 Fractional step precision
Construct a runtime with `stepSizeMs = 1000 / 60`, `maxStepsPerFrame: 6`, and timeline capacity ≥ 128. Loop 60 times, invoking `tick(stepSizeMs)`. After the loop, assert `currentStep === nextExecutableStep === 60` and the latest backlog reported by diagnostics stays below 1e-6 ms (using `toBeCloseTo` for safety). This safeguards the floating-point carry logic against regression when alternative cadence (e.g., 60 Hz) is configured.

## 6. Implementation Notes
- Extend the existing `createRuntime` helper in `packages/core/src/index.test.ts` to accept diagnostics overrides and to surface the runtime head index for timeline reads.
- Provide a tiny local utility (e.g., `readBacklog(runtime, head)`) that wraps `readDiagnosticsDelta` and returns `{ entries, head }` so tests can chain delta reads without repeating boilerplate.
- Use a deterministic `HighResolutionClock` stub returning monotonically increasing integers to keep durations zero while preserving order; the tests only care about backlog metadata.

## 7. Risks & Mitigations
- **Floating-point tolerance drift:** Use `toBeCloseTo` with an epsilon (1e-6) instead of strict equality so the fractional-step test stays stable across JS engines.
- **Timeline capacity wrap-around:** Configure capacities ≥ number of expected entries (8 and 128) to avoid dropped records; add an assertion that `dropped === 0`.
- **Diagnostic overhead in tests:** Each runtime instance is short-lived and exercises at most a dozen ticks, so the additional timeline bookkeeping should keep Vitest runtimes negligible (under 5 ms per test).

## 8. Rollout Steps
- Update the test helper and add the backlog reader utility in `packages/core/src/index.test.ts`.
- Implement the three Vitest cases described above, keeping assertions focused on accumulator behaviour.
- Run `pnpm test --filter @idle-engine/core` locally and ensure Lefthook’s `pnpm test:ci` passes.
- Cross-link the new coverage in `docs/runtime-command-queue-design.md` Appendix A when landing the change.

## 9. Open Questions
- Should we assert telemetry counters (e.g., `telemetry.recordTick`) alongside diagnostics to guarantee both pathways stay aligned?
- Do we want to expose a small runtime test helper for backlog reads in other suites, or keep the utility local to `index.test.ts` for now?

## 10. Acceptance Criteria
- New Vitest cases verify clamp backlog values, backlog drainage, and fractional cadence precision in `packages/core/src/index.test.ts`.
- Diagnostics delta assertions fail if `metadata.accumulatorBacklogMs` is missing or diverges from the expected remainder.
- The fractional-step test leaves accumulator debt below 1e-6 ms after 60 frames.
- `pnpm test --filter @idle-engine/core` (and the broader `pnpm test:ci`) completes without regressions.
