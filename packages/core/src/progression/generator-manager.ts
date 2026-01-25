import {
  evaluateNumericFormula,
  type FormulaEvaluationContext,
  type Condition,
  type NormalizedGenerator,
  type NumericFormula,
} from '@idle-engine/content-schema';

/**
 * GeneratorManager owns generator progression state and quoting logic.
 *
 * Responsibilities:
 * - Maintain generator unlock/visibility state and unlock hints
 * - Compute generator production/consumption rates each step, including upgrade effects
 * - Provide a {@link GeneratorPurchaseEvaluator} for cost quoting/purchasing
 *
 * It relies on the facade-provided condition context and upgrade effects, so it
 * can stay independent of the upgrade/resource modules.
 */
import type {
  GeneratorPurchaseEvaluator,
  GeneratorPurchaseQuote,
  GeneratorResourceCost,
} from '../resource-command-handlers.js';
import type {
  GeneratorRateView,
  ProgressionGeneratorState,
} from '../progression.js';
import type { EvaluatedUpgradeEffects } from '../upgrade-effects.js';
import {
  combineConditions,
  describeCondition,
  evaluateCondition,
  type ConditionContext,
} from '../condition-evaluator.js';

import type {
  FormulaEvaluationContextFactory,
} from './formula-context.js';
import {
  clampOwned,
  evaluateCostFormula,
  getDisplayName,
  type Mutable,
} from './progression-utils.js';

export type GeneratorRecord = {
  readonly definition: NormalizedGenerator;
  readonly state: Mutable<ProgressionGeneratorState>;
};

const DEFAULT_RATE_CONTEXT: FormulaEvaluationContext = {
  variables: { level: 1, time: 0, deltaTime: 0 },
  entities: {
    resource: () => 0,
    generator: () => 0,
    upgrade: () => 0,
    automation: () => 0,
    prestigeLayer: () => 0,
  },
};

