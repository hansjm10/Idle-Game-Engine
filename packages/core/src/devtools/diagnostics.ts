import type {
  DiagnosticTimelineEntry,
  DiagnosticTimelineResult,
  DiagnosticTimelineQueueMetrics,
  DiagnosticTimelineSystemSpan,
  LegacyDiagnosticTimelineSnapshot,
} from '../diagnostics/diagnostic-timeline.js';

export interface FormattedDiagnosticTimelineEntry {
  readonly message: string;
  readonly context: {
    readonly entry: DiagnosticTimelineEntry;
    readonly slowestSystem?: DiagnosticTimelineSystemSpan;
    readonly slowSystems?: readonly DiagnosticTimelineSystemSpan[];
    readonly accumulatorBacklogMs?: number;
    readonly queue?: DiagnosticTimelineQueueMetrics;
  };
}

export type DiagnosticTimelineFormatterInput =
  | DiagnosticTimelineResult
  | LegacyDiagnosticTimelineSnapshot
  | readonly DiagnosticTimelineEntry[]
  | null
  | undefined;

const DIAGNOSTIC_PREFIX = '[diagnostics:timeline]';

export function formatLatestDiagnosticTimelineEntry(
  source: DiagnosticTimelineFormatterInput,
): FormattedDiagnosticTimelineEntry | null {
  const entry = extractLatestEntry(source);
  if (!entry) {
    return null;
  }

  const metadata = entry.metadata;
  const systems = metadata?.systems;

  const slowestSystem = systems ? findSlowestSystem(systems) : undefined;
  const slowSystems =
    systems?.some((system) => system.isSlow)
      ? systems.filter((system) => system.isSlow)
      : undefined;

  const message = buildMessage(entry, slowestSystem, slowSystems);

  const context = {
    entry,
    slowestSystem,
    slowSystems,
    accumulatorBacklogMs: metadata?.accumulatorBacklogMs,
    queue: metadata?.queue,
  } as const;

  return { message, context };
}

function extractLatestEntry(
  source: DiagnosticTimelineFormatterInput,
): DiagnosticTimelineEntry | null {
  if (!source) {
    return null;
  }

  if (Array.isArray(source)) {
    return source.length > 0 ? source[source.length - 1] ?? null : null;
  }

  if (Array.isArray(source.entries) && source.entries.length > 0) {
    const entries = source.entries as readonly DiagnosticTimelineEntry[];
    return entries[entries.length - 1] ?? null;
  }

  return null;
}

function buildMessage(
  entry: DiagnosticTimelineEntry,
  slowestSystem: DiagnosticTimelineSystemSpan | undefined,
  slowSystems: readonly DiagnosticTimelineSystemSpan[] | undefined,
): string {
  const parts = [
    buildTickCompletionPart(entry),
    formatBacklogPart(entry.metadata?.accumulatorBacklogMs),
    formatQueuePart(entry.metadata?.queue),
    formatSlowSystemsPart(slowestSystem, slowSystems),
    formatErrorPart(entry.error),
  ].filter((part): part is string => part !== undefined);

  return `${DIAGNOSTIC_PREFIX} ${parts.join(' | ')}`;
}

function buildTickCompletionPart(entry: DiagnosticTimelineEntry): string {
  const durationLabel = formatDuration(entry.durationMs);
  const descriptors: string[] = [];

  if (typeof entry.budgetMs === 'number' && entry.budgetMs > 0) {
    descriptors.push(`budget ${formatDuration(entry.budgetMs)}ms`);
  }

  if (entry.overBudgetMs > 0) {
    descriptors.push(`over by ${formatDuration(entry.overBudgetMs)}ms`);
  } else if (entry.isSlow) {
    descriptors.push('slow tick');
  }

  const descriptorSuffix =
    descriptors.length > 0 ? ` (${descriptors.join(', ')})` : '';
  return `Tick ${entry.tick} completed in ${durationLabel}ms${descriptorSuffix}`;
}

function formatBacklogPart(backlog: unknown): string | undefined {
  if (typeof backlog !== 'number' || backlog <= 0) {
    return undefined;
  }
  return `backlog ${formatDuration(backlog)}ms`;
}

function formatQueuePart(queue: DiagnosticTimelineQueueMetrics | undefined): string | undefined {
  if (!queue) {
    return undefined;
  }

  const queueParts: string[] = [];
  if (typeof queue.captured === 'number' && queue.captured > 0) {
    queueParts.push(`captured ${queue.captured}`);
  }
  if (typeof queue.executed === 'number' && queue.executed > 0) {
    queueParts.push(`executed ${queue.executed}`);
  }
  if (typeof queue.skipped === 'number' && queue.skipped > 0) {
    queueParts.push(`skipped ${queue.skipped}`);
  }

  return queueParts.length > 0 ? `queue ${queueParts.join(', ')}` : undefined;
}

function formatSlowSystemsPart(
  slowestSystem: DiagnosticTimelineSystemSpan | undefined,
  slowSystems: readonly DiagnosticTimelineSystemSpan[] | undefined,
): string | undefined {
  if (slowSystems && slowSystems.length > 0) {
    const slowSystemLabels = slowSystems.map((system) =>
      formatSystemSummary(system, true),
    );
    return `slow systems ${slowSystemLabels.join(', ')}`;
  }

  if (slowestSystem) {
    return `slowest system ${formatSystemSummary(slowestSystem, false)}`;
  }

  return undefined;
}

function formatErrorPart(error: DiagnosticTimelineEntry['error']): string | undefined {
  if (!error) {
    return undefined;
  }

  return `error ${error.name ?? error.message ?? 'Unknown error'}`;
}

function findSlowestSystem(
  systems: readonly DiagnosticTimelineSystemSpan[],
): DiagnosticTimelineSystemSpan | undefined {
  if (systems.length === 0) {
    return undefined;
  }
  let slowest = systems[0];
  for (let index = 1; index < systems.length; index += 1) {
    const candidate = systems[index];
    if (candidate.durationMs > slowest.durationMs) {
      slowest = candidate;
    }
  }
  return slowest;
}

function formatSystemSummary(
  system: DiagnosticTimelineSystemSpan,
  highlightOverBudget: boolean,
): string {
  const base = `${system.id}:${formatDuration(system.durationMs)}ms`;

  if (
    highlightOverBudget &&
    system.overBudgetMs > 0 &&
    system.budgetMs !== undefined
  ) {
    return `${base} (+${formatDuration(system.overBudgetMs)}ms over ${formatDuration(system.budgetMs)}ms)`;
  }

  return base;
}

function formatDuration(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }

  const rounded = Math.round(value * 100) / 100;
  const fixed = rounded.toFixed(2);
  return fixed.replace(/\.?0+$/, '');
}
