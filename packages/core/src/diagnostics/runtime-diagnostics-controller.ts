import {
  createDiagnosticTimelineRecorder,
  createNoopDiagnosticTimelineRecorder,
  getDefaultHighResolutionClock,
  toErrorLike,
  type CompleteTickOptions,
  type DiagnosticTickHandle,
  type DiagnosticTimelineEventMetrics,
  type DiagnosticTimelineMetadata,
  type DiagnosticTimelineOptions,
  type DiagnosticTimelineQueueMetrics,
  type DiagnosticTimelineRecorder,
  type DiagnosticTimelineResult,
  type DiagnosticTimelinePhase,
  type DiagnosticTimelineSystemHistory,
  type DiagnosticTimelineSystemSpan,
  type HighResolutionClock,
  type ResolvedDiagnosticTimelineOptions,
} from './diagnostic-timeline.js';
import { telemetry } from '../telemetry.js';

const DEFAULT_SLOW_SYSTEM_BUDGET_MS = 16;
const DEFAULT_SYSTEM_HISTORY_SIZE = 60;

export interface RuntimeDiagnosticsTimelineOptions
  extends DiagnosticTimelineOptions {
  readonly enabled?: boolean;
  readonly slowSystemBudgetMs?: number;
  readonly systemHistorySize?: number;
}

export interface IdleEngineRuntimeDiagnosticsOptions {
  readonly timeline?: RuntimeDiagnosticsTimelineOptions | false;
}

export interface RuntimeDiagnosticsController {
  readonly isEnabled: boolean;
  readonly timeline: DiagnosticTimelineRecorder;
  beginTick(tick: number): RuntimeTickDiagnostics;
  readDelta(sinceHead?: number): DiagnosticTimelineResult;
  snapshot(): DiagnosticTimelineResult;
  enable(options?: RuntimeDiagnosticsTimelineOptions): void;
  disable(): void;
  getConfiguration(): Readonly<ResolvedDiagnosticTimelineOptions>;
  clear(): void;
}

export interface RuntimeTickDiagnostics {
  readonly tick: number;
  recordQueueMetrics(metrics: DiagnosticTimelineQueueMetrics): void;
  recordEventMetrics(metrics: DiagnosticTimelineEventMetrics): void;
  setAccumulatorBacklogMs(backlogMs: number): void;
  addPhase(
    name: string,
    durationMs: number,
    offsetMs?: number,
  ): void;
  startSystem(systemId: string): RuntimeSystemSpanDiagnostics;
  complete(): void;
  fail(error: unknown): never;
}

export interface RuntimeSystemSpanDiagnostics {
  end(): void;
  fail(error: unknown): never;
}

export interface CreateRuntimeDiagnosticsControllerOptions {
  readonly stepSizeMs: number;
}

const noopTimeline = createNoopDiagnosticTimelineRecorder();

const noopSystemSpan: RuntimeSystemSpanDiagnostics = {
  end() {
    // intentionally noop
  },
  fail(error: unknown): never {
    throw error;
  },
};

const noopTickDiagnostics: RuntimeTickDiagnostics = {
  tick: -1,
  recordQueueMetrics() {
    // intentionally noop
  },
  recordEventMetrics() {
    // intentionally noop
  },
  setAccumulatorBacklogMs() {
    // intentionally noop
  },
  addPhase() {
    // intentionally noop
  },
  startSystem() {
    return noopSystemSpan;
  },
  complete() {
    // intentionally noop
  },
  fail(error: unknown): never {
    throw error;
  },
};

interface SystemHistoryEntry {
  readonly values: number[];
}

interface RuntimeTickContext {
  readonly tick: number;
  readonly handle: DiagnosticTickHandle;
  readonly clock: HighResolutionClock;
  readonly controller: EnabledRuntimeDiagnostics;
  readonly tickBudgetMs?: number;
}

class EnabledRuntimeDiagnostics {
  readonly isEnabled = true;
  readonly timeline: DiagnosticTimelineRecorder;
  private readonly clock: HighResolutionClock;
  private readonly slowSystemBudgetMs?: number;
  private readonly systemHistorySize: number;
  private readonly tickBudgetMs?: number;
  private readonly systemHistory = new Map<string, SystemHistoryEntry>();
  private readonly resolvedConfiguration: Readonly<ResolvedDiagnosticTimelineOptions>;

