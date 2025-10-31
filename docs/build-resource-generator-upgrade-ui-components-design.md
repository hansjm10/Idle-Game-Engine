# Build Resource/Generator/Upgrade UI Components

## Document Control
- **Title**: Build resource/generator/upgrade UI components
- **Authors**: Idle Engine Design-Authoring Agent (Autonomous Delivery)
- **Reviewers**: TODO (Shell UX Maintainer); TODO (Runtime Core Maintainer)
- **Status**: Draft
- **Last Updated**: 2025-10-31
- **Related Issues**: Idle-Game-Engine#18
- **Execution Mode**: AI-led

## 1. Summary
The Build resource/generator/upgrade UI components initiative replaces the placeholder shell with production-ready progression surfaces by extending worker snapshots, surfacing generator and upgrade contracts, and composing accessible React components that dispatch deterministic commands, enabling players and AI automation to interact with the Idle Engine loop end to end.

## 2. Context & Problem Statement
- **Background**: The current shell renders only runtime ticks and diagnostics (`packages/shell-web/src/modules/App.tsx:32`) while core systems already model resources and generator purchases (`packages/core/src/resource-command-handlers.ts:54`) and sample packs describe generators/resources (`packages/content-sample/src/generated/@idle-engine/sample-pack.generated.ts:90`); existing design guidance mandates default UI kits for resources and upgrades (`docs/idle-engine-design.md:178`).
- **Problem**: There is no way to visualise or interact with resources, generators, or upgrades in the shell, blocking Build resource/generator/upgrade UI components progress and contradicting Presentation Phase goals (`docs/implementation-plan.md:56`); `ShellRuntimeState` omits resource payloads (`packages/shell-web/src/modules/shell-state.types.ts:16`) and the worker protocol publishes no progression detail (`packages/shell-web/src/modules/runtime-worker-protocol.ts:24`).
- **Forces**: Build resource/generator/upgrade UI components must preserve deterministic worker messaging (`docs/runtime-command-queue-design.md:1034`), obey worker-bridge safety rails (`docs/runtime-react-worker-bridge-design.md:160`), remain accessible for upcoming smoke tests (`docs/accessibility-smoke-tests-design.md:57`), and align with AI board workflows (`docs/project-board-workflow.md:21`).

## 3. Goals & Non-Goals
- **Goals**: Deliver worker snapshots and shell view-models for Build resource/generator/upgrade UI components; render accessible resource dashboards, generator lists, and upgrade modals; enable command dispatch (`PURCHASE_GENERATOR`, planned upgrade purchase) with optimistic feedback; instrument telemetry for AI observability.
- **Non-Goals**: Building social or guild UI (tracked separately); overhauling core economics or content schema; shipping art direction beyond utilitarian layout for Build resource/generator/upgrade UI components.

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**: Presentation Shell maintainers; Runtime Core systems leads; Content authoring team enabling Build resource/generator/upgrade UI components.
- **Agent Roles**: Design Authoring Agent (this document) sets guardrails; Runtime Protocol Agent updates worker payloads; Shell UI Implementation Agent builds components; QA & A11y Agent validates Build resource/generator/upgrade UI components flows.
- **Affected Packages/Services**: `packages/core`; `packages/shell-web`; `packages/content-sample`; `docs/`.
- **Compatibility Considerations**: Bump `WORKER_MESSAGE_SCHEMA_VERSION` (`packages/shell-web/src/modules/runtime-worker-protocol.ts:7`) with backward opt-out; maintain command contracts from `docs/runtime-command-queue-design.md:1034`; ensure serialized saves remain forward-compatible.

## 5. Current State
- Shell shows only tick count and event inspector (`packages/shell-web/src/modules/App.tsx:32`), blocking Build resource/generator/upgrade UI components UI usage.
- `ShellState` lacks resource/generator fields (`packages/shell-web/src/modules/shell-state.types.ts:16`), so hooks cannot consume progression data.
- Worker bridge proxies state and commands but serializes only events and backpressure (`packages/shell-web/src/modules/worker-bridge.ts:672`).
- Runtime exposes generator purchase handlers without UI integration (`packages/core/src/resource-command-handlers.ts:54`).
- Sample content already defines resources/generators for Build resource/generator/upgrade UI components to visualise (`packages/content-sample/src/generated/@idle-engine/sample-pack.generated.ts:90`).
- Project plan requires rendering resource panels and upgrade modals in this phase (`docs/implementation-plan.md:56`).

## 6. Proposed Solution

