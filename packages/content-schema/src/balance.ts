import type { Condition } from './base/conditions.js';
import type { NumericFormula } from './base/formulas.js';
import { evaluateNumericFormula } from './base/formula-evaluator.js';
import type { ContentSchemaWarning } from './errors.js';
import type {
  NormalizedContentPack,
  NormalizedAchievement,
  NormalizedGenerator,
  NormalizedPrestigeLayer,
  NormalizedResource,
  NormalizedUpgrade,
} from './pack.js';

const DEFAULT_SAMPLE_SIZE = 100;
const DEFAULT_MAX_GROWTH = 20;
const EPSILON = 1e-9;

export interface BalanceValidationOptions {
  readonly enabled?: boolean;
  /**
   * Maximum purchase index (inclusive) sampled when probing rates and costs.
   * For example, a sample size of 100 will evaluate levels 0 through 100.
   */
  readonly sampleSize?: number;
  /**
   * Maximum allowed multiplicative growth between adjacent purchase indices.
   * A value of 20 caps each step to at most 20x the previous cost/reward.
   */
  readonly maxGrowth?: number;
  /**
   * When true, balance issues are reported but do not fail validation.
   */
  readonly warnOnly?: boolean;
}

export interface BalanceCheckResult {
  readonly warnings: readonly ContentSchemaWarning[];
  readonly errors: readonly ContentSchemaWarning[];
}

type IssueSink = (issue: ContentSchemaWarning) => void;

type CostProgression = {
  readonly values: readonly number[];
  readonly path: readonly (string | number)[];
  readonly entityId: string;
  readonly resourceId?: string;
  readonly kind: 'generator' | 'upgrade' | 'prestige';
};

type UnlockOrderingLookup = Readonly<{
  readonly resources: ReadonlyMap<string, NormalizedResource>;
  readonly generators: ReadonlyMap<string, NormalizedGenerator>;
  readonly upgrades: ReadonlyMap<string, NormalizedUpgrade>;
}>;

type ConditionResourceLookup = Pick<UnlockOrderingLookup, 'generators' | 'upgrades'>;

type FlagResourceLookup = ReadonlyMap<string, ReadonlySet<string>>;

const createLevelSamples = (
  sampleSize: number,
  maxLevel: number | undefined,
): readonly number[] => {
  const limit = maxLevel === undefined ? sampleSize : Math.min(sampleSize, maxLevel);
  const levels: number[] = [];
  for (let level = 0; level <= limit; level += 1) {
    levels.push(level);
  }
  return levels;
};

const createEvaluationContext = (level: number) => ({
  variables: { level, time: 0, deltaTime: 1 },
  entities: {
    resource: () => 0,
    generator: () => 0,
    upgrade: () => 0,
    automation: () => 0,
    prestigeLayer: () => 0,
  },
});

const evaluateFormula = (
  formula: NumericFormula,
  level: number,
): { readonly ok: true; readonly value: number } | { readonly ok: false; readonly error: unknown } => {
  try {
    const value = evaluateNumericFormula(formula, createEvaluationContext(level));
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error };
  }
};

const recordIssue = (
  issue: ContentSchemaWarning,
  warnings: ContentSchemaWarning[],
  errors: ContentSchemaWarning[],
  sink?: IssueSink,
) => {
  sink?.(issue);
  if (issue.severity === 'warning') {
    warnings.push(issue);
  } else {
    errors.push(issue);
  }
};

