# Prestige System Completion Design

## Document Control
- **Title**: Complete prestige system with runtime handler, snapshot types, and UI components
- **Authors**: Idle Engine Team
- **Reviewers**: Runtime Core Maintainers, Shell UX Maintainers
- **Status**: Draft
- **Last Updated**: 2025-11-27
- **Related Issues**: Idle-Game-Engine#18 (Progression UI)
- **Execution Mode**: AI-led

## 1. Summary

This design completes the prestige system by adding the missing runtime handler, snapshot types, and UI components. Players will be able to view available prestige layers, preview rewards with resource breakdowns, understand what gets reset vs. retained, and execute prestige resets through a confirmation modal. The implementation extends the existing `ProgressionSnapshot` contract and follows established patterns from the generator/upgrade UI components.

## 2. Context & Problem Statement

- **Background**: The runtime defines `PRESTIGE_RESET` command type and authorization policy (`packages/core/src/command.ts:112,263-272`), but no production handler exists. The sample pack includes a complete prestige layer (`Ascension Alpha`) with unlock conditions, reset targets, and reward formulas (`packages/content-sample/content/pack.json:988-1070`). UI components exist for resources, generators, and upgrades, but prestige has no UI surface.

- **Problem**: Players cannot interact with the prestige system despite content being defined. The `ProgressionSnapshot` omits prestige layer data, blocking the shell from displaying prestige status or rewards. This leaves a core idle game mechanic inaccessible.

- **Forces**: Implementation must follow existing command handler patterns (`resource-command-handlers.ts`), maintain worker bridge isolation, preserve deterministic replay, and meet accessibility standards established by existing UI components.

## 3. Goals & Non-Goals

### Goals

1. Implement `PRESTIGE_RESET` command handler in `packages/core` with proper validation, status checks, and telemetry
2. Extend `ProgressionSnapshot` with `PrestigeLayerView[]` containing unlock status, reward preview, and reset targets
3. Build `PrestigePanel` component rendering a multi-layer list with teaser mode for locked layers
4. Build `PrestigeModal` component for confirmation flow with reward breakdown and reset summary
5. Wire prestige data through worker bridge to shell state provider
6. Add accessibility support (focus traps, ARIA labels, keyboard navigation)

### Non-Goals

- Multiple prestige resets in quick succession (cooldown enforcement deferred)
- Prestige layer unlock animations or celebration effects
- Cross-session prestige statistics tracking
- Prestige automation (explicitly blocked by command authorization)

## 4. Stakeholders, Agents & Impacted Surfaces

- **Primary Stakeholders**: Runtime Core maintainers, Shell UX maintainers
- **Agent Roles**: Runtime Implementation Agent (handler, types), Shell UI Implementation Agent (components, integration), QA Agent (tests, accessibility)
- **Affected Packages/Services**: `packages/core`, `packages/shell-web`
- **Compatibility Considerations**: Extends `ProgressionSnapshot` with new field; existing consumers unaffected as field is additive

## 5. Current State

- `PRESTIGE_RESET` command type defined (`packages/core/src/command.ts:112`)
- `PrestigeResetPayload` interface defined with `layer` and optional `confirmationToken` (`packages/core/src/command.ts:163-166`)
- Command authorization blocks AUTOMATION priority (`packages/core/src/command.ts:265-272`)
- No production handler registered; only test stubs exist (`command-dispatcher.test.ts:127`)
- `ProgressionSnapshot` contains `resources`, `generators`, `upgrades` but no prestige data (`packages/core/src/progression.ts:65-71`)
- Sample pack defines `Ascension Alpha` layer with complex reward formula (`packages/content-sample/content/pack.json:988-1070`)
- No prestige UI components exist in `packages/shell-web`

## 6. Proposed Solution

### 6.1 Architecture Overview

**Data Flow**