### 6.1 Architecture Overview
- **Narrative**: Extend runtime snapshots with a consolidated `progressionView` (resources, generators, upgrades) inside the worker; `ShellStateProvider` consumes this snapshot, derives memoized view-models, and hands them to new React components that drive Build resource/generator/upgrade UI components while dispatching commands back through the existing bridge.
- **Diagram**:
  ```
  +---------------------------+        +-----------------------------+
  | React Shell Components    |        | Worker Runtime              |
  | - ResourceDashboard       |<------>| - ProgressionSnapshot pump  |
  | - GeneratorPanel          |        | - Command handlers          |
  | - UpgradeModal            |------->| - Purchase/upgrade evaluators|
  +---------------------------+        +-----------------------------+
             ^                                         |
             | telemetry + tests                       v
  +---------------------------+        +-----------------------------+
  | AI Validation Pipelines   |        | Content Sample Extensions   |
  +---------------------------+        +-----------------------------+
  ```

### 6.2 Detailed Design
- **Runtime Changes**: Extend `RuntimeStatePayload` with frozen resource/generator/upgrade arrays derived from `SerializedResourceState` and generator indices inside the worker; add upgrade ownership scaffolding (TODO owner: Runtime Protocol Agent) while keeping Build resource/generator/upgrade UI components data deterministic and double-buffered.
- **Data & Schemas**: Introduce `ProgressionSnapshot` TypeScript types exported from `@idle-engine/core` for Build resource/generator/upgrade UI components; align generator cost curves with sample pack schema (`packages/content-sample/src/generated/@idle-engine/sample-pack.generated.ts:114`) and reserve upgrade schema wiring as TODO (Content Systems owner).
- **APIs & Contracts**: Add `PURCHASE_UPGRADE` command type (TODO owner: Runtime Protocol Agent) mirroring `PurchaseGeneratorPayload` (`packages/core/src/command.ts:121`); expose read-only view helpers on the shell bridge for Build resource/generator/upgrade UI components; guarantee schema version negotiation.
- **Tooling & Automation**: Update Vitest suites for worker and shell modules (`packages/shell-web/src/modules/runtime.worker.test.ts`) to assert new payloads; add component unit tests for Build resource/generator/upgrade UI components using React Testing Library; ensure `pnpm test --filter shell-web` remains primary validation (`docs/runtime-react-worker-bridge-design.md:164`).

### 6.3 Operational Considerations
- **Deployment**: Roll out under `VITE_ENABLE_PROGRESSION_UI` flag defaulting to false until Build resource/generator/upgrade UI components tests pass in CI, then enable for dev and production sequentially.
- **Telemetry & Observability**: Emit shell analytics events through existing facade (`packages/shell-web/src/modules/shell-analytics.ts:1`) for resource purchases and upgrade actions; gauge adoption via weekly reports.
- **Security & Compliance**: Ensure no PII in snapshots; honour command authorization policies during Build resource/generator/upgrade UI components interactions; maintain worker isolation per security guidelines.

## 7. Work Breakdown & Delivery Plan

### 7.1 Issue Map
| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| feat(core): emit progression snapshot | Add `ProgressionSnapshot` export, worker serialization, schema bump for Build resource/generator/upgrade UI components | Runtime Protocol Agent | Telemetry scaffolding ready | Vitest worker-suite validates snapshot; schema version doc updated |
| feat(shell-web): integrate progression state | Extend `ShellStateProvider`, selectors, context for Build resource/generator/upgrade UI components | Shell UI Implementation Agent | Progression snapshot merged | Shell hook tests prove memoization; bridge still passes diagnostics tests |
| feat(shell-web): resource dashboard UI | Render resource list with capacities, rates, accessibility hooks | Shell UI Implementation Agent | Progression hook available | Component tests cover locked/unlocked states; passes `pnpm test --filter shell-web` |
| feat(shell-web): generator & upgrade interactions | Create generator cards, command dispatch, upgrade modal | Interaction QA Agent | Dashboard UI merged | Commands fire with optimistic updates; telemetry events asserted in tests |
| docs/content-sample: enrich progression data | Backfill generators, upgrades, localization for Build resource/generator/upgrade UI components showcase | Content Data Agent | Progression snapshot contract final | Content tests regenerate artifacts; docs note new content |

### 7.2 Milestones
- **Phase 1**: Finalize progression snapshot contract, raise schema version, land worker tests; exit when Build resource/generator/upgrade UI components data flows to shell.
- **Phase 2**: Ship resource dashboard and generator cards behind feature flag; exit when manual smoke confirms deterministic updates.
- **Phase 3**: Enable upgrade modal, telemetry, and accessibility validation; exit when Playwright smoke runs clean.

