import {
  createResourceState,
  reconcileSaveAgainstDefinitions,
  type GeneratorPurchaseEvaluator,
  type GeneratorPurchaseQuote,
  type GeneratorResourceCost,
  type GeneratorRateView,
  type ProgressionAuthoritativeState,
  type ProgressionGeneratorState,
  type ProgressionResourceState,
  type ProgressionUpgradeState,
  type ResourceDefinition,
  type ResourceProgressionMetadata,
  type ResourceState,
  type SerializedResourceState,
  type UpgradePurchaseEvaluator,
  type UpgradePurchaseQuote,
  type UpgradeResourceCost,
  type UpgradeStatus,
} from '@idle-engine/core';
import type {
  Condition,
  NormalizedContentPack,
  NormalizedGenerator,
  NormalizedResource,
  NormalizedUpgrade,
  NumericFormula,
} from '@idle-engine/content-schema';
import { evaluateNumericFormula } from '@idle-engine/content-schema';

import {
  combineConditions,
  type ConditionContext,
  describeCondition,
  evaluateCondition,
} from './condition-evaluator.js';

type Mutable<T> = {
  -readonly [K in keyof T]: T[K];
};

type GeneratorRecord = {
  readonly definition: NormalizedGenerator;
  readonly state: Mutable<ProgressionGeneratorState>;
};

type MutableUpgradeState = Mutable<ProgressionUpgradeState> & {
  purchases?: number;
};

type UpgradeRecord = {
  readonly definition: NormalizedUpgrade;
  readonly state: MutableUpgradeState;
  purchases: number;
};

/**
 * Coordinates progression state for an idle game, managing resources, generators, and upgrades.
 *
 * The coordinator maintains authoritative state and provides evaluators for calculating
 * purchase costs and availability. It handles state updates per game step and supports
 * hydration from serialized saves.
 *
 * @example
 * ```typescript
 * const coordinator = createProgressionCoordinator({
 *   content: normalizedContentPack,
 *   stepDurationMs: 100,
 * });
 *
 * // Hydrate from save data
 * coordinator.hydrateResources(savedResourceState);
 *
 * // Update for current step
 * coordinator.updateForStep(currentStep);
 *
 * // Access state and evaluators
 * const snapshot = buildProgressionSnapshot(step, elapsedMs, coordinator.state);
 * const quote = coordinator.generatorEvaluator.getPurchaseQuote('generator.id', 1);
 * ```
 */
export interface ProgressionCoordinator {
  /**
   * The authoritative progression state containing resources, generators, and upgrades
   */
  readonly state: ProgressionAuthoritativeState;

  /**
   * The resource state manager for tracking resource amounts and metadata
   */
  readonly resourceState: ResourceState;

  /**
   * Evaluator for calculating generator purchase costs and availability
   */
  readonly generatorEvaluator: GeneratorPurchaseEvaluator;

  /**
   * Evaluator for calculating upgrade purchase costs and availability.
   * Undefined if the content pack contains no upgrades.
   */
  readonly upgradeEvaluator?: UpgradePurchaseEvaluator;

  /**
   * Hydrates resource state from serialized save data
   *
   * @param serialized - The serialized resource state from a save file, or undefined to skip hydration
   */
  hydrateResources(serialized: SerializedResourceState | undefined): void;

  /**
   * Updates progression state for the current game step
   *
   * This evaluates unlock conditions, visibility conditions, and updates
   * all generator and upgrade state based on the current game state.
   *
   * @param step - The current game step number
   */
  updateForStep(step: number): void;
}

/**
 * Configuration options for creating a progression coordinator
 */
export interface ProgressionCoordinatorOptions {
  /**
   * The normalized content pack defining game resources, generators, and upgrades
   */
  readonly content: NormalizedContentPack;

  /**
   * Duration of each game step in milliseconds (must be non-negative)
   */
  readonly stepDurationMs: number;

  /**
   * Optional initial progression state to restore from a save.
   * If omitted, creates a fresh state from content definitions.
   */
  readonly initialState?: ProgressionAuthoritativeState;

  /**
   * Optional callback for reporting errors encountered during cost calculations.
   * Called when invalid costs are detected (non-finite or negative values).
   */
  readonly onError?: (error: Error) => void;
}