  constructor(
    options: RuntimeDiagnosticsTimelineOptions,
    context: CreateRuntimeDiagnosticsControllerOptions,
  ) {
    const clock = options.clock ?? getDefaultHighResolutionClock();
    this.clock = clock;

    const recorderOptions: DiagnosticTimelineOptions = {
      capacity: options.capacity,
      slowTickBudgetMs: options.slowTickBudgetMs,
      clock,
    };

    this.timeline = createDiagnosticTimelineRecorder(recorderOptions);

    const resolvedSlowSystemBudget =
      typeof options.slowSystemBudgetMs === 'number' &&
      Number.isFinite(options.slowSystemBudgetMs) &&
      options.slowSystemBudgetMs > 0
        ? options.slowSystemBudgetMs
        : Math.min(context.stepSizeMs, DEFAULT_SLOW_SYSTEM_BUDGET_MS);

    this.slowSystemBudgetMs =
      resolvedSlowSystemBudget > 0 ? resolvedSlowSystemBudget : undefined;

    const resolvedHistorySize =
      typeof options.systemHistorySize === 'number' &&
      Number.isFinite(options.systemHistorySize) &&
      options.systemHistorySize > 0
        ? Math.floor(options.systemHistorySize)
        : DEFAULT_SYSTEM_HISTORY_SIZE;

    this.systemHistorySize = Math.max(1, resolvedHistorySize);

    const tickBudget =
      typeof options.slowTickBudgetMs === 'number' &&
      Number.isFinite(options.slowTickBudgetMs) &&
      options.slowTickBudgetMs > 0
        ? options.slowTickBudgetMs
        : context.stepSizeMs;

    this.tickBudgetMs = tickBudget > 0 ? tickBudget : undefined;

    const baseConfiguration = this.timeline.readDelta().configuration;
    this.resolvedConfiguration = Object.freeze({
      ...baseConfiguration,
      enabled: true,
      slowSystemBudgetMs: this.slowSystemBudgetMs,
      systemHistorySize: this.systemHistorySize,
      tickBudgetMs: this.tickBudgetMs,
    });
  }

  beginTick(tick: number): RuntimeTickDiagnostics {
    const handle = this.timeline.startTick(tick, {
      budgetMs: this.tickBudgetMs,
    });
    return new RealRuntimeTickDiagnostics({
      tick,
      handle,
      clock: this.clock,
      controller: this,
      tickBudgetMs: this.tickBudgetMs,
    });
  }

  readDelta(sinceHead?: number): DiagnosticTimelineResult {
    const base = this.timeline.readDelta(sinceHead);
    if (base.configuration === this.resolvedConfiguration) {
      return base;
    }

    return Object.freeze({
      entries: base.entries,
      head: base.head,
      dropped: base.dropped,
      configuration: this.resolvedConfiguration,
    });
  }

  getConfiguration(): Readonly<ResolvedDiagnosticTimelineOptions> {
    return this.resolvedConfiguration;
  }

  snapshot(): DiagnosticTimelineResult {
    return this.readDelta();
  }

  clear(): void {
    this.timeline.clear();
    this.systemHistory.clear();
  }

  completeSystemSpan(
    systemId: string,
    tick: number,
    durationMs: number,
    error?: unknown,
  ): DiagnosticTimelineSystemSpan {
    const history = this.recordSystemHistory(systemId, durationMs);
    const budget = this.slowSystemBudgetMs;
    const isSlow = typeof budget === 'number' && durationMs > budget;
    const overBudget =
      isSlow && typeof budget === 'number' ? durationMs - budget : 0;

    if (isSlow && budget !== undefined) {
      telemetry.recordWarning('SystemExecutionSlow', {
        systemId,
        tick,
        durationMs,
        budgetMs: budget,
        overBudgetMs: overBudget,
        averageDurationMs: history.averageMs,
        maxDurationMs: history.maxMs,
        sampleCount: history.sampleCount,
      });
    }

    return {
      id: systemId,
      durationMs,
      budgetMs: budget,
      isSlow,
      overBudgetMs: overBudget,
      history,
      error: toErrorLike(error),
    };
  }

