import type { DiagnosticTimelineEntry, DiagnosticTimelineResult } from './diagnostic-timeline.js';

export interface DiagnosticsSummary {
  readonly totalEntries: number;
  readonly head: number;
  readonly dropped: number;
  readonly slowTickCount: number;
  readonly maxTickDurationMs: number;
  readonly avgTickDurationMs: number;
  readonly maxQueueBacklog: number;
  readonly configuration: DiagnosticTimelineResult['configuration'];
  readonly last?: DiagnosticTimelineEntry;
}

export interface DiagnosticsThresholds {
  /** Fail when any tick exceeds this duration (ms). If omitted, no check. */
  readonly maxTickDurationMs?: number;
  /** Fail when any tick ends with queue backlog above this size. If omitted, no check. */
  readonly maxQueueBacklog?: number;
}

export interface DiagnosticsEvaluation {
  readonly ok: boolean;
  readonly reasons: readonly string[];
  readonly summary: DiagnosticsSummary;
}

export function summarizeDiagnostics(result: DiagnosticTimelineResult): DiagnosticsSummary {
  const entries = result.entries;
  const totalEntries = entries.length;
  let slowTickCount = 0;
  let maxTickDurationMs = 0;
  let totalDurationMs = 0;
  let maxQueueBacklog = 0;

  for (const e of entries) {
    if (e.isSlow) slowTickCount += 1;
    if (e.durationMs > maxTickDurationMs) maxTickDurationMs = e.durationMs;
    totalDurationMs += e.durationMs;
    const backlog = e.metadata?.queue?.sizeAfter ?? 0;
    if (backlog > maxQueueBacklog) maxQueueBacklog = backlog;
  }

  const avgTickDurationMs = totalEntries > 0 ? totalDurationMs / totalEntries : 0;
  const last = totalEntries > 0 ? entries[totalEntries - 1] : undefined;

  return Object.freeze({
    totalEntries,
    head: result.head,
    dropped: result.dropped,
    slowTickCount,
    maxTickDurationMs,
    avgTickDurationMs,
    maxQueueBacklog,
    configuration: result.configuration,
    last,
  });
}

export function evaluateDiagnostics(
  result: DiagnosticTimelineResult,
  thresholds: DiagnosticsThresholds = {},
): DiagnosticsEvaluation {
  const summary = summarizeDiagnostics(result);
  const reasons: string[] = [];

  if (typeof thresholds.maxTickDurationMs === 'number') {
    if (summary.maxTickDurationMs > thresholds.maxTickDurationMs) {
      reasons.push(
        `maxTickDuration ${summary.maxTickDurationMs.toFixed(2)}ms > ${thresholds.maxTickDurationMs}ms`,
      );
    }
  }

  if (typeof thresholds.maxQueueBacklog === 'number') {
    if (summary.maxQueueBacklog > thresholds.maxQueueBacklog) {
      reasons.push(
        `maxQueueBacklog ${summary.maxQueueBacklog} > ${thresholds.maxQueueBacklog}`,
      );
    }
  }

  return Object.freeze({ ok: reasons.length === 0, reasons, summary });
}

