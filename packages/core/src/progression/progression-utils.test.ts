import { describe, expect, it, vi } from 'vitest';

import type {
  FormulaEvaluationContext,
  NumericFormula,
} from '@idle-engine/content-schema';

import {
  clampOwned,
  evaluateCostFormula,
  evaluateFiniteNumericFormula,
  getDisplayName,
  normalizeFiniteNonNegativeNumber,
  normalizeNonNegativeInt,
  normalizeOptionalNonNegativeInt,
} from './progression-utils.js';

const context = {} as FormulaEvaluationContext;

const constant = (value: number): NumericFormula => ({
  kind: 'constant',
  value,
});

describe('progression-utils', () => {
  describe('evaluateCostFormula', () => {
    it('returns finite evaluated values', () => {
      expect(evaluateCostFormula(constant(5), context)).toBe(5);
    });

    it('returns undefined for non-finite values and thrown errors', () => {
      expect(
        evaluateCostFormula(constant(Number.POSITIVE_INFINITY), context),
      ).toBeUndefined();

      expect(
        evaluateCostFormula({ kind: 'invalid' } as unknown as NumericFormula, context),
      ).toBeUndefined();
    });
  });

  describe('evaluateFiniteNumericFormula', () => {
    it('reports errors when evaluation returns non-finite values or throws', () => {
      const onError = vi.fn();

      expect(
        evaluateFiniteNumericFormula(constant(Number.NaN), context, onError, 'test-formula'),
      ).toBeUndefined();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('returned invalid value'),
        }),
      );

      onError.mockClear();

      expect(
        evaluateFiniteNumericFormula(
          { kind: 'invalid' } as unknown as NumericFormula,
          context,
          onError,
          'test-formula',
        ),
      ).toBeUndefined();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('failed:'),
        }),
      );
    });
  });

  describe('normalizers', () => {
    it('normalizes finite non-negative numbers', () => {
      expect(normalizeFiniteNonNegativeNumber(3)).toBe(3);
      expect(normalizeFiniteNonNegativeNumber(-1)).toBe(0);
      expect(normalizeFiniteNonNegativeNumber(Number.NaN)).toBe(0);
      expect(normalizeFiniteNonNegativeNumber('3')).toBe(0);
    });

    it('normalizes non-negative ints', () => {
      expect(normalizeNonNegativeInt(3.9)).toBe(3);
      expect(normalizeNonNegativeInt(-1)).toBe(0);
      expect(normalizeNonNegativeInt(Number.POSITIVE_INFINITY)).toBe(0);
    });

    it('normalizes optional non-negative ints', () => {
      expect(normalizeOptionalNonNegativeInt(undefined)).toBeUndefined();
      expect(normalizeOptionalNonNegativeInt(3.9)).toBe(3);
      expect(normalizeOptionalNonNegativeInt(-1)).toBeUndefined();
      expect(normalizeOptionalNonNegativeInt(Number.NaN)).toBeUndefined();
    });
  });

  describe('clampOwned', () => {
    it('clamps owned counts to non-negative bounds', () => {
      expect(clampOwned(-5)).toBe(0);
      expect(clampOwned(5)).toBe(5);
      expect(clampOwned(Number.NaN)).toBe(0);
      expect(clampOwned(10, 3)).toBe(3);
      expect(clampOwned(-1, -5)).toBe(0);
    });
  });

  describe('getDisplayName', () => {
    it('resolves strings and localized default fields', () => {
      expect(getDisplayName('Name', 'fallback')).toBe('Name');
      expect(getDisplayName({ default: 'Localized' }, 'fallback')).toBe(
        'Localized',
      );
      expect(getDisplayName({ default: 123 }, 'fallback')).toBe('fallback');
      expect(getDisplayName(null, 'fallback')).toBe('fallback');
    });
  });
});

