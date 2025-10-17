export interface HighResolutionClock {
  now(): number;
}

export interface DiagnosticTimelineOptions {
  readonly capacity?: number;
  readonly slowTickBudgetMs?: number;
  readonly clock?: HighResolutionClock;
}

export interface StartTickOptions {
  readonly budgetMs?: number;
}

export interface CompleteTickOptions {
  readonly endedAt?: number;
  readonly error?: unknown;
  readonly budgetMs?: number;
  readonly metadata?: DiagnosticTimelineMetadata;
}

export interface ErrorLike {
  readonly name?: string;
  readonly message?: string;
  readonly stack?: string;
}

type MutableErrorLike = {
  name?: string;
  message?: string;
  stack?: string;
};

export interface DiagnosticTimelineEntry {
  readonly tick: number;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly durationMs: number;
  readonly budgetMs?: number;
  readonly isSlow: boolean;
  readonly overBudgetMs: number;
  readonly error?: ErrorLike;
  readonly metadata?: DiagnosticTimelineMetadata;
}

export interface DiagnosticTimelineQueueMetrics {
  readonly sizeBefore: number;
  readonly sizeAfter: number;
  readonly captured: number;
  readonly executed: number;
  readonly skipped: number;
}

export interface DiagnosticTimelineEventChannelSnapshot {
  readonly channel: number;
  readonly subscribers: number;
  readonly remainingCapacity: number;
  readonly cooldownTicksRemaining: number;
  readonly softLimitBreaches: number;
  readonly eventsPerSecond: number;
  readonly softLimitActive: boolean;
}

export interface DiagnosticTimelineEventMetrics {
  readonly counters: {
    readonly published: number;
    readonly softLimited: number;
    readonly overflowed: number;
    readonly subscribers: number;
  };
  readonly channels: readonly DiagnosticTimelineEventChannelSnapshot[];
}

export interface DiagnosticTimelineSystemHistory {
  readonly sampleCount: number;
  readonly averageMs: number;
  readonly maxMs: number;
}

export interface DiagnosticTimelineSystemSpan {
  readonly id: string;
  readonly durationMs: number;
  readonly budgetMs?: number;
  readonly isSlow: boolean;
  readonly overBudgetMs: number;
  readonly history?: DiagnosticTimelineSystemHistory;
  readonly error?: ErrorLike;
}

export interface DiagnosticTimelineMetadata {
  readonly accumulatorBacklogMs?: number;
  readonly queue?: DiagnosticTimelineQueueMetrics;
  readonly events?: DiagnosticTimelineEventMetrics;
  readonly systems?: readonly DiagnosticTimelineSystemSpan[];
}

export interface DiagnosticTimelineResult {
  readonly capacity: number;
  readonly size: number;
  readonly droppedEntries: number;
  readonly lastTick?: number;
  readonly entries: readonly DiagnosticTimelineEntry[];
}

export interface DiagnosticTickHandle {
  readonly tick: number;
  readonly startedAt: number;
  end(completion?: CompleteTickOptions): void;
  fail(
    error: unknown,
    completion?: Omit<CompleteTickOptions, 'error'>,
  ): void;
}

export interface DiagnosticTimelineRecorder {
  startTick(tick: number, options?: StartTickOptions): DiagnosticTickHandle;
  snapshot(): DiagnosticTimelineResult;
  clear(): void;
}

interface TimelineEntryInternal {
  tick: number;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  budgetMs?: number;
  isSlow: boolean;
  overBudgetMs: number;
  error?: ErrorLike;
  metadata?: DiagnosticTimelineMetadata;
}

const DEFAULT_CAPACITY = 120;
const DEFAULT_SLOW_TICK_BUDGET_MS = 50;
const EMPTY_ENTRIES = Object.freeze([]) as readonly DiagnosticTimelineEntry[];

const sharedPerformance = (globalThis as {
  performance?: Performance;
}).performance;

