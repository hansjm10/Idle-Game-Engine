import { afterEach, describe, expect, it } from 'vitest';

import {
  PRDRegistry,
  PseudoRandomDistribution,
  calculatePRDAverageProbability,
  calculatePRDConstant,
  resetRNG,
  setRNGSeed,
} from './rng.js';

afterEach(() => {
  resetRNG();
});

describe('PseudoRandomDistribution', () => {
  it('clamps edge probabilities', () => {
    expect(calculatePRDConstant(-1)).toBe(0);
    expect(calculatePRDConstant(2)).toBe(1);
    expect(calculatePRDAverageProbability(0)).toBe(0);
    expect(calculatePRDAverageProbability(2)).toBe(1);
  });

  it('converges to the stated probability over many trials', () => {
    setRNGSeed(12345);
    const prd = new PseudoRandomDistribution(0.25);

    let successes = 0;
    const trials = 10000;
    for (let i = 0; i < trials; i += 1) {
      if (prd.roll()) {
        successes += 1;
      }
    }

    const actualRate = successes / trials;
    expect(actualRate).toBeCloseTo(0.25, 1);
  });

  it('computes constants for tiny probabilities without truncation', () => {
    const target = 0.0001;
    const constant = calculatePRDConstant(target);
    const actual = calculatePRDAverageProbability(constant);

    expect(actual).toBeCloseTo(target, 6);
  });

  it('converges for low base probabilities', () => {
    setRNGSeed(67890);
    const prd = new PseudoRandomDistribution(0.01);

    let successes = 0;
    const trials = 100000;
    for (let i = 0; i < trials; i += 1) {
      if (prd.roll()) {
        successes += 1;
      }
    }

    const actualRate = successes / trials;
    expect(actualRate).toBeCloseTo(0.01, 2);
  });

  it('bounds failure streaks', () => {
    setRNGSeed(12345);
    const prd = new PseudoRandomDistribution(0.25);

    let maxStreak = 0;
    let currentStreak = 0;
    for (let i = 0; i < 10000; i += 1) {
      if (prd.roll()) {
        maxStreak = Math.max(maxStreak, currentStreak);
        currentStreak = 0;
      } else {
        currentStreak += 1;
      }
    }

    expect(maxStreak).toBeLessThan(20);
  });

  it('is deterministic with the same seed', () => {
    setRNGSeed(4242);
    const prd1 = new PseudoRandomDistribution(0.5);
    const results1 = Array.from({ length: 100 }, () => prd1.roll());

    setRNGSeed(4242);
    const prd2 = new PseudoRandomDistribution(0.5);
    const results2 = Array.from({ length: 100 }, () => prd2.roll());

    expect(results1).toEqual(results2);
  });
});

describe('PRDRegistry', () => {
  it('captures and restores PRD state', () => {
    setRNGSeed(7);
    const registry = new PRDRegistry();
    const prd = registry.getOrCreate('mission.alpha', 0.2);
    prd.roll();
    prd.roll();

    const snapshot = registry.captureState();
    const restored = new PRDRegistry();
    restored.restoreState(snapshot);

    expect(restored.captureState()).toEqual(snapshot);
  });

  it('updates PRD base probability when re-requested', () => {
    const registry = new PRDRegistry(() => 0.99);
    const prd = registry.getOrCreate('mission.alpha', 0);

    prd.roll();
    expect(prd.getState().attempts).toBe(1);

    registry.getOrCreate('mission.alpha', 1);
    expect(prd.getState()).toEqual({ attempts: 0, constant: 1 });
  });

  it('updates PRD for tiny base-rate changes near zero', () => {
    const registry = new PRDRegistry(() => 0.99);
    const prd = registry.getOrCreate('mission.tiny', 0);

    const tinyRate = 1e-13;
    registry.getOrCreate('mission.tiny', tinyRate);
    expect(prd.getState().constant).toBeCloseTo(
      calculatePRDConstant(tinyRate),
      8,
    );
  });
});