### 7.3 Coordination Notes
- **Hand-off Package**: Provide agents with snapshot type definitions, sample content diffs, and schema bump notes for Build resource/generator/upgrade UI components.
- **Communication Cadence**: Daily async status updates via project board comments; formal review checkpoints at milestone boundaries; escalate blockers through Issue #18 thread.

## 8. Agent Guidance & Guardrails
- **Context Packets**: Agents must preload `docs/idle-engine-design.md`, `docs/runtime-command-queue-design.md`, and relevant source files before acting on Build resource/generator/upgrade UI components.
- **Prompting & Constraints**: Use command templates referencing `bridge.sendCommand` patterns; follow naming conventions and commit style while focusing on Build resource/generator/upgrade UI components.
- **Safety Rails**: Do not bypass worker bridge isolation (`docs/runtime-react-worker-bridge-design.md:160`); avoid mutating serialized state; keep feature flag default off until acceptance suite passes.
- **Validation Hooks**: Run `pnpm lint`, `pnpm test --filter shell-web`, and `pnpm test:a11y` after UI modifications; document outputs in issue comments.

## 9. Alternatives Considered
- Rely on ad hoc shell-side calculations without worker updates: rejected because it diverges from determinism and cannot reflect authoritative generator costs for Build resource/generator/upgrade UI components.
- Build a separate standalone UI prototype: rejected as it duplicates bridge logic and violates deployment plan tied to `packages/shell-web`.

## 10. Testing & Validation Plan
- **Unit / Integration**: Expand worker serialization tests and React component snapshots; ensure Build resource/generator/upgrade UI components hooks handle locked/unlocked transitions.
- **Performance**: Profile resource list rendering with 100+ nodes; ensure updates stay below 16 ms using memoization.
- **Tooling / A11y**: Re-run Playwright smoke once Build resource/generator/upgrade UI components ship (`docs/accessibility-smoke-tests-design.md:57`); add axe assertions for modal focus traps.

## 11. Risks & Mitigations
- Schema drift between worker and shell for Build resource/generator/upgrade UI components; mitigate via shared types and compile-time checks.
- Feature flag left disabled in production leading to dead code; mitigate by tracking rollout issue and gating removal in Follow-Up Work.
- Upgrade economics missing until content team supplies data; mitigate via TODO owner assignment and stub entries flagged in Open Questions.

## 12. Rollout Plan
- **Milestones**: Enable flag in `dev` after Phase 2; promote to `main` once tests pass; remove flag after two stable releases.
- **Migration Strategy**: Maintain fallback to old shell layout by gating new components; provide migration doc for any third-party shells.
- **Communication**: Announce Build resource/generator/upgrade UI components availability in weekly status reports; update onboarding documentation post-rollout.

## 13. Open Questions
- TODO (Content Systems): Confirm upgrade catalog and unlock sequencing for Build resource/generator/upgrade UI components.
- TODO (UX Lead): Provide visual hierarchy guidelines and iconography requirements.
- TODO (Runtime Protocol Agent): Decide on upgrade purchase command semantics and refund behaviour.

## 14. Follow-Up Work
- Document automation toggles and prestige integration once Build resource/generator/upgrade UI components stabilize.
- Evaluate persistence integration so progression state survives reloads.
- Plan tutorial overlays leveraging new UI surfaces.

## 15. References
- `packages/shell-web/src/modules/App.tsx:32`
- `packages/shell-web/src/modules/shell-state.types.ts:16`
- `packages/shell-web/src/modules/runtime-worker-protocol.ts:24`
- `packages/core/src/resource-command-handlers.ts:54`
- `packages/content-sample/src/generated/@idle-engine/sample-pack.generated.ts:90`
- `docs/idle-engine-design.md:175`
- `docs/implementation-plan.md:56`
- `docs/runtime-command-queue-design.md:1034`
- `docs/runtime-react-worker-bridge-design.md:160`
- `docs/accessibility-smoke-tests-design.md:57`
- `docs/project-board-workflow.md:21`

## Appendix A — Glossary
- **Build resource/generator/upgrade UI components**: The initiative delivering resource dashboards, generator cards, and upgrade modals in the shell.
- **Progression Snapshot**: Worker-emitted frozen structure capturing resources, generators, and upgrades for rendering.
- **ResourceDashboard**: Proposed React component summarizing resource amounts, capacities, and rates.
- **GeneratorPanel**: Component listing generators, ownership counts, and purchase actions.
- **UpgradeModal**: Overlay presenting upgrade catalog entries with purchase controls and dependencies.

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2025-10-31 | Idle Engine Design-Authoring Agent | Initial draft for Build resource/generator/upgrade UI components |
