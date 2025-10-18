import { describe, expect, it } from 'vitest';

import {
  formatLatestDiagnosticTimelineEntry,
  type FormattedDiagnosticTimelineEntry,
} from './diagnostics.js';
import type {
  DiagnosticTimelineEntry,
  DiagnosticTimelineResult,
  DiagnosticTimelineSystemSpan,
} from '../diagnostics/diagnostic-timeline.js';

const baseConfiguration: DiagnosticTimelineResult['configuration'] =
  Object.freeze({
    capacity: 10,
    slowTickBudgetMs: undefined,
    enabled: true,
    slowSystemBudgetMs: undefined,
    systemHistorySize: undefined,
    tickBudgetMs: undefined,
  });

describe('formatLatestDiagnosticTimelineEntry', () => {
  it('returns null when no entries are available', () => {
    const result = formatLatestDiagnosticTimelineEntry({
      entries: [],
      head: 0,
      dropped: 0,
      configuration: baseConfiguration,
    });

    expect(result).toBeNull();
  });

  it('formats a slow tick with queue metrics and slow systems', () => {
    const slowSystem: DiagnosticTimelineSystemSpan = {
      id: 'physics',
      durationMs: 6.78,
      budgetMs: 4,
      isSlow: true,
      overBudgetMs: 2.78,
      history: {
        sampleCount: 8,
        averageMs: 5.5,
        maxMs: 7.1,
      },
    };
    const otherSystem: DiagnosticTimelineSystemSpan = {
      id: 'ai',
      durationMs: 3.12,
      budgetMs: 4,
      isSlow: false,
      overBudgetMs: 0,
      history: {
        sampleCount: 8,
        averageMs: 3,
        maxMs: 3.4,
      },
    };

    const entry: DiagnosticTimelineEntry = {
      tick: 24,
      startedAt: 1000,
      endedAt: 1012.34,
      durationMs: 12.34,
      budgetMs: 8,
      isSlow: true,
      overBudgetMs: 4.34,
      metadata: {
        accumulatorBacklogMs: 15.67,
        queue: {
          sizeBefore: 5,
          sizeAfter: 2,
          captured: 3,
          executed: 3,
          skipped: 1,
        },
        systems: [slowSystem, otherSystem],
      },
    };

    const formatted = formatLatestDiagnosticTimelineEntry({
      entries: [entry],
      head: 1,
      dropped: 0,
      configuration: baseConfiguration,
    });

    expect(formatted).not.toBeNull();
    const value = formatted as FormattedDiagnosticTimelineEntry;
    expect(value.message).toContain('Tick 24 completed in 12.34ms');
    expect(value.message).toContain('budget 8ms');
    expect(value.message).toContain('over by 4.34ms');
    expect(value.message).toContain('backlog 15.67ms');
    expect(value.message).toContain('queue captured 3, executed 3');
    expect(value.message).toContain(
      'slow systems physics:6.78ms (+2.78ms over 4ms)',
    );
    expect(value.context.entry).toBe(entry);
    expect(value.context.slowestSystem).toBe(slowSystem);
    expect(value.context.slowSystems).toEqual([slowSystem]);
    expect(value.context.accumulatorBacklogMs).toBe(15.67);
    expect(value.context.queue?.captured).toBe(3);
  });

  it('mentions the slowest system when none exceed their budget', () => {
    const systems: DiagnosticTimelineSystemSpan[] = [
      {
        id: 'render',
        durationMs: 4.01,
        budgetMs: 5,
        isSlow: false,
        overBudgetMs: 0,
      },
      {
        id: 'physics',
        durationMs: 5.87,
        budgetMs: 6,
        isSlow: false,
        overBudgetMs: 0,
      },
    ];

    const entry: DiagnosticTimelineEntry = {
      tick: 7,
      startedAt: 300,
      endedAt: 306,
      durationMs: 6,
      budgetMs: 10,
      isSlow: false,
      overBudgetMs: 0,
      metadata: {
        systems,
      },
    };

    const formatted = formatLatestDiagnosticTimelineEntry({
      entries: [entry],
      head: 1,
      dropped: 0,
      configuration: baseConfiguration,
    });

    expect(formatted).not.toBeNull();
    const value = formatted as FormattedDiagnosticTimelineEntry;
    expect(value.message).toContain(
      'slowest system physics:5.87ms',
    );
    expect(value.context.slowestSystem).toBe(systems[1]);
    expect(value.context.slowSystems).toBeUndefined();
  });
});