  private recordSystemHistory(
    systemId: string,
    durationMs: number,
  ): DiagnosticTimelineSystemHistory {
    let entry = this.systemHistory.get(systemId);
    if (!entry) {
      entry = { values: [] };
      this.systemHistory.set(systemId, entry);
    }

    entry.values.push(durationMs);
    if (entry.values.length > this.systemHistorySize) {
      entry.values.shift();
    }

    const { values } = entry;
    let sum = 0;
    let max = 0;
    for (const value of values) {
      sum += value;
      if (value > max) {
        max = value;
      }
    }

    const sampleCount = values.length;
    const average = sampleCount > 0 ? sum / sampleCount : 0;

    return {
      sampleCount,
      averageMs: average,
      maxMs: max,
    };
  }

  maybeRecordSlowTickWarning(
    tick: number,
    durationMs: number,
    metadata: DiagnosticTimelineMetadata,
  ): void {
    const budget = this.tickBudgetMs;
    if (typeof budget !== 'number' || budget <= 0 || durationMs <= budget) {
      return;
    }

    const overBudget = durationMs - budget;
    const slowestSystem = metadata.systems
      ? metadata.systems.reduce<DiagnosticTimelineSystemSpan | undefined>(
          (slowest, span) => {
            if (!slowest || span.durationMs > slowest.durationMs) {
              return span;
            }
            return slowest;
          },
          undefined,
        )
      : undefined;

    telemetry.recordWarning('TickExecutionSlow', {
      tick,
      durationMs,
      budgetMs: budget,
      overBudgetMs: overBudget,
      accumulatorBacklogMs: metadata.accumulatorBacklogMs,
      queueCaptured: metadata.queue?.captured,
      queueExecuted: metadata.queue?.executed,
      queueSkipped: metadata.queue?.skipped,
      slowestSystemId: slowestSystem?.id,
      slowestSystemDurationMs: slowestSystem?.durationMs,
      slowestSystemOverBudgetMs: slowestSystem?.overBudgetMs,
    });
  }
}

class RealRuntimeTickDiagnostics implements RuntimeTickDiagnostics {
  readonly tick: number;
  private readonly handle: DiagnosticTickHandle;
  private readonly clock: HighResolutionClock;
  private readonly controller: EnabledRuntimeDiagnostics;
  private readonly tickBudgetMs?: number;
  private completed = false;
  private queueMetrics: DiagnosticTimelineQueueMetrics | undefined;
  private eventMetrics: DiagnosticTimelineEventMetrics | undefined;
  private accumulatorBacklogMs: number | undefined;
  private readonly systemSpans: DiagnosticTimelineSystemSpan[] = [];
  private readonly phases: DiagnosticTimelinePhase[] = [];

  constructor(context: RuntimeTickContext) {
    this.tick = context.tick;
    this.handle = context.handle;
    this.clock = context.clock;
    this.controller = context.controller;
    this.tickBudgetMs = context.tickBudgetMs;
  }

  recordQueueMetrics(metrics: DiagnosticTimelineQueueMetrics): void {
    this.queueMetrics = { ...metrics };
  }

  recordEventMetrics(metrics: DiagnosticTimelineEventMetrics): void {
    this.eventMetrics = {
      counters: { ...metrics.counters },
      channels: metrics.channels.map((channel) => ({ ...channel })),
    };
  }

  setAccumulatorBacklogMs(backlogMs: number): void {
    this.accumulatorBacklogMs = backlogMs;
  }

