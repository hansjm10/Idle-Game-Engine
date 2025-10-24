import type { ResourceState } from '../resource-state.js';
import type { UpgradeState } from '../upgrade-state.js';
import type { ModifierPipeline } from '../modifiers/modifier-pipeline.js';
import type { TickContext } from './system-types.js';
import type { SystemDefinition } from './system-types.js';
import type { GeneratorModifierLedger } from './modifier-ledger.js';

export type UpgradeModifierMode = 'additive' | 'multiplicative' | 'exponential';

export interface UpgradeEffectDefinition<TContext = UpgradeEffectContext> {
  readonly targetGeneratorId: string;
  readonly mode: UpgradeModifierMode;
  readonly baseValue?: number;
  readonly pipeline?: ModifierPipeline<TContext>;
}

export interface ResourceThresholdRequirement {
  readonly type: 'resourceThreshold';
  readonly resourceId: string;
  readonly amount: number;
}

export type UpgradeRequirement = ResourceThresholdRequirement;

export interface UpgradeRuntimeDefinition {
  readonly upgradeId: string;
  readonly requirement?: UpgradeRequirement;
  readonly effects: readonly UpgradeEffectDefinition[];
}

export interface UpgradeEffectContext {
  readonly step: number;
  readonly deltaMs: number;
  readonly upgradeId: string;
  readonly purchaseCount: number;
  readonly requirementSatisfied: boolean;
}

export interface UpgradeSystemOptions {
  readonly upgrades: UpgradeState;
  readonly resources?: ResourceState;
  readonly ledger: GeneratorModifierLedger;
  readonly definitions: readonly UpgradeRuntimeDefinition[];
  readonly id?: string;
  readonly before?: readonly string[];
  readonly after?: readonly string[];
}

export function createUpgradeSystem(options: UpgradeSystemOptions): SystemDefinition {
  const {
    upgrades,
    resources,
    ledger,
    definitions,
    id = 'upgrades',
    before,
    after,
  } = options;

  return {
    id,
    before,
    after,
    tick(context: TickContext) {
      ledger.reset();

      for (const definition of definitions) {
        const upgradeIndex = upgrades.getIndex(definition.upgradeId);
        if (upgradeIndex === undefined) {
          continue;
        }

        const requirementSatisfied = evaluateRequirement(definition.requirement, resources);
        if (definition.requirement && requirementSatisfied) {
          upgrades.unlock(upgradeIndex);
        }

        if (!upgrades.isUnlocked(upgradeIndex)) {
          continue;
        }

        const purchaseCount = upgrades.getPurchaseCount(upgradeIndex);
        if (purchaseCount <= 0) {
          continue;
        }

        const effectContext: UpgradeEffectContext = {
          step: context.step,
          deltaMs: context.deltaMs,
          upgradeId: definition.upgradeId,
          purchaseCount,
          requirementSatisfied,
        };

        for (const effect of definition.effects) {
          const baseValue = effect.baseValue ?? purchaseCount;
          const pipeline = effect.pipeline;
          const finalValue = pipeline ? pipeline.apply(baseValue, effectContext) : baseValue;
          applyEffect(ledger, effect.targetGeneratorId, effect.mode, finalValue);
        }
      }
    },
  };
}

function evaluateRequirement(
  requirement: UpgradeRequirement | undefined,
  resources: ResourceState | undefined,
): boolean {
  if (!requirement) {
    return true;
  }

  if (!resources) {
    return false;
  }

  switch (requirement.type) {
    case 'resourceThreshold': {
      const index = resources.getIndex(requirement.resourceId);
      if (index === undefined) {
        return false;
      }
      return resources.getAmount(index) >= requirement.amount;
    }
    default:
      return false;
  }
}

function applyEffect(
  ledger: GeneratorModifierLedger,
  generatorId: string,
  mode: UpgradeModifierMode,
  value: number,
): void {
  switch (mode) {
    case 'additive':
      ledger.applyAdditive(generatorId, value);
      return;
    case 'multiplicative':
      ledger.applyMultiplicative(generatorId, value);
      return;
    case 'exponential':
      ledger.applyExponential(generatorId, value);
      return;
    default:
      throw new Error(`Unsupported upgrade modifier mode: ${mode satisfies never}`);
  }
}
