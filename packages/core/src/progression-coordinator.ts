import type {
  Condition,
  NormalizedContentPack,
  NormalizedGenerator,
  NormalizedPrestigeLayer,
  NormalizedResource,
  NormalizedUpgrade,
  NumericFormula,
} from '@idle-engine/content-schema';
import {
  evaluateNumericFormula,
  type FormulaEvaluationContext,
} from '@idle-engine/content-schema';

import {
  createResourceState,
  reconcileSaveAgainstDefinitions,
  type ResourceDefinition,
  type ResourceState,
  type SerializedResourceState,
} from './resource-state.js';
import {
  type GeneratorPurchaseEvaluator,
  type GeneratorPurchaseQuote,
  type GeneratorResourceCost,
  type UpgradePurchaseApplicationOptions,
  type UpgradePurchaseEvaluator,
  type UpgradePurchaseQuote,
  type UpgradeResourceCost,
  type UpgradeStatus,
} from './resource-command-handlers.js';
import {
  type GeneratorRateView,
  type PrestigeQuote,
  type PrestigeRewardPreview,
  type PrestigeSystemEvaluator,
  type ProgressionAuthoritativeState,
  type ProgressionGeneratorState,
  type ProgressionPrestigeLayerState,
  type ProgressionResourceState,
  type ProgressionUpgradeState,
  type ResourceProgressionMetadata,
} from './progression.js';
import {
  applyPrestigeReset,
  type PrestigeResetTarget,
  type PrestigeResourceFlagTarget,
  type PrestigeRetentionTarget,
} from './prestige-reset.js';
import { telemetry } from './telemetry.js';
import {
  combineConditions,
  type ConditionContext,
  describeCondition,
  evaluateCondition,
} from './condition-evaluator.js';
import type { RuntimeEventType } from './events/runtime-event.js';
import {
  evaluateUpgradeEffects,
  type EvaluatedUpgradeEffects,
  type UpgradeEffectSource,
} from './upgrade-effects.js';

type Mutable<T> = {
  -readonly [K in keyof T]: T[K];
};

type GeneratorRecord = {
  readonly definition: NormalizedGenerator;
  readonly state: Mutable<ProgressionGeneratorState>;
};

type ResourceConditionRecord = {
  readonly id: string;
  readonly unlockCondition?: Condition;
  readonly visibilityCondition?: Condition;
};

type MutableUpgradeState = Mutable<ProgressionUpgradeState> & {
  purchases?: number;
};

type UpgradeRecord = {
  readonly definition: NormalizedUpgrade;
  readonly state: MutableUpgradeState;
  purchases: number;
};

type MutablePrestigeLayerState = Mutable<ProgressionPrestigeLayerState>;