```
┌─────────────────────────────────────────────────────────────────────┐
│                         React Shell                                  │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐  │
│  │  PrestigePanel  │───▶│  PrestigeModal  │───▶│  ShellBridge    │  │
│  │  (layer list)   │    │  (confirmation) │    │  sendCommand()  │  │
│  └─────────────────┘    └─────────────────┘    └────────┬────────┘  │
└────────────────────────────────────────────────────────│───────────┘
                                                          │ postMessage
┌────────────────────────────────────────────────────────│───────────┐
│                      Web Worker                         ▼            │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐  │
│  │ ProgressionSnap │◀───│  PrestigeSystem │◀───│ CommandDispatch │  │
│  │ (+ prestigeView)│    │  (evaluator)    │    │ PRESTIGE_RESET  │  │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

**Key Components**

- **PrestigePanel**: Renders list of prestige layers. Unlocked layers show reward preview and "Prestige" button. Locked layers appear dimmed with teaser hints.

- **PrestigeModal**: Confirmation dialog with reward breakdown (expandable), two-column reset summary, and confirm/cancel actions. Focus-trapped for accessibility.

- **PrestigeSystemEvaluator**: New evaluator interface in `packages/core` providing `getPrestigeQuote()` for reward calculation and `applyPrestige()` for reset execution.

- **PRESTIGE_RESET handler**: Validates layer exists, checks unlock conditions, executes reset via PrestigeSystemEvaluator, emits telemetry.

- **PrestigeLayerView**: New type added to `ProgressionSnapshot` containing layer status, reward preview, reset targets, and unlock hints.

### 6.2 Detailed Design

#### Types & Interfaces

**PrestigeLayerView (new type in `packages/core/src/progression.ts`)**

```typescript
export type PrestigeLayerView = Readonly<{
  id: string;
  displayName: string;
  summary?: string;
  status: 'locked' | 'available' | 'completed';
  unlockHint?: string;           // Teaser text for locked layers
  isVisible: boolean;
  rewardPreview?: PrestigeRewardPreview;
  resetTargets: readonly string[]; // Resource IDs that will be reset
  retainedTargets: readonly string[]; // Resource IDs that survive
}>;

export type PrestigeRewardPreview = Readonly<{
  resourceId: string;
  amount: number;
  breakdown?: readonly PrestigeRewardContribution[];
}>;

export type PrestigeRewardContribution = Readonly<{
  sourceResourceId: string;
  sourceAmount: number;
  contribution: number;          // How much this resource contributes to reward
}>;
```

**Extended ProgressionSnapshot**

```typescript
export type ProgressionSnapshot = Readonly<{
  step: number;
  publishedAt: number;
  resources: readonly ResourceView[];
  generators: readonly GeneratorView[];
  upgrades: readonly UpgradeView[];
  prestigeLayers: readonly PrestigeLayerView[];  // NEW
}>;
```

**PrestigeSystemEvaluator Interface**

```typescript
export interface PrestigeQuote {
  readonly layerId: string;
  readonly status: 'locked' | 'available' | 'completed';
  readonly reward: PrestigeRewardPreview;
  readonly resetTargets: readonly string[];
  readonly retainedTargets: readonly string[];
}

export interface PrestigeSystemEvaluator {
  getPrestigeQuote(layerId: string): PrestigeQuote | undefined;
  applyPrestige(layerId: string, confirmationToken?: string): void;
}
```

**Implementation Location & Instantiation**

The concrete `PrestigeSystemEvaluator` implementation lives in `packages/core/src/prestige-system.ts`. It is instantiated by the runtime during initialization when prestige layer definitions are loaded from compiled content:

1. **Content Loading**: `IdleEngineRuntime` receives compiled content pack with `prestigeLayers` array
2. **Evaluator Creation**: Runtime creates `PrestigeSystemEvaluatorImpl` passing:
   - Prestige layer definitions from content
   - Reference to `ResourceState` for current values and mutations
   - Reference to expression evaluator for reward formula calculation
3. **Handler Wiring**: Evaluator instance passed to `registerResourceCommandHandlers()` via `prestigeSystem` option
4. **Snapshot Building**: Same evaluator instance used by `buildProgressionSnapshot()` to populate `prestigeLayers` field

The evaluator maintains no internal state beyond references; all prestige state (completion count, timestamps) is stored in `ResourceState` as special resources or flags defined by content.

#### PRESTIGE_RESET Command Handler

**Handler Registration (in `packages/core/src/resource-command-handlers.ts`)**

```typescript
export interface ResourceCommandHandlerOptions {
  // ... existing fields
  readonly prestigeSystem?: PrestigeSystemEvaluator;
}

