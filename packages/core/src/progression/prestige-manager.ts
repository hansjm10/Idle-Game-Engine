import type { NormalizedPrestigeLayer } from '@idle-engine/content-schema';
import {
  evaluateNumericFormula,
  type FormulaEvaluationContext,
} from '@idle-engine/content-schema';

import type {
  PrestigeQuote,
  PrestigeRewardPreview,
  PrestigeSystemEvaluator,
  ProgressionPrestigeLayerState,
} from '../progression.js';
import type { ResourceDefinition, ResourceState } from '../resource-state.js';
import {
  evaluateCondition,
  describeCondition,
  type ConditionContext,
} from '../condition-evaluator.js';
import {
  applyPrestigeReset,
  type PrestigeResetTarget,
  type PrestigeResourceFlagTarget,
  type PrestigeRetentionTarget,
} from '../prestige-reset.js';
import { telemetry } from '../telemetry.js';

import { getDisplayName, type Mutable } from './progression-utils.js';

type MutablePrestigeLayerState = Mutable<ProgressionPrestigeLayerState>;

export type PrestigeLayerRecord = {
  readonly definition: NormalizedPrestigeLayer;
  readonly state: MutablePrestigeLayerState;
};

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

export type PrestigeEvaluatorAccess = Readonly<{
  readonly resourceState: ResourceState;
  readonly stepDurationMs: number;
  getLastUpdatedStep: () => number;
  getResourceAmount: (resourceId: string) => number;
  getGeneratorOwned: (generatorId: string) => number | undefined;
  getUpgradePurchases: (upgradeId: string) => number | undefined;
  getResourceDefinition: (resourceId: string) => ResourceDefinition | undefined;
  resetGeneratorForPrestige: (generatorId: string, resetStep: number) => boolean;
  resetUpgradeForPrestige: (upgradeId: string) => boolean;
  updateForStep: (step: number) => void;
}>;

export class PrestigeManager {
  public readonly prestigeEvaluator?: PrestigeSystemEvaluator;

  private readonly prestigeLayers: Map<string, PrestigeLayerRecord>;
  private readonly prestigeLayerList: PrestigeLayerRecord[];
  private readonly prestigeLayerDisplayNames: ReadonlyMap<string, string>;

  constructor(options: {
    readonly prestigeLayers: readonly NormalizedPrestigeLayer[];
    readonly initialState?: readonly ProgressionPrestigeLayerState[];
    readonly resourceState: ResourceState;
    readonly access: PrestigeEvaluatorAccess;
  }) {
    this.prestigeLayerDisplayNames = new Map(
      options.prestigeLayers.map((layer) => [
        layer.id,
        getDisplayName(layer.name, layer.id),
      ]),
    );

    this.prestigeLayers = new Map();
    const initialLayers = new Map(
      (options.initialState ?? []).map((layer) => [layer.id, layer]),
    );
    this.prestigeLayerList = options.prestigeLayers.map((layer) => {
      const record = createPrestigeLayerRecord(layer, initialLayers.get(layer.id));
      this.prestigeLayers.set(layer.id, record);
      return record;
    });

    for (const layer of options.prestigeLayers) {
      const prestigeCountId = `${layer.id}-prestige-count`;
      const index = options.resourceState.getIndex(prestigeCountId);
      if (index === undefined) {
        throw new Error(
          `Prestige layer "${layer.id}" requires a resource named "${prestigeCountId}" to track prestige count. ` +
          `Add this resource to your content pack's resources array.`,
        );
      }
    }

    this.prestigeEvaluator =
      this.prestigeLayerList.length > 0
        ? new ContentPrestigeEvaluator(options.access, (layerId) =>
            this.getPrestigeLayerRecord(layerId),
          )
        : undefined;
  }

  getPrestigeLayerRecord(layerId: string): PrestigeLayerRecord | undefined {
    return this.prestigeLayers.get(layerId);
  }

  getPrestigeLayerStates(): readonly ProgressionPrestigeLayerState[] {
    return this.prestigeLayerList.map((record) => record.state);
  }

  getDisplayNames(): ReadonlyMap<string, string> {
    return this.prestigeLayerDisplayNames;
  }

  updateForStep(conditionContext: ConditionContext): void {
    for (const record of this.prestigeLayerList) {
      const isUnlocked = evaluateCondition(
        record.definition.unlockCondition,
        conditionContext,
      );
      record.state.isUnlocked = isUnlocked;
      record.state.isVisible = isUnlocked;
      record.state.unlockHint = isUnlocked
        ? undefined
        : describeCondition(record.definition.unlockCondition, conditionContext);
    }
  }
}

class ContentPrestigeEvaluator implements PrestigeSystemEvaluator {
  private readonly usedTokens = new Map<string, number>();
  private static readonly TOKEN_EXPIRATION_MS = 60_000;

  constructor(
    private readonly access: PrestigeEvaluatorAccess,
    private readonly getLayerRecord: (layerId: string) => PrestigeLayerRecord | undefined,
  ) {}

