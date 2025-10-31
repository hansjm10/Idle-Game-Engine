# Build Resource/Generator/Upgrade UI Components

## Document Control
- **Title**: Build resource/generator/upgrade UI components
- **Authors**: Idle Engine Design-Authoring Agent (Autonomous Delivery)
- **Reviewers**: Shell UX Maintainers (Presentation Shell Workstream); Runtime Core Maintainers
- **Status**: Draft
- **Last Updated**: 2025-10-31
- **Related Issues**: Idle-Game-Engine#18
- **Execution Mode**: AI-led

## 1. Summary
The progression UI initiative replaces the placeholder shell with production-ready progression surfaces by extending worker snapshots, surfacing generator and upgrade contracts, and composing accessible React components that dispatch deterministic commands, enabling players and AI automation to interact with the Idle Engine loop end to end.

## 2. Context & Problem Statement
- **Background**: The current shell renders only runtime ticks and diagnostics (`packages/shell-web/src/modules/App.tsx:32`) while core systems already model resources and generator purchases (`packages/core/src/resource-command-handlers.ts:54`) and sample packs describe generators/resources (`packages/content-sample/src/generated/@idle-engine/sample-pack.generated.ts:90`); existing design guidance mandates default UI kits for resources and upgrades (`docs/idle-engine-design.md:178`).
- **Problem**: There is no way to visualise or interact with resources, generators, or upgrades in the shell, blocking the progression UI milestone and contradicting Presentation Phase goals (`docs/implementation-plan.md:56`); `ShellRuntimeState` omits resource payloads (`packages/shell-web/src/modules/shell-state.types.ts:16`) and the worker protocol publishes no progression detail (`packages/shell-web/src/modules/runtime-worker-protocol.ts:24`).
- **Forces**: Progression UI work must preserve deterministic worker messaging (`docs/runtime-command-queue-design.md:1034`), obey worker-bridge safety rails (`docs/runtime-react-worker-bridge-design.md:160`), remain accessible for upcoming smoke tests (`docs/accessibility-smoke-tests-design.md:57`), and align with AI board workflows (`docs/project-board-workflow.md:21`).

## 3. Goals & Non-Goals
- **Goals**: Deliver worker snapshots and shell view-models for the progression UI; render accessible resource dashboards, generator lists, and upgrade modals; enable command dispatch (`PURCHASE_GENERATOR`, planned upgrade purchase) with optimistic feedback; instrument telemetry for AI observability.
- **Non-Goals**: Building social or guild UI (tracked separately); overhauling core economics or content schema; shipping art direction beyond utilitarian layout for this progression UI milestone.

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**: Presentation Shell maintainers; Runtime Core systems leads; Content authoring team enabling the progression UI.
- **Agent Roles**: Design Authoring Agent (this document) sets guardrails; Runtime Protocol Agent updates worker payloads; Shell UI Implementation Agent builds components; Progression QA & A11y Agent validates progression UI flows.
- **Affected Packages/Services**: `packages/core`; `packages/shell-web`; `packages/content-sample`; `docs/`.
- **Compatibility Considerations**: Bump `WORKER_MESSAGE_SCHEMA_VERSION` (`packages/shell-web/src/modules/runtime-worker-protocol.ts:7`) with backward opt-out; rely on the `SCHEMA_VERSION_MISMATCH` guard in `packages/shell-web/src/runtime.worker.ts:818` and the bridge-side filter (`packages/shell-web/src/modules/worker-bridge.ts:223`) to block incompatible envelopes while logging telemetry; surface a fatal notification in the shell and fall back to the inline runtime path when the first READY message fails; maintain command contracts from `docs/runtime-command-queue-design.md:1034`; ensure serialized saves remain forward-compatible.

## 5. Current State
- Shell shows only tick count and event inspector (`packages/shell-web/src/modules/App.tsx:32`), blocking progression UI usage.
- `ShellState` lacks resource/generator fields (`packages/shell-web/src/modules/shell-state.types.ts:16`), so hooks cannot consume progression data.
- Worker bridge proxies state and commands but serializes only events and backpressure (`packages/shell-web/src/modules/worker-bridge.ts:672`).
- Runtime exposes generator purchase handlers without UI integration (`packages/core/src/resource-command-handlers.ts:54`).
- Sample content already defines resources/generators for the progression UI to visualise (`packages/content-sample/src/generated/@idle-engine/sample-pack.generated.ts:90`).
- Project plan requires rendering resource panels and upgrade modals in this phase (`docs/implementation-plan.md:56`).

## 6. Proposed Solution