const checkNonNegativeRates = (
  generator: NormalizedGenerator,
  generatorIndex: number,
  sampleLevels: readonly number[],
  warnings: ContentSchemaWarning[],
  errors: ContentSchemaWarning[],
  sink?: IssueSink,
) => {
  const visitRate = (
    formula: NumericFormula,
    path: readonly (string | number)[],
    resourceId: string,
  ) => {
    for (const level of sampleLevels) {
      const evaluation = evaluateFormula(formula, level);
      if (!evaluation.ok) {
        recordIssue(
          {
            code: 'balance.rate.evaluationFailed',
            message: `Formula evaluation failed for "${resourceId}" at level ${level} in generator "${generator.id}".`,
            path,
            severity: 'error',
            suggestion: 'Ensure referenced variables/entities are available and formulas avoid invalid operations.',
          },
          warnings,
          errors,
          sink,
        );
        return;
      }
      const value = evaluation.value;
      if (!Number.isFinite(value)) {
        recordIssue(
          {
            code: 'balance.rate.nonFinite',
            message: `Rate for "${resourceId}" in generator "${generator.id}" is non-finite at level ${level}.`,
            path,
            severity: 'error',
          },
          warnings,
          errors,
          sink,
        );
        return;
      }
      if (value < 0) {
        recordIssue(
          {
            code: 'balance.rate.negative',
            message: `Rate for "${resourceId}" in generator "${generator.id}" is negative at level ${level}.`,
            path,
            severity: 'error',
          },
          warnings,
          errors,
          sink,
        );
        return;
      }
    }
  };

  generator.produces.forEach((entry, index) =>
    visitRate(entry.rate, ['generators', generatorIndex, 'produces', index, 'rate'], entry.resourceId),
  );
  generator.consumes.forEach((entry, index) =>
    visitRate(entry.rate, ['generators', generatorIndex, 'consumes', index, 'rate'], entry.resourceId),
  );
};

const checkCostProgression = (
  progression: CostProgression,
  maxGrowth: number,
  warnings: ContentSchemaWarning[],
  errors: ContentSchemaWarning[],
  sink?: IssueSink,
) => {
  if (progression.values.length <= 1) {
    return;
  }

  const label = progression.resourceId ? ` (${progression.resourceId})` : '';
  let previous = progression.values[0] ?? 0;
  progression.values.slice(1).forEach((value, offset) => {
    const level = offset + 1;
    if (value + EPSILON < previous) {
      recordIssue(
        {
          code: 'balance.cost.nonMonotonic',
          message: `Cost for ${progression.kind} "${progression.entityId}"${label} decreases between purchases ${level - 1} and ${level}.`,
          path: progression.path,
          severity: 'error',
        },
        warnings,
        errors,
        sink,
      );
    }

    const baseline = Math.max(previous, EPSILON);
    if (value - baseline * maxGrowth > EPSILON) {
      recordIssue(
        {
          code: 'balance.cost.exceedsGrowthCap',
          message: `Cost growth for ${progression.kind} "${progression.entityId}"${label} exceeds ${maxGrowth}x between purchases ${level - 1} and ${level}.`,
          path: progression.path,
          severity: 'error',
        },
        warnings,
        errors,
        sink,
      );
    }
    previous = value;
  });
};

