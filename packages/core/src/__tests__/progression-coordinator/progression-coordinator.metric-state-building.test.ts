import { describe, expect, it } from 'vitest';

import { createProgressionCoordinator } from '../../index.js';
import { createContentPack, createResourceDefinition } from '../../content-test-helpers.js';

describe('Metric state building', () => {
  it('builds metric states from content pack definitions', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 0,
    });

    // Create a pack with metrics manually
    const basePack = createContentPack({
      resources: [energy],
    });

    // Add metrics to the pack
    const packWithMetrics = {
      ...basePack,
      metrics: [
        {
          id: 'metric.playtime',
          name: { default: 'Playtime', variants: {} },
          description: { default: 'Total time played', variants: {} },
          kind: 'counter' as const,
          unit: 'seconds',
          aggregation: 'sum' as const,
          attributes: [],
          source: { kind: 'runtime' as const },
        },
        {
          id: 'metric.resources-gained',
          name: { default: 'Resources Gained', variants: {} },
          description: 'Total resources accumulated',
          kind: 'gauge' as const,
          unit: '1',
          aggregation: 'cumulative' as const,
          attributes: [],
          source: { kind: 'content' as const },
        },
      ],
      lookup: {
        ...basePack.lookup,
        metrics: new Map([
          ['metric.playtime', { id: 'metric.playtime' }],
          ['metric.resources-gained', { id: 'metric.resources-gained' }],
        ]),
      },
    };

    const coordinator = createProgressionCoordinator({
      content: packWithMetrics as any,
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);

    // Verify metric states are built
    const metricStates = coordinator.state.metrics;
    expect(metricStates).toBeDefined();
    expect(metricStates?.length).toBe(2);

    const playtimeMetric = metricStates?.find((m) => m.id === 'metric.playtime');
    expect(playtimeMetric?.displayName).toBe('Playtime');
    expect(playtimeMetric?.description).toBe('Total time played');
    expect(playtimeMetric?.kind).toBe('counter');
    expect(playtimeMetric?.unit).toBe('seconds');
    expect(playtimeMetric?.aggregation).toBe('sum');
    expect(playtimeMetric?.sourceKind).toBe('runtime');

    const resourcesMetric = metricStates?.find((m) => m.id === 'metric.resources-gained');
    expect(resourcesMetric?.displayName).toBe('Resources Gained');
    expect(resourcesMetric?.description).toBe('Total resources accumulated');
    expect(resourcesMetric?.kind).toBe('gauge');
    expect(resourcesMetric?.sourceKind).toBe('content');
  });
});
