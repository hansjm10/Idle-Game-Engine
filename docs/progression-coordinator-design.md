# Progression Coordinator Pattern

## Document Control
- **Title**: Progression Coordinator Pattern for Hydrating Progression Snapshots
- **Authors**: Design Documentation Agent (Retroactive Documentation)
- **Reviewers**: Runtime Core Maintainers; Shell UX Maintainers
- **Status**: Approved (Documenting Existing Implementation)
- **Last Updated**: 2025-11-01
- **Related Issues**: #302, #303
- **Execution Mode**: N/A (Retroactive documentation of shipped code)

## 1. Summary

This document describes the **Progression Coordinator pattern** implemented in PR #303, which centralizes progression state management for resources, generators, and upgrades. The coordinator owns authoritative progression state, evaluates unlock/visibility conditions per game step, provides purchase cost evaluators to command handlers, and supports hydration from serialized saves. This is **retroactive documentation** of the existing implementation in `packages/shell-web/src/modules/progression-coordinator.ts`.

## 2. Context & Problem Statement

- **Background**: Prior to PR #303, the runtime worker directly managed progression state through scattered command handlers (`packages/core/src/resource-command-handlers.ts`). The worker lacked a centralized mechanism to evaluate unlock conditions, manage generator/upgrade visibility, or hydrate progression state from saves.

- **Problem**: Without a coordinator pattern, progression logic was fragmented across command handlers, making it difficult to:
  - Evaluate complex unlock conditions defined in content packs
  - Maintain consistent state between fresh sessions and restored saves
  - Provide unified purchase cost quotes to the presentation layer
  - Update generator/upgrade visibility dynamically based on game state

- **Forces**: The solution needed to preserve deterministic command execution, integrate with existing resource state management (`packages/core/src/resource-state.ts`), support the progression snapshot schema defined in `docs/build-resource-generator-upgrade-ui-components-design.md` §6.2, and enable session restoration as specified in `docs/runtime-react-worker-bridge-design.md` §14.1.

## 3. Goals & Non-Goals

**Goals**:
- Centralize ownership of authoritative progression state in a single coordinator
- Evaluate unlock and visibility conditions from content pack definitions
- Provide purchase evaluators implementing `GeneratorPurchaseEvaluator` and `UpgradePurchaseEvaluator` interfaces
- Support hydration from `SerializedResourceState` for session restoration
- Maintain per-tick state updates for dynamic condition evaluation
- Enable building immutable `ProgressionSnapshot` for shell consumption

**Non-Goals**:
- Modifying core resource state storage architecture (remains in `@idle-engine/core`)
- Implementing new condition types beyond those in content schema
- Changing command queue execution model
- Adding new progression features beyond what PR #303 delivered

## 4. Stakeholders, Agents & Impacted Surfaces

- **Primary Stakeholders**: Runtime Core maintainers; Shell UX team consuming snapshots
- **Agent Roles**: N/A (existing implementation)
- **Affected Packages/Services**: `packages/shell-web` (coordinator implementation); `packages/core` (interfaces, resource state, progression types); `packages/content-sample` (consumed by coordinator)
- **Compatibility Considerations**: Coordinator integrates with existing command handlers; saves from pre-PR#303 require migration handled by resource state reconciliation

## 5. Current State

**As implemented in PR #303** (`packages/shell-web/src/modules/progression-coordinator.ts:1-818`):

The coordinator is a facade that:
- Owns a `ResourceState` instance for managing resource amounts/capacity/flags
- Maintains internal mutable records for generators and upgrades
- Exposes frozen `ProgressionAuthoritativeState` to external consumers
- Provides `GeneratorPurchaseEvaluator` and `UpgradePurchaseEvaluator` implementations
- Evaluates content-defined conditions via `condition-evaluator.ts`
- Updates all progression state in `updateForStep()` called every game tick

