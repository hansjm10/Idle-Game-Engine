---
title: Tick Accumulator Edge Case Coverage
---

# Tick Accumulator Edge Case Coverage

Use this design document to guide the implementation of comprehensive test coverage for the fixed-step accumulator in the Idle Engine Runtime, ensuring deterministic behavior across edge cases including clamp scenarios, backlog drainage, and floating-point precision.

## Document Control
- **Title**: Implement comprehensive test coverage for tick accumulator edge cases
- **Authors**: TBD
- **Reviewers**: TBD
- **Status**: Design
- **Last Updated**: 2025-10-18
- **Related Issues**: #10
- **Execution Mode**: AI-led

## 1. Summary
The fixed-step accumulator in `IdleEngineRuntime.tick` maintains simulation determinism despite jittery host frame timings. While basic happy-path behavior is tested, critical edge cases—including backlog telemetry during clamping, deterministic debt drainage, and floating-point precision across many frames—lack explicit coverage. This design proposes three targeted test scenarios to validate accumulator remainder reporting, backlog drain sequences, and fractional step precision, ensuring scheduler and diagnostics changes cannot silently break offline catch-up, spiral-of-death protections, or devtools timeline functionality.

## 2. Context & Problem Statement
- **Background**: The fixed-step accumulator (packages/core/src/index.ts) is the core mechanism ensuring deterministic simulation behavior when host frame timings vary. The design specification in `docs/idle-engine-design.md` §6.2 depends on accurate backlog telemetry and precision guarantees.
- **Problem**: Current test coverage only validates basic command execution order and simple fractional carry-over. Backlog telemetry, precision guarantees, clamp scenarios, and drift prevention are not exercised. Without this coverage, scheduler or diagnostics changes could silently break critical functionality relied upon by offline catch-up mechanisms, spiral-of-death protections, and devtools timeline consumers.
- **Forces**: Tests must remain lightweight (under 5ms per test), use deterministic clocks to avoid flakiness, and integrate with existing Vitest infrastructure without introducing new runtime configuration or API changes.

## 3. Goals & Non-Goals
- **Goals**:
  1. Assert that when `maxStepsPerFrame` clamps execution, the accumulator remainder reported through diagnostics matches mathematical expectations
  2. Prove that backlog debt drains deterministically once host delta stabilizes, preventing unbounded carry-over
  3. Verify that fractional step sizes (e.g., 1000/60 ms) do not accumulate floating-point drift across many frames and keep backlog within tight tolerance
  4. Exercise the diagnostics delta reader so regressions in timeline metadata emission are caught by the unit suite
- **Non-Goals**:
  - Introduce new runtime configuration knobs or observable API changes
  - Cover worker bridge, shell UI integration, or command queue correctness beyond accumulator checks
  - Benchmark performance or profile timeline overhead (test-only effort)

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**: Runtime Core team
- **Agent Roles**: Testing Agent responsible for implementing test cases and validation utilities
- **Affected Packages/Services**: `packages/core` (specifically `src/index.ts` and `src/index.test.ts`)
- **Compatibility Considerations**: No API changes; backward compatible test additions only

## 5. Current State
- `packages/core/src/index.test.ts` already verifies step clamping, command scheduling, and a basic `"accumulates fractional time"` scenario, but never inspects accumulator state or diagnostics output
- `packages/core/src/devtools/diagnostics.test.ts` formats backlog metadata with mocked entries; no test ensures the runtime actually emits that data
- The diagnostics controller (`packages/core/src/diagnostics/runtime-diagnostics-controller.ts`) forwards `setAccumulatorBacklogMs`, yet no assertion fails if the value drifts or disappears

## 6. Proposed Solution
### 6.1 Architecture Overview
- **Narrative**: Extend existing test infrastructure in `packages/core/src/index.test.ts` with three focused test scenarios that exercise the accumulator's edge cases. Tests will use a deterministic `HighResolutionClock` stub and inspect diagnostics timeline entries to validate backlog metadata. A small utility function will simplify reading diagnostics deltas across multiple frames.
- **Diagram**: N/A (test-only changes)

### 6.2 Detailed Design
- **Runtime Changes**: None; tests only
- **Data & Schemas**: N/A
- **APIs & Contracts**: N/A
- **Tooling & Automation**: Extend `createRuntime` test helper to accept diagnostics overrides and surface runtime head index for timeline reads

### 6.3 Operational Considerations
- **Deployment**: N/A (tests only)
- **Telemetry & Observability**: Tests validate that telemetry is correctly emitted
- **Security & Compliance**: N/A

## 7. Work Breakdown & Delivery Plan
### 7.1 Issue Map

| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| test(core): add tick accumulator edge case coverage | Implement three test scenarios: clamp backlog telemetry, backlog drain sequence, and fractional step precision | Testing Agent | Design approval | All three tests pass; backlog metadata validated; pnpm test:ci passes |

### 7.2 Milestones
- **Phase 1**: Implement test helper extensions and three core test scenarios; validate with local test runs and CI

### 7.3 Coordination Notes
- **Hand-off Package**: Design document (this file), existing test files in packages/core/src
- **Communication Cadence**: Status update upon PR creation; review checkpoint before merge

