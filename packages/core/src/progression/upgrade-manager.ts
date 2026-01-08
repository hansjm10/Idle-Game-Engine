import type { NormalizedUpgrade, NumericFormula } from '@idle-engine/content-schema';

/**
 * UpgradeManager owns upgrade state, purchase quoting/application, and upgrade effect evaluation.
 *
 * Responsibilities:
 * - Maintain upgrade visibility/status, costs, and unlock hints
 * - Provide a {@link UpgradePurchaseEvaluator} used by command handlers
 * - Evaluate and aggregate upgrade effects into a compact representation that
 *   other managers can consume (e.g. generator rate multipliers, unlock grants)
 *
 * Cross-cutting effects (flags/automations/unlocks/events) are applied here,
 * while the facade coordinates when derived effects should be recomputed.
 */
import type {
  UpgradePurchaseApplicationOptions,
  UpgradePurchaseEvaluator,
  UpgradePurchaseQuote,
  UpgradeResourceCost,
  UpgradeStatus,
} from '../resource-command-handlers.js';
import type { ProgressionUpgradeState } from '../progression.js';
import {
  combineConditions,
  describeCondition,
  evaluateCondition,
  type ConditionContext,
} from '../condition-evaluator.js';
import type { RuntimeEventType } from '../events/runtime-event.js';
import { telemetry } from '../telemetry.js';
import {
  evaluateUpgradeEffects,
  type EvaluatedUpgradeEffects,
  type UpgradeEffectSource,
} from '../upgrade-effects.js';

import type { FormulaEvaluationContextFactory } from './formula-context.js';
import {
  evaluateCostFormula,
  getDisplayName,
  type Mutable,
} from './progression-utils.js';

type MutableUpgradeState = Mutable<ProgressionUpgradeState> & {
  purchases?: number;
};

export type UpgradeRecord = UpgradeEffectSource & {
  readonly state: MutableUpgradeState;
  purchases: number;
};