export function getDefaultHighResolutionClock(): HighResolutionClock {
  if (
    sharedPerformance &&
    typeof sharedPerformance.now === 'function'
  ) {
    return {
      now: () => sharedPerformance.now(),
    };
  }

  const maybeProcess = (globalThis as {
    process?: {
      hrtime?: {
        (): [number, number];
        bigint?: () => bigint;
      };
    };
  }).process;

  const bigintHrTime = maybeProcess?.hrtime?.bigint;

  if (typeof bigintHrTime === 'function') {
    const origin = bigintHrTime.call(maybeProcess);
    return {
      now: () => {
        const delta = bigintHrTime.call(maybeProcess) - origin;
        return Number(delta) / 1_000_000;
      },
    };
  }

  return {
    now: () => Date.now(),
  };
}

const sharedDefaultClock = getDefaultHighResolutionClock();

export function createDiagnosticTimelineRecorder(
  options: DiagnosticTimelineOptions = {},
): DiagnosticTimelineRecorder {
  const capacityOption = options.capacity;
  const capacity =
    typeof capacityOption === 'number' &&
    Number.isFinite(capacityOption) &&
    capacityOption >= 0
      ? Math.floor(capacityOption)
      : DEFAULT_CAPACITY;
  const slowTickBudgetMs =
    options.slowTickBudgetMs ?? DEFAULT_SLOW_TICK_BUDGET_MS;
  const clock = options.clock ?? sharedDefaultClock;

  const pool: TimelineEntryInternal[] = new Array(capacity);
  let writeIndex = 0;
  let size = 0;
  let droppedEntries = 0;
  let lastTick: number | undefined;

  function claimSlot(index: number): TimelineEntryInternal {
    const existing = pool[index];
    if (existing !== undefined) {
      return existing;
    }
    const entry: TimelineEntryInternal = {
      tick: 0,
      startedAt: 0,
      endedAt: 0,
      durationMs: 0,
      budgetMs: undefined,
      isSlow: false,
      overBudgetMs: 0,
      error: undefined,
      metadata: undefined,
    };
    pool[index] = entry;
    return entry;
  }

  function commitEntry(entry: TimelineEntryInternal): void {
    if (size === capacity) {
      droppedEntries += 1;
    } else {
      size += 1;
    }
    if (capacity > 0) {
      writeIndex = (writeIndex + 1) % capacity;
    }
    lastTick = entry.tick;
  }

  function startTick(
    tick: number,
    startOptions?: StartTickOptions,
  ): DiagnosticTickHandle {
    const startedAt = clock.now();
    const budgetMs =
      startOptions?.budgetMs ?? slowTickBudgetMs;
    let ended = false;

    const handle: DiagnosticTickHandle = {
      tick,
      startedAt,
      end(completion?: CompleteTickOptions) {
        if (ended) {
          return;
        }
        ended = true;

        const endTime =
          completion?.endedAt ?? clock.now();
        const duration =
          endTime >= startedAt ? endTime - startedAt : 0;

        const finalBudget =
          completion?.budgetMs ?? budgetMs;

        if (capacity === 0) {
          droppedEntries += 1;
          lastTick = tick;
          return;
        }

        const slotIndex = writeIndex;
        const slot = claimSlot(slotIndex);

        slot.tick = tick;
        slot.startedAt = startedAt;
        slot.endedAt = endTime;
        slot.durationMs = duration;
        slot.budgetMs = finalBudget;
        slot.isSlow =
          finalBudget !== undefined && duration > finalBudget;
        slot.overBudgetMs =
          slot.isSlow && finalBudget !== undefined
            ? duration - finalBudget
            : 0;
        slot.error = toErrorLike(completion?.error);
        slot.metadata = cloneMetadata(completion?.metadata);

        commitEntry(slot);
      },
      fail(error, completion) {
        handle.end({
          ...completion,
          error,
        });
      },
    };

    return handle;
  }

  function snapshot(): DiagnosticTimelineResult {
    if (size === 0) {
      return Object.freeze({
        capacity,
        size,
        droppedEntries,
        lastTick,
        entries: EMPTY_ENTRIES,
      });
    }

    const entries: DiagnosticTimelineEntry[] = [];
    const startIndex =
      size === capacity ? writeIndex : 0;

    for (let i = 0; i < size; i += 1) {
      const index = capacity === 0
        ? 0
        : (startIndex + i) % capacity;
      const source = pool[index];
      if (!source) {
        continue;
      }
      const clonedError =
        source.error === undefined
          ? undefined
          : {
              name: source.error.name,
              message: source.error.message,
              stack: source.error.stack,
            };
      const entry: DiagnosticTimelineEntry = Object.freeze({
        tick: source.tick,
        startedAt: source.startedAt,
        endedAt: source.endedAt,
        durationMs: source.durationMs,
        budgetMs: source.budgetMs,
        isSlow: source.isSlow,
        overBudgetMs: source.overBudgetMs,
        error: clonedError ? Object.freeze(clonedError) : undefined,
        metadata: source.metadata,
      });
      entries.push(entry);
    }

    const finalEntries = Object.freeze(entries);
    return Object.freeze({
      capacity,
      size,
      droppedEntries,
      lastTick,
      entries: finalEntries,
    });
  }

  function clear(): void {
    writeIndex = 0;
    size = 0;
    droppedEntries = 0;
    lastTick = undefined;
    for (let index = 0; index < capacity; index += 1) {
      const slot = pool[index];
      if (!slot) {
        continue;
      }
      slot.metadata = undefined;
    }
  }

  return {
    startTick,
    snapshot,
    clear,
  };
}

