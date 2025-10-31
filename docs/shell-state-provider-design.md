# Implement Shell State Provider Context

Issue: #17 — Shell state provider context

## Document Control
- **Title**: Establish shell state provider and context for presentation layer
- **Authors**: Idle Engine Design Authoring Agent (AI)
- **Reviewers**: TODO (Presentation Shell Lead)
- **Status**: Approved
- **Last Updated**: 2025-10-31
- **Related Issues**: [#17](https://github.com/hansjm10/Idle-Game-Engine/issues/17)
- **Execution Mode**: AI-led

## 1. Summary
This proposal defines a `ShellStateProvider` and matching React context that centralise runtime snapshots, command dispatch, and diagnostics exposure for the presentation shell. A memoised state store wraps the existing worker bridge so every shell surface consumes deterministic engine data without duplicating glue code.

The provider formalises derived data such as event history and back-pressure analytics, exposes typed hooks for state/actions, and documents how downstream modules integrate with the shared context.

## 2. Context & Problem Statement
- **Background**: The shell currently relies on ad-hoc hooks to subscribe to runtime ticks (`packages/shell-web/src/modules/App.tsx:38`) and transform event payloads before handing them to panels like `EventInspector` (`packages/shell-web/src/modules/EventInspector.tsx:12`). The worker bridge design (`docs/runtime-react-worker-bridge-design.md:1`) documents message contracts, and the implementation plan (`docs/implementation-plan.md:105`) has long called for a dedicated context to host engine state.
- **Problem**: Components instantiate their own stores, duplicate event sorting, and risk race conditions when multiple subscribers call `restoreSession()` on `WorkerBridgeImpl` (`packages/shell-web/src/modules/worker-bridge.ts:310`). The fragmentation slows feature work, complicates telemetry, and blocks reuse across future UI surfaces.
- **Forces**: The solution must honour deterministic ordering rules from the runtime worker (`packages/shell-web/src/runtime.worker.ts:153`), stay compatible with existing analytics hooks (`packages/shell-web/src/modules/shell-analytics.ts:49`), and leave space for planned persistence features described in `docs/implementation-plan.md:60`.

## 3. Goals & Non-Goals
- **Goals**:
  - Deliver a `ShellStateProvider` that owns the worker lifecycle, session restore, and bounded event history aggregation (target 200 snapshots, configurable) for downstream consumers.
  - Expose typed hooks (`useShellState`, `useShellBridge`, `useShellDiagnostics`) that wrap worker interactions with consistent error telemetry.
  - Document the provider contract so future design work referencing the shell state provider/context stays aligned.
- **Non-Goals**:
  - Alter runtime command semantics or worker message formats (covered by `docs/runtime-react-worker-bridge-design.md:15`).
  - Ship visual redesigns or new panels; this effort only supplies shared state plumbing.
  - Implement persistence storage or offline replay (reserved for later phases in `docs/implementation-plan.md:60`).

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**:
  - Presentation Shell workstream coordinating shared UI state.
  - Runtime Core maintainers ensuring deterministic snapshots.
  - Developer Experience owners enforcing lint/test automation.
- **Agent Roles**:
  - Shell State Provider Implementation Agent — builds provider, reducer, and context exposure.
  - Shell Integration Migration Agent — replaces ad-hoc state in `App` and future modules with context consumers.
  - Observability & QA Agent — extends analytics hooks and adds Vitest coverage.
- **Affected Packages/Services**:
  - `packages/shell-web/src/modules/App.tsx`
  - `packages/shell-web/src/modules/worker-bridge.ts`
  - `packages/shell-web/src/modules/SocialDevPanel.tsx`
  - `packages/shell-web/src/modules/EventInspector.tsx`
- **Compatibility Considerations**:
  - Preserve worker schema version negotiation (`packages/shell-web/src/modules/runtime-worker-protocol.ts:7`).
  - Maintain telemetry facade guarantees for errors emitted during provider init (`packages/shell-web/src/modules/shell-analytics.ts:76`).
  - Avoid breaking tests reliant on `window.__IDLE_WORKER_BRIDGE__` debugging handles (`packages/shell-web/src/modules/worker-bridge.ts:635`).

## 5. Current State
The shell instantiates `WorkerBridgeImpl` inside `useWorkerBridge` and stores the singleton on `window` for inspection (`packages/shell-web/src/modules/worker-bridge.ts:622`). `App.tsx` manually handles session restore, state subscription, and event history management (`packages/shell-web/src/modules/App.tsx:24`), while social commands dispatch directly from `SocialDevPanel` (`packages/shell-web/src/modules/SocialDevPanel.tsx:38`). No shared context exists, forcing each component to recreate listeners and derive the same secondary data. The worker bridge spec (`docs/runtime-react-worker-bridge-design.md:18`) notes that a context was deferred pending this design.

## 6. Proposed Solution
### 6.1 Architecture Overview
Introduce a layered architecture in which a `ShellStateStore` encapsulates reducer-driven state derived from worker snapshots, a `ShellStateProvider` component owns the worker instance and subscriptions, and memoised selectors feed React contexts for state and actions. Consumers import hooks instead of touching `WorkerBridgeImpl` directly, while diagnostics and social operations remain proxied through provider-bound closures. A follow-up diagram will outline event flow through the provider.

### 6.2 Detailed Design
- **Runtime Changes**: No structural updates to the runtime worker; the provider listens to `STATE_UPDATE` envelopes already emitted (`packages/shell-web/src/runtime.worker.ts:162`). Guardrails ensure provider consumers cannot mutate runtime state directly.
- **Data & Schemas**: Define `ShellState` with fields for `runtime` (step, events, backPressure, and the latest `lastSnapshot` pointer), `bridge` (ready flags, lastUpdateAt, error queue), and `social` (pending request map plus the most recent `lastFailure` metadata). Move the `MAX_EVENT_HISTORY` constant from `App.tsx:13` into the provider with configurability via props. Type definitions live in `packages/shell-web/src/modules/shell-state.types.ts`.
- **APIs & Contracts**: Export `ShellStateProvider`, `useShellState`, `useShellBridge`, and `useShellDiagnostics`. Hooks throw descriptive errors if misused outside the provider. Session restore fires once during provider mount, respecting existing `WorkerBridge` promise semantics. Social commands resolve through provider-managed `pendingRequests` to expose optimistic UI state mirroring `packages/shell-web/src/modules/worker-bridge.ts:340`. `runtime.lastSnapshot` remains `undefined` until the first `STATE_UPDATE`, then mirrors the latest reducer snapshot so consumers can derive memoised selectors. `social.lastFailure` surfaces the last failed request and persists until a subsequent failure overwrites it, allowing telemetry to inspect the most recent error without implicitly clearing on success.
- **Tooling & Automation**: Add Vitest suites covering reducer transitions, event history bounds, and error propagation. Extend analytics tests (`packages/shell-web/src/modules/shell-analytics.test.ts`) with provider-driven telemetry assertions. Update any stories or samples to mount components under the provider.

### 6.3 Operational Considerations
- **Deployment**: No CI pipeline changes; provider ships within `@idle-engine/shell-web`. Ensure build output stays in sync with checked-in `dist/` artefacts (read-only per guidelines).
- **Telemetry & Observability**: Route provider errors to `recordTelemetryError` (`packages/shell-web/src/modules/worker-bridge.ts:280`) to keep analytics consistent. Emit structured console warnings when context usage is invalid.
- **Security & Compliance**: Maintain existing social command token handling (`packages/shell-web/src/modules/SocialDevPanel.tsx:44`). Provider must not persist tokens in global state; they remain per-component to honour auth boundaries.

## 7. Work Breakdown & Delivery Plan
### 7.1 Issue Map
| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| feat(shell-web): scaffold shell state provider | Implement provider, reducer, contexts, and initial tests. | Shell State Provider Implementation Agent | Approval of this design | Reducer unit tests pass; provider exports documented; no lint violations. |
| feat(shell-web): migrate shell modules to provider | Rewire `App`, `EventInspector`, and `SocialDevPanel` to consume the context. | Shell Integration Migration Agent | Provider scaffold issue | UI renders unchanged; manual smoke run verifies commands/events. |
| test(shell-web): expand diagnostics & telemetry coverage | Add Vitest suites and telemetry assertions to validate provider instrumentation. | Observability & QA Agent | Provider scaffold issue | Vitest suites stable; reporter JSON preserved; analytics warnings verified. |

### 7.2 Milestones
- **Phase 1**: Provider scaffolding approved → PR merged → unit tests green (target two working days).
- **Phase 2**: Consumer migration and diagnostics coverage complete → accessibility smoke test run (`pnpm test:a11y`) without regression (target next two working days).

### 7.3 Coordination Notes
- **Hand-off Package**: Share this design, the worker bridge spec (`docs/runtime-react-worker-bridge-design.md:1`), and relevant code pointers (`packages/shell-web/src/modules/worker-bridge.ts:622`, `packages/shell-web/src/modules/App.tsx:15`).
- **Communication Cadence**: Daily async updates in the Presentation Shell channel; design checkpoints at provider PR open/merge; escalate blockers to the Presentation Shell Lead.

## 8. Agent Guidance & Guardrails
- **Context Packets**: Agents must review this design, `docs/runtime-react-worker-bridge-design.md:15`, and `docs/resource-state-storage-design.md:1` before coding.
- **Prompting & Constraints**: Use the canonical prompt “Implement ShellStateProvider per Issue #17; follow repo lint/test scripts.” Enforce conventional commits (`feat(shell-web): …`).
- **Safety Rails**: Do not modify `dist/` artefacts; avoid destructive git commands; keep telemetry facade intact; respect `MAX_EVENT_HISTORY` configurability.
- **Validation Hooks**: Run `pnpm lint`, `pnpm test --filter shell-web`, and `pnpm test:a11y` before completion; ensure the Vitest reporter JSON remains unmodified.

## 9. Alternatives Considered
- **Status Quo per-component state**: Rejected due to duplicated logic, inconsistent event ordering, and harder persistence integration.
- **External state manager (Redux/Zustand)**: Adds dependencies and complicates deterministic replay; provider pattern keeps footprint minimal.
- **Worker-driven push to global store**: Would bypass React lifecycle, risking stale renders and race conditions; context ensures controlled updates.

## 10. Testing & Validation Plan
- **Unit / Integration**: Add reducer tests in `packages/shell-web/src/modules/__tests__/shell-state-provider.test.ts`; component integration test mounting `App` under the provider verifies event rendering.
- **Performance**: Measure provider update latency by logging reducer timing in development; ensure no additional allocations beyond existing `MAX_EVENT_HISTORY`.
- **Tooling / A11y**: Re-run `pnpm test:a11y` after migration to confirm provider does not disrupt Playwright smoke flows (`docs/accessibility-smoke-tests-design.md:4`).

## 11. Risks & Mitigations
- **Risk**: Provider re-renders too frequently, impacting performance. **Mitigation**: Split state and action contexts; memoise selectors; add React DevTools profiling.
- **Risk**: Social commands leak tokens. **Mitigation**: Keep access tokens in local component state; provider only handles request lifecycle metadata.
- **Risk**: Diagnostics subscriptions conflict. **Mitigation**: Reference-count diagnostics listeners and fall back to noop when zero subscribers remain.

## 12. Rollout Plan
- **Milestones**: Provider PR merged → consumer migration PR → QA validation.
- **Migration Strategy**: Ship provider behind a feature flag prop if needed; migrate `App` first, then opt in additional panels; remove old state hooks once parity is confirmed.
- **Communication**: Post release notes in the Presentation Shell changelog; reference this design and Issue #17 in PR descriptions.

## 13. Resolved Questions
- **Event history retention**: Presentation Shell confirmed the provider keeps a rotating window of runtime events with a default cap of 200 entries (matching `DEFAULT_MAX_EVENT_HISTORY`). Consumers can override `maxEventHistory` when mounting the provider; eviction remains FIFO to bound memory. Telemetry should log capacity hits so the persistence workstream can validate truncation behaviour.
- **Future persistence payloads**: Runtime Core agreed the provider contract exposes restore payloads via the existing `restoreSession` API and will support optional persistence hooks in a follow-up (`registerPersistenceHook`/`unregisterPersistenceHook` slated for the persistence milestone roadmap). This keeps the reducer state immutable today while leaving space for IndexedDB/cloud checkpoints during the persistence milestone.
- **Debug handle strategy**: DX signed off on keeping `window.__IDLE_WORKER_BRIDGE__` behind development-only guards. Builds strip the handle in production, with an explicit `__ENABLE_IDLE_DEBUG__` opt-in for staging diagnostics. Documentation now highlights the guardrails so automated tests relying on the handle remain unaffected.

## 14. Follow-Up Work
- Schedule persistence integration design to extend the provider with save/load channels.
- Publish and maintain the [Shell State Provider Integration Guide](shell-state-provider-guide.md) so new contributors understand provider usage.
- Plan future localisation-aware selectors once UI strings are externalised.

## 15. References
- `packages/shell-web/src/modules/App.tsx:15`
- `packages/shell-web/src/modules/EventInspector.tsx:12`
- `packages/shell-web/src/modules/SocialDevPanel.tsx:38`
- `packages/shell-web/src/modules/worker-bridge.ts:622`
- `packages/shell-web/src/runtime.worker.ts:153`
- `packages/shell-web/src/modules/runtime-worker-protocol.ts:24`
- `packages/core/src/events/event-bus.ts:166`
- `docs/runtime-react-worker-bridge-design.md:1`
- `docs/implementation-plan.md:105`
- `docs/accessibility-smoke-tests-design.md:4`

## Appendix A — Glossary
- **ShellStateProvider**: React component delivering runtime context outlined in this design.
- **ShellState**: Aggregated snapshot data structure supplied by the provider.
- **WorkerBridge**: Abstraction around the runtime worker enabling command/state exchange.
- **Back Pressure Snapshot**: Runtime event buffer metrics defined in `packages/core/src/events/event-bus.ts:166`.

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2025-10-30 | Idle Engine Design Authoring Agent (AI) | Initial draft. |
| 2025-10-30 | Idle Engine Editorial Agent (AI) | Removed directive filler and clarified context. |
