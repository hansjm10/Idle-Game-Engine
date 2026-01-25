import type { FormulaEvaluationContext } from '@idle-engine/content-schema';

/**
 * ProgressionCoordinator implementation that composes focused managers.
 *
 * This facade preserves the public coordinator API while delegating each domain
 * (resources, generators, upgrades, prestige, achievements, metrics) to a small
 * module. It is responsible for per-tick orchestration order, cross-manager
 * wiring (condition context + formula context), and any shared caching/derived
 * state (e.g. evaluated upgrade effects).
 */
import type {
  ProgressionAuthoritativeState,
  ProgressionResourceState,
} from '../progression.js';
import type { ResourceDefinition } from '../resource-state.js';
import type { EvaluatedUpgradeEffects } from '../upgrade-effects.js';
import type { ConditionContext } from '../condition-evaluator.js';
import type { EventPublisher } from '../events/event-bus.js';
import { resolveEngineConfig } from '../config.js';

import { AchievementTracker } from './achievement-tracker.js';
import type {
  FormulaEvaluationContextFactory,
  FormulaEvaluationContextOverrides,
} from './formula-context.js';
import { GeneratorManager } from './generator-manager.js';
import { MetricManager } from './metric-manager.js';
import {
  PrestigeManager,
  type PrestigeEvaluatorAccess,
  type PrestigeLayerRecord,
} from './prestige-manager.js';
import { ResourceManager } from './resource-manager.js';
import { UpgradeManager, type UpgradeRecord } from './upgrade-manager.js';
import { getDisplayName, type Mutable } from './progression-utils.js';
import type { GeneratorRecord } from './generator-manager.js';
import type {
  ProgressionCoordinator,
  ProgressionCoordinatorOptions,
} from './progression-coordinator-types.js';

/**
 * Facade implementation of {@link ProgressionCoordinator}.
 *
 * Managers remain mostly independent; this class wires them together without
 * introducing circular dependencies.
 */
export class ProgressionFacade implements ProgressionCoordinator {
  public readonly state: ProgressionAuthoritativeState;
  public readonly resourceState;
  public readonly generatorEvaluator;
  public readonly upgradeEvaluator;
  public readonly prestigeEvaluator;

  private readonly resourceManager: ResourceManager;
  private readonly generatorManager: GeneratorManager;
  private readonly upgradeManager: UpgradeManager;
  private readonly achievementTracker: AchievementTracker;
  private readonly prestigeManager: PrestigeManager;
  private readonly metricManager: MetricManager;
  private readonly conditionContext: ConditionContext;
  private readonly createFormulaEvaluationContext: FormulaEvaluationContextFactory;
  private readonly onError?: (error: Error) => void;
  private readonly grantedAutomationIds = new Set<string>();
  private lastUpdatedStep = 0;