function buildGeneratorRates(
  entries: readonly { resourceId: string; rate: NumericFormula }[],
  context?: FormulaEvaluationContext,
): readonly GeneratorRateView[] {
  const rates: GeneratorRateView[] = [];
  const resolvedContext = context ?? DEFAULT_RATE_CONTEXT;

  for (const entry of entries) {
    const rate = evaluateNumericFormula(entry.rate, resolvedContext);
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

function createGeneratorRecord(
  generator: NormalizedGenerator,
  initial?: ProgressionGeneratorState,
): GeneratorRecord {
  const produces = buildGeneratorRates(generator.produces);
  const consumes = buildGeneratorRates(generator.consumes);
  const initialLevel = generator.initialLevel ?? 0;

  const state: Mutable<ProgressionGeneratorState> = initial
    ? (initial as Mutable<ProgressionGeneratorState>)
    : ({
        id: generator.id,
        displayName: getDisplayName(generator.name, generator.id),
        owned: initialLevel,
        enabled: true,
        isUnlocked: initialLevel > 0,
        isVisible: true,
        unlockHint: undefined,
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
  state.unlockHint =
    typeof state.unlockHint === 'string' ? state.unlockHint : undefined;
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

function evaluateVisibility(
  condition: Condition | undefined,
  conditionContext: ConditionContext,
): boolean {
  return condition ? evaluateCondition(condition, conditionContext) : true;
}

export class GeneratorManager {
  public readonly generatorEvaluator: GeneratorPurchaseEvaluator;

  private readonly generators: Map<string, GeneratorRecord>;
  private readonly generatorList: GeneratorRecord[];
  private readonly generatorDisplayNames: ReadonlyMap<string, string>;
  private readonly onError?: (error: Error) => void;
  private readonly getLastUpdatedStep: () => number;
  private readonly getUpgradeEffects: (step: number) => EvaluatedUpgradeEffects;
  private readonly createFormulaEvaluationContext: FormulaEvaluationContextFactory;

  constructor(options: {
    readonly generators: readonly NormalizedGenerator[];
    readonly initialState?: readonly ProgressionGeneratorState[];
    readonly onError?: (error: Error) => void;
    readonly getLastUpdatedStep: () => number;
    readonly getUpgradeEffects: (step: number) => EvaluatedUpgradeEffects;
    readonly createFormulaEvaluationContext: FormulaEvaluationContextFactory;
  }) {
    this.onError = options.onError;
    this.getLastUpdatedStep = options.getLastUpdatedStep;
    this.getUpgradeEffects = options.getUpgradeEffects;
    this.createFormulaEvaluationContext = options.createFormulaEvaluationContext;

    this.generatorDisplayNames = new Map(
      options.generators.map((generator) => [
        generator.id,
        getDisplayName(generator.name, generator.id),
      ]),
    );

    this.generators = new Map();
    const initialGenerators = new Map(
      (options.initialState ?? []).map((generator) => [generator.id, generator]),
    );
    this.generatorList = options.generators.map((generator) => {
      const record = createGeneratorRecord(
        generator,
        initialGenerators.get(generator.id),
      );
      this.generators.set(generator.id, record);
      return record;
    });

    this.generatorEvaluator = new ContentGeneratorEvaluator(this);
  }

  getGeneratorRecord(generatorId: string): GeneratorRecord | undefined {
    return this.generators.get(generatorId);
  }

  getGeneratorStates(): readonly ProgressionGeneratorState[] {
    return this.generatorList.map((record) => record.state);
  }

  getDisplayNames(): ReadonlyMap<string, string> {
    return this.generatorDisplayNames;
  }

  incrementGeneratorOwned(generatorId: string, count: number): void {
    const record = this.generators.get(generatorId);
    if (!record) {
      return;
    }
    record.state.owned = clampOwned(
      record.state.owned + count,
      record.definition.maxLevel,
    );
  }

  setGeneratorEnabled(generatorId: string, enabled: boolean): boolean {
    const record = this.generators.get(generatorId);
    if (!record) {
      return false;
    }
    record.state.enabled = enabled;
    return true;
  }

  resetGeneratorForPrestige(generatorId: string, resetStep: number): boolean {
    const record = this.generators.get(generatorId);
    if (!record) {
      return false;
    }

    const initialLevel = record.definition.initialLevel ?? 0;
    record.state.owned = initialLevel;
    record.state.enabled = true;
    record.state.isUnlocked = initialLevel > 0;
    record.state.nextPurchaseReadyAtStep = resetStep + 1;
    return true;
  }

  applyUnlockedGenerators(
    generatorIds: ReadonlySet<string>,
    step: number,
  ): void {
    for (const generatorId of generatorIds) {
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
  }

  updateForStep(
    step: number,
    conditionContext: ConditionContext,
    upgradeEffects: EvaluatedUpgradeEffects,
  ): void {
    this.updateGeneratorStatusForStep(step, conditionContext, upgradeEffects);
    this.updateGeneratorRatesForStep(step, upgradeEffects);
  }

  private computeGeneratorVisibility(
    record: GeneratorRecord,
    conditionContext: ConditionContext,
    unlockedByUpgrade: boolean,
  ): boolean {
    if (unlockedByUpgrade) {
      return true;
    }

    const visibilityCondition = record.definition.visibilityCondition;
    if (visibilityCondition) {
      return evaluateVisibility(visibilityCondition, conditionContext);
    }

    return record.state.isUnlocked;
  }

  private updateGeneratorStatusForStep(
    step: number,
    conditionContext: ConditionContext,
    upgradeEffects: EvaluatedUpgradeEffects,
  ): void {
    for (const record of this.generatorList) {
      const generatorId = record.definition.id;
      const unlockedByUpgrade = upgradeEffects.unlockedGenerators.has(generatorId);
      const baseUnlock = evaluateCondition(
        record.definition.baseUnlock,
        conditionContext,
      );
      const wasUnlocked = record.state.isUnlocked;
      if (!record.state.isUnlocked && (baseUnlock || unlockedByUpgrade)) {
        record.state.isUnlocked = true;
      }

      const visibilityCondition = record.definition.visibilityCondition;
      record.state.isVisible = this.computeGeneratorVisibility(
        record,
        conditionContext,
        unlockedByUpgrade,
      );

      const conditionsToDescribe =
        visibilityCondition &&
        !record.state.isVisible &&
        visibilityCondition !== record.definition.baseUnlock
          ? [record.definition.baseUnlock, visibilityCondition]
          : [record.definition.baseUnlock];
      record.state.unlockHint = record.state.isUnlocked
        ? undefined
        : describeCondition(
            combineConditions(conditionsToDescribe),
            conditionContext,
          );

      const shouldResetPurchaseReadyAt =
        !Number.isFinite(record.state.nextPurchaseReadyAtStep) ||
        (!wasUnlocked && record.state.isUnlocked);
      if (shouldResetPurchaseReadyAt) {
        record.state.nextPurchaseReadyAtStep = step + 1;
      }
      record.state.owned = clampOwned(
        record.state.owned,
        record.definition.maxLevel,
      );
    }
  }

  private updateGeneratorRatesForStep(
    step: number,
    upgradeEffects: EvaluatedUpgradeEffects,
  ): void {
    const generatorRateMultipliers = upgradeEffects.generatorRateMultipliers;
    const generatorConsumptionMultipliers =
      upgradeEffects.generatorConsumptionMultipliers;
    const generatorResourceConsumptionMultipliers =
      upgradeEffects.generatorResourceConsumptionMultipliers;
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
      const generatorConsumptionMultiplier =
        generatorConsumptionMultipliers.get(record.definition.id) ?? 1;
      const resourceConsumptionMultipliers =
        generatorResourceConsumptionMultipliers.get(record.definition.id);
      record.state.produces = baseProduces.map((rate) => {
        const resourceMultiplier =
          resourceRateMultipliers.get(rate.resourceId) ?? 1;
        return {
          ...rate,
          rate: rate.rate * generatorMultiplier * resourceMultiplier,
        };
      });
      record.state.consumes = baseConsumes.map((rate) => {
        const resourceConsumptionMultiplier =
          resourceConsumptionMultipliers?.get(rate.resourceId) ?? 1;
        const resourceMultiplier =
          resourceRateMultipliers.get(rate.resourceId) ?? 1;
        return {
          ...rate,
          rate:
            rate.rate *
            generatorMultiplier *
            resourceMultiplier *
            generatorConsumptionMultiplier *
            resourceConsumptionMultiplier,
        };
      });
    }
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

    const upgradeEffects = this.getUpgradeEffects(this.getLastUpdatedStep());
    const multiplier = upgradeEffects.generatorCostMultipliers.get(generatorId) ?? 1;

    const costs: GeneratorResourceCost[] = [];
    for (const entry of purchase.costs) {
      const costMultiplier = entry.costMultiplier;
      if (!Number.isFinite(costMultiplier) || costMultiplier < 0) {
        const error = new Error(
          `Generator cost calculation failed for "${generatorId}" (${entry.resourceId}): costMultiplier is invalid (${costMultiplier})`,
        );
        this.onError?.(error);
        return undefined;
      }

      const evaluatedCost = evaluateCostFormula(
        entry.costCurve,
        this.createFormulaEvaluationContext(purchaseIndex, this.getLastUpdatedStep(), {
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

      const cost = evaluatedCost * costMultiplier * multiplier;
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

    const costMultiplier = purchase.costMultiplier;
    if (!Number.isFinite(costMultiplier) || costMultiplier < 0) {
      const error = new Error(
        `Generator cost calculation failed for "${generatorId}": costMultiplier is invalid (${costMultiplier})`,
      );
      this.onError?.(error);
      return undefined;
    }
    const evaluatedCost = evaluateCostFormula(
      purchase.costCurve,
      this.createFormulaEvaluationContext(purchaseIndex, this.getLastUpdatedStep(), {
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
    const upgradeEffects = this.getUpgradeEffects(this.getLastUpdatedStep());
    const multiplier =
      upgradeEffects.generatorCostMultipliers.get(generatorId) ?? 1;
    const cost = evaluatedCost * costMultiplier * multiplier;
    if (!Number.isFinite(cost) || cost < 0) {
      const error = new Error(
        `Generator cost calculation failed for "${generatorId}" at purchase index ${purchaseIndex}: final cost is invalid (${cost})`,
      );
      this.onError?.(error);
      return undefined;
    }
    return cost;
  }
}

class ContentGeneratorEvaluator implements GeneratorPurchaseEvaluator {
  constructor(private readonly generatorManager: GeneratorManager) {}

  private getPurchasableRecord(
    generatorId: string,
    count: number,
  ): GeneratorRecord | undefined {
    if (!Number.isInteger(count) || count <= 0) {
      return undefined;
    }

    const record = this.generatorManager.getGeneratorRecord(generatorId);
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

    return record;
  }

  private computeBulkPurchaseCosts(
    generatorId: string,
    record: GeneratorRecord,
    count: number,
  ): readonly GeneratorResourceCost[] | undefined {
    const totalCostsByResource = new Map<string, number>();
    const baseOwned = record.state.owned;
    const maxLevel = record.definition.maxLevel;

    for (let offset = 0; offset < count; offset += 1) {
      const purchaseLevel = baseOwned + offset;
      if (maxLevel !== undefined && purchaseLevel >= maxLevel) {
        return undefined;
      }
      const costs = this.generatorManager.computeGeneratorCosts(generatorId, purchaseLevel);
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

    return Array.from(
      totalCostsByResource,
      ([resourceId, amount]) => ({
        resourceId,
        amount,
      }),
    );
  }

  getPurchaseQuote(
    generatorId: string,
    count: number,
  ): GeneratorPurchaseQuote | undefined {
    const record = this.getPurchasableRecord(generatorId, count);
    if (!record) {
      return undefined;
    }

    const costs = this.computeBulkPurchaseCosts(generatorId, record, count);
    if (!costs) {
      return undefined;
    }

    return {
      generatorId,
      costs,
    };
  }

  applyPurchase(generatorId: string, count: number): void {
    if (!Number.isInteger(count) || count <= 0) {
      return;
    }
    this.generatorManager.incrementGeneratorOwned(generatorId, count);
  }
}
