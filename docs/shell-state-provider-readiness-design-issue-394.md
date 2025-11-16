---
title: Deterministic Shell State Readiness Contract for ShellStateProvider
sidebar_position: 4
---

# Deterministic Shell State Readiness Contract for ShellStateProvider

Use this document to define and implement a deterministic async boundary for Shell state initialisation and telemetry in the web shell, replacing the current `flushMicrotasks`-based workaround in `ShellStateProvider` tests (GitHub issue #394).

## Document Control
- **Title**: Introduce deterministic Shell state readiness contract for ShellStateProvider
- **Authors**: Idle Engine Design-Authoring Agent (Shell Web)
- **Reviewers**: Shell Web Maintainer(s); Runtime/Bridge Maintainer(s)
- **Status**: Draft
- **Last Updated**: 2025-11-16
- **Related Issues**: [#394](https://github.com/hansjm10/Idle-Game-Engine/issues/394)
- **Execution Mode**: AI-led

## 1. Summary

This design defines a deterministic Shell state readiness contract for `ShellStateProvider` in `shell-web` and replaces the brittle `flushMicrotasks` test helper with an explicit, documented async boundary. Today, Shell tests rely on chained microtasks and `setTimeout(0)` to “hope” the provider has completed its initial async work; this results in non-obvious coupling to the event loop and potential flakiness. The proposed solution introduces a canonical readiness condition, exposed via Shell state and a dedicated test helper, so tests (and future automation) can await `ShellStateProvider` initialisation and telemetry wiring without relying on event-loop timing. The change is scoped to `shell-web` and must preserve existing progression and telemetry behaviour while enabling AI-led agents to update tests and implementation safely.

## 2. Context & Problem Statement

- **Background**
  - `ShellStateProvider` wraps the runtime worker bridge and exposes Shell state, progression, diagnostics, and social APIs to the web shell UI.
    - Provider implementation: `packages/shell-web/src/modules/ShellStateProvider.tsx` (e.g., readiness/restore effects at `:308` and `:448`).
    - Shell state reducer: `packages/shell-web/src/modules/shell-state-store.ts:30`–`:189`.
  - The provider already:
    - Awaits `bridge.awaitReady()` and dispatches a `bridge-ready` action (`ShellStateProvider.tsx:308`–`:329`, `shell-state-store.tsx:149`–`:163`).
    - Orchestrates restore via `bridge.awaitReady()` followed by `restoreSession`, with telemetry on failure (`ShellStateProvider.tsx:448`–`:486`).
  - Tests for Shell state and telemetry currently define local `flushMicrotasks` helpers that rely on multiple microtask and macrotask hops:
    - `packages/shell-web/src/modules/ShellStateProvider.test.tsx:80`–`:99`.
    - `packages/shell-web/src/modules/ShellStateProvider.telemetry.test.tsx:587`–`:593`.
  - These helpers are used before making assertions about progression APIs and telemetry events in the Shell environment.

- **Problem**
  - Tests have no explicit, semantic contract for “Shell state is ready”; they instead depend on:
    - Two `await Promise.resolve()` calls plus `setTimeout(0)` to flush effects and timers.
    - Implicit coupling to the timing of React effects and the worker bridge’s internal scheduling.
  - This leads to:
    - Fragile tests that may break when React’s scheduling, bridge behaviour, or effect structure changes, even if user-facing behaviour is unchanged.
    - Inability for AI agents to reason about the readiness boundary in a first-class way; they must treat `flushMicrotasks` as a magic incantation.
    - No reusable or documented mechanism for other Shell tests to await readiness.
  - The absence of a deterministic async boundary contradicts the goal of a deterministic, simulation-driven engine and makes it harder to reason about telemetry failures (e.g., `ShellStateProviderAwaitReadyFailed`, `ShellStateProviderRestoreEffectFailed`).

- **Forces**
  - **Determinism**
    - Test runs must remain deterministic and not rely on arbitrary timing delays.
    - Readiness should be described in terms of state/contract, not discrete microtasks.
  - **Compatibility**
    - The current UI contract (e.g., loading behaviour based on `bridge.isReady` and `lastUpdateAt`) must be preserved:
      - `ResourceDashboard`: `packages/shell-web/src/modules/ResourceDashboard.tsx:242`.
      - `GeneratorPanel`: `packages/shell-web/src/modules/GeneratorPanel.tsx:124`.
  - **React & StrictMode**
    - `ShellStateProvider` is already written to be StrictMode-safe (e.g., `lastAwaitedBridgeRef`, payload/bridge tracking).
    - Any new readiness handling must avoid double-dispatch bugs and work under StrictMode double-mount.
  - **Scope & Velocity**
    - The primary initiative is to support GitHub issue #394: deterministic Shell state readiness and removal of `flushMicrotasks`.
    - The design should be implementable by AI-led agents with minimal human intervention and clear guardrails.

## 3. Goals & Non-Goals

- **Goals**
  1. Define a clear, documented readiness contract for `ShellStateProvider` initialisation (“Shell state readiness contract for ShellStateProvider”).
  2. Provide a deterministic, awaitable test helper (or helpers) that encode this contract without reliance on microtask/macrotask flushing.
  3. Migrate `ShellStateProvider` and telemetry tests to the new contract, fully removing inline `flushMicrotasks` helpers.
  4. Maintain existing Shell progression and telemetry behaviour, including error telemetry for `awaitReady` and restore failures.
  5. Enable AI-led agents to safely extend the readiness contract to new tests or Shell surfaces using consistent patterns.

- **Non-Goals**
  - Redesign the underlying worker bridge protocol or `@idle-engine/core` runtime.
  - Change production loading UX, including how `ResourceDashboard` and `GeneratorPanel` compute `isLoading`.
  - Generalise readiness semantics to all subsystems (e.g., social backend, content loading) beyond what is necessary for Shell state initialisation and telemetry.
  - Introduce cross-package synchronization primitives outside `shell-web` for this initiative.

## 4. Stakeholders, Agents & Impacted Surfaces

- **Primary Stakeholders**
  - Shell Web maintainers (owners of `packages/shell-web`).
  - Runtime/Bridge maintainers (owners of `worker-bridge` integration).
  - Testing & CI maintainers (owners of `@idle-engine/config-vitest` and test flakiness triage).

- **Agent Roles**
  - **Design-Authoring Agent (this document)**
    - Produces and maintains this design document.
    - Ensures alignment with existing code and testing patterns.
  - **Shell-Web Implementation Agent**
    - Implements readiness helpers and any necessary provider changes in `packages/shell-web`.
    - Refactors tests to the new pattern.
  - **Test & Tooling Agent**
    - Validates test stability post-change.
    - Adjusts any shared test utilities or Vitest configuration if needed.
  - **Review & Governance Agent**
    - Monitors adherence to agent guardrails and coding standards.
    - Ensures changes are linked to `Fixes #394` and documented.

- **Affected Packages/Services**
  - `packages/shell-web`
    - `src/modules/ShellStateProvider.tsx:308`–`:339`, `:448`–`:486`.
    - `src/modules/shell-state-store.ts:30`–`:189`.
    - `src/modules/ShellStateProvider.test.tsx:80`–`:220`, `:364`–`:399`.
    - `src/modules/ShellStateProvider.telemetry.test.tsx:575`–`:638`.
  - No direct changes expected in `packages/core` or backend services for this initiative.

- **Compatibility Considerations**
  - The readiness contract should:
    - Be backwards compatible in production: UI components should continue to rely on `bridge.isReady` and `lastUpdateAt` semantics.
    - Avoid breaking `ShellBridgeApi` consumers (e.g., `useShellBridge` usage patterns).
  - Any new test-only exports must not be inadvertently used in production code.
  - The contract should be robust to future changes in `ShellStateProvider` internals (e.g., additional effects).

## 5. Current State

- **Provider & State**
  - `ShellStateProvider`:
    - Creates Shell state via `createInitialShellState` and `createShellStateReducer` (`ShellStateProvider.tsx:40`–`:55`, `shell-state-store.ts:64`–`:96`).
    - Tracks bridge readiness via a `useEffect` that calls `bridge.awaitReady()` and dispatches a `bridge-ready` action (`ShellStateProvider.tsx:308`–`:329`).
    - Orchestrates restore when `restorePayload` or the bridge changes:
      - Awaits `bridge.awaitReady()` and then `restoreSession(restorePayload)`.
      - Emits telemetry on failure: `ShellStateProviderRestoreEffectFailed` (`ShellStateProvider.tsx:448`–`:486`).
  - `ShellState`:
    - Includes `bridge.isReady`, `bridge.isRestoring`, and `runtime.lastSnapshot` (`shell-state-store.ts:103`–`:131`).
    - Sets `isReady: true` on `bridge-ready` (`shell-state-store.ts:149`–`:163`).
    - Uses `restore-started`/`restore-complete` to track restore status (`shell-state-store.ts:177`–`:201`).

- **UI Consumption**
  - `ResourceDashboard` and `GeneratorPanel` derive loading state from Shell bridge state:
    - `isLoading = !bridge.isReady || bridge.lastUpdateAt === null` (`ResourceDashboard.tsx:242`, `GeneratorPanel.tsx:124`).
  - This implies an implicit contract: the Shell is “ready” for UI when `bridge.isReady === true` and at least one state update has occurred (`lastUpdateAt !== null`), though tests currently do not wait on this combination semantically.

- **Test Behaviour**
  - `ShellStateProvider.test.tsx`:
    - Defines an inline `async function flushMicrotasks()` that awaits two microtasks plus a `setTimeout(0)` before assertions (`ShellStateProvider.test.tsx:80`–`:99`).
    - Uses `flushMicrotasks` across multiple test cases to wait for:
      - `useShellProgression` to return a non-null API.
      - Restore effects to fire when bridge or payload changes.
      - State update handlers to be registered (`ShellStateProvider.test.tsx:191`–`:200`).
  - `ShellStateProvider.telemetry.test.tsx`:
    - Defines a similar `flushMicrotasks` helper (`ShellStateProvider.telemetry.test.tsx:587`–`:593`).
    - Relies on it to:
      - Allow restore effects to fail and be reported via telemetry (`ShellStateProvider.telemetry.test.tsx:192`–`:212`).
      - Allow `awaitReady` failures to be reported (`ShellStateProvider.telemetry.test.tsx:208`–`:216`).
      - Ensure bridge error handling and telemetry are wired before unmount.

- **Gaps**
  - No explicit “Shell state readiness contract for ShellStateProvider” is defined in code or docs.
  - Tests depend on the incidental timing of React effects and worker bridge behaviour via `flushMicrotasks`.
  - There is no reusable or documented helper for other tests to await readiness; each suite reimplements a microtask flusher.

## 6. Proposed Solution

### 6.1 Architecture Overview

- **Narrative**
  - Define a formal readiness contract for `ShellStateProvider` based on Shell state:
    - Shell is considered *ready* when:
      1. The worker bridge has reported readiness (`bridge.isReady === true`).
      2. The provider is not currently restoring (`bridge.isRestoring === false`).
      3. At least one runtime snapshot has been processed (`runtime.lastSnapshot` is non-null and `bridge.lastUpdateAt !== null`).
  - Expose this contract in two ways:
    1. **State-Level Contract**: Document these invariants as the official readiness definition, accessible via `useShellState`.
    2. **Test-Level Helper**: Introduce a dedicated test helper `awaitShellStateReady` in `packages/shell-web/src/modules/__tests__/shell-state-ready.ts` (or similar test-only module) that:
       - Consumes `useShellState` (or a provided getter) and `waitFor` from `@testing-library/react`.
       - Awaits the readiness condition above with a bounded timeout.
  - Update `ShellStateProvider` tests to:
    - Replace `flushMicrotasks` with `awaitShellStateReady`.
    - Use the helper wherever they currently “wait for things to settle”.
  - Keep production API and UI semantics unchanged while providing agents and developers a clear readiness boundary.

- **Diagram (conceptual)**
  - **Initialisation flow**
    - `ShellStateProvider` mount
      → `useWorkerBridge` obtains `bridge`
      → Effect A: `bridge.awaitReady()` → dispatch `bridge-ready`
      → Effect B: `bridge.awaitReady()` → `restoreSession(restorePayload)` (if configured)
      → Effects: state update listeners, diagnostics, error listeners
      → `ShellState` transitions to:
        - `bridge.isReady === true`
        - `bridge.isRestoring === false`
        - `runtime.lastSnapshot !== null` (after first snapshot)
      → `awaitShellStateReady` resolves.

### 6.2 Detailed Design

- **Runtime Changes**
  - No changes to the underlying worker runtime or `@idle-engine/core`.
  - Minimal internal changes to `ShellStateProvider`:
    - Ensure that:
      - `bridge-ready` is always dispatched after `bridge.awaitReady()` resolves.
      - `restore-started` and `restore-complete` correctly bracket restore operations.
    - Confirm invariants:
      - After a successful `restoreSession` in the restore effect, `bridge.isRestoring` is `false`.
      - On a best-effort basis, at least one `state-update` has been dispatched following readiness (existing behaviour should already satisfy this).
  - Optionally, small internal refactoring to make readiness criteria easier to read for future maintainers (e.g., a derived boolean used only within tests and documentation).

- **Data & Schemas**
  - No changes to runtime data schemas or worker messages.
  - Clarify semantics of existing state fields:
    - `ShellBridgeState.isReady`: “`bridge.awaitReady()` has successfully completed at least once for the current bridge instance.”
    - `ShellBridgeState.isRestoring`: “A restore operation started by the provider is currently in-flight.”
    - `ShellRuntimeState.lastSnapshot`: “The latest runtime snapshot received; `null` indicates no snapshot yet.”

- **APIs & Contracts**
  - **Readiness Contract (logical)**
    - Define `ShellStateProvider` readiness as the following predicate evaluated over `ShellState`:
      - `bridge.isReady === true`
      - `bridge.isRestoring === false`
      - `bridge.lastUpdateAt !== null`
      - `runtime.lastSnapshot !== undefined` (or non-null)
    - This contract is:
      - The canonical definition used by `awaitShellStateReady`.
      - A documented expectation for future tests that need a ready Shell.

  - **Test Helper API**
    - Add a new module, e.g. `packages/shell-web/src/modules/__tests__/shell-state-ready.ts` (or `test-helpers.shell-state-ready.ts` if co-locating with existing helpers), exporting:

      ```ts
      export interface ShellReadyOptions {
        readonly timeoutMs?: number;
      }

      export async function awaitShellStateReady(
        getShellState: () => ShellState,
        options?: ShellReadyOptions,
      ): Promise<void>;
      ```

    - Implementation sketch:
      - Uses `waitFor` from `@testing-library/react` with a default timeout (e.g. 1–2 seconds) to poll `getShellState()` until the readiness predicate holds.
      - Throws a descriptive error if the timeout elapses, including partial state for debugging.
    - Usage patterns:
      - For `renderHook` tests:
        ```ts
        const { result } = renderHook(() => useShellState(), { wrapper });
        await awaitShellStateReady(() => result.current);
        ```
      - For integration tests using container probes:
        ```ts
        const shellStateRef = { current: null as ShellState | null };
        // Probe component sets shellStateRef.current from context
        await awaitShellStateReady(() => {
          if (!shellStateRef.current) throw new Error('Shell state not yet attached');
          return shellStateRef.current;
        });
        ```

  - **Test Refactoring**
    - `ShellStateProvider.test.tsx`:
      - Replace inline `flushMicrotasks` with calls to `awaitShellStateReady`, passing appropriate getters.
      - Where tests currently rely on “all async work settled” but not on readiness per se (e.g. verifying error propagation), selectively use:
        - `waitFor` with more local predicates (e.g. telemetry spy called).
        - Or the readiness helper plus additional expectations.
    - `ShellStateProvider.telemetry.test.tsx`:
      - Similar replacement for readiness-sensitive assertions, especially where telemetry from restore and `awaitReady` failures is expected.

- **Tooling & Automation**
  - Maintain Vitest-based tests; no new frameworks introduced.
  - Update any existing shared test utilities that may benefit from the readiness helper (optional but recommended).
  - Ensure the helper module is not imported into production bundles:
    - Place it under a `__tests__` or clearly test-only path.
    - Avoid exporting it from main `modules/index.ts`.

### 6.3 Operational Considerations

- **Deployment**
  - No special deployment changes; this is a test-focused improvement with minor provider internals clarification.
  - Merged as part of regular `shell-web` changes, gated by CI:
    - `pnpm test --filter shell-web`
    - `pnpm lint --filter shell-web`

- **Telemetry & Observability**
  - Maintain existing telemetry events:
    - `ShellStateProviderAwaitReadyFailed`.
    - `ShellStateProviderRestoreEffectFailed`.
    - Social and diagnostics-related telemetry.
  - Optionally log additional context in tests when readiness fails to be reached within timeout, but avoid production logging changes.

- **Security & Compliance**
  - No changes to PII handling or permissions.
  - Test helper must not expose additional secrets or environment details.

## 7. Work Breakdown & Delivery Plan

### 7.1 Issue Map

Populate the table as the canonical source for downstream GitHub issues.

| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| feat(shell-web): define ShellStateProvider readiness contract | Document and validate the logical readiness predicate over `ShellState` and ensure provider effects maintain it | Shell-Web Implementation Agent | This design approved | Predicate is captured in code comments and/or docstrings; unit tests assert readiness invariants via reducer/state tests |
| test(shell-web): add awaitShellStateReady helper | Implement `awaitShellStateReady` test helper and initial unit tests for the helper | Test & Tooling Agent | Readiness predicate defined | Helper module exists under `packages/shell-web/src/modules/__tests__/`; tests pass; helper is not exported into production bundles |
| test(shell-web): migrate ShellStateProvider tests off flushMicrotasks | Refactor `ShellStateProvider.test.tsx` to use readiness helper and targeted `waitFor` instead of `flushMicrotasks` | Shell-Web Implementation Agent | Helper implemented | No `flushMicrotasks` function remains in `ShellStateProvider.test.tsx`; tests pass and remain deterministic |
| test(shell-web): migrate ShellStateProvider telemetry tests off flushMicrotasks | Refactor telemetry tests to await readiness and specific telemetry events without microtask flushing | Shell-Web Implementation Agent | Helper implemented | No `flushMicrotasks` function remains in `ShellStateProvider.telemetry.test.tsx`; telemetry assertions are stable |
| chore(shell-web): remove legacy microtask helpers & document readiness | Remove any remaining microtask-based helpers in Shell state tests; add a short section to docs or test README summarising the readiness contract | Shell-Web Implementation Agent | All migrations completed | `flushMicrotasks` no longer appears in the repo; docs/tests reference the readiness helper and contract; CI is green |
| meta: drive Fixes #394 PR | Integrate all work on a dedicated branch, run tests, and open a PR referencing `Fixes #394` | Review & Governance Agent | All above issues closed | PR merged with message and description including `Fixes #394`; GitHub issue auto-closes |

### 7.2 Milestones

- **Phase 1: Contract & Helper (1–2 days)**
  - Finalise readiness predicate in code comments.
  - Implement `awaitShellStateReady`.
  - Add unit tests for the helper using simple mocked `ShellState` transitions.

- **Phase 2: Test Migration (1–2 days)**
  - Refactor `ShellStateProvider.test.tsx` and telemetry tests to the new helper.
  - Remove `flushMicrotasks` definitions.
  - Validate tests locally and in CI.

- **Phase 3: Documentation & Cleanup (≤1 day)**
  - Add short documentation snippet (either within test files or a `docs/` note) describing the readiness contract.
  - Confirm no other tests rely on `flushMicrotasks` or similar patterns.
  - Land PR with `Fixes #394`.

### 7.3 Coordination Notes

- **Hand-off Package**
  - This design document.
  - Relevant source files:
    - `packages/shell-web/src/modules/ShellStateProvider.tsx`.
    - `packages/shell-web/src/modules/shell-state-store.ts`.
    - `packages/shell-web/src/modules/ShellStateProvider.test.tsx`.
    - `packages/shell-web/src/modules/ShellStateProvider.telemetry.test.tsx`.
  - Commands:
    - `pnpm test --filter shell-web`.
    - `pnpm lint --filter shell-web`.

- **Communication Cadence**
  - Agents should:
    - Update the GitHub issue #394 with progress notes per phase.
    - Request human review once tests are migrated and passing.
  - Escalation path:
    - Shell Web maintainer for design ambiguities.
    - Runtime/Bridge maintainer for questions about `awaitReady` guarantees.

## 8. Agent Guidance & Guardrails

- **Context Packets**
  - Agents must load:
    - This design document.
    - `packages/shell-web/src/modules/ShellStateProvider.tsx`.
    - `packages/shell-web/src/modules/shell-state-store.ts`.
    - `packages/shell-web/src/modules/ShellStateProvider.test.tsx`.
    - `packages/shell-web/src/modules/ShellStateProvider.telemetry.test.tsx`.
  - Environment assumptions:
    - Node ≥ 20.10.
    - `pnpm` ≥ 8.
    - `pnpm install` has been run at repo root.

- **Prompting & Constraints**
  - Agents should follow:
    - Repository coding conventions in `AGENTS.md` and `eslint.config.mjs`.
    - TypeScript style guidelines:
      - Use `import type { ... }` for type-only imports.
      - Co-locate test helpers with tests when appropriate.
    - Commit/PR conventions:
      - Use Conventional Commits; final PR must include `Fixes #394` in description.
  - Example agent prompt snippet:
    - “Update `ShellStateProvider` tests to replace the `flushMicrotasks` helper with the `awaitShellStateReady` helper, using the readiness contract defined in `docs/deterministic-shell-state-readiness.md` (or this design). Ensure tests remain deterministic and do not rely on `setTimeout(0)`.”

- **Safety Rails**
  - Forbidden actions:
    - Do not modify `dist/` outputs.
    - Do not change core runtime semantics in `packages/core` as part of this initiative.
    - Do not disable or bypass tests; fix them.
    - Do not introduce arbitrary sleeps (`setTimeout`-based waits) in tests.
  - Rollback procedures:
    - If readiness helper introduces new flakiness:
      - Revert the helper and test changes in a dedicated revert commit.
      - File a follow-up issue documenting observed failures and logs.

- **Validation Hooks**
  - Before marking tasks complete, agents must run:
    - `pnpm test --filter shell-web`.
    - `pnpm lint --filter shell-web`.
  - Optionally:
    - `pnpm test:a11y` when Shell UI flows are affected (should not be necessary for this test-focused change but can be run as a safety check).

## 9. Alternatives Considered

- **Alternative A: Extend ShellBridgeApi with a public `ready` Promise**
  - Description:
    - Add a `ready: Promise<void>` property to `ShellBridgeApi`, backed by `bridge.awaitReady()`, and have tests await `useShellBridge().ready`.
  - Pros:
    - Simple consumption from tests and potentially application code.
  - Cons:
    - Introduces new public API with ambiguous semantics relative to `awaitReady()`.
    - Does not directly capture restore completion or initial snapshot availability.
    - Risks encouraging production code to block on readiness in ways that might hurt UX.
  - Reason rejected:
    - The problem is primarily test-facing; adding a production API is unnecessary scope.

- **Alternative B: Deterministic “tick” API in the runtime**
  - Description:
    - Add a “tick” or “drain” API to the worker/runtime, allowing tests to advance the simulation deterministically.
  - Pros:
    - Strong deterministic semantics across many subsystems.
  - Cons:
    - Requires changes to `@idle-engine/core` and worker protocols.
    - Overkill for the narrow goal of Shell state readiness in `shell-web`.
  - Reason rejected:
    - Too large and cross-cutting for issue #394; may be revisited for broader deterministic testing.

- **Alternative C: Keep `flushMicrotasks` but share it as a utility**
  - Description:
    - Refactor the existing microtask-based helper into a shared test util and document it.
  - Pros:
    - Minimal code changes.
  - Cons:
    - Retains brittle reliance on event-loop details.
    - Fails to provide a semantic readiness contract.
  - Reason rejected:
    - Does not meet the acceptance criteria of deterministic, contract-based readiness.

## 10. Testing & Validation Plan

- **Unit / Integration**
  - Add tests for readiness helper:
    - Simulate `ShellState` transitions and assert that `awaitShellStateReady` resolves when the predicate is satisfied and times out otherwise.
  - Update and re-run:
    - `ShellStateProvider.test.tsx`:
      - Verify all existing scenarios (progression API, restore behaviour, error handling) using the new helper.
    - `ShellStateProvider.telemetry.test.tsx`:
      - Ensure telemetry events (`RestoreEffectFailed`, `AwaitReadyFailed`, social failures) still fire as expected.
  - Use Vitest filters for targeted runs:
    - `pnpm test --filter shell-web -- ShellStateProvider`.
    - `pnpm test --filter shell-web -- ShellStateProvider.telemetry`.

- **Performance**
  - No explicit performance benchmarks required; however:
    - Ensure readiness helper timeout is reasonable and does not materially slow tests.
    - Monitor test duration regressions in CI runs.

- **Tooling / A11y**
  - No direct impact on Playwright or accessibility tests.
  - Optionally run:
    - `pnpm test:a11y` after changes to guard against unexpected UI regressions from provider tweaks.

## 11. Risks & Mitigations

- **Risk 1: Mis-specified readiness predicate**
  - Impact:
    - Tests may hang or fail if readiness is never reached, or assert too early if predicate is too weak.
  - Mitigations:
    - Derive predicate from existing UI semantics (`isLoading` usage).
    - Add focused tests that assert the relationship between `bridge-ready`, `restore` actions, and readiness.
    - Include state snapshots in error messages on timeout to aid debugging.

- **Risk 2: StrictMode interactions**
  - Impact:
    - Double-mount behaviour may cause multiple `awaitReady` / restore sequences and subtle ordering issues.
  - Mitigations:
    - The provider already guards against duplicate awaits (`lastAwaitedBridgeRef`, `lastRestorePayloadRef`, `lastRestoreBridgeRef`).
    - Ensure readiness predicate does not depend on transient intermediate states and is idempotent.

- **Risk 3: Hidden consumers of `flushMicrotasks`**
  - Impact:
    - Other tests may implicitly rely on `flushMicrotasks` or similar patterns; removal could cause regressions.
  - Mitigations:
    - Search the codebase (`rg "flushMicrotasks" -n`) before removal.
    - Migrate or explicitly document any remaining usage; if unavoidable, keep such usage narrowly scoped and justified.

- **Risk 4: Overfitting to current provider implementation**
  - Impact:
    - Future changes to `ShellStateProvider` effects may unintentionally break the readiness helper.
  - Mitigations:
    - Keep readiness defined in terms of `ShellState`, not internal effect order.
    - Revisit the helper and tests when provider internals change; update references accordingly.

## 12. Rollout Plan

- **Milestones**
  - M1: Helper implemented and validated locally.
  - M2: `ShellStateProvider` tests migrated and passing.
  - M3: Telemetry tests migrated; `flushMicrotasks` removed.
  - M4: PR merged with `Fixes #394`.

- **Migration Strategy**
  - Implement helper and migrate tests within the same feature branch (`issue-394`).
  - Avoid partial migration where tests mix `flushMicrotasks` and readiness helper in confusing ways.
  - Maintain backwards compatibility with runtime and UI by not changing public APIs.

- **Communication**
  - Document the readiness contract at the top of the helper module and in a brief comment in `ShellStateProvider.test.tsx`.
  - Mention the new pattern and helper in the PR description and link to this design document.
  - If test flakiness is discovered, note it in the GitHub issue and consider a follow-up design for broader deterministic testing.

## 13. Open Questions

1. Should the readiness helper be exported from a central `test-utils` module (`packages/shell-web/src/test-utils.ts`) instead of a `__tests__`-local file to encourage reuse?
   - **Decision**: Keep the readiness helper out of the shared worker harness utilities and scope it to React-only test modules (e.g., `packages/shell-web/src/modules/test-helpers.ts` or a `modules/__tests__/shell-state-ready.ts`-style helper).
   - **Rationale**: `packages/shell-web/src/test-utils.ts` is imported by worker-centric suites such as `packages/shell-web/src/runtime.worker.test.ts` and `packages/shell-web/src/modules/session-persistence-integration.test.ts`, which deliberately avoid React or DOM-specific dependencies so they can run in the Node-based worker harness. Exporting a React Testing Library–based readiness helper from that module would force those suites to pull in unnecessary DOM tooling and could break worker-only runs.
   - **Owner**: Shell Web Maintainer — **CLOSED**.
2. Do any other Shell tests (beyond `ShellStateProvider*`) need to await the same readiness boundary?
   - **Decision**: The readiness helper only needs to replace the local `flushMicrotasks` helpers in `packages/shell-web/src/modules/ShellStateProvider.test.tsx` and `packages/shell-web/src/modules/ShellStateProvider.telemetry.test.tsx`.
   - **Rationale**: A repository search shows that only these two suites currently rely on the implicit provider readiness boundary; other Shell UI tests either mock shell hooks or remain synchronous and do not need to await the provider. Keeping the helper’s usage limited to these suites keeps the migration small and avoids touching unrelated tests.
   - **Owner**: Test & Tooling Agent — **CLOSED**.
3. Should we treat “first snapshot received” as mandatory for readiness, or is `bridge.isReady && !isRestoring` sufficient?
   - **Decision**: Readiness is defined as “bridge is ready, not restoring, and the first progression snapshot has been processed”: `bridge.isReady === true`, `bridge.isRestoring === false`, and `state.runtime.progression.snapshot !== null`.
   - **Rationale**: UI components such as `packages/shell-web/src/modules/ResourceDashboard.tsx` and `packages/shell-web/src/modules/GeneratorPanel.tsx` already treat readiness as “bridge ready plus at least one snapshot,” blocking on `progression.select*()` returning data while gating their loading indicators on `!bridge.isReady || bridge.lastUpdateAt === null`. Without a first snapshot, selectors continue to return `null` even if `bridge.isReady` has flipped, so the helper must also wait for the first snapshot to keep tests aligned with real UI semantics.
   - **Owner**: Runtime/Bridge Maintainer — **CLOSED**.
4. Is there value in exposing a limited, public `useShellReady` hook for application code, or should readiness remain test-only for now?
   - **Decision**: Readiness remains a test-only concern; no public `useShellReady` hook will be added at this stage.
   - **Rationale**: Production components that care about readiness (e.g., `ResourceDashboard`, `GeneratorPanel`) already consume `useShellState()` and check `bridge.isReady` / `bridge.lastUpdateAt` directly while handling `progression` selectors that may be `null`. Introducing a dedicated hook would expand the public API surface without current production consumers or clear benefit; it can be revisited when a concrete application use case emerges.
   - **Owner**: Shell Web Maintainer — **CLOSED**.

## 14. Follow-Up Work

- Consider a broader deterministic testing strategy:
  - Example: a general “simulation tick” helper for worker-driven components.
  - **Owner**: Runtime/Bridge Maintainer — **Timing**: Post-#394.
- Audit other microtask-based test helpers across the monorepo and align them with similar contract-based patterns.
  - **Owner**: Test & Tooling Agent — **Timing**: After Shell readiness stabilises.
- Evaluate whether readiness semantics should be shared with any backend or social features (e.g., `services/social`).
  - **Owner**: Social Service Maintainer — **Timing**: As needed.

## 15. References

- `packages/shell-web/src/modules/ShellStateProvider.tsx:308` — Bridge readiness effect using `awaitReady`.
- `packages/shell-web/src/modules/ShellStateProvider.tsx:448` — Restore effect and telemetry on failure.
- `packages/shell-web/src/modules/shell-state-store.ts:103` — Initial Shell bridge state including `isReady` and `isRestoring`.
- `packages/shell-web/src/modules/shell-state-store.ts:149` — Reducer handling `bridge-ready` action.
- `packages/shell-web/src/modules/ShellStateProvider.test.tsx:80` — Existing `flushMicrotasks` helper.
- `packages/shell-web/src/modules/ShellStateProvider.telemetry.test.tsx:587` — Existing telemetry `flushMicrotasks` helper.
- `packages/shell-web/src/modules/ResourceDashboard.tsx:242` — UI loading state based on `bridge.isReady`.
- `packages/shell-web/src/modules/GeneratorPanel.tsx:124` — UI loading state based on `bridge.isReady`.
- GitHub issue `#394` — “Investigate flushMicrotasks test helper and async boundaries”.

## Appendix A — Glossary

- **Shell state readiness contract for ShellStateProvider**: The formal predicate over `ShellState` that defines when the Shell is considered initialised and stable for tests and UI (bridge ready, not restoring, snapshot received).
- **`flushMicrotasks` helper**: A test-only function that chains `Promise.resolve()` and `setTimeout(0)` calls to approximate completion of pending microtasks and macrotasks.
- **Worker bridge**: The abstraction that connects the web shell to the deterministic runtime worker, providing `awaitReady`, state updates, telemetry, and social commands.

## Appendix B — Change Log

| Date       | Author                         | Change Summary                                                   |
|------------|--------------------------------|------------------------------------------------------------------|
| 2025-11-16 | Idle Engine Design-Authoring Agent | Initial draft of deterministic Shell state readiness contract for ShellStateProvider and test migration plan (targets `Fixes #394`). |