const collectGeneratorCosts = (
  generator: NormalizedGenerator,
  generatorIndex: number,
  sampleLevels: readonly number[],
  maxGrowth: number,
  warnings: ContentSchemaWarning[],
  errors: ContentSchemaWarning[],
  sink?: IssueSink,
) => {
  const collectCostProgressionForEntry = (
    resourceId: string,
    costMultiplier: number,
    costCurve: NumericFormula,
    pathPrefix: readonly (string | number)[],
  ) => {
    const label = ` (${resourceId})`;
    const costs: number[] = [];
    for (const level of sampleLevels) {
      const evaluation = evaluateFormula(costCurve, level);
      if (!evaluation.ok) {
        recordIssue(
          {
            code: 'balance.cost.evaluationFailed',
            message: `Cost evaluation failed for generator "${generator.id}"${label} at purchase ${level}.`,
            path: [...pathPrefix, 'costCurve'],
            severity: 'error',
          },
          warnings,
          errors,
          sink,
        );
        break;
      }
      const multiplier = evaluation.value;
      if (!Number.isFinite(multiplier)) {
        recordIssue(
          {
            code: 'balance.cost.nonFinite',
            message: `Cost multiplier for generator "${generator.id}"${label} is non-finite at purchase ${level}.`,
            path: [...pathPrefix, 'costCurve'],
            severity: 'error',
          },
          warnings,
          errors,
          sink,
        );
        break;
      }
      if (multiplier < 0) {
        recordIssue(
          {
            code: 'balance.cost.negative',
            message: `Cost multiplier for generator "${generator.id}"${label} is negative at purchase ${level}.`,
            path: [...pathPrefix, 'costCurve'],
            severity: 'error',
          },
          warnings,
          errors,
          sink,
        );
        break;
      }
      const cost = costMultiplier * multiplier;
      if (!Number.isFinite(cost)) {
        recordIssue(
          {
            code: 'balance.cost.nonFinite',
            message: `Computed cost for generator "${generator.id}"${label} is non-finite at purchase ${level}.`,
            path: [...pathPrefix, 'costMultiplier'],
            severity: 'error',
          },
          warnings,
          errors,
          sink,
        );
        break;
      }
      if (cost < 0) {
        recordIssue(
          {
            code: 'balance.cost.negative',
            message: `Computed cost for generator "${generator.id}"${label} is negative at purchase ${level}.`,
            path: [...pathPrefix, 'costMultiplier'],
            severity: 'error',
          },
          warnings,
          errors,
          sink,
        );
        break;
      }
      costs.push(cost);
    }

    checkCostProgression(
      {
        values: costs,
        path: [...pathPrefix, 'costCurve'],
        entityId: generator.id,
        resourceId,
        kind: 'generator',
      },
      maxGrowth,
      warnings,
      errors,
      sink,
    );
  };

  if ('costs' in generator.purchase) {
    generator.purchase.costs.forEach((entry, costIndex) => {
      collectCostProgressionForEntry(
        entry.resourceId,
        entry.costMultiplier,
        entry.costCurve,
        ['generators', generatorIndex, 'purchase', 'costs', costIndex],
      );
    });
    return;
  }

  collectCostProgressionForEntry(
    generator.purchase.currencyId,
    generator.purchase.costMultiplier,
    generator.purchase.costCurve,
    ['generators', generatorIndex, 'purchase'],
  );
};

const collectUpgradeCosts = (
  upgrade: NormalizedUpgrade,
  upgradeIndex: number,
  sampleLevels: readonly number[],
  maxGrowth: number,
  warnings: ContentSchemaWarning[],
  errors: ContentSchemaWarning[],
  sink?: IssueSink,
) => {
  const repeatableCostCurve = upgrade.repeatable?.costCurve;
  const repeatableMultipliers = sampleLevels.map((level) => {
    if (!repeatableCostCurve) {
      return 1;
    }

    const repeatableResult = evaluateFormula(repeatableCostCurve, level);
    if (!repeatableResult.ok) {
      recordIssue(
        {
          code: 'balance.cost.evaluationFailed',
          message: `Repeatable cost evaluation failed for upgrade "${upgrade.id}" at purchase ${level}.`,
          path: ['upgrades', upgradeIndex, 'repeatable', 'costCurve'],
          severity: 'error',
        },
        warnings,
        errors,
        sink,
      );
      return undefined;
    }

    const repeatableMultiplier = repeatableResult.value;
    if (!Number.isFinite(repeatableMultiplier) || repeatableMultiplier < 0) {
      recordIssue(
        {
          code: !Number.isFinite(repeatableMultiplier)
            ? 'balance.cost.nonFinite'
            : 'balance.cost.negative',
          message: `Repeatable cost multiplier for upgrade "${upgrade.id}" is invalid at purchase ${level}.`,
          path: ['upgrades', upgradeIndex, 'repeatable', 'costCurve'],
          severity: 'error',
        },
        warnings,
        errors,
        sink,
      );
      return undefined;
    }

    return repeatableMultiplier;
  });

  if (repeatableMultipliers.some((value) => value === undefined)) {
    return;
  }

  const collectCostProgressionForEntry = (
    resourceId: string,
    costMultiplier: number,
    costCurve: NumericFormula,
    pathPrefix: readonly (string | number)[],
  ) => {
    const label = ` (${resourceId})`;
    const costs: number[] = [];
    for (let index = 0; index < sampleLevels.length; index += 1) {
      const level = sampleLevels[index] ?? 0;
      const repeatableMultiplier = repeatableMultipliers[index] ?? 1;

      const baseResult = evaluateFormula(costCurve, level);
      if (!baseResult.ok) {
        recordIssue(
          {
            code: 'balance.cost.evaluationFailed',
          message: `Cost multiplier evaluation failed for upgrade "${upgrade.id}"${label} at purchase ${level}.`,
            path: [...pathPrefix, 'costCurve'],
            severity: 'error',
          },
          warnings,
          errors,
          sink,
        );
        break;
      }
      const baseMultiplier = baseResult.value;
      if (!Number.isFinite(baseMultiplier) || baseMultiplier < 0) {
        recordIssue(
          {
            code: !Number.isFinite(baseMultiplier)
              ? 'balance.cost.nonFinite'
              : 'balance.cost.negative',
          message: `Cost multiplier for upgrade "${upgrade.id}"${label} is invalid at purchase ${level}.`,
            path: [...pathPrefix, 'costCurve'],
            severity: 'error',
          },
          warnings,
          errors,
          sink,
        );
        break;
      }

      const cost = costMultiplier * baseMultiplier * repeatableMultiplier;
      if (!Number.isFinite(cost) || cost < 0) {
        recordIssue(
          {
            code: !Number.isFinite(cost)
              ? 'balance.cost.nonFinite'
              : 'balance.cost.negative',
            message: `Computed cost for upgrade "${upgrade.id}"${label} is invalid at purchase ${level}.`,
            path: [...pathPrefix, 'costMultiplier'],
            severity: 'error',
          },
          warnings,
          errors,
          sink,
        );
        break;
      }

      costs.push(cost);
    }

    checkCostProgression(
      {
        values: costs,
        path: [...pathPrefix, 'costCurve'],
        entityId: upgrade.id,
        resourceId,
        kind: 'upgrade',
      },
      maxGrowth,
      warnings,
      errors,
      sink,
    );
  };

  if ('costs' in upgrade.cost) {
    upgrade.cost.costs.forEach((entry, costIndex) => {
      collectCostProgressionForEntry(
        entry.resourceId,
        entry.costMultiplier,
        entry.costCurve,
        ['upgrades', upgradeIndex, 'cost', 'costs', costIndex],
      );
    });
    return;
  }

  collectCostProgressionForEntry(
    upgrade.cost.currencyId,
    upgrade.cost.costMultiplier,
    upgrade.cost.costCurve,
    ['upgrades', upgradeIndex, 'cost'],
  );
};

