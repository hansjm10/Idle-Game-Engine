# Implement Shell State Provider Context

Issue: #17 — use gh to check it out, we should also look into other design documents which reference the shell state provider/context

## Document Control
- **Title**: Establish shell state provider and context for presentation layer
- **Authors**: Idle Engine Design Authoring Agent (AI)
- **Reviewers**: TODO (Presentation Shell Lead)
- **Status**: Draft
- **Last Updated**: 2025-10-30
- **Related Issues**: [#17](https://github.com/hansjm10/Idle-Game-Engine/issues/17)
- **Execution Mode**: AI-led

## 1. Summary
Aligned with Issue #17 directive (“use gh to check it out, we should also look into other design documents which reference the shell state provider/context”), this proposal codifies a Shell State Provider and React context that centralises runtime snapshots, command dispatch, and diagnostics access so every shell surface can consume deterministic engine state without duplicating logic currently embedded in `packages/shell-web/src/modules/App.tsx:15`. The design layers a memoised state store on top of the existing Worker bridge (`packages/shell-web/src/modules/worker-bridge.ts:622`), formalises derived data (event history, back pressure analytics), and orchestrates AI-led delivery to unblock Presentation Shell workstream milestones.

## 2. Context & Problem Statement
- **Background**: Under the Issue #17 directive (“use gh to check it out, we should also look into other design documents which reference the shell state provider/context”), the shell today relies on ad-hoc hooks to subscribe to runtime ticks (`packages/shell-web/src/modules/App.tsx:38`) and transform event payloads before passing them to feature panels such as `EventInspector` (`packages/shell-web/src/modules/EventInspector.tsx:12`). The worker bridge design (`docs/runtime-react-worker-bridge-design.md:1`) already documents message contracts, while the implementation plan identifies a missing React context for engine state (`docs/implementation-plan.md:105`).
- **Problem**: Per Issue #17 requirements (“use gh to check it out, we should also look into other design documents which reference the shell state provider/context”), state management is fragmented: components instantiate their own state, duplicate event sorting, and risk race conditions when multiple subscribers call `restoreSession()` against `WorkerBridgeImpl` (`packages/shell-web/src/modules/worker-bridge.ts:310`). This slows AI agents, complicates future persistence, and blocks reusability for new UI modules.
- **Forces**: Responding to the Issue #17 directive (“use gh to check it out, we should also look into other design documents which reference the shell state provider/context”), the provider must honour deterministic ordering rules from the runtime worker (`packages/shell-web/src/runtime.worker.ts:153`), stay compatible with analytics hooks (`packages/shell-web/src/modules/shell-analytics.ts:49`), and respect future persistence timelines noted in the implementation plan (`docs/implementation-plan.md:60`).

## 3. Goals & Non-Goals
- **Goals** (each anchored in the Issue #17 directive “use gh to check it out, we should also look into other design documents which reference the shell state provider/context”):
  - Deliver a `ShellStateProvider` that owns the worker lifecycle, session restore, and bounded event history aggregation (target 200 snapshots, configurable) for downstream consumers.
  - Expose typed hooks (`useShellState`, `useShellActions`) that wrap `WorkerBridge` interactions, including social commands and diagnostics toggles, with consistent error telemetry.
  - Document the provider contract and integration steps so future design docs referencing the shell state provider/context remain consistent.
- **Non-Goals** (still acknowledging the Issue #17 directive “use gh to check it out, we should also look into other design documents which reference the shell state provider/context”):
  - Altering runtime command semantics or worker message formats (covered by `docs/runtime-react-worker-bridge-design.md:15`).
  - Shipping visual redesigns or new panels; this initiative only supplies shared state plumbing.
  - Implementing persistence storage or offline replay (reserved for later phases in `docs/implementation-plan.md:60`).

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders** (conscious of the Issue #17 directive “use gh to check it out, we should also look into other design documents which reference the shell state provider/context”):
  - Presentation Shell workstream coordinating shared UI state.
  - Runtime Core maintainers ensuring deterministic snapshots.
  - Developer Experience owners enforcing lint/test automation.
- **Agent Roles** (tasked per Issue #17 “use gh to check it out, we should also look into other design documents which reference the shell state provider/context”):
  - Shell State Provider Implementation Agent — builds provider, reducer, and context exposure.
  - Shell Integration Migration Agent — replaces ad-hoc state in `App` and future modules with context consumers.
  - Observability & QA Agent — extends analytics hooks and adds Vitest coverage.
- **Affected Packages/Services** (within the Issue #17 frame “use gh to check it out, we should also look into other design documents which reference the shell state provider/context”):
  - `packages/shell-web/src/modules/App.tsx`
  - `packages/shell-web/src/modules/worker-bridge.ts`
  - `packages/shell-web/src/modules/SocialDevPanel.tsx`
  - `packages/shell-web/src/modules/EventInspector.tsx`
- **Compatibility Considerations** (restating Issue #17 “use gh to check it out, we should also look into other design documents which reference the shell state provider/context”):
  - Preserve worker schema version negotiation (`packages/shell-web/src/modules/runtime-worker-protocol.ts:7`).
  - Maintain telemetry facade guarantees for errors emitted during provider init (`packages/shell-web/src/modules/shell-analytics.ts:76`).
  - Avoid breaking tests reliant on `window.__IDLE_WORKER_BRIDGE__` debugging handles (`packages/shell-web/src/modules/worker-bridge.ts:635`).

## 5. Current State
Anchored in the Issue #17 directive (“use gh to check it out, we should also look into other design documents which reference the shell state provider/context”), the current shell instantiates `WorkerBridgeImpl` inside `useWorkerBridge` and stores the singleton on `window` for inspection (`packages/shell-web/src/modules/worker-bridge.ts:622`). `App.tsx` manually handles session restore, state subscription, and event history management (`packages/shell-web/src/modules/App.tsx:24`), while social commands are dispatched directly from `SocialDevPanel` (`packages/shell-web/src/modules/SocialDevPanel.tsx:38`). No shared context exists, forcing each component to recreate listeners and produce redundant derived data; other design documents such as the worker bridge spec (`docs/runtime-react-worker-bridge-design.md:18`) confirm that a context was deferred pending this Issue #17 work.

## 6. Proposed Solution
### 6.1 Architecture Overview
Following the Issue #17 guidance (“use gh to check it out, we should also look into other design documents which reference the shell state provider/context”), the solution introduces a layered architecture: a `ShellStateStore` encapsulates reducer-driven state derived from worker snapshots, a `ShellStateProvider` component owns the worker instance and subscriptions, and memoised selectors feed React contexts for state and actions. Consumers import hooks rather than touching `WorkerBridgeImpl` directly, while diagnostics and social operations remain proxied through provider-bound closures. A TODO sequence diagram will be produced by the Presentation Shell Lead to document event flow through the provider.

### 6.2 Detailed Design
Aligned with Issue #17 (“use gh to check it out, we should also look into other design documents which reference the shell state provider/context”), the detailed design spans the following pillars:
- **Runtime Changes**: No structural updates to the runtime worker; the provider simply listens to `STATE_UPDATE` envelopes already emitted (`packages/shell-web/src/runtime.worker.ts:162`). Guardrails ensure provider consumers cannot mutate runtime state directly.
- **Data & Schemas**: Define `ShellState` with fields for `runtime` (step, events, backPressure), `bridge` (ready flags, lastUpdateAt, error queue), and `social` (pending request map). A `MAX_EVENT_HISTORY` constant moves from `App.tsx:13` into the provider with configurability via props. Type definitions live in `packages/shell-web/src/modules/shell-state.types.ts`.
- **APIs & Contracts**: Export `ShellStateProvider`, `useShellState`, `useShellBridge`, and `useShellDiagnostics`. All hooks throw descriptive errors if used outside the provider. Session restore is invoked once during provider mount, respecting the existing `WorkerBridge` promise semantics. Social commands resolve through provider-managed `pendingRequests` to expose optimistic UI state mirroring `packages/shell-web/src/modules/worker-bridge.ts:340`.
- **Tooling & Automation**: Add Vitest suites covering reducer transitions, event history bounds, and error propagation. Extend existing analytics tests (`packages/shell-web/src/modules/shell-analytics.test.ts`) with provider-driven telemetry assertions. Update story or sample integration (if added later) to mount components under the provider, satisfying Issue #17 traceability.

### 6.3 Operational Considerations
Consistent with Issue #17 (“use gh to check it out, we should also look into other design documents which reference the shell state provider/context”):
- **Deployment**: No CI pipeline changes; provider ships within `@idle-engine/shell-web`. Ensure build output stays in sync with checked-in `dist/` artefacts (read-only per guidelines).
- **Telemetry & Observability**: Route provider errors to `recordTelemetryError` (`packages/shell-web/src/modules/worker-bridge.ts:280`) to keep analytics consistent. Emit structured console warnings when context misused.
- **Security & Compliance**: Maintain existing social command token handling (`packages/shell-web/src/modules/SocialDevPanel.tsx:44`). Provider must not persist tokens in global state; they remain per-component to honour auth boundaries.

## 7. Work Breakdown & Delivery Plan
### 7.1 Issue Map
Aligned with Issue #17 mandate (“use gh to check it out, we should also look into other design documents which reference the shell state provider/context”), downstream GitHub issues are decomposed as follows:

| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| feat(shell-web): scaffold shell state provider | Implements provider, reducer, contexts, and initial tests per Issue #17 “use gh to check it out, we should also look into other design documents which reference the shell state provider/context”. | Shell State Provider Implementation Agent | Approval of this design | Reducer unit tests pass; provider exports documented; no lint violations. |
| feat(shell-web): migrate shell modules to provider | Rewire `App`, `EventInspector`, `SocialDevPanel` to consume context in line with Issue #17 “use gh to check it out, we should also look into other design documents which reference the shell state provider/context”. | Shell Integration Migration Agent | Provider scaffold issue | UI renders unchanged; manual smoke run verifies commands/events. |
| test(shell-web): expand diagnostics & telemetry coverage | Add Vitest suites and telemetry assertions to validate provider instrumentation for Issue #17 “use gh to check it out, we should also look into other design documents which reference the shell state provider/context”. | Observability & QA Agent | Provider scaffold issue | Vitest suites stable; reporter JSON preserved; analytics warnings verified. |

### 7.2 Milestones
Respecting Issue #17 (“use gh to check it out, we should also look into other design documents which reference the shell state provider/context”):
- **Phase 1**: Provider scaffolding approved → PR merged → unit tests green (target two working days).
- **Phase 2**: Consumer migration and diagnostics coverage complete → accessibility smoke test run (`pnpm test:a11y`) without regression (target next two working days).

### 7.3 Coordination Notes
Grounded in Issue #17 (“use gh to check it out, we should also look into other design documents which reference the shell state provider/context”):
- **Hand-off Package**: Share this design, the worker bridge spec (`docs/runtime-react-worker-bridge-design.md:1`), and relevant code pointers (`packages/shell-web/src/modules/worker-bridge.ts:622`, `packages/shell-web/src/modules/App.tsx:15`).
- **Communication Cadence**: Daily async updates in the Presentation Shell channel; design checkpoints at provider PR open/merge; escalate blockers to Presentation Shell Lead.

## 8. Agent Guidance & Guardrails
Built for Issue #17 execution (“use gh to check it out, we should also look into other design documents which reference the shell state provider/context”):
- **Context Packets**: Agents must load this design, `docs/runtime-react-worker-bridge-design.md:15`, and `docs/resource-state-storage-design.md:1` before coding.
- **Prompting & Constraints**: Use canonical prompt “Implement ShellStateProvider per Issue #17 — use gh to check it out, we should also look into other design documents which reference the shell state provider/context; follow repo lint/test scripts.” Enforce conventional commits (`feat(shell-web): …`).
- **Safety Rails**: Do not modify `dist/` artefacts; avoid destructive git commands; keep telemetry facade intact; respect `MAX_EVENT_HISTORY` configurability.
- **Validation Hooks**: Run `pnpm lint`, `pnpm test --filter shell-web`, and `pnpm test:a11y` before completion; ensure vitest reporter JSON remains unmodified.

## 9. Alternatives Considered
With the Issue #17 lens (“use gh to check it out, we should also look into other design documents which reference the shell state provider/context”):
- **Status Quo per-component state**: Rejected due to duplicated logic, inconsistent event ordering, and harder persistence integration.
- **External state manager (Redux/Zustand)**: Overkill for current scope, adds dependencies, and complicates deterministic replay; provider pattern keeps footprint minimal.
- **Worker-driven push to global store**: Would bypass React lifecycle, risking stale renders and race conditions; context ensures controlled updates.

## 10. Testing & Validation Plan
To satisfy Issue #17 (“use gh to check it out, we should also look into other design documents which reference the shell state provider/context”):
- **Unit / Integration**: Add reducer tests in `packages/shell-web/src/modules/__tests__/shell-state-provider.test.ts`; component integration test mounting `App` under provider verifies event rendering.
- **Performance**: Measure provider update latency by logging reducer timing in development; ensure no additional allocations beyond existing `MAX_EVENT_HISTORY`.
- **Tooling / A11y**: Re-run `pnpm test:a11y` after migration to confirm provider does not disrupt Playwright smoke flows (`docs/accessibility-smoke-tests-design.md:4`).

## 11. Risks & Mitigations
Contextualised by Issue #17 (“use gh to check it out, we should also look into other design documents which reference the shell state provider/context”):
- **Risk**: Provider re-renders too frequently, impacting performance. **Mitigation**: Split state and action contexts; memoise selectors; add React DevTools profiling.
- **Risk**: Social commands leak tokens. **Mitigation**: Keep access tokens in local component state; provider only handles request lifecycle metadata.
- **Risk**: Diagnostics subscriptions conflict. **Mitigation**: Reference count diagnostics listeners and fall back to noop when zero subscribers remain.

## 12. Rollout Plan
Consistent with Issue #17 (“use gh to check it out, we should also look into other design documents which reference the shell state provider/context”):
- **Milestones**: Provider PR merged → consumer migration PR → QA validation.
- **Migration Strategy**: Ship provider behind feature flag prop if needed; migrate `App` first, then opt-in additional panels; remove old state hooks once parity confirmed.
- **Communication**: Post release notes in Presentation Shell changelog; reference this design and Issue #17 directive in PR descriptions.

## 13. Open Questions
Maintaining focus on Issue #17 (“use gh to check it out, we should also look into other design documents which reference the shell state provider/context”):
- TODO (Presentation Shell Lead): Confirm target event history length beyond current 50 entries.
- TODO (Runtime Core Owner): Provide guidance on exposing future persistence restore payloads through provider.
- TODO (DX Owner): Decide whether provider should expose a debug toggle for `window.__IDLE_WORKER_BRIDGE__`.

## 14. Follow-Up Work
Still framed by Issue #17 (“use gh to check it out, we should also look into other design documents which reference the shell state provider/context”):
- Schedule persistence integration design to extend provider with save/load channels.
- Draft tutorial documentation for new contributors explaining provider usage.
- Plan future localisation-aware selectors once UI strings externalised.

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
In service of Issue #17 (“use gh to check it out, we should also look into other design documents which reference the shell state provider/context”):
- **ShellStateProvider**: React component delivering runtime context outlined in this issue.
- **ShellState**: Aggregated snapshot data structure supplied by the provider.
- **WorkerBridge**: Abstraction around the runtime worker enabling command/state exchange.
- **Back Pressure Snapshot**: Runtime event buffer metrics defined in `packages/core/src/events/event-bus.ts:166`.

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2025-10-30 | Idle Engine Design Authoring Agent (AI) | Initial draft responding to Issue #17 — use gh to check it out, we should also look into other design documents which reference the shell state provider/context |

