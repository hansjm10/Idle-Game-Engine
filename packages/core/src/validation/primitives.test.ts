import { describe, expect, it } from 'vitest';

import {
  isBoolean,
  isFiniteNumber,
  isNonBlankString,
  isNonEmptyString,
  isNonNegativeInteger,
} from './primitives.js';

describe('validation/primitives', () => {
  describe('isNonEmptyString', () => {
    it('accepts strings with length > 0 (including whitespace)', () => {
      expect(isNonEmptyString('hello')).toBe(true);
      expect(isNonEmptyString('   ')).toBe(true);
      expect(isNonEmptyString('\n')).toBe(true);
    });

    it('rejects empty strings and non-strings', () => {
      expect(isNonEmptyString('')).toBe(false);
      expect(isNonEmptyString(1)).toBe(false);
      expect(isNonEmptyString(null)).toBe(false);
      expect(isNonEmptyString(undefined)).toBe(false);
    });
  });

  describe('isNonBlankString', () => {
    it('accepts strings whose trim() is non-empty', () => {
      expect(isNonBlankString('hello')).toBe(true);
      expect(isNonBlankString(' hello ')).toBe(true);
    });

    it('rejects blank strings and non-strings', () => {
      expect(isNonBlankString('')).toBe(false);
      expect(isNonBlankString('   ')).toBe(false);
      expect(isNonBlankString('\n')).toBe(false);
      expect(isNonBlankString(1)).toBe(false);
      expect(isNonBlankString(null)).toBe(false);
      expect(isNonBlankString(undefined)).toBe(false);
    });
  });

  describe('isFiniteNumber', () => {
    it('accepts finite numbers', () => {
      expect(isFiniteNumber(0)).toBe(true);
      expect(isFiniteNumber(1)).toBe(true);
      expect(isFiniteNumber(-1)).toBe(true);
      expect(isFiniteNumber(3.14)).toBe(true);
    });

    it('rejects NaN, infinities, and non-numbers', () => {
      expect(isFiniteNumber(Number.NaN)).toBe(false);
      expect(isFiniteNumber(Number.POSITIVE_INFINITY)).toBe(false);
      expect(isFiniteNumber(Number.NEGATIVE_INFINITY)).toBe(false);
      expect(isFiniteNumber('1')).toBe(false);
      expect(isFiniteNumber(null)).toBe(false);
      expect(isFiniteNumber(undefined)).toBe(false);
    });
  });

  describe('isNonNegativeInteger', () => {
    it('accepts integers >= 0', () => {
      expect(isNonNegativeInteger(0)).toBe(true);
      expect(isNonNegativeInteger(1)).toBe(true);
      expect(isNonNegativeInteger(42)).toBe(true);
    });

    it('rejects negatives, non-integers, and non-numbers', () => {
      expect(isNonNegativeInteger(-1)).toBe(false);
      expect(isNonNegativeInteger(1.5)).toBe(false);
      expect(isNonNegativeInteger(Number.NaN)).toBe(false);
      expect(isNonNegativeInteger(Number.POSITIVE_INFINITY)).toBe(false);
      expect(isNonNegativeInteger('1')).toBe(false);
      expect(isNonNegativeInteger(null)).toBe(false);
      expect(isNonNegativeInteger(undefined)).toBe(false);
    });
  });

  describe('isBoolean', () => {
    it('accepts booleans', () => {
      expect(isBoolean(true)).toBe(true);
      expect(isBoolean(false)).toBe(true);
    });

    it('rejects non-booleans', () => {
      expect(isBoolean(0)).toBe(false);
      expect(isBoolean(1)).toBe(false);
      expect(isBoolean('true')).toBe(false);
      expect(isBoolean(null)).toBe(false);
      expect(isBoolean(undefined)).toBe(false);
    });
  });
});