/**
 * Creates a new progression coordinator for managing game progression state
 *
 * The coordinator handles all progression logic including resource management,
 * generator unlock/visibility evaluation, upgrade availability, and purchase cost calculations.
 *
 * @param options - Configuration options for the coordinator
 * @returns A new progression coordinator instance
 *
 * @example
 * ```typescript
 * // Create a fresh coordinator
 * const coordinator = createProgressionCoordinator({
 *   content: contentPack,
 *   stepDurationMs: 100,
 * });
 *
 * // Restore from save
 * const coordinator = createProgressionCoordinator({
 *   content: contentPack,
 *   stepDurationMs: 100,
 *   initialState: savedProgressionState,
 * });
 * ```
 */
export function createProgressionCoordinator(
  options: ProgressionCoordinatorOptions,
): ProgressionCoordinator {
  return new ProgressionCoordinatorImpl(options);
}

class ProgressionCoordinatorImpl implements ProgressionCoordinator {
  public readonly state: ProgressionAuthoritativeState;
  public readonly resourceState: ResourceState;
  public readonly generatorEvaluator: GeneratorPurchaseEvaluator;
  public readonly upgradeEvaluator?: UpgradePurchaseEvaluator;

  private readonly content: NormalizedContentPack;
  private readonly resourceDefinitions: readonly ResourceDefinition[];
  private readonly generators: Map<string, GeneratorRecord>;
  private readonly generatorList: GeneratorRecord[];
  private readonly upgrades: Map<string, UpgradeRecord>;
  private readonly upgradeList: UpgradeRecord[];
  private readonly conditionContext: ConditionContext;
  private readonly onError?: (error: Error) => void;

  constructor(options: ProgressionCoordinatorOptions) {
    this.content = options.content;
    this.onError = options.onError;

    const initialState = options.initialState
      ? (options.initialState as Mutable<ProgressionAuthoritativeState>)
      : undefined;

    const resourceDefinitions = options.content.resources.map(
      (resource): ResourceDefinition => ({
        id: resource.id,
        startAmount: resource.startAmount ?? 0,
        capacity:
          resource.capacity === null || resource.capacity === undefined
            ? undefined
            : resource.capacity,
        unlocked: resource.unlocked ?? false,
        visible: resource.visible ?? true,
        dirtyTolerance: resource.dirtyTolerance ?? undefined,
      }),
    );

    this.resourceDefinitions = resourceDefinitions;

    const initialResourceState =
      initialState?.resources?.state ?? undefined;
    this.resourceState =
      initialResourceState ?? createResourceState(resourceDefinitions);
    this.hydrateResources(initialState?.resources?.serialized);

    const resourceMetadata = buildResourceMetadata(options.content.resources);
    const progressionResources =
      (initialState?.resources as Mutable<ProgressionResourceState> | undefined) ??
      ({} as Mutable<ProgressionResourceState>);
    progressionResources.state = this.resourceState;
    progressionResources.metadata = resourceMetadata;

    this.generators = new Map();
    const initialGenerators = new Map(
      (initialState?.generators ?? []).map((generator) => [generator.id, generator]),
    );
    this.generatorList = options.content.generators.map((generator) => {
      const record = createGeneratorRecord(
        generator,
        initialGenerators.get(generator.id),
      );
      this.generators.set(generator.id, record);
      return record;
    });

    this.upgrades = new Map();
    const initialUpgrades = new Map(
      (initialState?.upgrades ?? []).map((upgrade) => [upgrade.id, upgrade]),
    );
    this.upgradeList = options.content.upgrades.map((upgrade) => {
      const record = createUpgradeRecord(
        upgrade,
        initialUpgrades.get(upgrade.id),
      );
      this.upgrades.set(upgrade.id, record);
      return record;
    });

    this.conditionContext = {
      getResourceAmount: (resourceId) => {
        const index = this.resourceState.getIndex(resourceId);
        return index === undefined
          ? 0
          : this.resourceState.getAmount(index);
      },
      getGeneratorLevel: (generatorId) => {
        const record = this.generators.get(generatorId);
        return record?.state.owned ?? 0;
      },
      getUpgradePurchases: (upgradeId) => {
        const record = this.upgrades.get(upgradeId);
        return record?.purchases ?? 0;
      },
    };

    this.generatorEvaluator = new ContentGeneratorEvaluator(this);
    this.upgradeEvaluator =
      this.upgradeList.length > 0
        ? new ContentUpgradeEvaluator(this)
        : undefined;

    const state =
      initialState ?? ({} as Mutable<ProgressionAuthoritativeState>);
    state.stepDurationMs = options.stepDurationMs;
    state.resources = progressionResources;
    state.generatorPurchases = this.generatorEvaluator;
    state.generators = this.generatorList.map((record) => record.state);
    state.upgradePurchases =
      this.upgradeList.length > 0 ? this.upgradeEvaluator : undefined;
    state.upgrades = this.upgradeList.map((record) => record.state);

    this.state = state;

    this.updateForStep(0);
  }

