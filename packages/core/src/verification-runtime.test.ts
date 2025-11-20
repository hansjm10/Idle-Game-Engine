import { describe, expect, it } from 'vitest';

import {
  IdleEngineRuntime,
  buildEconomyStateSummary,
  createVerificationRuntime,
  runVerificationTicks,
  createResourceState,
  resetRNG,
  setRNGSeed,
  type ResourceDefinition,
} from './index.js';

describe('verification runtime helpers', () => {
  it('buildEconomyStateSummary captures step, rates, and metadata', () => {
    const definitions: ResourceDefinition[] = [
      { id: 'gold', startAmount: 10, capacity: 100 },
    ];
    const runtime = new IdleEngineRuntime({ stepSizeMs: 50 });
    const resources = createResourceState(definitions);

    setRNGSeed(123);
    resources.applyIncome(0, 5);
    resources.applyExpense(0, 2);

    const summary = buildEconomyStateSummary({
      runtime,
      resources,
      publishedAt: 111,
    });

    resetRNG();

    expect(summary.step).toBe(0);
    expect(summary.stepSizeMs).toBe(50);
    expect(summary.publishedAt).toBe(111);
    expect(summary.definitionDigest.ids).toEqual(['gold']);
    expect(summary.rngSeed).toBe(123);
    expect(summary.resources[0]).toMatchObject({
      id: 'gold',
      amount: 10,
      capacity: 100,
      unlocked: true,
      visible: true,
      rates: {
        incomePerSecond: 5,
        expensePerSecond: 2,
        netPerSecond: 3,
      },
    });
  });

  it('createVerificationRuntime hydrates and advances from the summary step', () => {
    const definitions: ResourceDefinition[] = [
      { id: 'energy', startAmount: 5 },
    ];
    const runtime = new IdleEngineRuntime({
      stepSizeMs: 25,
      initialStep: 7,
    });
    const resources = createResourceState(definitions);
    resources.applyIncome(0, 4);

    const summary = buildEconomyStateSummary({
      runtime,
      resources,
      publishedAt: 0,
    });

    const verification = createVerificationRuntime({
      summary,
      definitions,
    });

    expect(verification.runtime.getCurrentStep()).toBe(summary.step);
    expect(verification.runtime.getStepSizeMs()).toBe(summary.stepSizeMs);

    const result = runVerificationTicks(verification, { ticks: 2 });
    const expectedDelta = 4 * (summary.stepSizeMs / 1000) * 2;
    const energyDelta = result.deltas.find(
      (delta) => delta.id === 'energy',
    );

    expect(energyDelta?.delta).toBeCloseTo(expectedDelta, 6);
    expect(result.end.step).toBe(summary.step + 2);
  });

  it('runVerificationTicks is deterministic for identical inputs', () => {
    const definitions: ResourceDefinition[] = [
      { id: 'coins', startAmount: 20 },
    ];
    const runtime = new IdleEngineRuntime({ stepSizeMs: 100 });
    const resources = createResourceState(definitions);
    resources.applyIncome(0, 3);

    const summary = buildEconomyStateSummary({
      runtime,
      resources,
      publishedAt: 0,
    });

    const firstRun = runVerificationTicks(
      createVerificationRuntime({ summary, definitions }),
      { ticks: 5 },
    );

    const secondRun = runVerificationTicks(
      createVerificationRuntime({ summary, definitions }),
      { ticks: 5 },
    );

    expect(secondRun.deltas).toEqual(firstRun.deltas);
    expect(secondRun.end.resources).toEqual(firstRun.end.resources);
  });
});