**Integration point** (`packages/shell-web/src/runtime.worker.ts:134-160`):
- Worker creates coordinator with `sampleContent` and optional `initialState` from saved game
- Coordinator's evaluators are registered with command handlers
- `updateForStep()` is called after runtime step advances (line 225)
- `buildProgressionSnapshot()` uses coordinator's authoritative state (lines 228-232)

## 6. Proposed Solution

> **Note**: This section describes the **existing implementation** from PR #303, not future work.

### 6.1 Architecture Overview

**Pattern**: Facade + Dependency Injection

The coordinator acts as a facade over:
- Resource state (struct-of-arrays storage from `@idle-engine/core`)
- Generator records (mutable internal state mapped to content definitions)
- Upgrade records (mutable internal state with purchase tracking)
- Condition evaluation context (provides state access for condition DSL)

**Diagram**:
```
┌─────────────────────────────────┐
│   Runtime Worker                │
│  ┌──────────────────────────┐   │
│  │ ProgressionCoordinator   │   │
│  │                          │   │
│  │  state: Authoritative    │◄──┼── buildProgressionSnapshot()
│  │  resourceState: Mutable  │   │
│  │  generatorEvaluator      │◄──┼── Command Handlers
│  │  upgradeEvaluator        │   │
│  │                          │   │
│  │  updateForStep(step)     │◄──┼── Per-tick update
│  │  hydrateResources(save)  │◄──┼── Session restore
│  └────────┬─────────────────┘   │
│           │                     │
│           ▼                     │
│  ┌──────────────────┐           │
│  │ Condition        │           │
│  │ Evaluator        │           │
│  └──────────────────┘           │
│           │                     │
│           ▼                     │
│  ┌──────────────────────────┐   │
│  │ Content Pack             │   │
│  │ (generators, upgrades,   │   │
│  │  unlock conditions)      │   │
│  └──────────────────────────┘   │
└─────────────────────────────────┘
```

### 6.2 Detailed Design

#### 6.2.1 Public API Contract

**Interface** (`packages/shell-web/src/modules/progression-coordinator.ts:81-119`):

```typescript
export interface ProgressionCoordinator {
  readonly state: ProgressionAuthoritativeState;
  readonly resourceState: ResourceState;
  readonly generatorEvaluator: GeneratorPurchaseEvaluator;
  readonly upgradeEvaluator?: UpgradePurchaseEvaluator;  // undefined if no upgrades

  hydrateResources(serialized: SerializedResourceState | undefined): void;
  updateForStep(step: number): void;
}
```

**Factory Function** (`packages/shell-web/src/modules/progression-coordinator.ts:167-171`):

```typescript
export function createProgressionCoordinator(
  options: ProgressionCoordinatorOptions,
): ProgressionCoordinator
```

**Options**:
- `content: NormalizedContentPack` - Content definitions for resources/generators/upgrades
- `stepDurationMs: number` - Game tick duration (must be non-negative)
- `initialState?: ProgressionAuthoritativeState` - Optional save state to restore

#### 6.2.2 State Management Strategy

**Hybrid Mutability**:

The coordinator uses **mutable internal records** for performance (`packages/shell-web/src/modules/progression-coordinator.ts:37-54`):

```typescript
type GeneratorRecord = {
  readonly definition: NormalizedGenerator;
  readonly state: Mutable<ProgressionGeneratorState>;
};

type UpgradeRecord = {
  readonly definition: NormalizedUpgrade;
  readonly state: MutableUpgradeState;
  purchases: number;
};
```

**Rationale**: Avoiding allocation churn during per-tick `updateForStep()` calls. Mutating records in-place prevents creating new state objects every tick when conditions are re-evaluated.

**External API**: The `state` property exposes a **frozen view** (`ProgressionAuthoritativeState`) where consumers cannot mutate progression state. This prevents accidental mutation from command handlers or snapshot builders.

#### 6.2.3 Initialization Flow