const evaluatePrestigeReward = (
  layer: NormalizedPrestigeLayer,
  layerIndex: number,
  level: number,
  warnings: ContentSchemaWarning[],
  errors: ContentSchemaWarning[],
  sink?: IssueSink,
): number | undefined => {
  const baseRewardResult = evaluateFormula(layer.reward.baseReward, level);
  if (!baseRewardResult.ok) {
    recordIssue(
      {
        code: 'balance.prestige.evaluationFailed',
        message: `Base reward evaluation failed for prestige layer "${layer.id}" at index ${level}.`,
        path: ['prestigeLayers', layerIndex, 'reward', 'baseReward'],
        severity: 'error',
      },
      warnings,
      errors,
      sink,
    );
    return undefined;
  }
  const baseReward = baseRewardResult.value;
  if (!Number.isFinite(baseReward) || baseReward < 0) {
    recordIssue(
      {
        code: !Number.isFinite(baseReward)
          ? 'balance.prestige.nonFinite'
          : 'balance.prestige.negative',
        message: `Base reward for prestige layer "${layer.id}" is invalid at index ${level}.`,
        path: ['prestigeLayers', layerIndex, 'reward', 'baseReward'],
        severity: 'error',
      },
      warnings,
      errors,
      sink,
    );
    return undefined;
  }

  if (!layer.reward.multiplierCurve) {
    return baseReward;
  }

  const multiplierResult = evaluateFormula(layer.reward.multiplierCurve, level);
  if (!multiplierResult.ok) {
    recordIssue(
      {
        code: 'balance.prestige.evaluationFailed',
        message: `Multiplier evaluation failed for prestige layer "${layer.id}" at index ${level}.`,
        path: ['prestigeLayers', layerIndex, 'reward', 'multiplierCurve'],
        severity: 'error',
      },
      warnings,
      errors,
      sink,
    );
    return undefined;
  }
  const multiplier = multiplierResult.value;
  if (!Number.isFinite(multiplier) || multiplier < 0) {
    recordIssue(
      {
        code: !Number.isFinite(multiplier)
          ? 'balance.prestige.nonFinite'
          : 'balance.prestige.negative',
        message: `Multiplier for prestige layer "${layer.id}" is invalid at index ${level}.`,
        path: ['prestigeLayers', layerIndex, 'reward', 'multiplierCurve'],
        severity: 'error',
      },
      warnings,
      errors,
      sink,
    );
    return undefined;
  }

  const reward = baseReward * multiplier;
  if (!Number.isFinite(reward) || reward < 0) {
    recordIssue(
      {
        code: !Number.isFinite(reward)
          ? 'balance.prestige.nonFinite'
          : 'balance.prestige.negative',
        message: `Computed reward for prestige layer "${layer.id}" is invalid at index ${level}.`,
        path: ['prestigeLayers', layerIndex, 'reward', 'baseReward'],
        severity: 'error',
      },
      warnings,
      errors,
      sink,
    );
    return undefined;
  }
  return reward;
};

