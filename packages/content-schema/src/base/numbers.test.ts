import { describe, expect, it } from 'vitest';

import {
  finiteNumberSchema,
  integerSchema,
  nonNegativeNumberSchema,
  percentSchema,
  positiveIntSchema,
} from './numbers.js';

describe('numbers', () => {
  it('coerces values to finite numbers', () => {
    expect(finiteNumberSchema.parse('42')).toBe(42);
    expect(finiteNumberSchema.safeParse(Number.NaN).success).toBe(false);
  });

  it('enforces non-negative numbers', () => {
    expect(nonNegativeNumberSchema.parse(0)).toBe(0);
    expect(nonNegativeNumberSchema.safeParse(-0.1).success).toBe(false);
  });

  it('validates positive integers', () => {
    expect(positiveIntSchema.parse('3')).toBe(3);
    expect(positiveIntSchema.safeParse(0).success).toBe(false);
    expect(positiveIntSchema.safeParse(2.5).success).toBe(false);
  });

  it('restricts percentages to the inclusive range [0, 1]', () => {
    expect(percentSchema.parse(0.5)).toBe(0.5);
    expect(percentSchema.safeParse(1.2).success).toBe(false);
  });

  it('maintains a standalone integer schema', () => {
    expect(integerSchema.parse('4')).toBe(4);
    expect(integerSchema.safeParse(3.14).success).toBe(false);
  });
});