export function registerResourceCommandHandlers(options: ResourceCommandHandlerOptions): void {
  // ... existing registrations

  if (options.prestigeSystem) {
    dispatcher.register<PrestigeResetPayload>(
      RUNTIME_COMMAND_TYPES.PRESTIGE_RESET,
      createPrestigeResetHandler(options.prestigeSystem),
    );
  }
}
```

**Handler Flow**

1. **Validate payload** - Check `layerId` is non-empty string
2. **Get quote** - Call `prestigeSystem.getPrestigeQuote(layerId)`
3. **Check status** - Reject if `locked` (warning telemetry)
4. **Execute** - Call `prestigeSystem.applyPrestige(layerId, confirmationToken)`
5. **Record success** - `telemetry.recordProgress('PrestigeResetConfirmed', ...)`

**Telemetry Events**

| Event | Level | When |
|-------|-------|------|
| `PrestigeResetInvalidLayer` | error | Layer ID validation fails |
| `PrestigeResetUnknown` | error | Evaluator returns undefined |
| `PrestigeResetLocked` | warning | Layer not yet available |
| `PrestigeResetApplyFailed` | error | Evaluator throws during apply |
| `PrestigeResetConfirmed` | progress | Success |

**Design Decisions**

- **Change `PrestigeResetPayload.layer` from number to string**: The existing payload uses `layer: number`, but content packs define layers with string IDs (e.g., `"sample-pack.ascension-alpha"`). This design proposes changing to `layerId: string` for consistency with the content schema and evaluator interface. The existing numeric field was a placeholder; no production code depends on it. Update the payload interface in `packages/core/src/command.ts`:

  ```typescript
  export interface PrestigeResetPayload {
    readonly layerId: string;           // Changed from layer: number
    readonly confirmationToken?: string;
  }
  ```

- **No resource cost for prestige**: Prestige layers don't have a purchase cost - they have unlock conditions and give rewards. The "cost" is losing progress. This simplifies the handler (no spend/refund transaction needed).

- **Confirmation token is advisory**: The token is passed through to `applyPrestige()` for the evaluator to use if needed (e.g., UI-generated nonce), but the handler doesn't validate it. This matches how `metadata` is passed to `applyPurchase()` in upgrades.

- **Reset scope is content-driven**: The `resetTargets` array in prestige layer definitions determines exactly what gets reset. Currently, the content schema supports resource IDs only. Generators and upgrades are reset implicitly when their backing resources are reset (e.g., resetting "energy" means generators that cost energy become re-purchasable). Future schema extensions could add explicit `resetGenerators` and `resetUpgrades` arrays if finer control is needed. For the sample pack's `Ascension Alpha` layer, resetting the four listed resources effectively resets early-game progression while preserving prestige currency.

- **Empty resetTargets arrays are valid**: Prestige layers with empty `resetTargets` arrays are intentional "bonus layers" that grant rewards without resetting any resources. Use cases include: milestone rewards that don't require sacrifice, achievement-style prestige that stacks with other layers, and tutorial/onboarding layers that introduce prestige mechanics gently without penalizing players.

- **Retention specifies what survives with amounts**: The `retention` array in content defines not just which resources survive but how much (constant value or percentage). The UI simplifies this to `retainedTargets: readonly string[]` showing resource IDs only; exact retention amounts are an implementation detail handled by the evaluator during reset execution.

- **Prestige layers are repeatable**: Status cycles `available` → `completed` → `available`, allowing players to prestige the same layer multiple times. Repeatable prestige creates compounding progression loops (each reset can grant scaling rewards via `multiplierCurve`), extends session lifetime engagement, and justifies tier expansion (Alpha→Beta→Gamma). This matches successful idle games like Cookie Clicker and AdCap.

- **Track prestige count per layer as a resource**: Each prestige layer has an associated counter stored as a standard resource in `ResourceState` (e.g., `sample-pack.ascension-alpha-prestige-count`). This leverages existing architecture without special cases and enables: achievement systems, dynamic reward scaling via `multiplierCurve` expressions that reference the count, unlock conditions for higher prestige tiers (e.g., "Unlock Ascension Beta after 5 successful Alpha resets"), and player motivation through visible progress metrics.

- **Locked layers visible with teaser hints**: Locked prestige layers appear in the UI with a dimmed/blurred appearance and an `unlockHint` teaser. This creates discovery motivation and prevents confusion about progression. Teaser hints should be thematic ("Reach deeper into the machine...") rather than revealing exact requirements, preserving mystery while showing players a roadmap of future progression.

#### UI Components

**PrestigePanel (`packages/shell-web/src/modules/PrestigePanel.tsx`)**

```typescript
interface PrestigeLayerCardProps {
  readonly layer: PrestigeLayerView;
  onPrestige: (layerId: string) => void;
}