### 6.1 Architecture Overview
- **Narrative**: Extend runtime snapshots with a consolidated `ProgressionSnapshot` (resources, generators, upgrades) inside the worker; `ShellStateProvider` consumes this snapshot, derives memoized view-models, and hands them to new React components that drive the progression UI while dispatching commands back through the existing bridge.
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
- **Runtime Changes**: Extend `RuntimeStatePayload` with frozen resource/generator/upgrade arrays derived from `SerializedResourceState` and generator indices inside the worker; add upgrade ownership scaffolding (TODO owner: Runtime Protocol Agent) while keeping progression UI data deterministic and double-buffered.
- **Data & Schemas**: Introduce `ProgressionSnapshot` TypeScript types exported from `@idle-engine/core` for the progression UI; align generator cost curves with sample pack schema (`packages/content-sample/src/generated/@idle-engine/sample-pack.generated.ts:114`) and reserve upgrade schema wiring as TODO (Content Systems owner).

#### Field Sourcing
- **Resources**: Publish `resources` by reshaping `SerializedResourceState` fields (`packages/core/src/resource-state.ts:119`) into presentation-friendly records. `perTick` is computed as `resourceState.getNetPerSecond(index) * (runtime.getStepSizeMs() / 1000)` so UI consumers receive the net delta per runtime step.
- **Generators**: Hydrate generator rows from the authoritative progression systems (existing handlers in `packages/core/src/resource-command-handlers.ts:54`), including the next purchase price calculated via the generator definition’s cost curve helpers. Expose `nextPurchaseReadyAtStep` as `currentStep + 1` when no cooldown applies, mirroring the command queue’s deterministic “next tick” execution window.
- **Upgrades**: Surface upgrade visibility, availability, and purchase pricing from the upgrade progression system once the TODO scaffolding lands. While stubbing in the interim, mark snapshot entries with `status: 'locked' | 'available' | 'purchased'` to match the future data contract, and gate any `available` state behind real economics shipped from `packages/content-sample`.
- **APIs & Contracts**: Add `PURCHASE_UPGRADE` command type (TODO owner: Runtime Protocol Agent) mirroring `PurchaseGeneratorPayload` (`packages/core/src/command.ts:121`); expose read-only view helpers on the shell bridge for the progression UI; guarantee schema version negotiation.
- **Tooling & Automation**: Update Vitest suites for worker and shell modules (`packages/shell-web/src/runtime.worker.test.ts`) to assert new payloads and rejection flows; add component unit tests for the progression UI using React Testing Library; ensure `pnpm test --filter shell-web` remains primary validation (`docs/runtime-react-worker-bridge-design.md:164`).

#### Example Snapshot & Command Flow
```typescript
type ProgressionSnapshot = Readonly<{
  step: number;
  publishedAt: number;
  resources: readonly ResourceView[];
  generators: readonly GeneratorView[];
  upgrades: readonly UpgradeView[];
}>;

type ResourceView = Readonly<{
  id: string;
  displayName: string;
  amount: number;
  capacity?: number;
  perTick: number;
}>;

type GeneratorView = Readonly<{
  id: string;
  displayName: string;
  owned: number;
  isUnlocked: boolean;
  purchasePrice: number;
  currencyId: string;
  produces: readonly { resourceId: string; rate: number }[];
  consumes: readonly { resourceId: string; rate: number }[];
  nextPurchaseReadyAtStep: number;
}>;

type UpgradeView = Readonly<{
  id: string;
  displayName: string;
  status: 'locked' | 'available' | 'purchased';
  purchasePrice?: number;
  currencyId?: string;
  unlockHint?: string;
}>;
```

```json
{
  "step": 420,
  "publishedAt": 1730395539123,
  "resources": [
    {
      "id": "sample-pack.energy",
      "displayName": "Energy",
      "amount": 125.5,
      "capacity": 250,
      "perTick": 0.55
    },
    {
      "id": "sample-pack.crystal",
      "displayName": "Crystal",
      "amount": 4,
      "perTick": 0.025
    }
  ],
  "generators": [
    {
      "id": "sample-pack.reactor",
      "displayName": "Reactor",
      "owned": 6,
      "isUnlocked": true,
      "purchasePrice": 23.13,
      "currencyId": "sample-pack.energy",
      "produces": [
        { "resourceId": "sample-pack.energy", "rate": 1 }
      ],
      "consumes": [],
      "nextPurchaseReadyAtStep": 421
    },
    {
      "id": "sample-pack.harvester",
      "displayName": "Crystal Harvester",
      "owned": 1,
      "isUnlocked": true,
      "purchasePrice": 30,
      "currencyId": "sample-pack.energy",
      "produces": [
        { "resourceId": "sample-pack.crystal", "rate": 0.25 }
      ],
      "consumes": [
        { "resourceId": "sample-pack.energy", "rate": 0.5 }
      ],
      "nextPurchaseReadyAtStep": 421
    }
  ],
  "upgrades": [
    {
      "id": "sample-pack.harvester-efficiency",
      "displayName": "Harvester Efficiency",
      "status": "locked",
      "unlockHint": "Accumulate 20 crystal to reveal this upgrade."
    },
    {
      "id": "sample-pack.reactor-insulation",
      "displayName": "Reactor Insulation",
      "status": "available",
      "purchasePrice": 75,
      "currencyId": "sample-pack.energy"
    },
    {
      "id": "sample-pack.reactor-overclock",
      "displayName": "Reactor Overclock",
      "status": "purchased"
    }
  ]
}
```