## 8. Agent Guidance & Guardrails
- **Context Packets**: Read `packages/core/src/index.test.ts`, `packages/core/src/index.ts`, `packages/core/src/diagnostics/runtime-diagnostics-controller.ts`
- **Prompting & Constraints**: Use Vitest for all tests; follow existing test naming and structure conventions; commit messages must follow conventional commits format
- **Safety Rails**: Do not modify production code in packages/core/src/index.ts; test-only changes permitted in test files
- **Validation Hooks**: Must run `pnpm test --filter @idle-engine/core` and `pnpm test:ci` successfully before marking complete

## 9. Alternatives Considered
- **Mock-only diagnostics testing**: Rejected because it wouldn't validate the full integration path from runtime to diagnostics emission
- **Integration tests instead of unit tests**: Rejected due to higher complexity and slower execution; unit tests provide sufficient coverage for accumulator logic
- **Property-based testing**: Considered but deferred as overkill for these specific deterministic scenarios

## 10. Testing & Validation Plan
- **Unit / Integration**: Three new unit tests in `packages/core/src/index.test.ts`:

### 10.1 Clamp backlog telemetry
Instantiate an `IdleEngineRuntime` with `stepSizeMs: 10`, `maxStepsPerFrame: 2`, and diagnostics timeline enabled (capacity ≥ 8, deterministic `clock.now`). Call `tick(45)` once. Expect `currentStep` and `nextExecutableStep` to advance to 2, and `readDiagnosticsDelta(previousHead).entries` to contain two records whose `metadata.accumulatorBacklogMs` equals `25` while queue metrics remain zero. This exercises the clamp path and confirms the remainder surfaces through diagnostics.

### 10.2 Backlog drain sequence
Using a fresh runtime configured as above, invoke ticks with deltas `[45, 10, 10, 5]`, capturing the timeline delta after each frame. The recorded backlog sequence should be `[25, 15, 5, 0]`, and `currentStep` should advance by `[2, 2, 2, 1]` for a total of 7. This demonstrates deterministic debt reduction once the host stops overshooting and ensures the accumulator never underflows.

### 10.3 Fractional step precision
Construct a runtime with `stepSizeMs = 1000 / 60`, `maxStepsPerFrame: 6`, and timeline capacity ≥ 128. Loop 60 times, invoking `tick(stepSizeMs)`. After the loop, assert `currentStep === nextExecutableStep === 60` and the latest backlog reported by diagnostics stays below 1e-6 ms (using `toBeCloseTo` for safety). This safeguards the floating-point carry logic against regression when alternative cadence (e.g., 60 Hz) is configured.

- **Performance**: Each test should complete in under 5ms; total overhead negligible in Vitest runs
- **Tooling / A11y**: N/A

## 11. Risks & Mitigations
- **Risk**: Floating-point tolerance drift across different JavaScript engines
  - **Mitigation**: Use `toBeCloseTo` with epsilon (1e-6) instead of strict equality in fractional-step test
- **Risk**: Timeline capacity wrap-around causing dropped records
  - **Mitigation**: Configure capacities ≥ number of expected entries (8 and 128); add assertion that `dropped === 0`
- **Risk**: Diagnostic overhead impacting test performance
  - **Mitigation**: Each runtime instance is short-lived and exercises at most a dozen ticks, keeping overhead under 5ms per test

## 12. Rollout Plan
- **Milestones**: Single-phase implementation and merge
- **Migration Strategy**: N/A (additive tests only)
- **Communication**: Cross-link new coverage in `docs/runtime-command-queue-design.md` Appendix A when landing the change

## 13. Open Questions
- Should we assert telemetry counters (e.g., `telemetry.recordTick`) alongside diagnostics to guarantee both pathways stay aligned?
- Do we want to expose a small runtime test helper for backlog reads in other suites, or keep the utility local to `index.test.ts` for now?

## 14. Follow-Up Work
- Consider property-based testing for accumulator behavior if additional edge cases emerge
- Evaluate exposing backlog reader utility for reuse in other test suites (deferred pending initial implementation feedback)

## 15. References
- `docs/idle-engine-design.md` §6.2 (fixed-step accumulator specification)
- `packages/core/src/index.ts` (IdleEngineRuntime.tick implementation)
- `packages/core/src/index.test.ts` (existing test coverage)
- `packages/core/src/devtools/diagnostics.test.ts` (diagnostics formatting tests)
- `packages/core/src/diagnostics/runtime-diagnostics-controller.ts` (diagnostics controller)

## Appendix A — Glossary
- **Accumulator**: The fractional time remainder tracked between frames to maintain deterministic step execution
- **Backlog**: The accumulated time debt when frame deltas exceed what can be processed within `maxStepsPerFrame`
- **Clamp**: The limiting mechanism that caps the number of simulation steps executed per frame via `maxStepsPerFrame`
- **Fixed-step**: A simulation technique where logic executes at fixed time intervals regardless of variable frame timing

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2025-10-18 | TBD    | Initial draft |
| 2025-12-21 | Claude Opus 4.5 | Migrated to standardized template format |