**Constructor** (`packages/shell-web/src/modules/progression-coordinator.ts:187-285`):

1. **Convert content resources to definitions** (lines 194-206):
   - Maps `NormalizedResource` → `ResourceDefinition`
   - Applies defaults (`startAmount`, `capacity`, `unlocked`, `visible`)

2. **Create or restore resource state** (lines 210-214):
   - If `initialState?.resources?.state` exists, reuse it
   - Otherwise create fresh `ResourceState` with `createResourceState(definitions)`
   - Call `hydrateResources()` with serialized state if available

3. **Build generator records** (lines 223-234):
   - Map content generators to internal `GeneratorRecord`
   - Restore saved generator state if `initialState` provided
   - Initialize unlocked/visible flags, owned count, cost arrays

4. **Build upgrade records** (lines 236-247):
   - Map content upgrades to internal `UpgradeRecord`
   - Restore saved upgrade state if `initialState` provided
   - Infer purchase count from status if not saved (lines 684-693)

5. **Create condition evaluation context** (lines 249-264):
   - Provides closures accessing resource amounts, generator levels, upgrade purchases
   - Context is dependency-injected into `evaluateCondition()` calls

6. **Instantiate evaluators** (lines 266-270):
   - `generatorEvaluator = new ContentGeneratorEvaluator(this)`
   - `upgradeEvaluator = new ContentUpgradeEvaluator(this)` if upgrades exist

7. **Assemble authoritative state** (lines 272-282):
   - Populate `ProgressionAuthoritativeState` with references to resource state, evaluators, and record arrays
   - State is reused across ticks; properties are reassigned rather than recreated

8. **Initial update** (line 284):
   - Call `updateForStep(0)` to evaluate initial unlock/visibility conditions

#### 6.2.4 Per-Tick Update Logic

**`updateForStep(step)`** (`packages/shell-web/src/modules/progression-coordinator.ts:301-350`):

Called by runtime worker after step advances (`packages/shell-web/src/runtime.worker.ts:225`).

**Generator update loop** (lines 304-329):
```typescript
for (const record of this.generatorList) {
  // Evaluate base unlock condition
  const baseUnlock = evaluateCondition(
    record.definition.baseUnlock,
    this.conditionContext,
  );

  // Persistent unlock semantics: once unlocked, never revert
  if (!record.state.isUnlocked && baseUnlock) {
    record.state.isUnlocked = true;
  }

  // Visibility can toggle based on current state
  const visibleCondition = record.definition.visibilityCondition;
  record.state.isVisible = visibleCondition
    ? evaluateCondition(visibleCondition, this.conditionContext)
    : true;

  // Initialize or update nextPurchaseReadyAtStep
  if (!Number.isFinite(record.state.nextPurchaseReadyAtStep)) {
    record.state.nextPurchaseReadyAtStep = step + 1;
  } else if (!wasUnlocked && record.state.isUnlocked) {
    // Reset cooldown on unlock transition
    record.state.nextPurchaseReadyAtStep = step + 1;
  }

  // Clamp owned count to maxLevel if defined
  record.state.owned = clampOwned(record.state.owned, record.definition.maxLevel);
}
```

**Critical Behavior - Persistent Unlocks**:
- `baseUnlock` condition evaluated every tick
- **Once `isUnlocked` transitions to `true`, it NEVER reverts** (line 310-312)
- This ensures generators remain available after unlock conditions are met, even if conditions later fail (e.g., player spends resources below threshold)

**Upgrade update loop** (lines 331-349):
```typescript
for (const record of this.upgradeList) {
  // Resolve status based on prerequisites, unlock condition, purchase count
  const status = this.resolveUpgradeStatus(record);
  record.state.status = status;

  // Evaluate visibility condition
  const visibilityCondition = record.definition.visibilityCondition;
  record.state.isVisible = visibilityCondition
    ? evaluateCondition(visibilityCondition, this.conditionContext)
    : true;

  // Generate unlock hint for locked upgrades
  record.state.unlockHint = status === 'locked'
    ? describeCondition(
        record.definition.unlockCondition ??
        combineConditions(record.definition.prerequisites)
      )
    : undefined;

  // Compute current costs
  record.state.costs = this.computeUpgradeCosts(record);
  record.state.purchases = record.purchases;
}
```