Upgrades in the snapshot illustration use placeholder IDs; update them once `packages/content-sample` adds real upgrade definitions alongside the generator content. The example covers locked, available, and purchased states so UI consumers can map every variant.

1. Player clicks “Buy Reactor” in `GeneratorPanel`.
2. Component calls `bridge.sendCommand('PURCHASE_GENERATOR', { generatorId: 'sample-pack.reactor', count: 1 })`.
3. Worker validates funds, applies the purchase through `resource-command-handlers.ts`, emits telemetry, and republishes the snapshot at `step + 1`.
4. `ShellStateProvider` receives the updated snapshot, recomputes memoized selectors, and re-renders the dashboard with optimistic feedback already reflected because the component staged the delta while awaiting confirmation.
5. Analytics facade logs `generator.purchase.confirmed` with the request latency once the worker response arrives.

#### Failure & Mismatch Handling
- If the worker rejects a purchase (insufficient currency, invalid generator, or upgrade lock), the snapshot emitted on the next tick omits the optimistic delta. `ShellStateProvider` rolls back the pending state and surfaces a toast summarising the denial while logging `generator.purchase.denied` / `upgrade.purchase.denied` through `packages/shell-web/src/modules/shell-analytics.ts:1`.
- When the bridge receives an `ERROR` envelope with a `requestId`, it cancels the pending optimistic entry, emits `progression-ui.command-error`, and replays the authoritative snapshot once available (`packages/shell-web/src/modules/worker-bridge.ts:246`). Components must treat the rollback as deterministic and keep focus in place for accessibility.
- Schema mismatches still hit the guardrail at `packages/shell-web/src/modules/worker-bridge.ts:223`; emit `progression-ui.schema-mismatch`, show the fatal notification described in §4, and revert to the inline runtime until the refresh path succeeds.

#### Upgrade Purchase Contract
- Introduce `RUNTIME_COMMAND_TYPES.PURCHASE_UPGRADE` in `packages/core/src/command.ts`, pairing it with a `PurchaseUpgradePayload` containing `upgradeId` and optional `metadata` for future side effects. The shell bridge stamps the command with `CommandPriority.PLAYER`, matching `PURCHASE_GENERATOR`.
- Worker-side handlers mirror generator purchases: validate availability, evaluate resource costs using the same currency resolver, and, on success, emit an updated `ProgressionSnapshot` alongside telemetry (`upgrade.purchase.confirmed` / `upgrade.purchase.denied`).
- Extend `ShellStateProvider` optimistic handling to stage upgrade status as `pending` until the next snapshot arrives, ensuring UI feedback is consistent with generator purchases.

### 6.3 Operational Considerations
- **Deployment**: Roll out under `VITE_ENABLE_PROGRESSION_UI` flag defaulting to false until progression UI tests pass in CI, then enable for dev and production sequentially.
- **Telemetry & Observability**: Emit shell analytics events through existing facade (`packages/shell-web/src/modules/shell-analytics.ts:1`) for resource purchases and upgrade actions; fire a `progression-ui.schema-mismatch` event when the bridge filters worker envelopes so rollout monitors highlight version skew; gauge adoption via weekly reports.
- **Security & Compliance**: Ensure no PII in snapshots; honour command authorization policies during progression UI interactions; maintain worker isolation per security guidelines.

## 7. Work Breakdown & Delivery Plan

### 7.1 Issue Map
| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| feat(core): emit progression snapshot | Add `ProgressionSnapshot` export, worker serialization, schema bump for the progression UI | Runtime Protocol Agent | Telemetry scaffolding ready | Vitest worker-suite validates snapshot; schema version doc updated |
| feat(shell-web): integrate progression state | Extend `ShellStateProvider`, selectors, context for the progression UI | Shell UI Implementation Agent | Progression snapshot merged | Shell hook tests prove memoization; bridge still passes diagnostics tests |
| feat(shell-web): resource dashboard UI | Render resource list with capacities, rates, accessibility hooks | Shell UI Implementation Agent | Progression hook available | Component tests cover locked/unlocked states; passes `pnpm test --filter shell-web` |
| feat(shell-web): generator & upgrade interactions | Create generator cards, command dispatch, upgrade modal | Shell UI Implementation Agent | Dashboard UI merged | Commands fire with optimistic updates; rejected purchases revert UI with toast + telemetry assertions; QA sign-off captured |
| docs/content-sample: enrich progression data | Backfill generators, upgrades, localization for the progression UI showcase | Content Data Agent | Progression snapshot contract final | Content tests regenerate artifacts; upgrade economics and unlocks ship before flag enablement; docs note new content |

