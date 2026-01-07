import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  validateBoolean,
  validateField,
  validateNonEmptyString,
  validatePositiveInteger,
  validatePositiveNumber,
} from './command-validation.js';
import type {
  CommandResultFailure,
  ExecutionContext,
} from './command-dispatcher.js';
import { CommandPriority } from './command.js';
import { resetTelemetry, telemetry } from './telemetry.js';

// Helper to assert result is a failure (not undefined/void/Promise)
const asFailure = (result: unknown): CommandResultFailure =>
  result as CommandResultFailure;

describe('command-validation', () => {
  const createMockContext = (
    overrides?: Partial<ExecutionContext>,
  ): ExecutionContext =>
    ({
      step: 1,
      priority: CommandPriority.PLAYER,
      ...overrides,
    }) as ExecutionContext;

  afterEach(() => {
    resetTelemetry();
    vi.restoreAllMocks();
  });

  describe('validateField', () => {
    it('returns undefined when validation passes', () => {
      const ctx = createMockContext();
      const result = validateField(
        true,
        ctx,
        'test_event',
        {},
        {
          code: 'TEST_ERROR',
          message: 'Test error',
        },
      );
      expect(result).toBeUndefined();
    });

    it('returns CommandHandlerResult with success false when validation fails', () => {
      const ctx = createMockContext();
      const error = { code: 'INVALID_INPUT', message: 'Input is invalid' };
      const result = validateField(
        false,
        ctx,
        'validation_failed',
        { field: 'name' },
        error,
      );

      expect(result).toBeDefined();
      const failure = asFailure(result);
      expect(failure.success).toBe(false);
      expect(failure.error).toEqual(error);
    });

    it('records telemetry error on validation failure', () => {
      const recordErrorSpy = vi.spyOn(telemetry, 'recordError');
      const ctx = createMockContext({
        step: 5,
        priority: CommandPriority.AUTOMATION,
      });
      const error = {
        code: 'BAD_VALUE',
        message: 'Value is bad',
        details: { value: -1 },
      };

      validateField(false, ctx, 'bad_value_event', { input: -1 }, error);

      expect(recordErrorSpy).toHaveBeenCalledWith(
        'bad_value_event',
        expect.objectContaining({
          input: -1,
          step: 5,
          priority: CommandPriority.AUTOMATION,
        }),
      );
    });

    it('includes error details in result when provided', () => {
      const ctx = createMockContext();
      const error = {
        code: 'DETAILED_ERROR',
        message: 'Error with details',
        details: { extraInfo: 'data' },
      };
      const result = validateField(false, ctx, 'event', {}, error);

      expect(asFailure(result).error.details).toEqual({ extraInfo: 'data' });
    });

    it('omits error details from result when not provided', () => {
      const ctx = createMockContext();
      const error = { code: 'SIMPLE_ERROR', message: 'Simple error' };
      const result = validateField(false, ctx, 'event', {}, error);

      expect(asFailure(result).error).not.toHaveProperty('details');
    });
  });

  describe('validateNonEmptyString', () => {
    it('returns undefined for valid non-empty string', () => {
      const ctx = createMockContext();
      const result = validateNonEmptyString('hello', ctx, 'event', {}, {
        code: 'EMPTY',
        message: 'String is empty',
      });
      expect(result).toBeUndefined();
    });

    it('returns error for empty string', () => {
      const ctx = createMockContext();
      const result = validateNonEmptyString('', ctx, 'event', {}, {
        code: 'EMPTY',
        message: 'String is empty',
      });
      expect(asFailure(result).success).toBe(false);
    });

    it('returns error for whitespace-only string', () => {
      const ctx = createMockContext();
      const result = validateNonEmptyString('   ', ctx, 'event', {}, {
        code: 'EMPTY',
        message: 'String is empty',
      });
      expect(asFailure(result).success).toBe(false);
    });

    it('returns error for non-string types', () => {
      const ctx = createMockContext();
      const result = validateNonEmptyString(123, ctx, 'event', {}, {
        code: 'NOT_STRING',
        message: 'Not a string',
      });
      expect(asFailure(result).success).toBe(false);
    });

    it('returns error for null', () => {
      const ctx = createMockContext();
      const result = validateNonEmptyString(null, ctx, 'event', {}, {
        code: 'NULL',
        message: 'Value is null',
      });
      expect(asFailure(result).success).toBe(false);
    });

    it('returns error for undefined', () => {
      const ctx = createMockContext();
      const result = validateNonEmptyString(undefined, ctx, 'event', {}, {
        code: 'UNDEFINED',
        message: 'Value is undefined',
      });
      expect(asFailure(result).success).toBe(false);
    });
  });

  describe('validatePositiveInteger', () => {
    it('returns undefined for positive integer', () => {
      const ctx = createMockContext();
      const result = validatePositiveInteger(42, ctx, 'event', {}, {
        code: 'NOT_POS_INT',
        message: 'Not positive integer',
      });
      expect(result).toBeUndefined();
    });

    it('returns undefined for 1 (boundary)', () => {
      const ctx = createMockContext();
      const result = validatePositiveInteger(1, ctx, 'event', {}, {
        code: 'NOT_POS_INT',
        message: 'Not positive integer',
      });
      expect(result).toBeUndefined();
    });

    it('returns error for zero', () => {
      const ctx = createMockContext();
      const result = validatePositiveInteger(0, ctx, 'event', {}, {
        code: 'ZERO',
        message: 'Value is zero',
      });
      expect(asFailure(result).success).toBe(false);
    });

    it('returns error for negative integer', () => {
      const ctx = createMockContext();
      const result = validatePositiveInteger(-5, ctx, 'event', {}, {
        code: 'NEGATIVE',
        message: 'Value is negative',
      });
      expect(asFailure(result).success).toBe(false);
    });

    it('returns error for floating point number', () => {
      const ctx = createMockContext();
      const result = validatePositiveInteger(3.14, ctx, 'event', {}, {
        code: 'NOT_INT',
        message: 'Value is not integer',
      });
      expect(asFailure(result).success).toBe(false);
    });

    it('returns error for NaN', () => {
      const ctx = createMockContext();
      const result = validatePositiveInteger(NaN, ctx, 'event', {}, {
        code: 'NAN',
        message: 'Value is NaN',
      });
      expect(asFailure(result).success).toBe(false);
    });

    it('returns error for Infinity', () => {
      const ctx = createMockContext();
      const result = validatePositiveInteger(Infinity, ctx, 'event', {}, {
        code: 'INFINITY',
        message: 'Value is Infinity',
      });
      expect(asFailure(result).success).toBe(false);
    });

    it('returns error for string number', () => {
      const ctx = createMockContext();
      const result = validatePositiveInteger('42', ctx, 'event', {}, {
        code: 'STRING',
        message: 'Value is string',
      });
      expect(asFailure(result).success).toBe(false);
    });
  });

  describe('validatePositiveNumber', () => {
    it('returns undefined for positive number', () => {
      const ctx = createMockContext();
      const result = validatePositiveNumber(3.14, ctx, 'event', {}, {
        code: 'NOT_POS',
        message: 'Not positive',
      });
      expect(result).toBeUndefined();
    });

    it('returns undefined for very small positive number', () => {
      const ctx = createMockContext();
      const result = validatePositiveNumber(0.0001, ctx, 'event', {}, {
        code: 'NOT_POS',
        message: 'Not positive',
      });
      expect(result).toBeUndefined();
    });

    it('returns error for zero', () => {
      const ctx = createMockContext();
      const result = validatePositiveNumber(0, ctx, 'event', {}, {
        code: 'ZERO',
        message: 'Value is zero',
      });
      expect(asFailure(result).success).toBe(false);
    });

    it('returns error for negative number', () => {
      const ctx = createMockContext();
      const result = validatePositiveNumber(-0.5, ctx, 'event', {}, {
        code: 'NEGATIVE',
        message: 'Value is negative',
      });
      expect(asFailure(result).success).toBe(false);
    });

    it('returns error for NaN', () => {
      const ctx = createMockContext();
      const result = validatePositiveNumber(NaN, ctx, 'event', {}, {
        code: 'NAN',
        message: 'Value is NaN',
      });
      expect(asFailure(result).success).toBe(false);
    });

    it('returns error for Infinity', () => {
      const ctx = createMockContext();
      const result = validatePositiveNumber(Infinity, ctx, 'event', {}, {
        code: 'INFINITY',
        message: 'Value is Infinity',
      });
      expect(asFailure(result).success).toBe(false);
    });

    it('returns error for negative Infinity', () => {
      const ctx = createMockContext();
      const result = validatePositiveNumber(-Infinity, ctx, 'event', {}, {
        code: 'NEG_INFINITY',
        message: 'Value is -Infinity',
      });
      expect(asFailure(result).success).toBe(false);
    });
  });

  describe('validateBoolean', () => {
    it('returns undefined for true', () => {
      const ctx = createMockContext();
      const result = validateBoolean(true, ctx, 'event', {}, {
        code: 'NOT_BOOL',
        message: 'Not boolean',
      });
      expect(result).toBeUndefined();
    });

    it('returns undefined for false', () => {
      const ctx = createMockContext();
      const result = validateBoolean(false, ctx, 'event', {}, {
        code: 'NOT_BOOL',
        message: 'Not boolean',
      });
      expect(result).toBeUndefined();
    });

    it('returns error for truthy non-boolean', () => {
      const ctx = createMockContext();
      const result = validateBoolean(1, ctx, 'event', {}, {
        code: 'NOT_BOOL',
        message: 'Not boolean',
      });
      expect(asFailure(result).success).toBe(false);
    });

    it('returns error for falsy non-boolean', () => {
      const ctx = createMockContext();
      const result = validateBoolean(0, ctx, 'event', {}, {
        code: 'NOT_BOOL',
        message: 'Not boolean',
      });
      expect(asFailure(result).success).toBe(false);
    });

    it('returns error for string "true"', () => {
      const ctx = createMockContext();
      const result = validateBoolean('true', ctx, 'event', {}, {
        code: 'NOT_BOOL',
        message: 'Not boolean',
      });
      expect(asFailure(result).success).toBe(false);
    });

    it('returns error for null', () => {
      const ctx = createMockContext();
      const result = validateBoolean(null, ctx, 'event', {}, {
        code: 'NOT_BOOL',
        message: 'Not boolean',
      });
      expect(asFailure(result).success).toBe(false);
    });
  });
});
