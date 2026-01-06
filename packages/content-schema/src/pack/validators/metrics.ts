import { assertAllowlisted } from './allowlists.js';
import type { CrossReferenceState } from './state.js';

export const validateMetrics = (state: CrossReferenceState) => {
  const { pack, ctx, context, warn } = state;

  pack.metrics.forEach((metric, index) => {
    if (metric.source.kind === 'script') {
      assertAllowlisted(
        context.allowlists.scripts,
        metric.source.scriptId,
        ['metrics', index, 'source', 'scriptId'],
        ctx,
        warn,
        'allowlist.script.missing',
        `Metric "${metric.id}" references script "${metric.source.scriptId}" that is not in the scripts allowlist.`,
      );
    }
  });
};