### 7.2 Milestones
- **Phase 1**: Finalize progression snapshot contract, raise schema version, land worker tests; exit when progression UI data flows to shell.
- **Phase 2**: Ship resource dashboard and generator cards behind feature flag; exit when manual smoke confirms deterministic updates.
- **Phase 3**: Enable upgrade modal, telemetry, and accessibility validation; exit when Playwright smoke runs clean.

### 7.3 Coordination Notes
- **Hand-off Package**: Provide agents with snapshot type definitions, sample content diffs, and schema bump notes for the progression UI.
- **Communication Cadence**: Daily async status updates via project board comments; formal review checkpoints at milestone boundaries; escalate blockers through Issue #18 thread.

## 8. Agent Guidance & Guardrails
- **Context Packets**: Agents must preload `docs/idle-engine-design.md`, `docs/runtime-command-queue-design.md`, and relevant source files before acting on the progression UI.
- **Prompting & Constraints**: Use command templates referencing `bridge.sendCommand` patterns; follow naming conventions and commit style while focusing on the progression UI.
- **Safety Rails**: Do not bypass worker bridge isolation (`docs/runtime-react-worker-bridge-design.md:160`); avoid mutating serialized state; keep feature flag default off until acceptance suite passes.
- **Validation Hooks**: Run `pnpm lint`, `pnpm test --filter shell-web`, and `pnpm test:a11y` after UI modifications; document outputs in issue comments.

## 9. Alternatives Considered
- Rely on ad hoc shell-side calculations without worker updates: rejected because it diverges from determinism and cannot reflect authoritative generator costs for the progression UI.
- Build a separate standalone UI prototype: rejected as it duplicates bridge logic and violates deployment plan tied to `packages/shell-web`.

## 10. Testing & Validation Plan
- **Unit / Integration**: Expand worker serialization tests and React component snapshots; ensure progression UI hooks handle locked/unlocked transitions.
- **Performance**: Profile resource list rendering with 100+ nodes; ensure updates stay below 16 ms using memoization.
- **Tooling / A11y**: Re-run Playwright smoke once the progression UI ships (`docs/accessibility-smoke-tests-design.md:57`); add axe assertions for modal focus traps.
- **Release Gates**: Block feature-flag promotion until `pnpm lint`, `pnpm test --filter core`, `pnpm test --filter shell-web`, and `pnpm test:a11y` complete without flake; record a manual scenario covering first generator purchase and upgrade reveal to validate optimistic UI against the example snapshot.

## 11. Risks & Mitigations
- Schema drift between worker and shell for the progression UI; mitigate via shared types and compile-time checks.
- Feature flag left disabled in production leading to dead code; mitigate by tracking rollout issue and gating removal in Follow-Up Work.
- Upgrade economics missing until content team supplies data; mitigate via the Content Systems deliverable documented in §13 and block flag enablement until it lands.

## 12. Rollout Plan
- **Milestones**: Enable flag in `dev` after Phase 2 once Release Gates pass on a `pnpm test --filter shell-web` focused run; promote to `main` after the telemetry dashboard confirms no `progression-ui.schema-mismatch` events for 72 hours; remove the flag after two stable releases and a green rerun of `pnpm test:a11y` on the enabled build.
- **Migration Strategy**: Maintain fallback to old shell layout by gating new components; provide migration doc for any third-party shells.
- **Communication**: Announce progression UI availability in weekly status reports; update onboarding documentation post-rollout.

## 13. Open Questions
- Content Systems (Issue #18 checkpoint): Deliver the definitive upgrade catalog and unlock sequencing before Phase 2 exits; progression flag cannot flip without this data set.
- UX Lead: Provide visual hierarchy guidelines and iconography requirements so GeneratorPanel/UpgradeModal align with shell patterns.
- Runtime Protocol Agent: Finalise upgrade purchase command semantics and refund behaviour, then codify them in `packages/core/src/command.ts` alongside regression tests.

## 14. Follow-Up Work
- Document automation toggles and prestige integration once the progression UI stabilizes.
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
- **Progression UI**: The initiative delivering resource dashboards, generator cards, and upgrade modals in the shell.
- **Progression Snapshot**: Worker-emitted frozen structure capturing resources, generators, and upgrades for rendering.
- **ResourceDashboard**: Proposed React component summarizing resource amounts, capacities, and rates.
- **GeneratorPanel**: Component listing generators, ownership counts, and purchase actions.
- **UpgradeModal**: Overlay presenting upgrade catalog entries with purchase controls and dependencies.

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2025-10-31 | Idle Engine Design-Authoring Agent | Initial draft for progression UI components |