  public hydrateResources(
    serialized: SerializedResourceState | undefined,
  ): void {
    if (!serialized) {
      return;
    }

    hydrateResourceState(
      this.resourceState,
      serialized,
      this.resourceDefinitions,
    );
  }

  public updateForStep(step: number): void {
    this.state.stepDurationMs = Math.max(0, this.state.stepDurationMs);

    for (const record of this.generatorList) {
      const baseUnlock = evaluateCondition(
        record.definition.baseUnlock,
        this.conditionContext,
      );
      const wasUnlocked = record.state.isUnlocked;
      if (!record.state.isUnlocked && baseUnlock) {
        record.state.isUnlocked = true;
      }

      record.state.isVisible = this.evaluateVisibility(
        record.definition.visibilityCondition,
      );

      if (!Number.isFinite(record.state.nextPurchaseReadyAtStep)) {
        record.state.nextPurchaseReadyAtStep = step + 1;
      } else if (!wasUnlocked && record.state.isUnlocked) {
        // Update nextPurchaseReadyAtStep when generator transitions to unlocked
        record.state.nextPurchaseReadyAtStep = step + 1;
      }
      record.state.owned = clampOwned(
        record.state.owned,
        record.definition.maxLevel,
      );
    }

    for (const record of this.upgradeList) {
      const status = this.resolveUpgradeStatus(record);
      record.state.status = status;
      record.state.isVisible = this.evaluateVisibility(
        record.definition.visibilityCondition,
      );

      record.state.unlockHint =
        status === 'locked'
          ? describeCondition(
              record.definition.unlockCondition ??
                combineConditions(record.definition.prerequisites),
            )
          : undefined;

      record.state.costs = this.computeUpgradeCosts(record);
      record.state.purchases = record.purchases;
    }
  }

  getResourceAmount(resourceId: string): number {
    return this.conditionContext.getResourceAmount(resourceId);
  }

  getGeneratorRecord(generatorId: string): GeneratorRecord | undefined {
    return this.generators.get(generatorId);
  }

  getUpgradeRecord(upgradeId: string): UpgradeRecord | undefined {
    return this.upgrades.get(upgradeId);
  }

  incrementGeneratorOwned(generatorId: string, count: number): void {
    const record = this.generators.get(generatorId);
    if (!record) {
      return;
    }
    const nextOwned = clampOwned(
      record.state.owned + count,
      record.definition.maxLevel,
    );
    record.state.owned = nextOwned;
  }

  incrementUpgradePurchases(upgradeId: string): void {
    const record = this.upgrades.get(upgradeId);
    if (!record) {
      return;
    }
    const repeatableConfig = record.definition.repeatable;
    const rawMaxPurchases =
      repeatableConfig?.maxPurchases ??
      (repeatableConfig ? Number.POSITIVE_INFINITY : 1);
    const nextPurchases = record.purchases + 1;
    if (Number.isFinite(rawMaxPurchases)) {
      const normalizedMax = Math.max(0, Math.floor(rawMaxPurchases));
      record.purchases = Math.min(nextPurchases, normalizedMax);
    } else {
      record.purchases = nextPurchases;
    }
    record.state.purchases = record.purchases;
  }

  computeGeneratorCost(
    generatorId: string,
    purchaseIndex: number,
  ): number | undefined {
    const record = this.generators.get(generatorId);
    if (!record) {
      const error = new Error(
        `Generator cost calculation failed: generator "${generatorId}" not found`,
      );
      this.onError?.(error);
      return undefined;
    }
    const baseCost = record.definition.purchase.baseCost;
    if (!Number.isFinite(baseCost) || baseCost < 0) {
      const error = new Error(
        `Generator cost calculation failed for "${generatorId}": baseCost is invalid (${baseCost})`,
      );
      this.onError?.(error);
      return undefined;
    }
    const evaluatedCost = evaluateCostFormula(
      record.definition.purchase.costCurve,
      purchaseIndex,
    );
    if (evaluatedCost === undefined || evaluatedCost < 0) {
      const error = new Error(
        `Generator cost calculation failed for "${generatorId}" at purchase index ${purchaseIndex}: cost curve evaluation returned ${evaluatedCost}`,
      );
      this.onError?.(error);
      return undefined;
    }
    const cost = evaluatedCost * baseCost;
    if (!Number.isFinite(cost) || cost < 0) {
      const error = new Error(
        `Generator cost calculation failed for "${generatorId}" at purchase index ${purchaseIndex}: final cost is invalid (${cost})`,
      );
      this.onError?.(error);
      return undefined;
    }
    return cost;
  }

