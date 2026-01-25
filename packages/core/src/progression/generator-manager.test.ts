import { describe, expect, it } from 'vitest';

import type { NumericFormula } from '@idle-engine/content-schema';

import { createGeneratorDefinition } from '../content-test-helpers.js';
import type { EvaluatedUpgradeEffects } from '../upgrade-effects.js';

import { GeneratorManager } from './generator-manager.js';
import type { FormulaEvaluationContextFactory } from './formula-context.js';

const EMPTY_UPGRADE_EFFECTS: EvaluatedUpgradeEffects = {
  generatorRateMultipliers: new Map(),
  generatorCostMultipliers: new Map(),
  generatorConsumptionMultipliers: new Map(),
  generatorResourceConsumptionMultipliers: new Map(),
  resourceRateMultipliers: new Map(),
  resourceCapacityOverrides: new Map(),
  dirtyToleranceOverrides: new Map(),
  unlockedResources: new Set(),
  unlockedGenerators: new Set(),
  grantedAutomations: new Set(),
  grantedFlags: new Map(),
};

const createFormulaEvaluationContext: FormulaEvaluationContextFactory = (level, step) => ({
  variables: { level, time: step, deltaTime: 0 },
  entities: {
    resource: () => 0,
    generator: () => 0,
    upgrade: () => 0,
    automation: () => 0,
    prestigeLayer: () => 0,
  },
});

describe('GeneratorManager', () => {
  it('initializes generator rates even when formulas reference entity lookups', () => {
    const generator = createGeneratorDefinition('generator.miner', {
      produces: [
        {
          resourceId: 'resource.energy',
          rate: {
            kind: 'expression',
            expression: {
              kind: 'ref',
              target: { type: 'resource', id: 'resource.energy' },
            },
          } satisfies NumericFormula,
        },
      ],
    });

    const manager = new GeneratorManager({
      generators: [generator],
      getLastUpdatedStep: () => 0,
      getUpgradeEffects: () => EMPTY_UPGRADE_EFFECTS,
      createFormulaEvaluationContext,
    });

    expect(manager.getGeneratorStates()[0]?.produces).toEqual([
      { resourceId: 'resource.energy', rate: 0 },
    ]);
  });
});