export function createNoopDiagnosticTimelineRecorder(): DiagnosticTimelineRecorder {
  const frozenResult = Object.freeze({
    capacity: 0,
    size: 0,
    droppedEntries: 0,
    lastTick: undefined,
    entries: EMPTY_ENTRIES,
  });

  return {
        startTick(tick: number): DiagnosticTickHandle {
      return {
        tick,
        startedAt: 0,
        end() {
          // intentionally noop
        },
        fail() {
          // intentionally noop
        },
      };
    },
    snapshot() {
      return frozenResult;
    },
    clear() {
      // intentionally noop
    },
  };
}

export function toErrorLike(value: unknown): ErrorLike | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (isErrorLike(value)) {
    const serialized: MutableErrorLike = {};
    if (value.name !== undefined) {
      serialized.name = value.name;
    }
    if (value.message !== undefined) {
      serialized.message = value.message;
    }
    if (value.stack !== undefined) {
      serialized.stack = value.stack;
    }
    return serialized;
  }

  if (typeof value === 'string') {
    return { message: value };
  }

  return { message: String(value) };
}

function isErrorLike(
  value: unknown,
): value is Error & { name?: string; message?: string; stack?: string } {
  if (!value || typeof value !== 'object') {
    return false;
  }
  return (
    typeof (value as { message?: unknown }).message === 'string' ||
    typeof (value as { name?: unknown }).name === 'string' ||
    typeof (value as { stack?: unknown }).stack === 'string'
  );
}

function cloneMetadata(
  metadata: DiagnosticTimelineMetadata | undefined,
): DiagnosticTimelineMetadata | undefined {
  if (!metadata) {
    return undefined;
  }

  const queueMetrics = metadata.queue
    ? Object.freeze({ ...metadata.queue })
    : undefined;

  const eventMetrics = metadata.events
    ? Object.freeze({
        counters: Object.freeze({ ...metadata.events.counters }),
        channels: Object.freeze(
          metadata.events.channels.map((channel) =>
            Object.freeze({ ...channel }),
          ),
        ),
      })
    : undefined;

  const systemSpans = metadata.systems
    ? Object.freeze(
        metadata.systems.map((span) =>
          Object.freeze({
            id: span.id,
            durationMs: span.durationMs,
            budgetMs: span.budgetMs,
            isSlow: span.isSlow,
            overBudgetMs: span.overBudgetMs,
            history: span.history
              ? Object.freeze({ ...span.history })
              : undefined,
            error: span.error
              ? Object.freeze({ ...span.error })
              : undefined,
          }),
        ),
      )
    : undefined;

  return Object.freeze({
    accumulatorBacklogMs: metadata.accumulatorBacklogMs,
    queue: queueMetrics,
    events: eventMetrics,
    systems: systemSpans,
  });
}