  computeUpgradeCosts(record: UpgradeRecord): readonly UpgradeResourceCost[] | undefined {
    const costs: UpgradeResourceCost[] = [];
    const purchaseLevel = record.purchases;
    const upgradeId = record.definition.id;

    const baseCost = record.definition.cost.baseCost;
    if (!Number.isFinite(baseCost) || baseCost < 0) {
      const error = new Error(
        `Upgrade cost calculation failed for "${upgradeId}": baseCost is invalid (${baseCost})`,
      );
      this.onError?.(error);
      return undefined;
    }
    const evaluatedCost = evaluateCostFormula(
      record.definition.cost.costCurve,
      purchaseLevel,
    );
    if (evaluatedCost === undefined || evaluatedCost < 0) {
      const error = new Error(
        `Upgrade cost calculation failed for "${upgradeId}" at purchase level ${purchaseLevel}: cost curve evaluation returned ${evaluatedCost}`,
      );
      this.onError?.(error);
      return undefined;
    }
    let amount = evaluatedCost * baseCost;
    const repeatableCostCurve = record.definition.repeatable?.costCurve;
    if (repeatableCostCurve) {
      const repeatableAdjustment = evaluateCostFormula(
        repeatableCostCurve,
        purchaseLevel,
      );
      if (repeatableAdjustment === undefined || repeatableAdjustment < 0) {
        const error = new Error(
          `Upgrade cost calculation failed for "${upgradeId}" at purchase level ${purchaseLevel}: repeatable cost curve evaluation returned ${repeatableAdjustment}`,
        );
        this.onError?.(error);
        return undefined;
      }
      amount *= repeatableAdjustment;
    }
    if (!Number.isFinite(amount) || amount < 0) {
      const error = new Error(
        `Upgrade cost calculation failed for "${upgradeId}" at purchase level ${purchaseLevel}: final amount is invalid (${amount})`,
      );
      this.onError?.(error);
      return undefined;
    }
    costs.push({
      resourceId: record.definition.cost.currencyId,
      amount,
    });
    return costs;
  }

  /**
   * Evaluates visibility condition for generators and upgrades.
   *
   * @param condition - Optional visibility condition to evaluate
   * @returns true if condition passes or is undefined (default visible), false otherwise
   */
  private evaluateVisibility(condition: Condition | undefined): boolean {
    return condition
      ? evaluateCondition(condition, this.conditionContext)
      : true;
  }

  resolveUpgradeStatus(record: UpgradeRecord): UpgradeStatus {
    const maxPurchases = record.definition.repeatable
      ? record.definition.repeatable.maxPurchases ?? Number.POSITIVE_INFINITY
      : 1;
    if (record.purchases >= maxPurchases) {
      return 'purchased';
    }

    const prerequisitesMet = record.definition.prerequisites.every((condition) =>
      evaluateCondition(condition, this.conditionContext),
    );

    if (!prerequisitesMet) {
      return 'locked';
    }

    const unlockCondition = record.definition.unlockCondition;
    return unlockCondition
      ? evaluateCondition(unlockCondition, this.conditionContext)
        ? 'available'
        : 'locked'
      : ('available' as UpgradeStatus);
  }
}

class ContentGeneratorEvaluator implements GeneratorPurchaseEvaluator {
  constructor(private readonly coordinator: ProgressionCoordinatorImpl) {}

