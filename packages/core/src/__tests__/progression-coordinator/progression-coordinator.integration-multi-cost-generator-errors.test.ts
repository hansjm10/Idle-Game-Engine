import { describe, expect, it } from 'vitest';

import { createProgressionCoordinator } from '../../internals.js';
import {
  createContentPack,
  createGeneratorDefinition,
  createResourceDefinition,
  literalOne,
} from '../../content-test-helpers.js';

describe('Integration: multi-cost generator error paths', () => {
  it('reports error when multi-cost generator has invalid costMultiplier on one entry', () => {
    const errors: Error[] = [];
    const energy = createResourceDefinition('resource.energy', { name: 'Energy' });
    const parts = createResourceDefinition('resource.parts', { name: 'Parts' });

    const generator = createGeneratorDefinition('generator.multi-cost-invalid', {
      name: 'Multi Cost Invalid Generator',
      purchase: {
        costs: [
          { resourceId: energy.id, costMultiplier: 10, costCurve: literalOne },
          { resourceId: parts.id, costMultiplier: -5, costCurve: literalOne }, // Invalid negative costMultiplier
        ],
      },
      produces: [{ resourceId: energy.id, rate: literalOne }],
    });

    const content = createContentPack({
      resources: [energy, parts],
      generators: [generator],
    });

    const coordinator = createProgressionCoordinator({
      content,
      stepDurationMs: 100,
      onError: (error) => errors.push(error),
    });

    const costs = (coordinator as any).computeGeneratorCosts('generator.multi-cost-invalid', 0);

    expect(costs).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Generator cost calculation failed');
    expect(errors[0].message).toContain('generator.multi-cost-invalid');
    expect(errors[0].message).toContain('resource.parts');
    expect(errors[0].message).toContain('costMultiplier is invalid');
  });

  it('reports error when multi-cost generator cost curve returns negative value', () => {
    const errors: Error[] = [];
    const energy = createResourceDefinition('resource.energy', { name: 'Energy' });
    const parts = createResourceDefinition('resource.parts', { name: 'Parts' });

    const generator = createGeneratorDefinition('generator.multi-cost-negative', {
      name: 'Multi Cost Negative Generator',
      purchase: {
        costs: [
          { resourceId: energy.id, costMultiplier: 10, costCurve: literalOne },
          { resourceId: parts.id, costMultiplier: 10, costCurve: { kind: 'constant', value: -100 } }, // Negative cost
        ],
      },
      produces: [{ resourceId: energy.id, rate: literalOne }],
    });

    const content = createContentPack({
      resources: [energy, parts],
      generators: [generator],
    });

    const coordinator = createProgressionCoordinator({
      content,
      stepDurationMs: 100,
      onError: (error) => errors.push(error),
    });

    const costs = (coordinator as any).computeGeneratorCosts('generator.multi-cost-negative', 0);

    expect(costs).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Generator cost calculation failed');
    expect(errors[0].message).toContain('generator.multi-cost-negative');
    expect(errors[0].message).toContain('resource.parts');
    expect(errors[0].message).toContain('cost curve evaluation returned');
  });

  it('reports error when multi-cost generator final cost is non-finite', () => {
    const errors: Error[] = [];
    const energy = createResourceDefinition('resource.energy', { name: 'Energy' });
    const parts = createResourceDefinition('resource.parts', { name: 'Parts' });

    const generator = createGeneratorDefinition('generator.multi-cost-overflow', {
      name: 'Multi Cost Overflow Generator',
      purchase: {
        costs: [
          { resourceId: energy.id, costMultiplier: 10, costCurve: literalOne },
          { resourceId: parts.id, costMultiplier: 1e308, costCurve: { kind: 'constant', value: 1e308 } }, // Will overflow
        ],
      },
      produces: [{ resourceId: energy.id, rate: literalOne }],
    });

    const content = createContentPack({
      resources: [energy, parts],
      generators: [generator],
    });

    const coordinator = createProgressionCoordinator({
      content,
      stepDurationMs: 100,
      onError: (error) => errors.push(error),
    });

    const costs = (coordinator as any).computeGeneratorCosts('generator.multi-cost-overflow', 0);

    expect(costs).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Generator cost calculation failed');
    expect(errors[0].message).toContain('generator.multi-cost-overflow');
    expect(errors[0].message).toContain('final cost is invalid');
  });

  it('reports error when computeGeneratorCost is called on multi-cost generator', () => {
    const errors: Error[] = [];
    const energy = createResourceDefinition('resource.energy', { name: 'Energy' });
    const parts = createResourceDefinition('resource.parts', { name: 'Parts' });

    const generator = createGeneratorDefinition('generator.multi-cost', {
      name: 'Multi Cost Generator',
      purchase: {
        costs: [
          { resourceId: energy.id, costMultiplier: 10, costCurve: literalOne },
          { resourceId: parts.id, costMultiplier: 25, costCurve: literalOne },
        ],
      },
      produces: [{ resourceId: energy.id, rate: literalOne }],
    });

    const content = createContentPack({
      resources: [energy, parts],
      generators: [generator],
    });

    const coordinator = createProgressionCoordinator({
      content,
      stepDurationMs: 100,
      onError: (error) => errors.push(error),
    });

    // computeGeneratorCost (singular) should fail for multi-cost generators
    const cost = (coordinator as any).computeGeneratorCost('generator.multi-cost', 0);

    expect(cost).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Generator cost calculation failed');
    expect(errors[0].message).toContain('generator.multi-cost');
    expect(errors[0].message).toContain('multi-cost purchase definitions require computeGeneratorCosts()');
  });
});