  getPrestigeQuote(layerId: string): PrestigeQuote | undefined {
    const record = this.getLayerRecord(layerId);
    if (!record) {
      return undefined;
    }

    const isUnlocked = record.state.isUnlocked;

    let status: PrestigeQuote['status'];
    if (!isUnlocked) {
      status = 'locked';
    } else {
      const prestigeCountId = `${layerId}-prestige-count`;
      const prestigeCount = this.access.getResourceAmount(prestigeCountId);
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
    if (!confirmationToken) {
      throw new Error('Prestige operation requires a confirmation token');
    }

    const now = Date.now();
    for (const [storedToken, timestamp] of this.usedTokens) {
      if (now - timestamp > ContentPrestigeEvaluator.TOKEN_EXPIRATION_MS) {
        this.usedTokens.delete(storedToken);
      }
    }

    if (this.usedTokens.has(confirmationToken)) {
      telemetry.recordWarning('PrestigeResetDuplicateToken', { layerId });
      throw new Error('Confirmation token has already been used');
    }

    this.usedTokens.set(confirmationToken, now);

    const record = this.getLayerRecord(layerId);
    if (!record) {
      throw new Error(`Prestige layer "${layerId}" not found`);
    }

    if (!record.state.isUnlocked) {
      throw new Error(`Prestige layer "${layerId}" is locked`);
    }

    telemetry.recordProgress('PrestigeResetTokenReceived', {
      layerId,
      tokenLength: confirmationToken.length,
    });

    const resourceState = this.access.resourceState;

    const retention = record.definition.retention ?? [];
    const preResetFormulaContext = this.buildFormulaContext();

    const rewardPreview = this.computeRewardPreview(record, preResetFormulaContext);

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

    const prestigeCountId = `${layerId}-prestige-count`;
    retainedResourceIds.add(prestigeCountId);

    const resetTargets: PrestigeResetTarget[] = [];
    const resetResourceFlags: PrestigeResourceFlagTarget[] = [];
    for (const resetResourceId of record.definition.resetTargets) {
      if (retainedResourceIds.has(resetResourceId)) {
        continue;
      }

      const definition = this.access.getResourceDefinition(resetResourceId);
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

    const retentionTargets: PrestigeRetentionTarget[] = [];
    for (const entry of retention) {
      if (entry.kind === 'resource' && entry.amount) {
        const retainedAmount = evaluateNumericFormula(
          entry.amount,
          preResetFormulaContext,
        );
        retentionTargets.push({
          resourceId: entry.resourceId,
          retainedAmount,
        });
      }
    }

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

    const resetStep = this.access.getLastUpdatedStep();

    for (const generatorId of record.definition.resetGenerators ?? []) {
      if (retainedGeneratorIds.has(generatorId)) {
        continue;
      }

      const reset = this.access.resetGeneratorForPrestige(generatorId, resetStep);
      if (!reset) {
        telemetry.recordWarning('PrestigeResetGeneratorSkipped', {
          layerId,
          generatorId,
        });
      }
    }

    for (const upgradeId of record.definition.resetUpgrades ?? []) {
      if (retainedUpgradeIds.has(upgradeId)) {
        continue;
      }

      const reset = this.access.resetUpgradeForPrestige(upgradeId);
      if (!reset) {
        telemetry.recordWarning('PrestigeResetUpgradeSkipped', {
          layerId,
          upgradeId,
        });
        continue;
      }
    }

    const countIndex = resourceState.getIndex(prestigeCountId);
    if (countIndex !== undefined) {
      resourceState.addAmount(countIndex, 1);
    }

    this.access.updateForStep(resetStep);
  }

  private computeRewardPreview(
    record: PrestigeLayerRecord,
    existingContext?: FormulaEvaluationContext,
  ): PrestigeRewardPreview {
    const rewardDefinition = record.definition.reward;
    const resourceId = rewardDefinition.resourceId;
    const context = existingContext ?? this.buildFormulaContext();

    const baseRewardAmount = evaluateNumericFormula(
      rewardDefinition.baseReward,
      context,
    );

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
    const resourceState = this.access.resourceState;
    const snapshot = resourceState.snapshot({ mode: 'publish' });

    const step = this.access.getLastUpdatedStep();
    const deltaTime = (this.access.stepDurationMs ?? 0) / 1000;
    const time = step * deltaTime;

    const variables: Record<string, number> = {
      level: 1,
      time,
      deltaTime,
    };
    for (let i = 0; i < snapshot.ids.length; i++) {
      const resourceId = snapshot.ids[i];
      variables[resourceId] = snapshot.amounts[i] ?? 0;
    }

    const resourceLookup = (id: string): number | undefined => {
      const index = resourceState.getIndex(id);
      return index !== undefined ? (snapshot.amounts[index] ?? 0) : undefined;
    };

    const generatorLookup = (id: string): number | undefined =>
      this.access.getGeneratorOwned(id);

    const upgradeLookup = (id: string): number | undefined =>
      this.access.getUpgradePurchases(id);

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
