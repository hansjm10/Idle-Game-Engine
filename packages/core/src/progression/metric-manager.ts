import type { NormalizedMetric } from '@idle-engine/content-schema';

/**
 * MetricManager builds metric state views and optionally exposes a value provider.
 *
 * The progression coordinator stores metric definitions in authoritative state so
 * shells can render them. Runtime values are optionally supplied by host code via
 * `getCustomMetricValue`, surfaced through a {@link MetricValueProvider}.
 */
import type { MetricValueProvider, ProgressionMetricState } from '../progression.js';

import { getDisplayName } from './progression-utils.js';

function buildMetricStates(
  metrics: readonly NormalizedMetric[],
): readonly ProgressionMetricState[] {
  if (!metrics || metrics.length === 0) {
    return Object.freeze([]);
  }

  const states: ProgressionMetricState[] = [];

  for (const metric of metrics) {
    const displayName = getDisplayName(metric.name, metric.id);
    const description =
      typeof metric.description === 'object' && metric.description !== null
        ? metric.description.default
        : metric.description;

    const state: ProgressionMetricState = {
      id: metric.id,
      displayName,
      description: description ?? undefined,
      kind: metric.kind,
      unit: metric.unit,
      aggregation: metric.aggregation,
      sourceKind: metric.source.kind,
    };

    states.push(state);
  }

  return Object.freeze(states);
}

export class MetricManager {
  public readonly metricStates: readonly ProgressionMetricState[];
  public readonly metricValueProvider: MetricValueProvider | undefined;

  constructor(options: {
    readonly metrics: readonly NormalizedMetric[];
    readonly getCustomMetricValue?: (metricId: string) => number;
  }) {
    this.metricStates = buildMetricStates(options.metrics);
    this.metricValueProvider = options.getCustomMetricValue
      ? {
          getMetricValue: (metricId: string) => {
            const value = options.getCustomMetricValue?.(metricId);
            return typeof value === 'number' && Number.isFinite(value)
              ? value
              : undefined;
          },
        }
      : undefined;
  }
}
