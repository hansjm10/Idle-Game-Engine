import type { ResourceState, ResourceStateView } from '../resource-state.js';
import type { GeneratorState, GeneratorStateView } from '../generator-state.js';
import type { ModifierPipeline } from '../modifiers/modifier-pipeline.js';
import type { GeneratorModifierLedger, ModifierVector } from './modifier-ledger.js';
import type { TickContext } from './system-types.js';
import type { SystemDefinition } from './system-types.js';

export interface ProductionOutputDefinition<TContext = ProductionModifierContext> {
  readonly resourceId: string;
  readonly ratePerSecond: number;
  readonly pipeline?: ModifierPipeline<TContext>;
}

export interface ProductionGeneratorDefinition {
  readonly generatorId: string;
  readonly produces: readonly ProductionOutputDefinition[];
  readonly consumes?: readonly ProductionOutputDefinition[];
}

export interface ProductionSystemOptions {
  readonly resources: ResourceState;
  readonly generators: GeneratorState;
  readonly ledger: GeneratorModifierLedger;
  readonly definitions: readonly ProductionGeneratorDefinition[];
  readonly id?: string;
  readonly before?: readonly string[];
  readonly after?: readonly string[];
}

export interface ProductionModifierContext {
  readonly step: number;
  readonly deltaMs: number;
  readonly generatorId: string;
  readonly generatorLevel: number;
  readonly resourceId: string;
  readonly baseRate: number;
  readonly ledgerModifiers: ModifierVector;
  readonly resources: ResourceStateView;
  readonly generators: GeneratorStateView;
}

export function createProductionSystem(options: ProductionSystemOptions): SystemDefinition {
  const {
    resources,
    generators,
    ledger,
    definitions,
    id = 'production',
    before,
    after,
  } = options;

  return {
    id,
    before,
    after,
    tick(context: TickContext) {
      const resourceView = resources.view();
      const generatorView = generators.view();

      for (const definition of definitions) {
        const generatorIndex = generators.getIndex(definition.generatorId);
        if (generatorIndex === undefined) {
          continue;
        }

        const level = generators.getLevel(generatorIndex);
        if (level <= 0) {
          continue;
        }

        const modifiers = ledger.get(definition.generatorId);

        applyOutputs({
          outputs: definition.produces,
          level,
          modifier: modifiers,
          generators,
          resources,
          resourceView,
          generatorView,
          context,
          generatorId: definition.generatorId,
        });

        if (definition.consumes) {
          applyOutputs({
            outputs: definition.consumes,
            level,
            modifier: modifiers,
            generators,
            resources,
            resourceView,
            generatorView,
            context,
            generatorId: definition.generatorId,
            consume: true,
          });
        }
      }
    },
  };
}

interface ApplyOutputsInput {
  readonly outputs: readonly ProductionOutputDefinition[];
  readonly level: number;
  readonly modifier: ModifierVector;
  readonly generators: GeneratorState;
  readonly resources: ResourceState;
  readonly resourceView: ResourceStateView;
  readonly generatorView: GeneratorStateView;
  readonly context: TickContext;
  readonly generatorId: string;
  readonly consume?: boolean;
}

function applyOutputs({
  outputs,
  level,
  modifier,
  resources,
  resourceView,
  generatorView,
  context,
  generatorId,
  consume = false,
}: ApplyOutputsInput): void {
  for (const output of outputs) {
    const baseRate = output.ratePerSecond * level;
    let adjusted = applyLedgerModifiers(baseRate, modifier);

    if (output.pipeline) {
      const pipelineContext: ProductionModifierContext = {
        step: context.step,
        deltaMs: context.deltaMs,
        generatorId,
        generatorLevel: level,
        resourceId: output.resourceId,
        baseRate,
        ledgerModifiers: modifier,
        resources: resourceView,
        generators: generatorView,
      };
      adjusted = output.pipeline.apply(adjusted, pipelineContext);
    }

    const resourceIndex = resources.getIndex(output.resourceId);
    if (resourceIndex === undefined) {
      continue;
    }

    if (adjusted === 0) {
      continue;
    }

    if (consume || adjusted < 0) {
      const expense = Math.abs(adjusted);
      resources.applyExpense(resourceIndex, expense);
    } else {
      resources.applyIncome(resourceIndex, adjusted);
    }
  }
}

function applyLedgerModifiers(baseRate: number, modifier: ModifierVector): number {
  let adjusted = baseRate + modifier.additive;
  adjusted *= modifier.multiplicative;
  if (modifier.exponential !== 1) {
    const magnitude = Math.abs(adjusted) ** modifier.exponential;
    adjusted = adjusted < 0 ? -magnitude : magnitude;
  }
  return adjusted;
}
