import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import {
  createDeterministicFormulaEvaluationContext,
  createFormulaArbitrary,
} from '../../base/formulas.arbitraries.js';
import { evaluateNumericFormula } from '../../base/formula-evaluator.js';
import { generatorDefinitionSchema } from '../generators.js';
import { upgradeDefinitionSchema } from '../upgrades.js';

// Keep runs modest to avoid slowing the suite; seed is deterministic.
const propertyConfig: fc.Parameters<unknown> = { numRuns: 100, seed: 177013 + 382 };

describe('property: generator and upgrade formulas remain finite and non-negative', () => {
  it('accepts generator definitions with safe produce/consume and costCurve formulas', async () => {
    const formula = createFormulaArbitrary();
    const context = createDeterministicFormulaEvaluationContext();

    await fc.assert(
      fc.property(formula, formula, formula, (produceRate, consumeRate, costCurve) => {
        const gen = generatorDefinitionSchema.parse({
          id: 'pack.generator/example',
          name: { default: 'Example Generator', variants: {} },
          produces: [{ resourceId: 'pack.resource/a', rate: produceRate }],
          consumes: [{ resourceId: 'pack.resource/b', rate: consumeRate }],
          purchase: {
            currencyId: 'pack.resource/a',
            baseCost: 1,
            costCurve,
          },
          baseUnlock: { kind: 'always' },
        });

        const level = 0; // purchase index / owned level
        const levelContext = {
          ...context,
          variables: { ...(context.variables ?? {}), level },
        };

        // Rates must be finite and non-negative by construction of the arbitrary
        const r1 = evaluateNumericFormula(gen.produces[0].rate, levelContext);
        const r2 = evaluateNumericFormula(gen.consumes[0].rate, levelContext);
        expect(Number.isFinite(r1)).toBe(true);
        expect(Number.isFinite(r2)).toBe(true);
        expect(r1).toBeGreaterThanOrEqual(0);
        expect(r2).toBeGreaterThanOrEqual(0);

        // Cost multiplier should also be finite and non-negative
        const multiplier = evaluateNumericFormula(gen.purchase.costCurve, levelContext);
        expect(Number.isFinite(multiplier)).toBe(true);
        expect(multiplier).toBeGreaterThanOrEqual(0);
      }),
      propertyConfig,
    );
  });

  it('accepts upgrade definitions with safe costCurve formulas', async () => {
    const costCurve = createFormulaArbitrary({ kinds: ['constant', 'linear', 'exponential', 'piecewise', 'expression'] });
    const context = createDeterministicFormulaEvaluationContext();

    await fc.assert(
      fc.property(costCurve, (curve) => {
        const upgrade = upgradeDefinitionSchema.parse({
          id: 'pack.upgrade/example',
          name: { default: 'Example Upgrade', variants: {} },
          category: 'generator',
          targets: [{ kind: 'generator', id: 'pack.generator/example' }],
          cost: {
            currencyId: 'pack.resource/a',
            baseCost: 10,
            costCurve: curve,
          },
          effects: [
            {
              kind: 'modifyGeneratorRate',
              generatorId: 'pack.generator/example',
              operation: 'multiply',
              value: { kind: 'constant', value: 1 },
            },
          ],
        });

        const level = 0; // purchase level for first buy
        const levelContext = {
          ...context,
          variables: { ...(context.variables ?? {}), level },
        };
        const multiplier = evaluateNumericFormula(upgrade.cost.costCurve, levelContext);
        expect(Number.isFinite(multiplier)).toBe(true);
        expect(multiplier).toBeGreaterThanOrEqual(0);
      }),
      propertyConfig,
    );
  });
});

