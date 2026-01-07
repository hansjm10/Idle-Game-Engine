import { describe, expect, it } from 'vitest';

import {
  resolveMaxTicksPerCall,
  resolveOfflineProgressTotals,
} from './offline-progress-limits.js';

describe('offline-progress-limits', () => {
  describe('resolveOfflineProgressTotals', () => {
    const STEP_SIZE_MS = 100; // Matches engine design timestep

    it('calculates steps and remainder from elapsed time with no limits', () => {
      const result = resolveOfflineProgressTotals(1050, STEP_SIZE_MS);
      // 1050ms / 100ms = 10 steps + 50ms remainder
      // totalMs includes remainder when uncapped
      expect(result).toEqual({
        totalMs: 1050,
        totalSteps: 10,
        totalRemainderMs: 50,
      });
    });

    it('returns zero steps for elapsed time less than step size', () => {
      const result = resolveOfflineProgressTotals(50, STEP_SIZE_MS);
      // 50ms < 100ms = 0 steps, 50ms remainder
      // totalMs includes remainder when no steps
      expect(result).toEqual({
        totalMs: 50,
        totalSteps: 0,
        totalRemainderMs: 50,
      });
    });

    it('handles exact multiple of step size', () => {
      const result = resolveOfflineProgressTotals(500, STEP_SIZE_MS);
      expect(result).toEqual({
        totalMs: 500,
        totalSteps: 5,
        totalRemainderMs: 0,
      });
    });

    describe('maxElapsedMs limit', () => {
      it('caps elapsed time to maxElapsedMs', () => {
        const result = resolveOfflineProgressTotals(10000, STEP_SIZE_MS, {
          maxElapsedMs: 500,
        });
        expect(result).toEqual({
          totalMs: 500,
          totalSteps: 5,
          totalRemainderMs: 0,
        });
      });

      it('ignores maxElapsedMs when elapsed is smaller', () => {
        const result = resolveOfflineProgressTotals(300, STEP_SIZE_MS, {
          maxElapsedMs: 1000,
        });
        expect(result).toEqual({
          totalMs: 300,
          totalSteps: 3,
          totalRemainderMs: 0,
        });
      });

      it('handles maxElapsedMs with remainder', () => {
        const result = resolveOfflineProgressTotals(10000, STEP_SIZE_MS, {
          maxElapsedMs: 550,
        });
        // Capped to 550ms, 5 steps * 100 = 500ms, remainder 50ms
        expect(result).toEqual({
          totalMs: 550,
          totalSteps: 5,
          totalRemainderMs: 50,
        });
      });
    });

    describe('maxSteps limit', () => {
      it('caps steps to maxSteps', () => {
        const result = resolveOfflineProgressTotals(10000, STEP_SIZE_MS, {
          maxSteps: 3,
        });
        // Capped to 3 steps, remainder zeroed when capped
        expect(result).toEqual({
          totalMs: 300,
          totalSteps: 3,
          totalRemainderMs: 0,
        });
      });

      it('ignores maxSteps when calculated steps are smaller', () => {
        const result = resolveOfflineProgressTotals(250, STEP_SIZE_MS, {
          maxSteps: 10,
        });
        // 250ms / 100 = 2 steps + 50ms remainder, not capped
        expect(result).toEqual({
          totalMs: 250,
          totalSteps: 2,
          totalRemainderMs: 50,
        });
      });
    });

    describe('combined limits', () => {
      it('applies maxElapsedMs first, then maxSteps', () => {
        const result = resolveOfflineProgressTotals(10000, STEP_SIZE_MS, {
          maxElapsedMs: 800,
          maxSteps: 5,
        });
        // 800ms / 100 = 8 steps, capped to 5, remainder zeroed
        expect(result).toEqual({
          totalMs: 500,
          totalSteps: 5,
          totalRemainderMs: 0,
        });
      });

      it('uses maxElapsedMs when it is more restrictive', () => {
        const result = resolveOfflineProgressTotals(10000, STEP_SIZE_MS, {
          maxElapsedMs: 200,
          maxSteps: 100,
        });
        // Capped to 200ms first = 2 steps, under maxSteps limit
        expect(result).toEqual({
          totalMs: 200,
          totalSteps: 2,
          totalRemainderMs: 0,
        });
      });
    });

    describe('edge cases', () => {
      it('handles zero elapsed time', () => {
        const result = resolveOfflineProgressTotals(0, STEP_SIZE_MS);
        expect(result).toEqual({
          totalMs: 0,
          totalSteps: 0,
          totalRemainderMs: 0,
        });
      });

      it('handles zero step size by returning zeros', () => {
        const result = resolveOfflineProgressTotals(1000, 0);
        expect(result).toEqual({
          totalMs: 0,
          totalSteps: 0,
          totalRemainderMs: 0,
        });
      });

      it('normalizes negative maxElapsedMs to undefined (no limit)', () => {
        const result = resolveOfflineProgressTotals(500, STEP_SIZE_MS, {
          maxElapsedMs: -100,
        });
        // Negative is treated as no limit
        expect(result.totalSteps).toBe(5);
      });

      it('normalizes NaN maxSteps to undefined (no limit)', () => {
        const result = resolveOfflineProgressTotals(500, STEP_SIZE_MS, {
          maxSteps: NaN,
        });
        expect(result.totalSteps).toBe(5);
      });

      it('normalizes Infinity maxElapsedMs to undefined (no limit)', () => {
        const result = resolveOfflineProgressTotals(500, STEP_SIZE_MS, {
          maxElapsedMs: Infinity,
        });
        expect(result.totalSteps).toBe(5);
      });

      it('normalizes negative elapsed to zero', () => {
        const result = resolveOfflineProgressTotals(-100, STEP_SIZE_MS);
        expect(result).toEqual({
          totalMs: 0,
          totalSteps: 0,
          totalRemainderMs: 0,
        });
      });
    });
  });

  describe('resolveMaxTicksPerCall', () => {
    it('returns undefined when no limits provided', () => {
      const result = resolveMaxTicksPerCall();
      expect(result).toBeUndefined();
    });

    it('returns undefined when limits object has no maxTicksPerCall', () => {
      const result = resolveMaxTicksPerCall({});
      expect(result).toBeUndefined();
    });

    it('returns maxTicksPerCall when valid positive integer', () => {
      const result = resolveMaxTicksPerCall({ maxTicksPerCall: 50 });
      expect(result).toBe(50);
    });

    it('returns undefined for zero maxTicksPerCall', () => {
      const result = resolveMaxTicksPerCall({ maxTicksPerCall: 0 });
      expect(result).toBeUndefined();
    });

    it('returns undefined for negative maxTicksPerCall', () => {
      const result = resolveMaxTicksPerCall({ maxTicksPerCall: -10 });
      expect(result).toBeUndefined();
    });

    it('returns undefined for NaN maxTicksPerCall', () => {
      const result = resolveMaxTicksPerCall({ maxTicksPerCall: NaN });
      expect(result).toBeUndefined();
    });

    it('returns undefined for Infinity maxTicksPerCall', () => {
      const result = resolveMaxTicksPerCall({ maxTicksPerCall: Infinity });
      expect(result).toBeUndefined();
    });

    it('floors floating point maxTicksPerCall', () => {
      const result = resolveMaxTicksPerCall({ maxTicksPerCall: 5.9 });
      expect(result).toBe(5);
    });
  });
});