  getPurchaseQuote(
    generatorId: string,
    count: number,
  ): GeneratorPurchaseQuote | undefined {
    if (!Number.isInteger(count) || count <= 0) {
      return undefined;
    }

    const record = this.coordinator.getGeneratorRecord(generatorId);
    if (!record) {
      return undefined;
    }

    if (!record.state.isUnlocked || !record.state.isVisible) {
      return undefined;
    }

    if (
      record.definition.purchase.maxBulk !== undefined &&
      count > record.definition.purchase.maxBulk
    ) {
      return undefined;
    }

    if (
      record.definition.maxLevel !== undefined &&
      record.state.owned >= record.definition.maxLevel
    ) {
      return undefined;
    }

    const currencyId = record.definition.purchase.currencyId;
    let totalCost = 0;

    for (let offset = 0; offset < count; offset += 1) {
      const purchaseLevel = record.state.owned + offset;
      if (
        record.definition.maxLevel !== undefined &&
        purchaseLevel >= record.definition.maxLevel
      ) {
        return undefined;
      }
      const cost = this.coordinator.computeGeneratorCost(
        generatorId,
        purchaseLevel,
      );
      if (cost === undefined || !Number.isFinite(cost) || cost < 0) {
        return undefined;
      }
      totalCost += cost;
    }

    const costs: GeneratorResourceCost[] = [
      {
        resourceId: currencyId,
        amount: totalCost,
      },
    ];

    return {
      generatorId,
      costs,
    };
  }

  applyPurchase(generatorId: string, count: number): void {
    if (!Number.isInteger(count) || count <= 0) {
      return;
    }
    this.coordinator.incrementGeneratorOwned(generatorId, count);
  }
}

class ContentUpgradeEvaluator implements UpgradePurchaseEvaluator {
  constructor(private readonly coordinator: ProgressionCoordinatorImpl) {}

  getPurchaseQuote(upgradeId: string): UpgradePurchaseQuote | undefined {
    const record = this.coordinator.getUpgradeRecord(upgradeId);
    if (!record) {
      return undefined;
    }

    const status = this.coordinator.resolveUpgradeStatus(record);
    const costs = this.coordinator.computeUpgradeCosts(record);

    if (status === 'locked') {
      return {
        upgradeId,
        status,
        costs: costs ?? [],
      };
    }

    const maxPurchases = record.definition.repeatable
      ? record.definition.repeatable.maxPurchases ?? Number.POSITIVE_INFINITY
      : 1;
    if (record.purchases >= maxPurchases) {
      return {
        upgradeId,
        status: 'purchased',
        costs: [],
      };
    }

    if (!costs) {
      return undefined;
    }

    return {
      upgradeId,
      status,
      costs,
    };
  }

  applyPurchase(upgradeId: string): void {
    this.coordinator.incrementUpgradePurchases(upgradeId);
  }
}

function createGeneratorRecord(
  generator: NormalizedGenerator,
  initial?: ProgressionGeneratorState,
): GeneratorRecord {
  const produces = buildGeneratorRates(generator.produces);
  const consumes = buildGeneratorRates(generator.consumes);

  const state: Mutable<ProgressionGeneratorState> = initial
    ? (initial as Mutable<ProgressionGeneratorState>)
    : ({
        id: generator.id,
        displayName: getDisplayName(generator.name, generator.id),
        owned: 0,
        isUnlocked: false,
        isVisible: true,
        costs: [],
        produces,
        consumes,
        nextPurchaseReadyAtStep: 1,
      } as Mutable<ProgressionGeneratorState>);

  state.id = generator.id;
  state.displayName = getDisplayName(generator.name, generator.id);
  state.owned = Number.isFinite(state.owned) ? state.owned : 0;
  state.isUnlocked = Boolean(state.isUnlocked);
  state.isVisible = state.isVisible ?? true;
  state.costs = Array.isArray(state.costs) ? state.costs : [];
  state.produces = produces;
  state.consumes = consumes;
  state.nextPurchaseReadyAtStep = Number.isFinite(
    state.nextPurchaseReadyAtStep,
  )
    ? state.nextPurchaseReadyAtStep
    : 1;

  return {
    definition: generator,
    state,
  };
}