#### 6.2.5 Hydration from Saves

**`hydrateResources(serialized)`** (`packages/shell-web/src/modules/progression-coordinator.ts:287-299`):

Delegates to `hydrateResourceState()` utility (lines 741-788):

1. **Reconcile save against current definitions**:
   - Calls `reconcileSaveAgainstDefinitions(serialized, definitions)` from `@idle-engine/core`
   - Returns `{ remap: number[] }` mapping saved indices to live indices
   - Handles added/removed resources between save and current schema

2. **Restore resource state**:
   - Set capacities from `serialized.capacities[savedIndex]`
   - Adjust amounts: add or spend to match `serialized.amounts[savedIndex]`
   - Restore unlocked/visible flags from bitsets

3. **Publish snapshot**:
   - Call `state.snapshot({ mode: 'publish' })` to flush changes to published buffer

**Integration** (`packages/shell-web/src/runtime.worker.ts:652-798`):
- Worker receives `RESTORE_SESSION` message with `state: SerializedResourceState`
- Preserves coordinator's resource metadata (line 746)
- Stores serialized state for reference (line 747)
- Calls `progressionCoordinator.hydrateResources(message.state)` (line 749)

#### 6.2.6 Purchase Evaluators

**Generator Evaluator** (`packages/shell-web/src/modules/progression-coordinator.ts:483-557`):

Implements `GeneratorPurchaseEvaluator` interface from `@idle-engine/core`.

**`getPurchaseQuote(generatorId, count)`** (lines 486-549):
- Validates count is positive integer
- Checks generator is unlocked and visible
- Validates bulk purchase limit (`maxBulk`)
- Validates not exceeding `maxLevel`
- Computes total cost by summing individual purchase costs using `computeGeneratorCost()`
- Returns `GeneratorPurchaseQuote` with `costs: [{ resourceId, amount }]`
- Returns `undefined` if any validation fails

**`applyPurchase(generatorId, count)`** (lines 551-556):
- Increments generator owned count via `incrementGeneratorOwned()`
- Clamps result to `maxLevel`

**Upgrade Evaluator** (`packages/shell-web/src/modules/progression-coordinator.ts:559-604`):

Implements `UpgradePurchaseEvaluator` interface from `@idle-engine/core`.

**`getPurchaseQuote(upgradeId)`** (lines 562-599):
- Resolves upgrade status (`locked` | `available` | `purchased`)
- Computes costs via `computeUpgradeCosts()`
- Returns quote with status and costs
- For `locked` upgrades, includes costs even though purchase unavailable (for UI display)
- Returns `undefined` if cost computation fails

**`applyPurchase(upgradeId)`** (lines 601-603):
- Increments purchase count via `incrementUpgradePurchases()`
- Clamps to `maxPurchases` for repeatable upgrades

#### 6.2.7 Cost Calculation

**Generator Costs** (`packages/shell-web/src/modules/progression-coordinator.ts:395-419`):

```typescript
computeGeneratorCost(generatorId: string, purchaseIndex: number): number | undefined {
  const baseCost = record.definition.purchase.baseCost;
  const evaluatedCost = evaluateCostFormula(
    record.definition.purchase.costCurve,
    purchaseIndex,
  );
  const cost = evaluatedCost * baseCost;
  return Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}
```

Formula: `cost = baseCost × evaluateCostFormula(costCurve, purchaseIndex)`

**Upgrade Costs** (`packages/shell-web/src/modules/progression-coordinator.ts:421-456`):

