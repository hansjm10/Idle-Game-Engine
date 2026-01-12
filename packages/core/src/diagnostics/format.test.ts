import { describe, expect, it } from 'vitest';

import type { DiagnosticTimelineResult } from './diagnostic-timeline.js';

import { evaluateDiagnostics, summarizeDiagnostics } from './format.js';

describe('diagnostics/format', () => {
  it('summarizes empty timelines deterministically', () => {
    const result: DiagnosticTimelineResult = {
      entries: [],
      head: 0,
      dropped: 0,
      configuration: { capacity: 10 },
    };

    const summary = summarizeDiagnostics(result);

    expect(Object.isFrozen(summary)).toBe(true);
    expect(summary).toMatchObject({
      totalEntries: 0,
      head: 0,
      dropped: 0,
      slowTickCount: 0,
      maxTickDurationMs: 0,
      avgTickDurationMs: 0,
      maxQueueBacklog: 0,
      configuration: result.configuration,
    });
    expect(summary.last).toBeUndefined();
  });

  it('computes tick duration, backlog, and threshold evaluations', () => {
    const result: DiagnosticTimelineResult = {
      entries: [
        {
          tick: 1,
          startedAt: 0,
          endedAt: 10,
          durationMs: 10,
          isSlow: false,
          overBudgetMs: 0,
          metadata: {
            queue: {
              sizeBefore: 0,
              sizeAfter: 3,
              captured: 0,
              executed: 0,
              skipped: 0,
            },
          },
        },
        {
          tick: 2,
          startedAt: 10,
          endedAt: 30,
          durationMs: 20,
          isSlow: true,
          overBudgetMs: 5,
          metadata: {},
        },
      ],
      head: 2,
      dropped: 0,
      configuration: { capacity: 10 },
    };

    const summary = summarizeDiagnostics(result);
    expect(summary.totalEntries).toBe(2);
    expect(summary.slowTickCount).toBe(1);
    expect(summary.maxTickDurationMs).toBe(20);
    expect(summary.avgTickDurationMs).toBe(15);
    expect(summary.maxQueueBacklog).toBe(3);
    expect(summary.last?.tick).toBe(2);

    const evaluation = evaluateDiagnostics(result, {
      maxTickDurationMs: 15,
      maxQueueBacklog: 2,
    });

    expect(Object.isFrozen(evaluation)).toBe(true);
    expect(evaluation.ok).toBe(false);
    expect(evaluation.reasons).toEqual([
      'maxTickDuration 20.00ms > 15ms',
      'maxQueueBacklog 3 > 2',
    ]);
  });
});