const collectPrestigeRewards = (
  layer: NormalizedPrestigeLayer,
  layerIndex: number,
  sampleLevels: readonly number[],
  maxGrowth: number,
  warnings: ContentSchemaWarning[],
  errors: ContentSchemaWarning[],
  sink?: IssueSink,
) => {
  const rewards: number[] = [];
  for (const level of sampleLevels) {
    const reward = evaluatePrestigeReward(layer, layerIndex, level, warnings, errors, sink);
    if (reward === undefined) {
      break;
    }
    rewards.push(reward);
  }

  if (rewards.length <= 1) {
    return;
  }

  let previous = rewards[0] ?? 0;
  rewards.slice(1).forEach((value, offset) => {
    const level = offset + 1;
    if (value + EPSILON < previous) {
      recordIssue(
        {
          code: 'balance.prestige.nonMonotonic',
          message: `Prestige rewards for "${layer.id}" decrease between indices ${level - 1} and ${level}.`,
          path: ['prestigeLayers', layerIndex, 'reward', 'baseReward'],
          severity: 'error',
        },
        warnings,
        errors,
        sink,
      );
    }

    const baseline = Math.max(previous, EPSILON);
    if (value - baseline * maxGrowth > EPSILON) {
      recordIssue(
        {
          code: 'balance.prestige.exceedsGrowthCap',
          message: `Prestige rewards for "${layer.id}" exceed ${maxGrowth}x growth between indices ${level - 1} and ${level}.`,
          path: ['prestigeLayers', layerIndex, 'reward', 'baseReward'],
          severity: 'error',
        },
        warnings,
        errors,
        sink,
      );
    }
    previous = value;
  });
};

const collectConditionResourceReferences = (
  condition: Condition | undefined,
  lookup: ConditionResourceLookup,
): Set<string> => {
  if (!condition) {
    return new Set();
  }

  switch (condition.kind) {
    case 'resourceThreshold':
      return new Set([condition.resourceId]);
    case 'generatorLevel': {
      const resources = new Set<string>();
      const generator = lookup.generators.get(condition.generatorId);
      generator?.produces.forEach((entry) => resources.add(entry.resourceId));
      return resources;
    }
    case 'upgradeOwned': {
      const resources = new Set<string>();
      const upgrade = lookup.upgrades.get(condition.upgradeId);
      upgrade?.effects.forEach((effect) => {
        if (effect.kind === 'unlockResource') {
          resources.add(effect.resourceId);
        }
      });
      return resources;
    }
    case 'prestigeCountThreshold':
    case 'prestigeCompleted':
      return new Set([`${condition.prestigeLayerId}-prestige-count`]);
    case 'prestigeUnlocked':
    case 'flag':
    case 'script':
    case 'always':
    case 'never':
      return new Set();
    case 'allOf':
    case 'anyOf': {
      const resources = new Set<string>();
      condition.conditions.forEach((nested) => {
        const nestedResources = collectConditionResourceReferences(nested, lookup);
        nestedResources.forEach((resourceId) => resources.add(resourceId));
      });
      return resources;
    }
    case 'not':
      return collectConditionResourceReferences(condition.condition, lookup);
    default:
      return new Set();
  }
};

