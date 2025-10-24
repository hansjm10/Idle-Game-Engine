import { describe, expect, it } from 'vitest';

import {
  additiveModifier,
  clampModifier,
  createModifierPipeline,
  exponentialModifier,
  multiplicativeModifier,
} from './modifier-pipeline.js';

describe('modifier-pipeline', () => {
  it('combines additive, multiplicative, and exponential stages deterministically', () => {
    interface Context {
      bonus: number;
      multiplier: number;
      exponent: number;
    }

    const pipeline = createModifierPipeline<Context>([
      additiveModifier((ctx) => ctx.bonus),
      multiplicativeModifier((ctx) => ctx.multiplier),
      exponentialModifier((ctx) => ctx.exponent),
    ]);

    const context = {
      bonus: 2,
      multiplier: 1.5,
      exponent: 2,
    };

    const result = pipeline.apply(4, context);
    // ((4 + 2) * 1.5) ** 2 = (6 * 1.5)^2 = 9^2 = 81
    expect(result).toBeCloseTo(81, 6);

    // Running the pipeline twice should produce identical results
    const repeat = pipeline.apply(4, context);
    expect(repeat).toBe(result);
  });

  it('supports clamping stages that preserve subsequent modifiers', () => {
    const pipeline = createModifierPipeline<Record<string, never>>([
      additiveModifier(() => 5),
      clampModifier(0, 8),
      multiplicativeModifier(() => 2),
    ]);

    const result = pipeline.apply(10, {});
    // base + additive => 15, clamped to 8, then multiplied by 2 => 16
    expect(result).toBe(16);
  });

  it('throws when stages emit non-finite values', () => {
    const pipeline = createModifierPipeline([
      additiveModifier(() => Number.NaN),
    ]);

    expect(() => pipeline.apply(1, {})).toThrowError(/non-finite/);
  });
});
