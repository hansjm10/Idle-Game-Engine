import { describe, expect, it } from 'vitest';
import { isErrorWithDetails, extractErrorDetails } from './error-utils.js';

describe('error-utils', () => {
  describe('isErrorWithDetails', () => {
    it('returns true for Error objects with details property', () => {
      const error = Object.assign(new Error('test'), {
        details: { code: 'TEST_ERROR', context: 'testing' },
      });
      expect(isErrorWithDetails(error)).toBe(true);
    });

    it('returns true for plain objects with details property', () => {
      const error = {
        message: 'test error',
        details: { code: 'TEST_ERROR' },
      };
      expect(isErrorWithDetails(error)).toBe(true);
    });

    it('returns false for Error objects without details', () => {
      const error = new Error('test');
      expect(isErrorWithDetails(error)).toBe(false);
    });

    it('returns false for plain objects without details', () => {
      const error = { message: 'test error' };
      expect(isErrorWithDetails(error)).toBe(false);
    });

    it('returns false for null', () => {
      expect(isErrorWithDetails(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isErrorWithDetails(undefined)).toBe(false);
    });

    it('returns false for primitives', () => {
      expect(isErrorWithDetails('error')).toBe(false);
      expect(isErrorWithDetails(42)).toBe(false);
      expect(isErrorWithDetails(true)).toBe(false);
    });

    it('returns false when details is null', () => {
      const error = { details: null };
      expect(isErrorWithDetails(error)).toBe(false);
    });

    it('returns false when details is not an object', () => {
      expect(isErrorWithDetails({ details: 'string' })).toBe(false);
      expect(isErrorWithDetails({ details: 42 })).toBe(false);
      expect(isErrorWithDetails({ details: true })).toBe(false);
    });
  });

  describe('extractErrorDetails', () => {
    it('extracts details from Error objects with details property', () => {
      const details = { code: 'TEST_ERROR', context: 'testing' };
      const error = Object.assign(new Error('test'), { details });
      expect(extractErrorDetails(error)).toEqual(details);
    });

    it('extracts details from plain objects with details property', () => {
      const details = { code: 'TEST_ERROR' };
      const error = { message: 'test error', details };
      expect(extractErrorDetails(error)).toEqual(details);
    });

    it('returns undefined for Error objects without details', () => {
      const error = new Error('test');
      expect(extractErrorDetails(error)).toBeUndefined();
    });

    it('returns undefined for plain objects without details', () => {
      const error = { message: 'test error' };
      expect(extractErrorDetails(error)).toBeUndefined();
    });

    it('returns undefined for null', () => {
      expect(extractErrorDetails(null)).toBeUndefined();
    });

    it('returns undefined for undefined', () => {
      expect(extractErrorDetails(undefined)).toBeUndefined();
    });

    it('returns undefined for primitives', () => {
      expect(extractErrorDetails('error')).toBeUndefined();
      expect(extractErrorDetails(42)).toBeUndefined();
      expect(extractErrorDetails(true)).toBeUndefined();
    });

    it('returns undefined when details is null', () => {
      const error = { details: null };
      expect(extractErrorDetails(error)).toBeUndefined();
    });

    it('returns undefined when details is not an object', () => {
      expect(extractErrorDetails({ details: 'string' })).toBeUndefined();
      expect(extractErrorDetails({ details: 42 })).toBeUndefined();
      expect(extractErrorDetails({ details: true })).toBeUndefined();
    });

    it('handles nested details objects', () => {
      const details = {
        code: 'NESTED_ERROR',
        nested: { field: 'value' },
        array: [1, 2, 3],
      };
      const error = Object.assign(new Error('test'), { details });
      expect(extractErrorDetails(error)).toEqual(details);
    });
  });
});