const collectUpgradeCostResources = (upgrade: NormalizedUpgrade): Set<string> => {
  const resources = new Set<string>();
  if ('costs' in upgrade.cost) {
    upgrade.cost.costs.forEach((cost) => resources.add(cost.resourceId));
  } else {
    resources.add(upgrade.cost.currencyId);
  }
  return resources;
};

const collectUpgradeResourceReferences = (
  upgrade: NormalizedUpgrade,
  lookup: ConditionResourceLookup,
): Set<string> => {
  const resources = collectUpgradeCostResources(upgrade);
  collectConditionResourceReferences(upgrade.unlockCondition, lookup).forEach(
    (resourceId) => resources.add(resourceId),
  );
  upgrade.prerequisites.forEach((prerequisite) => {
    collectConditionResourceReferences(prerequisite, lookup).forEach((resourceId) =>
      resources.add(resourceId),
    );
  });
  upgrade.effects.forEach((effect) => {
    if (effect.kind === 'unlockResource') {
      resources.add(effect.resourceId);
    }
  });
  return resources;
};

const collectAchievementTrackResourceReferences = (
  track: NormalizedAchievement['track'],
  lookup: ConditionResourceLookup,
): Set<string> => {
  switch (track.kind) {
    case 'resource':
      return new Set([track.resourceId]);
    case 'generator-level': {
      const resources = new Set<string>();
      const generator = lookup.generators.get(track.generatorId);
      generator?.produces.forEach((entry) => resources.add(entry.resourceId));
      return resources;
    }
    case 'generator-count': {
      const resources = new Set<string>();
      const generatorIds = track.generatorIds ?? [...lookup.generators.keys()];
      generatorIds.forEach((generatorId) => {
        const generator = lookup.generators.get(generatorId);
        generator?.produces.forEach((entry) => resources.add(entry.resourceId));
      });
      return resources;
    }
    case 'upgrade-owned': {
      const upgrade = lookup.upgrades.get(track.upgradeId);
      return upgrade ? collectUpgradeResourceReferences(upgrade, lookup) : new Set();
    }
    case 'flag':
    case 'script':
    case 'custom-metric':
      return new Set();
    default:
      return new Set();
  }
};

const collectAchievementResourceReferences = (
  achievement: NormalizedAchievement,
  lookup: ConditionResourceLookup,
): Set<string> => {
  const resources = collectConditionResourceReferences(
    achievement.unlockCondition,
    lookup,
  );
  collectAchievementTrackResourceReferences(achievement.track, lookup).forEach(
    (resourceId) => resources.add(resourceId),
  );
  return resources;
};

const buildFlagResourceLookup = (
  pack: NormalizedContentPack,
  lookup: ConditionResourceLookup,
): FlagResourceLookup => {
  const flagResources = new Map<string, Set<string>>();

  const mergeFlagResources = (flagId: string, resources: Set<string>) => {
    const existing = flagResources.get(flagId);
    if (!existing) {
      flagResources.set(flagId, new Set(resources));
      return;
    }
    for (const resourceId of existing) {
      if (!resources.has(resourceId)) {
        existing.delete(resourceId);
      }
    }
  };

  pack.upgrades.forEach((upgrade) => {
    let hasGrantFlag = false;
    upgrade.effects.forEach((effect) => {
      if (effect.kind === 'grantFlag' && effect.value !== false) {
        hasGrantFlag = true;
      }
    });
    if (!hasGrantFlag) {
      return;
    }
    const resources = collectUpgradeResourceReferences(upgrade, lookup);
    upgrade.effects.forEach((effect) => {
      if (effect.kind !== 'grantFlag') {
        return;
      }
      if (effect.value === false) {
        return;
      }
      mergeFlagResources(effect.flagId, resources);
    });
  });

  pack.achievements.forEach((achievement) => {
    const reward = achievement.reward;
    if (reward?.kind !== 'grantFlag') {
      return;
    }
    if (reward.value === false) {
      return;
    }
    const resources = collectAchievementResourceReferences(achievement, lookup);
    mergeFlagResources(reward.flagId, resources);
  });

  return flagResources;
};