  addPhase(
    name: string,
    durationMs: number,
    offsetMs?: number,
  ): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      return;
    }
    const normalizedOffset = Number.isFinite(offsetMs ?? NaN)
      ? (offsetMs!)
      : undefined;
    const phase: DiagnosticTimelinePhase =
      normalizedOffset === undefined
        ? {
            name,
            durationMs,
          }
        : {
            name,
            durationMs,
            offsetMs: normalizedOffset,
          };
    this.phases.push(phase);
  }

  startSystem(systemId: string): RuntimeSystemSpanDiagnostics {
    return new RealRuntimeSystemSpanDiagnostics({
      systemId,
      tick: this.tick,
      controller: this.controller,
      parent: this,
      clock: this.clock,
    });
  }

  complete(): void {
    if (this.completed) {
      return;
    }
    this.completed = true;

    const endedAt = this.clock.now();
    const metadata = this.buildMetadata();

    this.handle.end({
      endedAt,
      budgetMs: this.tickBudgetMs,
      metadata,
    } satisfies CompleteTickOptions);

    this.controller.maybeRecordSlowTickWarning(
      this.tick,
      endedAt - this.handle.startedAt,
      metadata,
    );
  }

  fail(error: unknown): never {
    if (!this.completed) {
      this.completed = true;
      const endedAt = this.clock.now();
      const metadata = this.buildMetadata();
      this.handle.fail(error, {
        endedAt,
        budgetMs: this.tickBudgetMs,
        metadata,
      });
    }

    throw error;
  }

  addSystemSpan(span: DiagnosticTimelineSystemSpan): void {
    this.systemSpans.push(span);
  }

  private buildMetadata(): DiagnosticTimelineMetadata {
    const metadata: DiagnosticTimelineMetadata = {
      accumulatorBacklogMs: this.accumulatorBacklogMs,
      queue: this.queueMetrics,
      events: this.eventMetrics,
      systems: this.systemSpans.slice(),
      phases:
        this.phases.length > 0
          ? this.phases.map((phase) => ({
              name: phase.name,
              durationMs: phase.durationMs,
              offsetMs: phase.offsetMs,
            }))
          : undefined,
    };
    return metadata;
  }
}

interface CreateSystemSpanContext {
  readonly systemId: string;
  readonly tick: number;
  readonly controller: EnabledRuntimeDiagnostics;
  readonly parent: RealRuntimeTickDiagnostics;
  readonly clock: HighResolutionClock;
}

class RealRuntimeSystemSpanDiagnostics
  implements RuntimeSystemSpanDiagnostics
{
  private readonly systemId: string;
  private readonly tick: number;
  private readonly controller: EnabledRuntimeDiagnostics;
  private readonly parent: RealRuntimeTickDiagnostics;
  private readonly clock: HighResolutionClock;
  private readonly startedAt: number;
  private completed = false;

  constructor(context: CreateSystemSpanContext) {
    this.systemId = context.systemId;
    this.tick = context.tick;
    this.controller = context.controller;
    this.parent = context.parent;
    this.clock = context.clock;
    this.startedAt = context.clock.now();
  }

  end(): void {
    this.finish(undefined);
  }

  fail(error: unknown): never {
    this.finish(error);
    throw error;
  }

  private finish(error: unknown): void {
    if (this.completed) {
      return;
    }
    this.completed = true;

    const endedAt = this.clock.now();
    const durationMs =
      endedAt >= this.startedAt ? endedAt - this.startedAt : 0;
    const span = this.controller.completeSystemSpan(
      this.systemId,
      this.tick,
      durationMs,
      error,
    );
    this.parent.addSystemSpan(span);
  }
}

const DISABLED_CONFIGURATION = Object.freeze({
  capacity: 0,
  slowTickBudgetMs: undefined,
  enabled: false,
} satisfies ResolvedDiagnosticTimelineOptions);