function PrestigeLayerCard({ layer, onPrestige }: PrestigeLayerCardProps): JSX.Element;
function LockedLayerCard({ layer }: { layer: PrestigeLayerView }): JSX.Element;
function LoadingState(): JSX.Element;
function EmptyState(): JSX.Element;

export function PrestigePanel(): JSX.Element | null;
```

**Layer Card States**

| Status | Appearance | Actions |
|--------|------------|---------|
| `locked` | Dimmed/blurred, teaser hint visible | None (non-interactive) |
| `available` | Full color, reward preview shown | "Prestige" button opens modal |
| `completed` | Checkmark badge, last reward shown | Can prestige again (if repeatable) |

**PrestigeModal (`packages/shell-web/src/modules/PrestigeModal.tsx`)**

```typescript
interface PrestigeModalProps {
  readonly open: boolean;
  readonly layer: PrestigeLayerView | null;
  readonly onConfirm: (layerId: string) => void;
  readonly onClose: () => void;
}

export function PrestigeModal({ open, layer, onConfirm, onClose }: PrestigeModalProps): JSX.Element | null;
```

**Modal Sections**

1. **Header** - Layer name, close button
2. **Reward preview** - "You will earn: X Prestige Flux" with expandable breakdown
3. **Reset summary** - Two columns: "Will be reset" | "Will be kept"
4. **Actions** - "Cancel" and "Confirm Prestige" buttons

**Accessibility**: Focus trap on open, Escape to close, `aria-modal="true"`, `role="dialog"`

#### Worker Bridge Integration

**ShellStateProvider Changes**

```typescript
export interface ShellProgressionContext {
  // ... existing
  selectPrestigeLayers: () => readonly PrestigeLayerView[] | null;
  selectPrestigeLayerById: (layerId: string) => PrestigeLayerView | null;
}
```

**Command Dispatch**

```typescript
shellBridge.sendCommand('PRESTIGE_RESET', {
  layerId: layer.id,
  confirmationToken: crypto.randomUUID(),
});
```

**Optimistic Updates**

Unlike generator/upgrade purchases, prestige resets don't need optimistic resource deltas - the entire state changes dramatically. The UI should:

1. Show loading/pending state on confirm
2. Wait for next snapshot from worker
3. Snapshot will reflect post-prestige state

### 6.3 Operational Considerations

- **Deployment**: No feature flags; prestige UI renders when layers exist in content
- **Telemetry & Observability**: Handler emits telemetry for all outcomes; UI errors surface via existing bridge error handling
- **Security & Compliance**: No PII in prestige data; authorization policy prevents automation abuse

## 7. Work Breakdown & Delivery Plan

### 7.1 Issue Map

**Phase 1: Core Runtime**

| Issue Title | Scope | Agent | Dependencies | Acceptance Criteria |
|-------------|-------|-------|--------------|---------------------|
| `feat(core): change PrestigeResetPayload.layer to layerId` | Update payload type from `layer: number` to `layerId: string` | Runtime Agent | None | Payload uses string ID, tests updated |
| `feat(core): add PrestigeLayerView types` | Add types to `progression.ts`, export from `index.ts` | Runtime Agent | Payload change | Types compile, exported in package |
| `feat(core): implement PrestigeSystemEvaluator interface` | Define interface, add to `ResourceCommandHandlerOptions` | Runtime Agent | Types | Interface matches design, optional field |
| `feat(core): add PRESTIGE_RESET handler` | Handler with validation, status checks, telemetry | Runtime Agent | Evaluator interface | All handler tests pass |
| `feat(core): extend buildProgressionSnapshot with prestigeLayers` | Add prestige layer view generation | Runtime Agent | Types, Evaluator | Snapshot tests cover prestige data |

**Phase 2: Worker Integration**

| Issue Title | Scope | Agent | Dependencies | Acceptance Criteria |
|-------------|-------|-------|--------------|---------------------|
| `feat(shell-web): wire PrestigeSystemEvaluator in worker` | Connect evaluator to runtime, pass to snapshot builder | Shell Agent | Phase 1 complete | Worker publishes prestige data |
| `feat(shell-web): add prestige selectors to ShellStateProvider` | `selectPrestigeLayers`, `selectPrestigeLayerById` | Shell Agent | Worker wiring | Selectors return typed data |

**Phase 3: UI Components**

| Issue Title | Scope | Agent | Dependencies | Acceptance Criteria |
|-------------|-------|-------|--------------|---------------------|
| `feat(shell-web): implement PrestigePanel component` | Layer list with locked/available states | Shell Agent | Selectors | Component tests pass, renders in app |
| `feat(shell-web): implement PrestigeModal component` | Confirmation flow with breakdown and reset summary | Shell Agent | Selectors | Focus trap works, a11y tests pass |
| `feat(shell-web): integrate PrestigePanel into App` | Add panel to main layout, wire command dispatch | Shell Agent | Panel, Modal | End-to-end prestige flow works |

**Phase 4: Polish & Validation**

| Issue Title | Scope | Agent | Dependencies | Acceptance Criteria |
|-------------|-------|-------|--------------|---------------------|
| `test(a11y): add prestige panel to smoke tests` | Playwright tests for panel and modal | QA Agent | Phase 3 complete | `pnpm test:a11y` passes |
| `docs: update progression UI design doc` | Mark prestige sections complete, update references | QA Agent | Phase 3 complete | Doc reflects implementation |

### 7.2 Milestones

- **Phase 1**: Core types and handler complete; prestige data flows internally
- **Phase 2**: Worker publishes prestige snapshots; shell can consume data
- **Phase 3**: Full UI functional; players can view and execute prestige
- **Phase 4**: Accessibility verified; documentation updated

### 7.3 Coordination Notes

- **Hand-off Package**: Types defined in Phase 1 unblock Phase 2-3 parallel work
- **Communication Cadence**: Update issue threads on completion; review checkpoints at phase boundaries

## 8. Agent Guidance & Guardrails

- **Context Packets**: Agents must preload `docs/build-resource-generator-upgrade-ui-components-design.md`, `packages/core/src/resource-command-handlers.ts`, `packages/core/src/progression.ts`
- **Prompting & Constraints**: Follow existing handler patterns exactly; use `telemetry.recordError/recordWarning/recordProgress` consistently
- **Safety Rails**: Do not bypass worker bridge isolation; do not allow AUTOMATION priority for prestige commands
- **Validation Hooks**: Run `pnpm lint`, `pnpm test --filter core`, `pnpm test --filter shell-web`, `pnpm test:a11y` after changes

## 9. Alternatives Considered

1. **Inline prestige button without modal**: Rejected for safety - prestige is irreversible and needs explicit confirmation with clear communication of consequences.

2. **Single-layer UI design**: Rejected as the schema already supports multiple layers; designing for multi-layer avoids rework.

3. **Always-visible locked layers with full requirements**: Rejected in favor of teaser mode to create mystery and avoid overwhelming new players.

## 10. Testing & Validation Plan

### Unit Tests

| Component | Test File | Coverage |
|-----------|-----------|----------|
| `PRESTIGE_RESET` handler | `resource-command-handlers.test.ts` | Valid/invalid layer, locked status, success telemetry, apply failure |
| `PrestigeSystemEvaluator` | `progression.test.ts` | Quote generation, reward calculation, reset execution |
| `buildProgressionSnapshot` | `progression.test.ts` | `prestigeLayers` field population, status mapping |
| `PrestigePanel` | `PrestigePanel.test.tsx` | Loading/empty/locked/available states, button interactions |
| `PrestigeModal` | `PrestigeModal.test.tsx` | Focus trap, breakdown expansion, confirm/cancel actions |

### Handler Test Cases

```typescript
describe('PRESTIGE_RESET handler', () => {
  it('rejects invalid layer with PrestigeResetInvalidLayer telemetry');
  it('rejects unknown layer with PrestigeResetUnknown telemetry');
  it('rejects locked layer with PrestigeResetLocked warning');
  it('executes prestige and emits PrestigeResetConfirmed on success');
  it('emits PrestigeResetApplyFailed and rethrows on evaluator error');
  it('passes confirmationToken through to applyPrestige');
  it('blocks AUTOMATION priority via command authorization');
});
```

### Component Test Cases

```typescript
describe('PrestigePanel', () => {
  it('renders loading state when bridge not ready');
  it('renders empty state when no prestige layers defined');
  it('renders locked layers with dimmed appearance and teaser hint');
  it('renders available layers with prestige button');
  it('opens modal when prestige button clicked');
});