const conditionReferencesResource = (
  condition: Condition | undefined,
  resource: NormalizedResource,
  lookup: UnlockOrderingLookup,
  flagResources: FlagResourceLookup,
): boolean => {
  if (!condition) {
    return false;
  }

  switch (condition.kind) {
    case 'resourceThreshold':
      return condition.resourceId === resource.id;
    case 'generatorLevel':
      return (
        lookup.generators
          .get(condition.generatorId)
          ?.produces.some((entry) => entry.resourceId === resource.id) ?? false
      );
    case 'upgradeOwned':
      return (
        lookup.upgrades
          .get(condition.upgradeId)
          ?.effects.some(
            (effect) =>
              effect.kind === 'unlockResource' && effect.resourceId === resource.id,
          ) ?? false
      );
    case 'prestigeCountThreshold':
      return `${condition.prestigeLayerId}-prestige-count` === resource.id;
    case 'prestigeCompleted':
      return `${condition.prestigeLayerId}-prestige-count` === resource.id;
    case 'flag':
      return flagResources.get(condition.flagId)?.has(resource.id) ?? false;
    case 'prestigeUnlocked':
    case 'script':
    case 'always':
    case 'never':
      return false;
    case 'allOf':
    case 'anyOf':
      return condition.conditions.some((nested) =>
        conditionReferencesResource(nested, resource, lookup, flagResources),
      );
    case 'not':
      return conditionReferencesResource(condition.condition, resource, lookup, flagResources);
    default:
      return false;
  }
};

const isResourceLockedLater = (resource: NormalizedResource): boolean => {
  if (resource.unlocked) {
    return false;
  }
  if (!resource.unlockCondition) {
    return false;
  }
  if (resource.unlockCondition.kind === 'always') {
    return false;
  }
  return true;
};

type ResourceOrderingCheckInput = Readonly<{
  resourceId: string;
  unlockCondition: Condition | undefined;
  dependentPath: readonly (string | number)[];
  dependentId: string;
  lookup: UnlockOrderingLookup;
  flagResources: FlagResourceLookup;
  warnings: ContentSchemaWarning[];
  errors: ContentSchemaWarning[];
  sink?: IssueSink;
}>;

const checkResourceOrdering = (input: ResourceOrderingCheckInput) => {
  const {
    resourceId,
    unlockCondition,
    dependentPath,
    dependentId,
    lookup,
    flagResources,
    warnings,
    errors,
    sink,
  } = input;
  const resource = lookup.resources.get(resourceId);
  if (!resource) {
    return;
  }

  if (!isResourceLockedLater(resource)) {
    return;
  }

  if (conditionReferencesResource(unlockCondition, resource, lookup, flagResources)) {
    return;
  }

  recordIssue(
    {
      code: 'balance.unlock.ordering',
      message: `Resource "${resourceId}" unlocks after dependent content "${dependentId}". Gate the dependent unlock on the resource or unlock the resource earlier.`,
      path: dependentPath,
      severity: 'warning',
    },
    warnings,
    errors,
    sink,
  );
};

const validateGenerators = (
  pack: NormalizedContentPack,
  sampleLevels: readonly number[],
  maxGrowth: number,
  flagResources: FlagResourceLookup,
  warnings: ContentSchemaWarning[],
  errors: ContentSchemaWarning[],
  sink?: IssueSink,
) => {
  const unlockOrderingLookup: UnlockOrderingLookup = pack.lookup;
  pack.generators.forEach((generator, index) => {
    checkNonNegativeRates(generator, index, sampleLevels, warnings, errors, sink);
    collectGeneratorCosts(generator, index, sampleLevels, maxGrowth, warnings, errors, sink);
    if ('costs' in generator.purchase) {
      generator.purchase.costs.forEach((cost, costIndex) => {
        checkResourceOrdering(
          {
            resourceId: cost.resourceId,
            unlockCondition: generator.baseUnlock,
            dependentPath: ['generators', index, 'purchase', 'costs', costIndex, 'resourceId'],
            dependentId: generator.id,
            lookup: unlockOrderingLookup,
            flagResources,
            warnings,
            errors,
            sink,
          },
        );
      });
    } else {
      checkResourceOrdering(
        {
          resourceId: generator.purchase.currencyId,
          unlockCondition: generator.baseUnlock,
          dependentPath: ['generators', index, 'purchase', 'currencyId'],
          dependentId: generator.id,
          lookup: unlockOrderingLookup,
          flagResources,
          warnings,
          errors,
          sink,
        },
      );
    }
    generator.consumes.forEach((entry, consumeIndex) => {
      checkResourceOrdering(
        {
          resourceId: entry.resourceId,
          unlockCondition: generator.baseUnlock,
          dependentPath: ['generators', index, 'consumes', consumeIndex, 'resourceId'],
          dependentId: generator.id,
          lookup: unlockOrderingLookup,
          flagResources,
          warnings,
          errors,
          sink,
        },
      );
    });
  });
};

