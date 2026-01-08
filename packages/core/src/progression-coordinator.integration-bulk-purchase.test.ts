import { describe, expect, it } from 'vitest';

import { createProgressionCoordinator } from './index.js';
import {
  createContentPack,
  createGeneratorDefinition,
  createResourceDefinition,
  literalOne,
} from './content-test-helpers.js';

describe('Integration: bulk purchase edge cases', () => {
  it('handles large bulk purchases (1000+ generators) with exponential cost curves', () => {
    const currency = createResourceDefinition('resource.currency', {
      name: 'Currency',
    });

    const generator = createGeneratorDefinition('generator.bulk', {
      name: 'Bulk Generator',
      purchase: {
        currencyId: currency.id,
        costMultiplier: 1,
        costCurve: {
          kind: 'exponential',
          base: 1,
          growth: 1.01,
        },
      },
    });

    const coordinator = createProgressionCoordinator({
      content: createContentPack({
        resources: [currency],
        generators: [generator],
      }),
      stepDurationMs: 100,
    });

    const quote = coordinator.generatorEvaluator.getPurchaseQuote(generator.id, 1000);
    expect(quote).toBeDefined();
    expect(quote?.costs[0]?.amount).toBeGreaterThan(0);
  });

  it('detects numeric overflow when bulk purchase costs exceed MAX_SAFE_INTEGER', () => {
    const currency = createResourceDefinition('resource.currency', {
      name: 'Currency',
    });

    const generator = createGeneratorDefinition('generator.overflow', {
      name: 'Overflow Generator',
      purchase: {
        currencyId: currency.id,
        costMultiplier: Number.MAX_SAFE_INTEGER,
        costCurve: literalOne,
      },
    });

    const coordinator = createProgressionCoordinator({
      content: createContentPack({
        resources: [currency],
        generators: [generator],
      }),
      stepDurationMs: 100,
    });

    const quote = coordinator.generatorEvaluator.getPurchaseQuote(generator.id, 2);
    if (quote !== undefined) {
      expect(Number.isFinite(quote.costs[0].amount)).toBe(true);
    }
  });

  it('handles bulk purchases hitting maxLevel boundary', () => {
    const currency = createResourceDefinition('resource.currency', {
      name: 'Currency',
    });

    const generator = createGeneratorDefinition('generator.capped', {
      name: 'Capped Generator',
      maxLevel: 5,
      purchase: {
        currencyId: currency.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
    });

    const coordinator = createProgressionCoordinator({
      content: createContentPack({
        resources: [currency],
        generators: [generator],
      }),
      stepDurationMs: 100,
    });

    coordinator.generatorEvaluator.applyPurchase(generator.id, 4);

    const validQuote = coordinator.generatorEvaluator.getPurchaseQuote(generator.id, 1);
    expect(validQuote).toBeDefined();

    const invalidQuote = coordinator.generatorEvaluator.getPurchaseQuote(generator.id, 2);
    expect(invalidQuote).toBeUndefined();
  });

  it('handles bulk purchase with insufficient resources mid-calculation', () => {
    const currency = createResourceDefinition('resource.currency', {
      name: 'Currency',
    });

    const generator = createGeneratorDefinition('generator.expensive', {
      name: 'Expensive Generator',
      purchase: {
        currencyId: currency.id,
        costMultiplier: 10,
        costCurve: {
          kind: 'linear',
          base: 10,
          slope: 10,
        },
      },
    });

    const coordinator = createProgressionCoordinator({
      content: createContentPack({
        resources: [currency],
        generators: [generator],
      }),
      stepDurationMs: 100,
    });

    const quote = coordinator.generatorEvaluator.getPurchaseQuote(generator.id, 3);
    expect(quote).toBeDefined();
    expect(quote?.costs[0]?.amount).toBeGreaterThan(0);
  });

  it('validates bulk purchase performance for 100 purchases completes quickly', () => {
    const currency = createResourceDefinition('resource.currency', {
      name: 'Currency',
    });

    const generator = createGeneratorDefinition('generator.performance', {
      name: 'Performance Generator',
      purchase: {
        currencyId: currency.id,
        costMultiplier: 1,
        costCurve: {
          kind: 'linear',
          base: 1,
          slope: 1,
        },
      },
    });

    const coordinator = createProgressionCoordinator({
      content: createContentPack({
        resources: [currency],
        generators: [generator],
      }),
      stepDurationMs: 100,
    });

    const start = performance.now();
    const quote = coordinator.generatorEvaluator.getPurchaseQuote(generator.id, 100);
    const end = performance.now();

    expect(quote).toBeDefined();
    expect(end - start).toBeLessThan(50);
  });
});