```typescript
computeUpgradeCosts(record: UpgradeRecord): readonly UpgradeResourceCost[] | undefined {
  const purchaseLevel = record.purchases;
  const baseCost = record.definition.cost.baseCost;
  const evaluatedCost = evaluateCostFormula(
    record.definition.cost.costCurve,
    purchaseLevel,
  );
  let amount = evaluatedCost * baseCost;

  // Apply repeatable cost curve if upgrade is repeatable
  const repeatableCostCurve = record.definition.repeatable?.costCurve;
  if (repeatableCostCurve) {
    const repeatableAdjustment = evaluateCostFormula(repeatableCostCurve, purchaseLevel);
    amount *= repeatableAdjustment;
  }

  return [{ resourceId: record.definition.cost.currencyId, amount }];
}
```

**Formula for repeatable upgrades**:
```
amount = baseCost × costCurve(purchaseLevel) × repeatableCostCurve(purchaseLevel)
```

**Cost formula evaluation** (lines 790-798):
- Evaluates `NumericFormula` with `{ variables: { level: purchaseLevel } }`
- Returns `undefined` if result is not finite
- Distinguishes from **static threshold evaluation** which uses `level: 0`

#### 6.2.8 Upgrade Status Resolution

**`resolveUpgradeStatus(record)`** (`packages/shell-web/src/modules/progression-coordinator.ts:458-480`):

Returns `'purchased' | 'available' | 'locked'` based on:

1. **Already purchased**: `purchases >= maxPurchases` → `'purchased'`
2. **Prerequisites not met**: Any prerequisite condition fails → `'locked'`
3. **Unlock condition**:
   - If `unlockCondition` defined and fails → `'locked'`
   - If `unlockCondition` passes (or undefined) → `'available'`

**Repeatable upgrades**: For upgrades with `repeatable` config and no `maxPurchases`, `maxPurchases` defaults to `Infinity`, so status remains `'available'` after purchase (tested in `progression-coordinator.test.ts:203-260`).

### 6.3 Operational Considerations

- **Deployment**: Shipped in PR #303; no feature flags or rollout strategy (core infrastructure)
- **Telemetry & Observability**: Coordinator does not emit telemetry directly; telemetry handled by command handlers consuming evaluators
- **Security & Compliance**: No PII; coordinator runs in worker isolation; no security implications

## 7. Work Breakdown & Delivery Plan

**N/A** - This documents completed work from PR #303.

## 8. Agent Guidance & Guardrails

**N/A** - This is retroactive documentation.

## 9. Alternatives Considered

**Alternative 1: Direct evaluator access without coordinator**

Have command handlers directly instantiate generator/upgrade evaluators and evaluate conditions inline.

**Rejected because**:
- Scatters progression logic across multiple command handlers
- Duplicates condition evaluation code
- Makes hydration from saves difficult (no centralized state ownership)
- Complicates testing (must mock multiple handlers instead of single coordinator)

**Alternative 2: Store progression state in ResourceState**

Extend `ResourceState` to also track generators and upgrades.

**Rejected because**:
- `ResourceState` is optimized for struct-of-arrays resource storage; adding generators/upgrades would break that model
- Generators/upgrades have different update semantics (unlock conditions, visibility, purchase counts)
- Would bloat `@idle-engine/core` package with shell-specific concerns

**Alternative 3: Immutable state updates**

Create new state objects every tick instead of mutating records.

**Rejected because**:
- Per-tick allocation churn (every generator/upgrade creates new object)
- Performance cost for large content packs
- Frozen external API already prevents accidental mutation

## 10. Testing & Validation Plan

**Existing test coverage** (`packages/shell-web/src/modules/progression-coordinator.test.ts`):

- **789 lines of integration tests** covering:
  - Repeatable upgrade behavior (lines 203-260)
  - Generator unlock with persistent semantics (lines 278-362)
  - Visibility condition evaluation (lines 299-321)
  - Cost calculation for generators and upgrades
  - Full game loop simulations with resource accumulation