class RuntimeDiagnosticsControllerImpl
  implements RuntimeDiagnosticsController
{
  private readonly context: CreateRuntimeDiagnosticsControllerOptions;
  private active: EnabledRuntimeDiagnostics | null = null;
  private timelineRecorder: DiagnosticTimelineRecorder = noopTimeline;
  private configuration: Readonly<ResolvedDiagnosticTimelineOptions> =
    DISABLED_CONFIGURATION;
  private preservedOptions:
    | RuntimeDiagnosticsTimelineOptions
    | undefined;

  constructor(
    diagnostics: IdleEngineRuntimeDiagnosticsOptions | undefined,
    context: CreateRuntimeDiagnosticsControllerOptions,
  ) {
    this.context = context;

    const timelineConfig = diagnostics?.timeline;
    if (timelineConfig !== undefined && timelineConfig !== false) {
      if (timelineConfig.enabled === false) {
        this.preservedOptions =
          this.normalizeRequestedOptions(timelineConfig);
        this.disable();
      } else {
        this.enable(timelineConfig);
      }
    }
  }

  get isEnabled(): boolean {
    return this.active !== null;
  }

  get timeline(): DiagnosticTimelineRecorder {
    return this.timelineRecorder;
  }

  beginTick(tick: number): RuntimeTickDiagnostics {
    if (!this.active) {
      return noopTickDiagnostics;
    }
    return this.active.beginTick(tick);
  }

  readDelta(sinceHead?: number): DiagnosticTimelineResult {
    if (!this.active) {
      const base = noopTimeline.readDelta(sinceHead);
      if (base.configuration === this.configuration) {
        return base;
      }
      return Object.freeze({
        entries: base.entries,
        head: base.head,
        dropped: base.dropped,
        configuration: this.configuration,
      });
    }

    const base = this.active.readDelta(sinceHead);
    if (base.configuration === this.configuration) {
      return base;
    }

    return Object.freeze({
      entries: base.entries,
      head: base.head,
      dropped: base.dropped,
      configuration: this.configuration,
    });
  }

  snapshot(): DiagnosticTimelineResult {
    return this.readDelta();
  }

  enable(options?: RuntimeDiagnosticsTimelineOptions): void {
    const baseOptions: RuntimeDiagnosticsTimelineOptions =
      this.preservedOptions !== undefined
        ? { ...this.preservedOptions }
        : {};

    const mergedOptions: RuntimeDiagnosticsTimelineOptions =
      options !== undefined
        ? { ...baseOptions, ...options }
        : baseOptions;

    if (mergedOptions.enabled === false) {
      this.preservedOptions =
        this.normalizeRequestedOptions(mergedOptions);
      this.disable();
      return;
    }
    const resolvedOptions: RuntimeDiagnosticsTimelineOptions = {
      ...mergedOptions,
      enabled: true,
    };
    this.active = new EnabledRuntimeDiagnostics(
      resolvedOptions,
      this.context,
    );
    this.timelineRecorder = this.active.timeline;
    this.configuration = this.active.getConfiguration();
    this.preservedOptions = this.mergePreservedOptions(
      resolvedOptions,
      this.configuration,
    );
  }

  disable(): void {
    const previous = this.configuration;
    if (this.active) {
      const baseOptions: RuntimeDiagnosticsTimelineOptions =
        this.preservedOptions !== undefined
          ? this.preservedOptions
          : {};
      this.preservedOptions = this.mergePreservedOptions(
        baseOptions,
        previous,
      );
    }
    this.active = null;
    this.timelineRecorder = noopTimeline;
    this.configuration = Object.freeze({
      ...previous,
      enabled: false,
    });
  }

  getConfiguration(): Readonly<ResolvedDiagnosticTimelineOptions> {
    return this.configuration;
  }

  clear(): void {
    this.active?.clear();
  }

  private normalizeRequestedOptions(
    options: RuntimeDiagnosticsTimelineOptions,
  ): RuntimeDiagnosticsTimelineOptions {
    return {
      ...options,
      enabled: true,
    };
  }

  private mergePreservedOptions(
    base: RuntimeDiagnosticsTimelineOptions,
    config: Readonly<ResolvedDiagnosticTimelineOptions>,
  ): RuntimeDiagnosticsTimelineOptions {
    const {
      capacity,
      slowTickBudgetMs,
      slowSystemBudgetMs,
      systemHistorySize,
      enabled: _,
      ...otherOptions
    } = base;

    return {
      ...otherOptions,
      enabled: true,
      capacity: capacity ?? config.capacity,
      slowTickBudgetMs:
        slowTickBudgetMs ?? config.slowTickBudgetMs,
      slowSystemBudgetMs:
        slowSystemBudgetMs ?? config.slowSystemBudgetMs,
      systemHistorySize:
        systemHistorySize ?? config.systemHistorySize,
    };
  }
}

export function createRuntimeDiagnosticsController(
  diagnostics: IdleEngineRuntimeDiagnosticsOptions | undefined,
  context: CreateRuntimeDiagnosticsControllerOptions,
): RuntimeDiagnosticsController {
  return new RuntimeDiagnosticsControllerImpl(diagnostics, context);
}