function createUpgradeRecord(
  upgrade: NormalizedUpgrade,
  initial?: ProgressionUpgradeState,
): UpgradeRecord {
  const state: MutableUpgradeState = initial
    ? (initial as MutableUpgradeState)
    : ({
        id: upgrade.id,
        displayName: getDisplayName(upgrade.name, upgrade.id),
        description: upgrade.description?.default,
        status: 'locked',
        costs: undefined,
        unlockHint: undefined,
        isVisible: true,
      } as MutableUpgradeState);

  state.id = upgrade.id;
  state.displayName = getDisplayName(upgrade.name, upgrade.id);
  state.description = upgrade.description?.default;
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

export class UpgradeManager {
  public readonly upgradeEvaluator: UpgradePurchaseEvaluator | undefined;

  private readonly upgrades: Map<string, UpgradeRecord>;
  private readonly upgradeList: UpgradeRecord[];
  private readonly upgradeDisplayNames: ReadonlyMap<string, string>;
  private readonly createFormulaEvaluationContext: FormulaEvaluationContextFactory;
  private readonly onError?: (error: Error) => void;
  private readonly getBaseCapacity: (resourceId: string) => number;
  private readonly getBaseDirtyTolerance: (resourceId: string) => number;
  private readonly getLastUpdatedStep: () => number;
  private readonly getConditionContext: () => ConditionContext;
  private readonly onPurchasesChanged: () => void;

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

  constructor(options: {
    readonly upgrades: readonly NormalizedUpgrade[];
    readonly initialState?: readonly ProgressionUpgradeState[];
    readonly createFormulaEvaluationContext: FormulaEvaluationContextFactory;
    readonly getBaseCapacity: (resourceId: string) => number;
    readonly getBaseDirtyTolerance: (resourceId: string) => number;
    readonly getLastUpdatedStep: () => number;
    readonly getConditionContext: () => ConditionContext;
    readonly onPurchasesChanged: () => void;
    readonly onError?: (error: Error) => void;
  }) {
    this.createFormulaEvaluationContext = options.createFormulaEvaluationContext;
    this.getBaseCapacity = options.getBaseCapacity;
    this.getBaseDirtyTolerance = options.getBaseDirtyTolerance;
    this.getLastUpdatedStep = options.getLastUpdatedStep;
    this.getConditionContext = options.getConditionContext;
    this.onPurchasesChanged = options.onPurchasesChanged;
    this.onError = options.onError;

    this.upgradeDisplayNames = new Map(
      options.upgrades.map((upgrade) => [
        upgrade.id,
        getDisplayName(upgrade.name, upgrade.id),
      ]),
    );

    this.upgrades = new Map();
    const initialUpgrades = new Map(
      (options.initialState ?? []).map((upgrade) => [upgrade.id, upgrade]),
    );
    this.upgradeList = options.upgrades.map((upgrade) => {
      const record = createUpgradeRecord(
        upgrade,
        initialUpgrades.get(upgrade.id),
      );
      this.upgrades.set(upgrade.id, record);
      return record;
    });

    this.upgradeEvaluator =
      this.upgradeList.length > 0 ? new ContentUpgradeEvaluator(this) : undefined;
  }

  getUpgradeRecord(upgradeId: string): UpgradeRecord | undefined {
    return this.upgrades.get(upgradeId);
  }

  getUpgradeMap(): ReadonlyMap<string, UpgradeRecord> {
    return this.upgrades;
  }

  getUpgradeStates(): readonly ProgressionUpgradeState[] {
    return this.upgradeList.map((record) => record.state);
  }

  getDisplayNames(): ReadonlyMap<string, string> {
    return this.upgradeDisplayNames;
  }

  getFlagValue(flagId: string): boolean | undefined {
    return this.flagState.get(flagId);
  }

  getGrantedAutomationIds(): ReadonlySet<string> {
    return this.grantedAutomationIds;
  }

  applyDerivedStateFromEffects(effects: EvaluatedUpgradeEffects): void {
    this.flagState.clear();
    for (const [flagId, value] of effects.grantedFlags) {
      this.flagState.set(flagId, value);
    }

    this.grantedAutomationIds.clear();
    for (const automationId of effects.grantedAutomations) {
      this.grantedAutomationIds.add(automationId);
    }
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
    this.onPurchasesChanged();
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
    this.onPurchasesChanged();
  }

  getUpgradeEffects(step: number): EvaluatedUpgradeEffects {
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
        getBaseCapacity: this.getBaseCapacity,
        getBaseDirtyTolerance: this.getBaseDirtyTolerance,
        onError: this.onError,
      },
    );

    this.upgradeEffectsCache = {
      step,
      revision: this.upgradePurchasesRevision,
      effects,
    };
    return effects;
  }

  getPurchaseQuote(upgradeId: string): UpgradePurchaseQuote | undefined {
    const record = this.getUpgradeRecord(upgradeId);
    if (!record) {
      return undefined;
    }

    const status = this.resolveUpgradeStatus(record, this.getConditionContext());
    const costs = this.computeUpgradeCosts(record);

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

  updateForStep(step: number, conditionContext: ConditionContext): void {
    for (const record of this.upgradeList) {
      const status = this.resolveUpgradeStatus(record, conditionContext);
      record.state.status = status;
      const visibilityCondition = record.definition.visibilityCondition;
      record.state.isVisible = visibilityCondition
        ? evaluateCondition(visibilityCondition, conditionContext)
        : status !== 'locked';

      record.state.unlockHint =
        status === 'locked'
          ? describeCondition(
              record.definition.unlockCondition ??
                combineConditions(record.definition.prerequisites),
              conditionContext,
            )
          : undefined;

      record.state.costs = this.computeUpgradeCostsAtStep(record, step);
      record.state.purchases = record.purchases;
    }
  }

  resolveUpgradeStatus(
    record: UpgradeRecord,
    conditionContext: ConditionContext,
  ): UpgradeStatus {
    const maxPurchases = record.definition.repeatable
      ? record.definition.repeatable.maxPurchases ?? Number.POSITIVE_INFINITY
      : 1;
    if (record.purchases >= maxPurchases) {
      return 'purchased';
    }

    const prerequisitesMet = record.definition.prerequisites.every((condition) =>
      evaluateCondition(condition, conditionContext),
    );

    if (!prerequisitesMet) {
      return 'locked';
    }

    const unlockCondition = record.definition.unlockCondition;
    if (!unlockCondition) {
      return 'available';
    }
    return evaluateCondition(unlockCondition, conditionContext)
      ? 'available'
      : 'locked';
  }

  computeUpgradeCosts(record: UpgradeRecord): readonly UpgradeResourceCost[] | undefined {
    return this.computeUpgradeCostsAtStep(record, this.getLastUpdatedStep());
  }

  private computeUpgradeCostsAtStep(
    record: UpgradeRecord,
    step: number,
  ): readonly UpgradeResourceCost[] | undefined {
    const costs: UpgradeResourceCost[] = [];
    const purchaseLevel = record.purchases;
    const upgradeId = record.definition.id;

    const repeatableCostCurve = record.definition.repeatable?.costCurve;
    let repeatableAdjustment = 1;
    if (repeatableCostCurve) {
      const evaluatedRepeatable = evaluateCostFormula(
        repeatableCostCurve,
        this.createFormulaEvaluationContext(purchaseLevel, step),
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
      costMultiplier: number,
      costCurve: NumericFormula,
    ) => {
      if (!Number.isFinite(costMultiplier) || costMultiplier < 0) {
        const error = new Error(
          `Upgrade cost calculation failed for "${upgradeId}" (${resourceId}): costMultiplier is invalid (${costMultiplier})`,
        );
        this.onError?.(error);
        return false;
      }

      const evaluatedCost = evaluateCostFormula(
        costCurve,
        this.createFormulaEvaluationContext(purchaseLevel, step),
      );
      if (evaluatedCost === undefined || evaluatedCost < 0) {
        const error = new Error(
          `Upgrade cost calculation failed for "${upgradeId}" (${resourceId}) at purchase level ${purchaseLevel}: cost curve evaluation returned ${evaluatedCost}`,
        );
        this.onError?.(error);
        return false;
      }

      const amount = evaluatedCost * costMultiplier * repeatableAdjustment;
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
        if (!evaluateCostEntry(entry.resourceId, entry.costMultiplier, entry.costCurve)) {
          return undefined;
        }
      }
    } else if (
      !evaluateCostEntry(
        cost.currencyId,
        cost.costMultiplier,
        cost.costCurve,
      )
    ) {
      return undefined;
    }

    return costs;
  }
}

class ContentUpgradeEvaluator implements UpgradePurchaseEvaluator {
  constructor(private readonly upgradeManager: UpgradeManager) {}

  getPurchaseQuote(upgradeId: string): UpgradePurchaseQuote | undefined {
    return this.upgradeManager.getPurchaseQuote(upgradeId);
  }

  applyPurchase(
    upgradeId: string,
    options?: UpgradePurchaseApplicationOptions,
  ): void {
    this.upgradeManager.incrementUpgradePurchases(upgradeId);

    const publisher = options?.events;
    if (!publisher) {
      return;
    }

    const record = this.upgradeManager.getUpgradeRecord(upgradeId);
    if (!record) {
      return;
    }

    const issuedAt = options?.issuedAt;
    const metadata = issuedAt === undefined ? undefined : { issuedAt };

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
