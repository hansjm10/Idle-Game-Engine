import { describe, expect, it } from 'vitest';

import {
  metricCollectionSchema,
  metricDefinitionSchema,
} from '../metrics.js';

describe('metricDefinitionSchema', () => {
  const baseMetric = {
    id: 'sessions-total',
    name: { default: 'Sessions', variants: {} },
    kind: 'counter',
    source: { kind: 'content' },
  } as const;

  it('normalizes units and attribute keys', () => {
    const definition = metricDefinitionSchema.parse({
      ...baseMetric,
      unit: '',
      attributes: ['Region', 'region', 'Device'],
    });

    expect(definition.unit).toBe('1');
    expect(definition.attributes).toEqual(['device', 'region']);
  });

  it('enforces aggregation for histograms', () => {
    expect(() =>
      metricDefinitionSchema.parse({
        ...baseMetric,
        id: 'response-latency',
        kind: 'histogram',
      }),
    ).toThrowError(/aggregation/i);
  });

  it('rejects metrics with excessive attribute keys', () => {
    expect(() =>
      metricDefinitionSchema.parse({
        ...baseMetric,
        attributes: ['a', 'b', 'c', 'd'],
      }),
    ).toThrowError(/attribute keys/i);
  });
});

describe('metricCollectionSchema', () => {
  it('rejects duplicate metric ids', () => {
    expect(() =>
      metricCollectionSchema.parse([
        {
          id: 'sessions-total',
          name: { default: 'Sessions', variants: {} },
          kind: 'counter',
          source: { kind: 'content' },
        },
        {
          id: 'sessions-total',
          name: { default: 'Sessions Copy', variants: {} },
          kind: 'gauge',
          source: { kind: 'runtime' },
        },
      ]),
    ).toThrowError(/duplicate metric id/i);
  });
});