function createUpgradeRecord(
  upgrade: NormalizedUpgrade,
  initial?: ProgressionUpgradeState,
): UpgradeRecord {
  const state: MutableUpgradeState = initial
    ? (initial as MutableUpgradeState)
    : ({
        id: upgrade.id,
        displayName: getDisplayName(upgrade.name, upgrade.id),
        status: 'locked',
        costs: undefined,
        unlockHint: undefined,
        isVisible: true,
      } as MutableUpgradeState);

  state.id = upgrade.id;
  state.displayName = getDisplayName(upgrade.name, upgrade.id);
  state.isVisible = Boolean(state.isVisible);
  state.costs = Array.isArray(state.costs) ? state.costs : undefined;
  state.status = state.status ?? 'locked';

  const repeatableConfig = upgrade.repeatable;
  const rawMaxPurchases =
    repeatableConfig?.maxPurchases ??
    (repeatableConfig ? Number.POSITIVE_INFINITY : 1);
  const normalizedMaxPurchases =
    Number.isFinite(rawMaxPurchases) && rawMaxPurchases > 0
      ? Math.max(0, Math.floor(rawMaxPurchases))
      : rawMaxPurchases;

  const savedPurchases = state.purchases;
  const normalizedSavedPurchases =
    savedPurchases !== undefined && Number.isFinite(savedPurchases)
      ? Math.max(0, Math.floor(savedPurchases))
      : undefined;

  let purchases: number;
  if (normalizedSavedPurchases !== undefined) {
    purchases = normalizedSavedPurchases;
  } else if (state.status === 'purchased') {
    purchases =
      Number.isFinite(normalizedMaxPurchases) && normalizedMaxPurchases > 0
        ? normalizedMaxPurchases
        : 1;
  } else {
    purchases = 0;
  }

  if (Number.isFinite(normalizedMaxPurchases)) {
    purchases = Math.min(purchases, normalizedMaxPurchases);
  }
  purchases = Math.max(0, Math.floor(purchases));
  state.purchases = purchases;

  return {
    definition: upgrade,
    state,
    purchases,
  };
}

function buildResourceMetadata(
  resources: readonly NormalizedResource[],
): ReadonlyMap<string, ResourceProgressionMetadata> {
  const metadata = new Map<string, ResourceProgressionMetadata>();
  for (const resource of resources) {
    metadata.set(resource.id, {
      displayName: getDisplayName(resource.name, resource.id),
    });
  }
  return metadata;
}

function buildGeneratorRates(
  entries: readonly { resourceId: string; rate: NumericFormula }[],
): readonly GeneratorRateView[] {
  const rates: GeneratorRateView[] = [];

  for (const entry of entries) {
    const rate = evaluateNumericFormula(entry.rate, {
      variables: { level: 1 },
    });
    if (!Number.isFinite(rate)) {
      continue;
    }
    rates.push({
      resourceId: entry.resourceId,
      rate,
    });
  }

  return rates;
}

function hydrateResourceState(
  state: ResourceState,
  serialized: SerializedResourceState,
  definitions: readonly ResourceDefinition[],
): void {
  const reconciliation = reconcileSaveAgainstDefinitions(
    serialized,
    definitions,
  );

  const { remap } = reconciliation;
  const unlocked = serialized.unlocked ?? [];
  const visible = serialized.visible ?? [];

  for (let savedIndex = 0; savedIndex < remap.length; savedIndex += 1) {
    const liveIndex = remap[savedIndex];
    if (liveIndex === undefined) {
      continue;
    }

    const resolvedCapacity = serialized.capacities[savedIndex];
    const capacity =
      resolvedCapacity === null || resolvedCapacity === undefined
        ? Number.POSITIVE_INFINITY
        : resolvedCapacity;
    state.setCapacity(liveIndex, capacity);

    const targetAmount = serialized.amounts[savedIndex] ?? 0;
    const currentAmount = state.getAmount(liveIndex);
    if (targetAmount > currentAmount) {
      state.addAmount(liveIndex, targetAmount - currentAmount);
    } else if (targetAmount < currentAmount) {
      const delta = currentAmount - targetAmount;
      if (delta > 0) {
        state.spendAmount(liveIndex, delta);
      }
    }

    if (unlocked[savedIndex]) {
      state.unlock(liveIndex);
    }
    if (visible[savedIndex]) {
      state.grantVisibility(liveIndex);
    }
  }

  state.snapshot({ mode: 'publish' });
}

function evaluateCostFormula(
  formula: NumericFormula,
  purchaseLevel: number,
): number | undefined {
  const amount = evaluateNumericFormula(formula, {
    variables: { level: purchaseLevel },
  });
  return Number.isFinite(amount) ? amount : undefined;
}

function clampOwned(owned: number, maxLevel?: number): number {
  const normalizedOwned = Number.isFinite(owned) ? owned : 0;
  if (maxLevel === undefined) {
    return Math.max(0, normalizedOwned);
  }
  const upperBound = Math.max(0, maxLevel);
  return Math.max(0, Math.min(normalizedOwned, upperBound));
}

function getDisplayName(
  name: NormalizedResource['name'],
  fallback: string,
): string {
  if (typeof name === 'string') {
    return name;
  }
  return name?.default ?? fallback;
}