describe('PrestigeModal', () => {
  it('traps focus within modal when open');
  it('closes on Escape key');
  it('displays reward amount and breakdown');
  it('shows reset/retained columns');
  it('calls onConfirm with layer ID when confirmed');
  it('displays error toast on command failure');
});
```

### Accessibility Tests

- Add prestige panel to Playwright smoke suite (`tools/a11y-smoke-tests`)
- Verify modal focus trap and restore
- Check ARIA labels on layer cards and buttons

## 11. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Prestige reward formula evaluation complexity | Incorrect rewards, player frustration | Reuse existing expression evaluator from content-schema; add property-based tests for edge cases |
| Worker snapshot size increase | Slower postMessage, UI lag | Prestige layers are few (fewer than 10 expected); monitor payload size in diagnostics |
| Modal focus trap conflicts with other modals | Accessibility issues | Ensure only one modal renders at a time; follow UpgradeModal pattern exactly |
| Reset targets misconfigured in content | Wrong resources reset, data loss | Validate `resetTargets` reference valid resource IDs at content compile time |
| Locked layer teaser hints reveal too much | Spoils progression discovery | Keep hints vague ("Reach deeper..."); content authors control hint text |

## 12. Rollout Plan

- **Phase 1-2**: Internal only; no user-facing changes
- **Phase 3**: Prestige UI visible when content defines layers
- **Phase 4**: Full validation before release
- **Migration Strategy**: None required; additive feature
- **Communication**: Document prestige UI in user-facing changelog

## 13. Follow-Up Work

- Prestige layer unlock animations and celebration effects
- Cross-session prestige statistics and achievements
- Prestige automation rules (if authorization policy changes)
- Multi-currency prestige rewards (beyond single resource)
- Explicit `resetGenerators` and `resetUpgrades` schema arrays (if use cases emerge)
- Multiplier curve support for scaling rewards based on prestige count

## 14. References

- `packages/core/src/command.ts:106-166` - Command types and payloads
- `packages/core/src/command.ts:230-290` - Command authorizations
- `packages/core/src/resource-command-handlers.ts` - Existing handler patterns
- `packages/core/src/progression.ts` - ProgressionSnapshot and view types
- `packages/content-sample/content/pack.json:988-1070` - Sample prestige layer
- `packages/shell-web/src/modules/UpgradeModal.tsx` - Modal pattern reference
- `packages/shell-web/src/modules/GeneratorPanel.tsx` - Panel pattern reference
- `docs/build-resource-generator-upgrade-ui-components-design.md` - Related progression UI design

## Appendix A — Glossary

- **Prestige Layer**: A reset mechanic that exchanges accumulated progress for permanent rewards
- **PrestigeLayerView**: UI-facing snapshot of a prestige layer's current state
- **Teaser Mode**: Display style for locked layers showing blurred appearance with hints
- **Reset Targets**: Resources that are reset to initial values when prestiging
- **Retained Targets**: Resources that survive a prestige reset

## Appendix B — Change Log

| Date | Author | Change Summary |
|------|--------|----------------|
| 2025-11-27 | Idle Engine Team | Initial draft |
| 2025-11-28 | Idle Engine Team | Review and completion: clarified layer ID type change, added evaluator implementation location, expanded design decisions (repeatable prestige, prestige count tracking, locked layer visibility), updated work breakdown tables with Agent/Dependencies columns, removed Open Questions section (all resolved and integrated into design) |
