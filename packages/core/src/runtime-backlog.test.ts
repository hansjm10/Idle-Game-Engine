import { describe, expect, it } from 'vitest';

import {
  normalizeRuntimeBacklogFields,
  normalizeRuntimeBacklogSourceState,
} from './runtime-backlog.js';

describe('runtime backlog normalization', () => {
  it.each([
    {
      name: 'missing backlog fields',
      fields: undefined,
      expected: {
        accumulatorBacklogMs: 0,
        hostFrameBacklogMs: 0,
        creditedBacklogMs: 0,
      },
    },
    {
      name: 'legacy total-only backlog',
      fields: { accumulatorBacklogMs: 75 },
      expected: {
        accumulatorBacklogMs: 75,
        hostFrameBacklogMs: 75,
        creditedBacklogMs: 0,
      },
    },
    {
      name: 'credited backlog with missing host-frame split',
      fields: { accumulatorBacklogMs: 75, creditedBacklogMs: 25 },
      expected: {
        accumulatorBacklogMs: 75,
        hostFrameBacklogMs: 50,
        creditedBacklogMs: 25,
      },
    },
    {
      name: 'source-specific split backlog',
      fields: {
        accumulatorBacklogMs: 75,
        hostFrameBacklogMs: 10,
        creditedBacklogMs: 25,
      },
      expected: {
        accumulatorBacklogMs: 35,
        hostFrameBacklogMs: 10,
        creditedBacklogMs: 25,
      },
    },
    {
      name: 'invalid backlog fields',
      fields: {
        accumulatorBacklogMs: Number.NaN,
        hostFrameBacklogMs: -1,
        creditedBacklogMs: Number.POSITIVE_INFINITY,
      },
      expected: {
        accumulatorBacklogMs: 0,
        hostFrameBacklogMs: 0,
        creditedBacklogMs: 0,
      },
    },
    {
      name: 'credited backlog exceeding total',
      fields: { accumulatorBacklogMs: 50, creditedBacklogMs: 75 },
      expected: {
        accumulatorBacklogMs: 75,
        hostFrameBacklogMs: 0,
        creditedBacklogMs: 75,
      },
    },
  ])('normalizes $name', ({ fields, expected }) => {
    expect(normalizeRuntimeBacklogFields(fields)).toEqual(expected);
  });

  it('normalizes persisted fields into runtime source state', () => {
    expect(
      normalizeRuntimeBacklogSourceState({
        accumulatorBacklogMs: 275,
        creditedBacklogMs: 125,
      }),
    ).toEqual({
      hostFrameMs: 150,
      creditedMs: 125,
    });
  });
});