type PrestigeLayerRecord = {
  readonly definition: NormalizedPrestigeLayer;
  readonly state: MutablePrestigeLayerState;
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
   * Evaluator for the prestige system, providing quotes and applying prestige.
   * Undefined if the content pack contains no prestige layers.
   */
  readonly prestigeEvaluator?: PrestigeSystemEvaluator;

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

  /**
   * Returns the most recent step passed to {@link updateForStep}.
   *
   * This is typically aligned with the runtime's `currentStep` and is useful
   * when persisting progression state for save/load.
   */
  getLastUpdatedStep(): number;

  /**
   * Increments the owned count for a generator, respecting max level constraints.
   *
   * @param generatorId - Generator identifier
   * @param count - Number of purchases to apply
   */
  incrementGeneratorOwned(generatorId: string, count: number): void;

  /**
   * Enables or disables a generator by ID.
   *
   * @param generatorId - Generator identifier
   * @param enabled - Desired enabled state
   * @returns true when generator exists and was updated
   */
  setGeneratorEnabled(generatorId: string, enabled: boolean): boolean;

  /**
   * Increments the purchase count for an upgrade, respecting max purchase limits.
   *
   * @param upgradeId - Upgrade identifier
   */
  incrementUpgradePurchases(upgradeId: string): void;

  /**
   * Sets the purchase count for an upgrade, respecting max purchase limits.
   *
   * @param upgradeId - Upgrade identifier
   * @param purchases - Desired purchase count (clamped to a non-negative integer)
   */
  setUpgradePurchases(upgradeId: string, purchases: number): void;

  /**
   * Returns automation ids granted by purchased upgrades.
   *
   * @remarks
   * This is derived state (not persisted) and is intended for wiring into the
   * automation system so content packs can unlock automations via upgrade effects.
   */
  getGrantedAutomationIds(): ReadonlySet<string>;

  /**
   * Returns a {@link ConditionContext} bound to the coordinator's current state.
   *
   * @remarks
   * This is intended for wiring into other systems (e.g. AutomationSystem) that
   * need to evaluate shared unlock/visibility semantics.
   */
  getConditionContext(): ConditionContext;

  /**
   * Retrieves the resource definition for a given resource ID.
   * Used by prestige system to access startAmount for resource resets.
   *
   * @param resourceId - Resource identifier
   * @returns The resource definition, or undefined if not found
   */
  getResourceDefinition(resourceId: string): ResourceDefinition | undefined;
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
  public readonly prestigeEvaluator?: PrestigeSystemEvaluator;

  private readonly resourceDefinitions: readonly ResourceDefinition[];
  private readonly resourceConditions: readonly ResourceConditionRecord[];
  private readonly generators: Map<string, GeneratorRecord>;
  private readonly generatorList: GeneratorRecord[];
  private readonly upgrades: Map<string, UpgradeRecord>;
  private readonly upgradeList: UpgradeRecord[];
  private readonly prestigeLayers: Map<string, PrestigeLayerRecord>;
  private readonly prestigeLayerList: PrestigeLayerRecord[];
  private readonly conditionContext: ConditionContext;
  private readonly onError?: (error: Error) => void;
  private readonly baseDirtyToleranceByIndex: Float64Array;
  private readonly dirtyToleranceOverrideIds = new Set<string>();
  private readonly flagState = new Map<string, boolean>();
  private readonly grantedAutomationIds = new Set<string>();
  private upgradePurchasesRevision = 0;
  private upgradeEffectsCache:
    | {
        readonly step: number;
        readonly revision: number;
        readonly effects: EvaluatedUpgradeEffects;
      }
    | undefined;
  private lastUpdatedStep = 0;

  constructor(options: ProgressionCoordinatorOptions) {
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
    this.resourceConditions = options.content.resources.map((resource) => ({
      id: resource.id,
      unlockCondition: resource.unlockCondition,
      visibilityCondition: resource.visibilityCondition,
    }));

    const initialResourceState =
      initialState?.resources?.state ?? undefined;
    this.resourceState =
      initialResourceState ?? createResourceState(resourceDefinitions);
    this.hydrateResources(initialState?.resources?.serialized);
    this.baseDirtyToleranceByIndex = new Float64Array(resourceDefinitions.length);
    for (let index = 0; index < resourceDefinitions.length; index += 1) {
      this.baseDirtyToleranceByIndex[index] = this.resourceState.getDirtyTolerance(
        index,
      );
    }

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

    const prestigeLayerDefinitions = options.content.prestigeLayers ?? [];
    this.prestigeLayers = new Map();
    const initialPrestigeLayers = new Map(
      (initialState?.prestigeLayers ?? []).map((layer) => [layer.id, layer]),
    );
    this.prestigeLayerList = prestigeLayerDefinitions.map((layer: NormalizedPrestigeLayer) => {
      const record = createPrestigeLayerRecord(
        layer,
        initialPrestigeLayers.get(layer.id),
      );
      this.prestigeLayers.set(layer.id, record);
      return record;
    });

    // Validate that each prestige layer has a corresponding prestige count resource
    for (const layer of prestigeLayerDefinitions) {
      const prestigeCountId = `${layer.id}-prestige-count`;
      const index = this.resourceState.getIndex(prestigeCountId);
      if (index === undefined) {
        throw new Error(
          `Prestige layer "${layer.id}" requires a resource named "${prestigeCountId}" to track prestige count. ` +
          `Add this resource to your content pack's resources array.`,
        );
      }
    }

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
      hasPrestigeLayerUnlocked: (prestigeLayerId) => {
        const record = this.prestigeLayers.get(prestigeLayerId);
        return record?.state.isUnlocked ?? false;
      },
      isFlagSet: (flagId) => this.flagState.get(flagId) ?? false,
    };

    this.generatorEvaluator = new ContentGeneratorEvaluator(this);
    this.upgradeEvaluator =
      this.upgradeList.length > 0
        ? new ContentUpgradeEvaluator(this)
        : undefined;
    this.prestigeEvaluator =
      this.prestigeLayerList.length > 0
        ? new ContentPrestigeEvaluator(this)
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
    state.prestigeSystem =
      this.prestigeLayerList.length > 0 ? this.prestigeEvaluator : undefined;
    state.prestigeLayers = this.prestigeLayerList.map((record) => record.state);

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

	  private getUpgradeEffects(step: number): EvaluatedUpgradeEffects {
	    const cached = this.upgradeEffectsCache;
	    if (
	      cached &&
	      cached.step === step &&
	      cached.revision === this.upgradePurchasesRevision
	    ) {
	      return cached.effects;
	    }

	    const effects = evaluateUpgradeEffects(
	      this.upgradeList as readonly UpgradeEffectSource[],
	      {
	        step,
	        createFormulaEvaluationContext: (level, stepValue) =>
	          this.createFormulaEvaluationContext(level, stepValue),
	        getBaseDirtyTolerance: (resourceId) => {
	          const index = this.resourceState.getIndex(resourceId);
	          if (index === undefined) {
	            return 0;
	          }
	          return this.baseDirtyToleranceByIndex[index] ?? 0;
	        },
	        onError: this.onError,
	      },
	    );

	    this.applyUpgradeEffectState(effects, step);
	    this.upgradeEffectsCache = {
	      step,
	      revision: this.upgradePurchasesRevision,
	      effects,
	    };
	    return effects;
	  }

	  private applyUpgradeEffectState(
	    effects: EvaluatedUpgradeEffects,
	    step: number,
	  ): void {
	    this.flagState.clear();
	    for (const [flagId, value] of effects.grantedFlags) {
	      this.flagState.set(flagId, value);
	    }

	    this.grantedAutomationIds.clear();
	    for (const automationId of effects.grantedAutomations) {
	      this.grantedAutomationIds.add(automationId);
	    }

	    for (const resourceId of effects.unlockedResources) {
	      const index = this.resourceState.getIndex(resourceId);
	      if (index === undefined) {
	        continue;
	      }
	      if (!this.resourceState.isUnlocked(index)) {
	        this.resourceState.unlock(index);
	      }
	      if (!this.resourceState.isVisible(index)) {
	        this.resourceState.grantVisibility(index);
	      }
	    }

	    for (const generatorId of effects.unlockedGenerators) {
	      const record = this.generators.get(generatorId);
	      if (!record) {
	        continue;
	      }
	      const wasUnlocked = record.state.isUnlocked;
	      if (!record.state.isUnlocked) {
	        record.state.isUnlocked = true;
	      }
	      record.state.isVisible = true;
	      if (!wasUnlocked) {
	        record.state.nextPurchaseReadyAtStep = step + 1;
	      }
	    }

	    for (const resourceId of this.dirtyToleranceOverrideIds) {
	      const index = this.resourceState.getIndex(resourceId);
	      if (index === undefined) {
	        continue;
	      }
	      this.resourceState.setDirtyTolerance(
	        index,
	        this.baseDirtyToleranceByIndex[index] ?? 0,
	      );
	    }
	    this.dirtyToleranceOverrideIds.clear();

	    for (const [resourceId, tolerance] of effects.dirtyToleranceOverrides) {
	      const index = this.resourceState.getIndex(resourceId);
	      if (index === undefined) {
	        continue;
	      }
	      this.resourceState.setDirtyTolerance(index, tolerance);
	      this.dirtyToleranceOverrideIds.add(resourceId);
	    }
	  }

	  public updateForStep(step: number): void {
	    this.lastUpdatedStep = step;
	    const mutableState = this.state as Mutable<ProgressionAuthoritativeState>;
	    mutableState.stepDurationMs = Math.max(0, mutableState.stepDurationMs);

	    const upgradeEffects = this.getUpgradeEffects(step);

	    for (let index = 0; index < this.resourceConditions.length; index += 1) {
	      const record = this.resourceConditions[index];

      if (record.unlockCondition && !this.resourceState.isUnlocked(index)) {
        if (evaluateCondition(record.unlockCondition, this.conditionContext)) {
          this.resourceState.unlock(index);
        }
      }

      if (record.visibilityCondition && !this.resourceState.isVisible(index)) {
        if (evaluateCondition(record.visibilityCondition, this.conditionContext)) {
          this.resourceState.grantVisibility(index);
        }
      }
    }

	    for (const record of this.generatorList) {
	      const unlockedByUpgrade = upgradeEffects.unlockedGenerators.has(
	        record.definition.id,
	      );
	      const baseUnlock = evaluateCondition(
	        record.definition.baseUnlock,
	        this.conditionContext,
	      );
	      const wasUnlocked = record.state.isUnlocked;
	      if (!record.state.isUnlocked && (baseUnlock || unlockedByUpgrade)) {
	        record.state.isUnlocked = true;
	      }

	      record.state.isVisible = unlockedByUpgrade
	        ? true
	        : this.evaluateVisibility(record.definition.visibilityCondition);

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

	    const generatorRateMultipliers = upgradeEffects.generatorRateMultipliers;
	    const resourceRateMultipliers = upgradeEffects.resourceRateMultipliers;
	    const baseRateContext = this.createFormulaEvaluationContext(1, step);
	    for (const record of this.generatorList) {
	      const baseProduces = buildGeneratorRates(
	        record.definition.produces,
	        baseRateContext,
	      );
	      const baseConsumes = buildGeneratorRates(
	        record.definition.consumes,
	        baseRateContext,
	      );
	      const generatorMultiplier =
	        generatorRateMultipliers.get(record.definition.id) ?? 1;
	      record.state.produces = baseProduces.map((rate) => {
	        const resourceMultiplier =
	          resourceRateMultipliers.get(rate.resourceId) ?? 1;
	        return {
	          ...rate,
	          rate: rate.rate * generatorMultiplier * resourceMultiplier,
	        };
	      });
	      record.state.consumes = baseConsumes.map((rate) => {
	        const resourceMultiplier =
	          resourceRateMultipliers.get(rate.resourceId) ?? 1;
	        return {
	          ...rate,
	          rate: rate.rate * generatorMultiplier * resourceMultiplier,
	        };
	      });
	    }

	    for (const record of this.prestigeLayerList) {
	      const isUnlocked = evaluateCondition(
	        record.definition.unlockCondition,
	        this.conditionContext,
      );
      record.state.isUnlocked = isUnlocked;
      record.state.isVisible = isUnlocked; // Default: visible when unlocked
      record.state.unlockHint = isUnlocked
        ? undefined
        : describeCondition(record.definition.unlockCondition);
    }
  }

  getResourceAmount(resourceId: string): number {
    return this.conditionContext.getResourceAmount(resourceId);
  }

  getLastUpdatedStep(): number {
    return this.lastUpdatedStep;
  }

  getGeneratorRecord(generatorId: string): GeneratorRecord | undefined {
    return this.generators.get(generatorId);
  }

  getUpgradeRecord(upgradeId: string): UpgradeRecord | undefined {
    return this.upgrades.get(upgradeId);
  }

  getPrestigeLayerRecord(layerId: string): PrestigeLayerRecord | undefined {
    return this.prestigeLayers.get(layerId);
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

  setGeneratorEnabled(generatorId: string, enabled: boolean): boolean {
    const record = this.generators.get(generatorId);
    if (!record) {
      return false;
    }
    record.state.enabled = enabled;
    return true;
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
	    this.upgradePurchasesRevision += 1;
	    this.upgradeEffectsCache = undefined;
	    this.getUpgradeEffects(this.lastUpdatedStep);
	  }

	  setUpgradePurchases(upgradeId: string, purchases: number): void {
	    const record = this.upgrades.get(upgradeId);
	    if (!record) {
	      return;
	    }

    const normalizedPurchases =
      Number.isFinite(purchases) && purchases >= 0
        ? Math.floor(purchases)
        : 0;

    const repeatableConfig = record.definition.repeatable;
    const rawMaxPurchases =
      repeatableConfig?.maxPurchases ??
      (repeatableConfig ? Number.POSITIVE_INFINITY : 1);

    if (Number.isFinite(rawMaxPurchases)) {
      const normalizedMax = Math.max(0, Math.floor(rawMaxPurchases));
      record.purchases = Math.min(normalizedPurchases, normalizedMax);
    } else {
      record.purchases = normalizedPurchases;
    }

	    record.state.purchases = record.purchases;
	    this.upgradePurchasesRevision += 1;
		    this.upgradeEffectsCache = undefined;
		    this.getUpgradeEffects(this.lastUpdatedStep);
		  }

	  getGrantedAutomationIds(): ReadonlySet<string> {
	    return this.grantedAutomationIds;
	  }

	  getConditionContext(): ConditionContext {
	    return this.conditionContext;
	  }

	  getResourceDefinition(resourceId: string): ResourceDefinition | undefined {
	    return this.resourceDefinitions.find((r) => r.id === resourceId);
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
    const purchase = record.definition.purchase;
    if ('costs' in purchase) {
      const error = new Error(
        `Generator cost calculation failed for "${generatorId}": multi-cost purchase definitions require computeGeneratorCosts()`,
      );
      this.onError?.(error);
      return undefined;
    }

    const baseCost = purchase.baseCost;
    if (!Number.isFinite(baseCost) || baseCost < 0) {
      const error = new Error(
        `Generator cost calculation failed for "${generatorId}": baseCost is invalid (${baseCost})`,
      );
      this.onError?.(error);
      return undefined;
    }
    const evaluatedCost = evaluateCostFormula(
      purchase.costCurve,
      this.createFormulaEvaluationContext(purchaseIndex, this.lastUpdatedStep, {
        generatorLevels: { [generatorId]: purchaseIndex },
      }),
    );
    if (evaluatedCost === undefined || evaluatedCost < 0) {
      const error = new Error(
        `Generator cost calculation failed for "${generatorId}" at purchase index ${purchaseIndex}: cost curve evaluation returned ${evaluatedCost}`,
      );
      this.onError?.(error);
      return undefined;
    }
	    const upgradeEffects = this.getUpgradeEffects(this.lastUpdatedStep);
	    const multiplier =
	      upgradeEffects.generatorCostMultipliers.get(generatorId) ?? 1;
	    const cost = evaluatedCost * baseCost * multiplier;
	    if (!Number.isFinite(cost) || cost < 0) {
	      const error = new Error(
	        `Generator cost calculation failed for "${generatorId}" at purchase index ${purchaseIndex}: final cost is invalid (${cost})`,
	      );
      this.onError?.(error);
      return undefined;
    }
    return cost;
  }

  computeGeneratorCosts(
    generatorId: string,
    purchaseIndex: number,
  ): readonly GeneratorResourceCost[] | undefined {
    const record = this.generators.get(generatorId);
    if (!record) {
      const error = new Error(
        `Generator cost calculation failed: generator "${generatorId}" not found`,
      );
      this.onError?.(error);
      return undefined;
    }

    const purchase = record.definition.purchase;
    if (!('costs' in purchase)) {
      const cost = this.computeGeneratorCost(generatorId, purchaseIndex);
      if (cost === undefined) {
        return undefined;
      }
      return [
        {
          resourceId: purchase.currencyId,
          amount: cost,
        },
      ];
    }

    const upgradeEffects = this.getUpgradeEffects(this.lastUpdatedStep);
    const multiplier = upgradeEffects.generatorCostMultipliers.get(generatorId) ?? 1;

    const costs: GeneratorResourceCost[] = [];
    for (const entry of purchase.costs) {
      const baseCost = entry.baseCost;
      if (!Number.isFinite(baseCost) || baseCost < 0) {
        const error = new Error(
          `Generator cost calculation failed for "${generatorId}" (${entry.resourceId}): baseCost is invalid (${baseCost})`,
        );
        this.onError?.(error);
        return undefined;
      }

      const evaluatedCost = evaluateCostFormula(
        entry.costCurve,
        this.createFormulaEvaluationContext(purchaseIndex, this.lastUpdatedStep, {
          generatorLevels: { [generatorId]: purchaseIndex },
        }),
      );
      if (evaluatedCost === undefined || evaluatedCost < 0) {
        const error = new Error(
          `Generator cost calculation failed for "${generatorId}" (${entry.resourceId}) at purchase index ${purchaseIndex}: cost curve evaluation returned ${evaluatedCost}`,
        );
        this.onError?.(error);
        return undefined;
      }

      const cost = evaluatedCost * baseCost * multiplier;
      if (!Number.isFinite(cost) || cost < 0) {
        const error = new Error(
          `Generator cost calculation failed for "${generatorId}" (${entry.resourceId}) at purchase index ${purchaseIndex}: final cost is invalid (${cost})`,
        );
        this.onError?.(error);
        return undefined;
      }

      costs.push({
        resourceId: entry.resourceId,
        amount: cost,
      });
    }

    return costs;
  }

  computeUpgradeCosts(record: UpgradeRecord): readonly UpgradeResourceCost[] | undefined {
    const costs: UpgradeResourceCost[] = [];
    const purchaseLevel = record.purchases;
    const upgradeId = record.definition.id;

    const repeatableCostCurve = record.definition.repeatable?.costCurve;
    let repeatableAdjustment = 1;
    if (repeatableCostCurve) {
      const evaluatedRepeatable = evaluateCostFormula(
        repeatableCostCurve,
        this.createFormulaEvaluationContext(purchaseLevel, this.lastUpdatedStep),
      );
      if (evaluatedRepeatable === undefined || evaluatedRepeatable < 0) {
        const error = new Error(
          `Upgrade cost calculation failed for "${upgradeId}" at purchase level ${purchaseLevel}: repeatable cost curve evaluation returned ${evaluatedRepeatable}`,
        );
        this.onError?.(error);
        return undefined;
      }
      repeatableAdjustment = evaluatedRepeatable;
    }

    const evaluateCostEntry = (
      resourceId: string,
      baseCost: number,
      costCurve: NumericFormula,
    ) => {
      if (!Number.isFinite(baseCost) || baseCost < 0) {
        const error = new Error(
          `Upgrade cost calculation failed for "${upgradeId}" (${resourceId}): baseCost is invalid (${baseCost})`,
        );
        this.onError?.(error);
        return false;
      }

      const evaluatedCost = evaluateCostFormula(
        costCurve,
        this.createFormulaEvaluationContext(purchaseLevel, this.lastUpdatedStep),
      );
      if (evaluatedCost === undefined || evaluatedCost < 0) {
        const error = new Error(
          `Upgrade cost calculation failed for "${upgradeId}" (${resourceId}) at purchase level ${purchaseLevel}: cost curve evaluation returned ${evaluatedCost}`,
        );
        this.onError?.(error);
        return false;
      }

      const amount = evaluatedCost * baseCost * repeatableAdjustment;
      if (!Number.isFinite(amount) || amount < 0) {
        const error = new Error(
          `Upgrade cost calculation failed for "${upgradeId}" (${resourceId}) at purchase level ${purchaseLevel}: final amount is invalid (${amount})`,
        );
        this.onError?.(error);
        return false;
      }

      costs.push({
        resourceId,
        amount,
      });

      return true;
    };

    const cost = record.definition.cost;
    if ('costs' in cost) {
      for (const entry of cost.costs) {
        if (!evaluateCostEntry(entry.resourceId, entry.baseCost, entry.costCurve)) {
          return undefined;
        }
      }
    } else {
      if (
        !evaluateCostEntry(
          cost.currencyId,
          cost.baseCost,
          cost.costCurve,
        )
      ) {
        return undefined;
      }
    }

    return costs;
  }

  /**
   * Evaluates visibility condition for generators and upgrades.
   *
   * @param condition - Optional visibility condition to evaluate
   * @returns true if condition passes or is undefined (default visible), false otherwise
   */
  private evaluateVisibility(condition: Condition | undefined): boolean {
    return condition ? evaluateCondition(condition, this.conditionContext) : true;
  }

  private createFormulaEvaluationContext(
    level: number,
    step: number,
    overrides?: {
      readonly generatorLevels?: Readonly<Record<string, number>>;
      readonly upgradePurchases?: Readonly<Record<string, number>>;
    },
  ): FormulaEvaluationContext {
    const deltaTime = (this.state.stepDurationMs ?? 0) / 1000;
    const time = step * deltaTime;
    const generatorLevels = overrides?.generatorLevels;
    const upgradePurchases = overrides?.upgradePurchases;
    return {
      variables: {
        level,
        time,
        deltaTime,
      },
      entities: {
        resource: (resourceId) => this.conditionContext.getResourceAmount(resourceId),
        generator: (generatorId) => {
          if (
            generatorLevels &&
            Object.prototype.hasOwnProperty.call(generatorLevels, generatorId)
          ) {
            return generatorLevels[generatorId];
          }
          return this.conditionContext.getGeneratorLevel(generatorId);
        },
        upgrade: (upgradeId) => {
          if (
            upgradePurchases &&
            Object.prototype.hasOwnProperty.call(upgradePurchases, upgradeId)
          ) {
            return upgradePurchases[upgradeId];
          }
          return this.conditionContext.getUpgradePurchases(upgradeId);
        },
        automation: () => 0,
        prestigeLayer: () => 0,
      },
    };
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

    const totalCostsByResource = new Map<string, number>();

    for (let offset = 0; offset < count; offset += 1) {
      const purchaseLevel = record.state.owned + offset;
      if (
        record.definition.maxLevel !== undefined &&
        purchaseLevel >= record.definition.maxLevel
      ) {
        return undefined;
      }

      const costs = this.coordinator.computeGeneratorCosts(generatorId, purchaseLevel);
      if (!costs || costs.length === 0) {
        return undefined;
      }

      for (const cost of costs) {
        const previous = totalCostsByResource.get(cost.resourceId) ?? 0;
        const updated = previous + cost.amount;
        if (!Number.isFinite(updated) || updated < 0) {
          return undefined;
        }
        totalCostsByResource.set(cost.resourceId, updated);
      }
    }

    const costs: GeneratorResourceCost[] = Array.from(
      totalCostsByResource,
      ([resourceId, amount]) => ({
        resourceId,
        amount,
      }),
    );

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

	  applyPurchase(
	    upgradeId: string,
	    options?: UpgradePurchaseApplicationOptions,
	  ): void {
	    this.coordinator.incrementUpgradePurchases(upgradeId);

	    const publisher = options?.events;
	    if (!publisher) {
	      return;
	    }

	    const record = this.coordinator.getUpgradeRecord(upgradeId);
	    if (!record) {
	      return;
	    }

	    const issuedAt = options?.issuedAt;
	    const metadata = issuedAt !== undefined ? { issuedAt } : undefined;

	    for (const effect of record.definition.effects) {
	      if (effect.kind !== 'emitEvent') {
	        continue;
	      }

	      try {
	        publisher.publish(effect.eventId as unknown as RuntimeEventType, {}, metadata);
	      } catch (error) {
	        const message = error instanceof Error ? error.message : String(error);
	        telemetry.recordWarning('UpgradeEmitEventFailed', {
	          upgradeId,
	          eventId: effect.eventId,
	          message,
	        });
	      }
	    }
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
        enabled: true,
        isUnlocked: false,
        isVisible: true,
        produces,
        consumes,
        nextPurchaseReadyAtStep: 1,
      } as Mutable<ProgressionGeneratorState>);

  state.id = generator.id;
  state.displayName = getDisplayName(generator.name, generator.id);
  state.owned = Number.isFinite(state.owned) ? state.owned : 0;
  state.enabled = typeof state.enabled === 'boolean' ? state.enabled : true;
  state.isUnlocked = Boolean(state.isUnlocked);
  state.isVisible = state.isVisible ?? true;
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
  context: FormulaEvaluationContext = {
    variables: { level: 1, time: 0, deltaTime: 0 },
  },
): readonly GeneratorRateView[] {
  const rates: GeneratorRateView[] = [];

  for (const entry of entries) {
    const rate = evaluateNumericFormula(entry.rate, context);
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
  context: FormulaEvaluationContext,
): number | undefined {
  try {
    const amount = evaluateNumericFormula(formula, context);
    return Number.isFinite(amount) ? amount : undefined;
  } catch {
    return undefined;
  }
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

function createPrestigeLayerRecord(
  layer: NormalizedPrestigeLayer,
  initial?: ProgressionPrestigeLayerState,
): PrestigeLayerRecord {
  const state: MutablePrestigeLayerState = initial
    ? (initial as MutablePrestigeLayerState)
    : ({
        id: layer.id,
        displayName: getDisplayName(layer.name, layer.id),
        summary: getDisplayName(layer.summary, ''),
        isUnlocked: false,
        isVisible: false,
        unlockHint: undefined,
      } as MutablePrestigeLayerState);

  state.id = layer.id;
  state.displayName = getDisplayName(layer.name, layer.id);
  state.summary = getDisplayName(layer.summary, '');
  state.isUnlocked = Boolean(state.isUnlocked);
  state.isVisible = Boolean(state.isVisible);

  return {
    definition: layer,
    state,
  };
}

class ContentPrestigeEvaluator implements PrestigeSystemEvaluator {
  private readonly usedTokens = new Map<string, number>();
  private static readonly TOKEN_EXPIRATION_MS = 60_000;

  constructor(private readonly coordinator: ProgressionCoordinatorImpl) {}

  getPrestigeQuote(layerId: string): PrestigeQuote | undefined {
    const record = this.coordinator.getPrestigeLayerRecord(layerId);
    if (!record) {
      return undefined;
    }

    const isUnlocked = record.state.isUnlocked;

    // Determine status: locked -> available -> completed
    // 'completed' indicates "has prestiged at least once" but remains available for repeating
    let status: PrestigeQuote['status'];
    if (!isUnlocked) {
      status = 'locked';
    } else {
      // Check if layer has been used at least once via prestige count resource
      const prestigeCountId = `${layerId}-prestige-count`;
      const prestigeCount = this.coordinator.getResourceAmount(prestigeCountId);
      status = prestigeCount >= 1 ? 'completed' : 'available';
    }

    const reward = this.computeRewardPreview(record);

    return {
      layerId,
      status,
      reward,
      resetTargets: record.definition.resetTargets,
      resetGenerators: record.definition.resetGenerators,
      resetUpgrades: record.definition.resetUpgrades,
      retainedTargets: this.computeRetainedTargets(record),
    };
  }

  applyPrestige(layerId: string, confirmationToken?: string): void {
    // Require confirmation token for all prestige operations
    if (!confirmationToken) {
      throw new Error('Prestige operation requires a confirmation token');
    }

    // Clean up expired tokens first
    const now = Date.now();
    for (const [storedToken, timestamp] of this.usedTokens) {
      if (now - timestamp > ContentPrestigeEvaluator.TOKEN_EXPIRATION_MS) {
        this.usedTokens.delete(storedToken);
      }
    }

    // Check for duplicate token
    if (this.usedTokens.has(confirmationToken)) {
      telemetry.recordWarning('PrestigeResetDuplicateToken', { layerId });
      throw new Error('Confirmation token has already been used');
    }

    // Store token with current timestamp
    this.usedTokens.set(confirmationToken, now);

    const record = this.coordinator.getPrestigeLayerRecord(layerId);
    if (!record) {
      throw new Error(`Prestige layer "${layerId}" not found`);
    }

    if (!record.state.isUnlocked) {
      throw new Error(`Prestige layer "${layerId}" is locked`);
    }

    // Log token receipt for debugging (don't log token value to avoid leaking secrets)
    telemetry.recordProgress('PrestigeResetTokenReceived', {
      layerId,
      tokenLength: confirmationToken.length,
    });

    const resourceState = this.coordinator.resourceState;

    // CRITICAL: Capture pre-reset formula context BEFORE any mutations.
    // Retention formulas must see original resource values, not post-reset values.
    const retention = record.definition.retention ?? [];
    const preResetFormulaContext = this.buildFormulaContext();

    // Calculate reward using current resource values (reuse context to avoid rebuild)
    const rewardPreview = this.computeRewardPreview(record, preResetFormulaContext);

    // Collect retained resource IDs to skip during reset
    const retainedResourceIds = new Set<string>();
    const retainedGeneratorIds = new Set<string>();
    const retainedUpgradeIds = new Set<string>();
    for (const entry of retention) {
      if (entry.kind === 'resource') {
        retainedResourceIds.add(entry.resourceId);
      } else if (entry.kind === 'generator') {
        retainedGeneratorIds.add(entry.generatorId);
      } else if (entry.kind === 'upgrade') {
        retainedUpgradeIds.add(entry.upgradeId);
      }
    }

    // Always protect the prestige counter from reset (convention: {layerId}-prestige-count)
    const prestigeCountId = `${layerId}-prestige-count`;
    retainedResourceIds.add(prestigeCountId);

    // Build reset targets with calculated startAmounts (skip retained resources)
    const resetTargets: PrestigeResetTarget[] = [];
    const resetResourceFlags: PrestigeResourceFlagTarget[] = [];
    for (const resetResourceId of record.definition.resetTargets) {
      if (retainedResourceIds.has(resetResourceId)) {
        continue; // Skip retained resources
      }

      const definition = this.coordinator.getResourceDefinition(resetResourceId);
      if (definition) {
        resetTargets.push({
          resourceId: resetResourceId,
          resetToAmount: definition.startAmount ?? 0,
        });
        resetResourceFlags.push({
          resourceId: resetResourceId,
          unlocked: definition.unlocked ?? true,
          visible: Boolean(definition.visible ?? true),
        });
      }
    }

    // Build retention targets with calculated amounts using pre-reset context.
    // Note: Resources in retention WITHOUT an amount formula are simply skipped
    // from resetTargets (handled above), preserving their current value.
    const retentionTargets: PrestigeRetentionTarget[] = [];
    for (const entry of retention) {
      if (entry.kind === 'resource' && entry.amount) {
        const retainedAmount = evaluateNumericFormula(
          entry.amount,
          preResetFormulaContext,
        );
        retentionTargets.push({
          resourceId: entry.resourceId,
          retainedAmount, // applyPrestigeReset handles normalization
        });
      }
      // Upgrades in retention: no action needed, purchase status preserved
    }

    // Delegate all mutations to core
    applyPrestigeReset({
      layerId,
      resourceState,
      reward: {
        resourceId: rewardPreview.resourceId,
        amount: rewardPreview.amount,
      },
      resetTargets,
      retentionTargets,
      resetResourceFlags,
    });

    const resetStep = this.coordinator.getLastUpdatedStep();

    // Reset generators (owned + enabled) unless explicitly retained.
    for (const generatorId of record.definition.resetGenerators ?? []) {
      if (retainedGeneratorIds.has(generatorId)) {
        continue;
      }

      const generatorRecord = this.coordinator.getGeneratorRecord(generatorId);
      if (!generatorRecord) {
        telemetry.recordWarning('PrestigeResetGeneratorSkipped', {
          layerId,
          generatorId,
        });
        continue;
      }

      generatorRecord.state.owned = 0;
      generatorRecord.state.enabled = true;
      generatorRecord.state.isUnlocked = false;
      generatorRecord.state.nextPurchaseReadyAtStep = resetStep + 1;
    }

    // Reset upgrade purchases unless explicitly retained.
    for (const upgradeId of record.definition.resetUpgrades ?? []) {
      if (retainedUpgradeIds.has(upgradeId)) {
        continue;
      }

      const upgradeRecord = this.coordinator.getUpgradeRecord(upgradeId);
      if (!upgradeRecord) {
        telemetry.recordWarning('PrestigeResetUpgradeSkipped', {
          layerId,
          upgradeId,
        });
        continue;
      }

      this.coordinator.setUpgradePurchases(upgradeId, 0);
    }

    // Increment prestige counter if resource exists
    const countIndex = resourceState.getIndex(prestigeCountId);
    if (countIndex !== undefined) {
      resourceState.addAmount(countIndex, 1);
    }

    // Re-evaluate unlock/visibility and upgrade effects after destructive reset.
    this.coordinator.updateForStep(resetStep);
  }

  private computeRewardPreview(
    record: PrestigeLayerRecord,
    existingContext?: FormulaEvaluationContext,
  ): PrestigeRewardPreview {
    const rewardDefinition = record.definition.reward;
    const resourceId = rewardDefinition.resourceId;
    const context = existingContext ?? this.buildFormulaContext();

    // Evaluate the base reward formula using current resource amounts
    const baseRewardAmount = evaluateNumericFormula(
      rewardDefinition.baseReward,
      context,
    );

    // Apply multiplier curve if present
    let amount = Number.isFinite(baseRewardAmount) ? baseRewardAmount : 0;
    if (rewardDefinition.multiplierCurve) {
      const multiplier = evaluateNumericFormula(
        rewardDefinition.multiplierCurve,
        context,
      );
      if (Number.isFinite(multiplier)) {
        amount *= multiplier;
      }
    }

    return {
      resourceId,
      amount: Math.max(0, Math.floor(amount)),
    };
  }

  private computeRetainedTargets(record: PrestigeLayerRecord): readonly string[] {
    const retention = record.definition.retention ?? [];
    const retained: string[] = [];

    for (const entry of retention) {
      if (entry.kind === 'resource') {
        retained.push(entry.resourceId);
      } else if (entry.kind === 'generator') {
        retained.push(entry.generatorId);
      } else if (entry.kind === 'upgrade') {
        retained.push(entry.upgradeId);
      }
    }

    return Object.freeze(retained);
  }

  private buildFormulaContext(): FormulaEvaluationContext {
    const resourceState = this.coordinator.resourceState;
    const snapshot = resourceState.snapshot({ mode: 'publish' });

    const step = this.coordinator.getLastUpdatedStep();
    const deltaTime = (this.coordinator.state.stepDurationMs ?? 0) / 1000;
    const time = step * deltaTime;

    // Build variables lookup (for backwards compatibility with variable-style formulas)
    const variables: Record<string, number> = {
      level: 1, // Maintain for backwards compatibility
      time,
      deltaTime,
    };
    for (let i = 0; i < snapshot.ids.length; i++) {
      const resourceId = snapshot.ids[i];
      variables[resourceId] = snapshot.amounts[i] ?? 0;
    }

    // Build entities lookup for entity reference formulas
    const resourceLookup = (id: string): number | undefined => {
      const index = resourceState.getIndex(id);
      return index !== undefined ? (snapshot.amounts[index] ?? 0) : undefined;
    };

    const generatorLookup = (id: string): number | undefined => {
      const record = this.coordinator.getGeneratorRecord(id);
      return record?.state.owned;
    };

    const upgradeLookup = (id: string): number | undefined => {
      const record = this.coordinator.getUpgradeRecord(id);
      return record?.purchases;
    };

    return {
      variables,
      entities: {
        resource: resourceLookup,
        generator: generatorLookup,
        upgrade: upgradeLookup,
      },
    };
  }
}