const validateUpgrades = (
  pack: NormalizedContentPack,
  sampleSize: number,
  maxGrowth: number,
  flagResources: FlagResourceLookup,
  warnings: ContentSchemaWarning[],
  errors: ContentSchemaWarning[],
  sink?: IssueSink,
) => {
  const unlockOrderingLookup: UnlockOrderingLookup = pack.lookup;
  pack.upgrades.forEach((upgrade, index) => {
    const maxPurchases = upgrade.repeatable
      ? upgrade.repeatable.maxPurchases ?? sampleSize
      : 0;
    const levels = createLevelSamples(sampleSize, maxPurchases);
    collectUpgradeCosts(upgrade, index, levels, maxGrowth, warnings, errors, sink);
    if ('costs' in upgrade.cost) {
      upgrade.cost.costs.forEach((cost, costIndex) => {
        checkResourceOrdering(
          {
            resourceId: cost.resourceId,
            unlockCondition: upgrade.unlockCondition,
            dependentPath: ['upgrades', index, 'cost', 'costs', costIndex, 'resourceId'],
            dependentId: upgrade.id,
            lookup: unlockOrderingLookup,
            flagResources,
            warnings,
            errors,
            sink,
          },
        );
      });
    } else {
      checkResourceOrdering(
        {
          resourceId: upgrade.cost.currencyId,
          unlockCondition: upgrade.unlockCondition,
          dependentPath: ['upgrades', index, 'cost', 'currencyId'],
          dependentId: upgrade.id,
          lookup: unlockOrderingLookup,
          flagResources,
          warnings,
          errors,
          sink,
        },
      );
    }
  });
};

const validatePrestigeLayers = (
  pack: NormalizedContentPack,
  sampleSize: number,
  maxGrowth: number,
  warnings: ContentSchemaWarning[],
  errors: ContentSchemaWarning[],
  sink?: IssueSink,
) => {
  pack.prestigeLayers.forEach((layer, index) => {
    const levels = createLevelSamples(sampleSize, sampleSize);
    collectPrestigeRewards(layer, index, levels, maxGrowth, warnings, errors, sink);
  });
};

export const validateContentPackBalance = (
  pack: NormalizedContentPack,
  options: BalanceValidationOptions = {},
  sink?: IssueSink,
): BalanceCheckResult => {
  const sampleSize = Math.max(0, Math.floor(options.sampleSize ?? DEFAULT_SAMPLE_SIZE));
  const maxGrowth = options.maxGrowth ?? DEFAULT_MAX_GROWTH;
  const warnings: ContentSchemaWarning[] = [];
  const errors: ContentSchemaWarning[] = [];

  const unlockOrderingLookup: UnlockOrderingLookup = pack.lookup;
  const flagResources = buildFlagResourceLookup(pack, unlockOrderingLookup);
  const purchaseLevels = createLevelSamples(sampleSize, sampleSize);

  validateGenerators(
    pack,
    purchaseLevels,
    maxGrowth,
    flagResources,
    warnings,
    errors,
    sink,
  );
  validateUpgrades(
    pack,
    sampleSize,
    maxGrowth,
    flagResources,
    warnings,
    errors,
    sink,
  );
  validatePrestigeLayers(pack, sampleSize, maxGrowth, warnings, errors, sink);

  return {
    warnings: Object.freeze(warnings),
    errors: Object.freeze(errors),
  };
};
