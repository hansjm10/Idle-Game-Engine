import { afterEach, describe, expect, it } from 'vitest';

import {
  getCurrentRNGSeed,
  getRNGState,
  resetRNG,
  seededRandom,
  setRNGSeed,
  setRNGState,
} from './rng.js';

/**
 * Tests for rng.ts that complement the existing rng-prd.test.ts file.
 * Focus on coverage gaps not already tested in rng-prd.test.ts.
 */
describe('rng', () => {
  afterEach(() => {
    resetRNG();
  });

  describe('seeded RNG core functions', () => {
    describe('getCurrentRNGSeed', () => {
      it('returns undefined before seed is set', () => {
        expect(getCurrentRNGSeed()).toBeUndefined();
      });

      it('returns the seed after setRNGSeed', () => {
        setRNGSeed(777);
        expect(getCurrentRNGSeed()).toBe(777);
      });

      it('returns normalized seed (unsigned 32-bit)', () => {
        setRNGSeed(-1);
        // -1 >>> 0 = 4294967295
        expect(getCurrentRNGSeed()).toBe(4294967295);
      });
    });

    describe('getRNGState', () => {
      it('returns undefined before seed is set', () => {
        expect(getRNGState()).toBeUndefined();
      });

      it('returns state after setRNGSeed', () => {
        setRNGSeed(12345);
        expect(getRNGState()).toBeDefined();
      });

      it('changes after each seededRandom call', () => {
        setRNGSeed(42);
        const state1 = getRNGState();
        seededRandom();
        const state2 = getRNGState();
        expect(state1).not.toBe(state2);
      });
    });

    describe('setRNGSeed', () => {
      it('initializes the RNG with a seed', () => {
        setRNGSeed(12345);
        expect(getCurrentRNGSeed()).toBe(12345);
      });

      it('resets state when called with a new seed', () => {
        setRNGSeed(12345);
        seededRandom();
        seededRandom();
        const stateAfterCalls = getRNGState();

        setRNGSeed(12345);
        expect(getRNGState()).not.toBe(stateAfterCalls);
      });

      it('handles seed of 0 by using 1 for state', () => {
        setRNGSeed(0);
        // Seed 0 normalizes to 0, but state becomes 0 || 0x1 = 1
        expect(getCurrentRNGSeed()).toBe(0);
        expect(getRNGState()).toBe(1);
      });
    });

    describe('seededRandom', () => {
      it('produces deterministic sequence with same seed', () => {
        setRNGSeed(42);
        const first = [seededRandom(), seededRandom(), seededRandom()];

        setRNGSeed(42);
        const second = [seededRandom(), seededRandom(), seededRandom()];

        expect(first).toEqual(second);
      });

      it('produces values in [0, 1) range', () => {
        setRNGSeed(99999);
        for (let i = 0; i < 1000; i++) {
          const value = seededRandom();
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThan(1);
        }
      });

      it('produces different sequences with different seeds', () => {
        setRNGSeed(1);
        const seq1 = [seededRandom(), seededRandom(), seededRandom()];

        setRNGSeed(2);
        const seq2 = [seededRandom(), seededRandom(), seededRandom()];

        expect(seq1).not.toEqual(seq2);
      });

      it('auto-initializes when called without seed', () => {
        resetRNG();
        // Should not throw, uses fallback from Math.random()
        const value = seededRandom();
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(1);
        // After auto-init, seed should be defined
        expect(getCurrentRNGSeed()).toBeDefined();
      });
    });

    describe('setRNGState', () => {
      it('can save and restore RNG state', () => {
        setRNGSeed(12345);
        seededRandom();
        seededRandom();
        const savedState = getRNGState();

        const nextValues = [seededRandom(), seededRandom(), seededRandom()];

        setRNGState(savedState!);
        const restoredValues = [seededRandom(), seededRandom(), seededRandom()];

        expect(restoredValues).toEqual(nextValues);
      });

      it('throws Error for NaN state', () => {
        expect(() => setRNGState(NaN)).toThrow(
          'RNG state must be a finite number.',
        );
      });

      it('throws Error for Infinity state', () => {
        expect(() => setRNGState(Infinity)).toThrow(
          'RNG state must be a finite number.',
        );
      });

      it('throws Error for negative Infinity state', () => {
        expect(() => setRNGState(-Infinity)).toThrow(
          'RNG state must be a finite number.',
        );
      });

      it('accepts negative numbers (converts to 32-bit signed)', () => {
        setRNGSeed(12345);
        // This should not throw
        setRNGState(-1);
        expect(getRNGState()).toBe(-1);
      });
    });

    describe('resetRNG', () => {
      it('clears seed and state', () => {
        setRNGSeed(12345);
        seededRandom();
        resetRNG();

        expect(getCurrentRNGSeed()).toBeUndefined();
        expect(getRNGState()).toBeUndefined();
      });
    });
  });
});