  constructor(options: ProgressionCoordinatorOptions) {
    const engineConfig = resolveEngineConfig(options.config);
    this.onError = options.onError;

    const initialState = options.initialState
      ? (options.initialState as Mutable<ProgressionAuthoritativeState>)
      : undefined;

    const state = initialState ?? ({} as Mutable<ProgressionAuthoritativeState>);
    state.stepDurationMs = options.stepDurationMs;

    this.resourceManager = new ResourceManager({
      resources: options.content.resources,
      initialResourceState: initialState?.resources?.state,
      initialSerializedState: initialState?.resources?.serialized,
      config: options.config,
    });
    this.resourceState = this.resourceManager.resourceState;

    const generatorDisplayNames = new Map<string, string>(
      options.content.generators.map((generator) => [
        generator.id,
        getDisplayName(generator.name, generator.id),
      ]),
    );
    const upgradeDisplayNames = new Map<string, string>(
      options.content.upgrades.map((upgrade) => [
        upgrade.id,
        getDisplayName(upgrade.name, upgrade.id),
      ]),
    );
    const prestigeLayerDefinitions = options.content.prestigeLayers ?? [];
    const prestigeLayerDisplayNames = new Map<string, string>(
      prestigeLayerDefinitions.map((layer) => [
        layer.id,
        getDisplayName(layer.name, layer.id),
      ]),
    );

    let generatorManager: GeneratorManager | undefined = undefined;
    let upgradeManager: UpgradeManager | undefined = undefined;
    let achievementTracker: AchievementTracker | undefined = undefined;
    let prestigeManager: PrestigeManager | undefined = undefined;

    this.conditionContext = {
      maxConditionDepth: engineConfig.limits.maxConditionDepth,
      getResourceAmount: (resourceId) => {
        const index = this.resourceState.getIndex(resourceId);
        return index === undefined ? 0 : this.resourceState.getAmount(index);
      },
      getGeneratorLevel: (generatorId) =>
        generatorManager?.getGeneratorRecord(generatorId)?.state.owned ?? 0,
      getUpgradePurchases: (upgradeId) =>
        upgradeManager?.getUpgradeRecord(upgradeId)?.purchases ?? 0,
      hasPrestigeLayerUnlocked: (prestigeLayerId) =>
        prestigeManager?.getPrestigeLayerRecord(prestigeLayerId)?.state.isUnlocked ??
        false,
      isFlagSet: (flagId) =>
        achievementTracker?.getFlagValue(flagId) ??
        upgradeManager?.getFlagValue(flagId) ??
        false,
      evaluateScriptCondition: options.evaluateScriptCondition,
      resolveResourceName: (resourceId) =>
        this.resourceManager.resourceMetadata.get(resourceId)?.displayName,
      resolveGeneratorName: (generatorId) =>
        generatorDisplayNames.get(generatorId),
      resolveUpgradeName: (upgradeId) => upgradeDisplayNames.get(upgradeId),
      resolvePrestigeLayerName: (prestigeLayerId) =>
        prestigeLayerDisplayNames.get(prestigeLayerId),
    };

    this.createFormulaEvaluationContext = (
      level: number,
      stepValue: number,
      overrides?: FormulaEvaluationContextOverrides,
    ): FormulaEvaluationContext => {
      const deltaTime = (state.stepDurationMs ?? 0) / 1000;
      const time = stepValue * deltaTime;
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
            if (generatorLevels && Object.hasOwn(generatorLevels, generatorId)) {
              return generatorLevels[generatorId];
            }
            return this.conditionContext.getGeneratorLevel(generatorId);
          },
          upgrade: (upgradeId) => {
            if (upgradePurchases && Object.hasOwn(upgradePurchases, upgradeId)) {
              return upgradePurchases[upgradeId];
            }
            return this.conditionContext.getUpgradePurchases(upgradeId);
          },
          automation: () => 0,
          prestigeLayer: () => 0,
        },
      };
    };

    this.achievementTracker = new AchievementTracker({
      achievements: options.content.achievements,
      initialState: initialState?.achievements,
      createFormulaEvaluationContext: this.createFormulaEvaluationContext,
      generatorIds: options.content.generators.map((generator) => generator.id),
      onError: this.onError,
      getCustomMetricValue: options.getCustomMetricValue,
    });
    achievementTracker = this.achievementTracker;

    this.metricManager = new MetricManager({
      metrics: options.content.metrics,
      getCustomMetricValue: options.getCustomMetricValue,
    });

    const onPurchasesChanged = () => {
      this.getUpgradeEffects(this.lastUpdatedStep);
    };

    this.upgradeManager = new UpgradeManager({
      upgrades: options.content.upgrades,
      initialState: initialState?.upgrades,
      createFormulaEvaluationContext: this.createFormulaEvaluationContext,
      getBaseCapacity: (resourceId) => this.resourceManager.getBaseCapacity(resourceId),
      getBaseDirtyTolerance: (resourceId) =>
        this.resourceManager.getBaseDirtyTolerance(resourceId),
      getLastUpdatedStep: () => this.lastUpdatedStep,
      getConditionContext: () => this.conditionContext,
      onPurchasesChanged,
      onError: this.onError,
    });
    upgradeManager = this.upgradeManager;

    this.generatorManager = new GeneratorManager({
      generators: options.content.generators,
      initialState: initialState?.generators,
      onError: this.onError,
      getLastUpdatedStep: () => this.lastUpdatedStep,
      getUpgradeEffects: (stepValue) => this.getUpgradeEffects(stepValue),
      createFormulaEvaluationContext: this.createFormulaEvaluationContext,
    });
    generatorManager = this.generatorManager;

    const prestigeAccess: PrestigeEvaluatorAccess = {
      resourceState: this.resourceState,
      stepDurationMs: state.stepDurationMs ?? 0,
      getLastUpdatedStep: () => this.getLastUpdatedStep(),
      getResourceAmount: (resourceId) => this.getResourceAmount(resourceId),
      getGeneratorOwned: (generatorId) =>
        this.generatorManager.getGeneratorRecord(generatorId)?.state.owned,
      getUpgradePurchases: (upgradeId) =>
        this.upgradeManager.getUpgradeRecord(upgradeId)?.purchases,
      getResourceDefinition: (resourceId) => this.getResourceDefinition(resourceId),
      resetGeneratorForPrestige: (generatorId, resetStep) =>
        this.generatorManager.resetGeneratorForPrestige(generatorId, resetStep),
      resetUpgradeForPrestige: (upgradeId) => {
        const record = this.upgradeManager.getUpgradeRecord(upgradeId);
        if (!record) {
          return false;
        }
        this.setUpgradePurchases(upgradeId, 0);
        return true;
      },
      updateForStep: (stepValue) => this.updateForStep(stepValue),
    };

    this.prestigeManager = new PrestigeManager({
      prestigeLayers: prestigeLayerDefinitions,
      initialState: initialState?.prestigeLayers,
      resourceState: this.resourceState,
      access: prestigeAccess,
    });
    prestigeManager = this.prestigeManager;

    const progressionResources =
      (initialState?.resources as Mutable<ProgressionResourceState> | undefined) ??
      ({} as Mutable<ProgressionResourceState>);
    progressionResources.state = this.resourceState;
    progressionResources.metadata = this.resourceManager.resourceMetadata;

    state.resources = progressionResources;
    this.generatorEvaluator = this.generatorManager.generatorEvaluator;
    state.generatorPurchases = this.generatorEvaluator;
    state.generators = this.generatorManager.getGeneratorStates();

    this.upgradeEvaluator = this.upgradeManager.upgradeEvaluator;
    state.upgradePurchases = this.upgradeEvaluator;
    state.upgrades = this.upgradeManager.getUpgradeStates();

    const achievements = this.achievementTracker.getAchievementStates();
    state.achievements = achievements;

    this.prestigeEvaluator = this.prestigeManager.prestigeEvaluator;
    state.prestigeSystem = this.prestigeEvaluator;
    state.prestigeLayers = this.prestigeManager.getPrestigeLayerStates();

    state.metrics =
      this.metricManager.metricStates.length > 0
        ? this.metricManager.metricStates
        : undefined;
    state.metricValueProvider = this.metricManager.metricValueProvider;

    this.state = state;

    this.updateForStep(0);
  }

  hydrateResources(serialized: ProgressionResourceState['serialized']): void {
    this.resourceManager.hydrateResources(serialized);
  }

  updateForStep(step: number, options?: { readonly events?: EventPublisher }): void {
    this.lastUpdatedStep = step;
    const mutableState = this.state as Mutable<ProgressionAuthoritativeState>;
    mutableState.stepDurationMs = Math.max(0, mutableState.stepDurationMs);

    const maxIterations = Math.max(1, this.achievementTracker.getAchievementCount() + 1);

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      this.achievementTracker.rebuildDerivedRewards(() =>
        this.rebuildCombinedAutomationIds(),
      );

      const upgradeEffects = this.getUpgradeEffects(step);

      this.resourceManager.updateUnlockVisibility(this.conditionContext);
      this.generatorManager.updateForStep(step, this.conditionContext, upgradeEffects);
      this.upgradeManager.updateForStep(step, this.conditionContext);
      this.prestigeManager.updateForStep(this.conditionContext);

      const achievementsUnlocked = this.achievementTracker.updateForStep(
        step,
        this.conditionContext,
        {
          events: options?.events,
          grantResource: (resourceId, amount) =>
            this.grantAchievementResource(resourceId, amount),
          grantUpgrade: (upgradeId) => this.incrementUpgradePurchases(upgradeId),
          onAutomationIdsChanged: () => this.rebuildCombinedAutomationIds(),
        },
      );

      if (!achievementsUnlocked) {
        break;
      }
    }
  }

  getLastUpdatedStep(): number {
    return this.lastUpdatedStep;
  }

  incrementGeneratorOwned(generatorId: string, count: number): void {
    this.generatorManager.incrementGeneratorOwned(generatorId, count);
  }

  setGeneratorEnabled(generatorId: string, enabled: boolean): boolean {
    return this.generatorManager.setGeneratorEnabled(generatorId, enabled);
  }

  incrementUpgradePurchases(upgradeId: string): void {
    this.upgradeManager.incrementUpgradePurchases(upgradeId);
  }

  setUpgradePurchases(upgradeId: string, purchases: number): void {
    this.upgradeManager.setUpgradePurchases(upgradeId, purchases);
  }

  getGrantedAutomationIds(): ReadonlySet<string> {
    return this.grantedAutomationIds;
  }

  getConditionContext(): ConditionContext {
    return this.conditionContext;
  }

  getResourceDefinition(resourceId: string): ResourceDefinition | undefined {
    return this.resourceManager.getResourceDefinition(resourceId);
  }

  get upgrades(): ReadonlyMap<string, UpgradeRecord> {
    return this.upgradeManager.getUpgradeMap();
  }

  getGeneratorRecord(generatorId: string): GeneratorRecord | undefined {
    return this.generatorManager.getGeneratorRecord(generatorId);
  }

  getUpgradeRecord(upgradeId: string): UpgradeRecord | undefined {
    return this.upgradeManager.getUpgradeRecord(upgradeId);
  }

  getPrestigeLayerRecord(layerId: string): PrestigeLayerRecord | undefined {
    return this.prestigeManager.getPrestigeLayerRecord(layerId);
  }

  computeUpgradeCosts(record: UpgradeRecord): ReturnType<UpgradeManager['computeUpgradeCosts']> {
    return this.upgradeManager.computeUpgradeCosts(record);
  }

  computeGeneratorCosts(
    generatorId: string,
    purchaseIndex: number,
  ): ReturnType<GeneratorManager['computeGeneratorCosts']> {
    return this.generatorManager.computeGeneratorCosts(generatorId, purchaseIndex);
  }

  computeGeneratorCost(
    generatorId: string,
    purchaseIndex: number,
  ): ReturnType<GeneratorManager['computeGeneratorCost']> {
    return this.generatorManager.computeGeneratorCost(generatorId, purchaseIndex);
  }

  private getResourceAmount(resourceId: string): number {
    return this.conditionContext.getResourceAmount(resourceId);
  }

  private rebuildCombinedAutomationIds(): void {
    this.grantedAutomationIds.clear();
    for (const automationId of this.upgradeManager.getGrantedAutomationIds()) {
      this.grantedAutomationIds.add(automationId);
    }
    for (const automationId of this.achievementTracker.getGrantedAutomationIds()) {
      this.grantedAutomationIds.add(automationId);
    }
  }

  private getUpgradeEffects(step: number): EvaluatedUpgradeEffects {
    const effects = this.upgradeManager.getUpgradeEffects(step);

    this.upgradeManager.applyDerivedStateFromEffects(effects);
    this.rebuildCombinedAutomationIds();

    this.resourceManager.applyUnlockedResources(effects.unlockedResources);
    this.generatorManager.applyUnlockedGenerators(effects.unlockedGenerators, step);
    this.resourceManager.applyCapacityOverrides(effects.resourceCapacityOverrides);
    this.resourceManager.applyDirtyToleranceOverrides(effects.dirtyToleranceOverrides);

    return effects;
  }

  private grantAchievementResource(resourceId: string, amount: number): void {
    const index = this.resourceState.getIndex(resourceId);
    if (index === undefined) {
      this.onError?.(
        new Error(
          `Achievement grantResource references unknown resource "${resourceId}".`,
        ),
      );
      return;
    }

    const normalizedAmount = Number.isFinite(amount) ? amount : 0;
    if (normalizedAmount <= 0) {
      return;
    }

    if (!this.resourceState.isUnlocked(index)) {
      this.resourceState.unlock(index);
    }
    if (!this.resourceState.isVisible(index)) {
      this.resourceState.grantVisibility(index);
    }
    this.resourceState.addAmount(index, normalizedAmount);
  }
}