**Condition evaluator tests** (`packages/shell-web/src/modules/condition-evaluator.test.ts`):

- **556 lines of unit tests** covering all condition types, comparators, error handling

**Runtime worker integration tests** (`packages/shell-web/src/runtime.worker.test.ts`):

- Test "hydrates progression snapshot from sample content state" (line 202)
- Test "hydrates live resource state from serialized progression when reusing game state" (line 327)

**Core progression tests** (`packages/core/src/progression.test.ts`):

- Test `nextPurchaseReadyAtStep` defaulting (lines 207-235)
- Test upgrade cost propagation with/without evaluators (lines 237-320)

## 11. Risks & Mitigations

**Risk**: Per-tick condition evaluation has O(n) cost as content scales

**Current Impact**: Low (sample content has ~10 generators/upgrades)

**Mitigation**: If needed in future:
- Add dirty tracking (only re-evaluate when dependencies change)
- Cache condition evaluation results
- Implement incremental evaluation for static conditions

**Risk**: Persistent unlock semantics could conflict with future "conditional unlock reversion" feature

**Impact**: Medium (would require breaking change)

**Mitigation**: Document persistent unlock behavior as **intentional design decision**. If reversion needed, add `revokeUnlock` API rather than changing `updateForStep()` behavior.

## 12. Rollout Plan

**N/A** - Shipped in PR #303 as core infrastructure.

## 13. Open Questions

**None** - This documents completed implementation.

## 14. Follow-Up Work

**Potential future enhancements** (not planned):

- **Incremental condition evaluation**: Track condition dependencies and only re-evaluate when state changes
- **Telemetry integration**: Emit events when generators unlock or upgrades become available
- **Schema versioning**: Add version field to `ProgressionAuthoritativeState` for future migrations
- **Performance profiling**: Benchmark `updateForStep()` with large content packs (1000+ generators)

## 15. References

### Implementation Files
- `packages/shell-web/src/modules/progression-coordinator.ts:1-818` - Coordinator implementation
- `packages/shell-web/src/modules/condition-evaluator.ts:1-283` - Condition evaluation system
- `packages/shell-web/src/modules/progression-coordinator.test.ts:1-789` - Integration tests
- `packages/shell-web/src/runtime.worker.ts:134-160` - Worker integration
- `packages/shell-web/src/runtime.worker.ts:225` - Per-tick update call
- `packages/shell-web/src/runtime.worker.ts:652-798` - Session restore integration
- `packages/core/src/progression.ts:1-400` - Snapshot builder
- `packages/core/src/resource-state.ts` - Resource state storage

### Design Documents
- `docs/build-resource-generator-upgrade-ui-components-design.md` §6.2 - Progression snapshot schema
- `docs/runtime-react-worker-bridge-design.md` §14.1 - Session restore flow
- `docs/resource-state-storage-design.md` §5.3 - Resource hydration mechanics

### Related Issues
- #302 - Issue tracking progression snapshot hydration
- #303 - PR implementing progression coordinator

## Appendix A — Glossary

- **Progression Coordinator**: Facade pattern centralizing progression state ownership and condition evaluation
- **Authoritative State**: Frozen view of progression state exposed to external consumers
- **Purchase Evaluator**: Interface for calculating and applying generator/upgrade purchases
- **Condition Context**: Dependency-injected interface providing state access for condition evaluation
- **Persistent Unlock**: Once a generator's `baseUnlock` condition passes, `isUnlocked` never reverts
- **Static Threshold**: Unlock conditions evaluated with `level: 0` (constant thresholds)
- **Dynamic Cost Curve**: Purchase costs evaluated with `level: purchaseIndex` (scaling curves)
- **Hydration**: Restoring progression state from serialized save data

## Appendix B — Change Log

| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2025-11-01 | Design Documentation Agent | Retroactive documentation of PR #303 implementation |
