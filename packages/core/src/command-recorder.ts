import { authorizeCommand } from './command-authorization.js';
import type { Command, CommandSnapshot } from './command.js';
import type {
  CommandDispatcher,
  ExecutionContext,
} from './command-dispatcher.js';
import type {
  DiagnosticTimelineResult,
  ResolvedDiagnosticTimelineOptions,
} from './diagnostics/diagnostic-timeline.js';
import { CommandQueue, deepFreezeInPlace } from './command-queue.js';
import type { ImmutablePayload } from './command.js';
import {
  isImmutableTypedArraySnapshot,
  type ImmutableArrayBufferSnapshot,
  type ImmutableSharedArrayBufferSnapshot,
  type ImmutableTypedArraySnapshot,
  type TypedArray,
} from './immutable-snapshots.js';
import type { EventBus, EventPublisher } from './events/event-bus.js';
import type { RuntimeEventFrame } from './events/runtime-event-frame.js';
import type {
  RuntimeEventManifestHash,
  RuntimeEventPayload,
  RuntimeEventType,
} from './events/runtime-event.js';
import { GENERATED_RUNTIME_EVENT_MANIFEST } from './events/runtime-event-manifest.generated.js';
import { telemetry } from './telemetry.js';
import {
  getCurrentRNGSeed,
  resetRNG,
  setRNGSeed,
} from './rng.js';
import { getGameState, setGameState } from './runtime-state.js';

export type StateSnapshot<TState = unknown> = ImmutablePayload<TState>;

export interface RecordedRuntimeEvent {
  readonly type: RuntimeEventType;
  readonly channel: number;
  readonly issuedAt: number;
  readonly dispatchOrder: number;
  readonly payload: ImmutablePayload<RuntimeEventPayload<RuntimeEventType>>;
}

export interface RecordedRuntimeEventFrame {
  readonly tick: number;
  readonly manifestHash: RuntimeEventManifestHash;
  readonly events: readonly RecordedRuntimeEvent[];
}

export interface CommandLog {
  readonly version: string;
  readonly startState: StateSnapshot;
  readonly commands: readonly CommandSnapshot[];
  readonly events: readonly RecordedRuntimeEventFrame[];
  readonly metadata: {
    readonly recordedAt: number;
    readonly seed?: number;
    readonly lastStep: number;
  };
}

export interface RuntimeReplayContext {
  readonly commandQueue: CommandQueue;
  readonly eventPublisher?: EventPublisher;
  readonly eventBus?: EventBus;
  getCurrentStep?(): number;
  getNextExecutableStep?(): number;
  setCurrentStep?(step: number): void;
  setNextExecutableStep?(step: number): void;
  readDiagnosticsDelta?(
    sinceHead?: number,
  ): DiagnosticTimelineResult;
  attachDiagnosticsDelta?(delta: DiagnosticTimelineResult): void;
}

const COMMAND_LOG_VERSION = '0.1.0';
const REPLAY_TELEMETRY_BATCH_SIZE = 1000;

const DEFAULT_REPLAY_EVENT_PUBLISHER: EventPublisher = {
  publish() {
    throw new Error('Event publisher is not configured for replay execution.');
  },
};

const sharedArrayBufferCtor = (globalThis as {
  SharedArrayBuffer?: typeof SharedArrayBuffer;
}).SharedArrayBuffer;

type FrozenCommand = CommandSnapshot;

const TYPED_ARRAY_CTOR_NAMES = new Set([
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
]);

interface DataViewSnapshot {
  readonly buffer: ArrayBufferLike;
  readonly byteOffset: number;
  readonly byteLength: number;
  getUint8(index: number): number;
  setUint8(index: number, value: number): void;
}

type ArrayBufferViewSnapshot = DataViewSnapshot | TypedArray;

function getConstructorName(value: object): string | undefined {
  const directCtor = (value as { constructor?: { name?: string } }).constructor;
  if (typeof directCtor === 'function' && directCtor.name) {
    return directCtor.name;
  }
  const prototypeCtor = Object.getPrototypeOf(value)?.constructor;
  if (typeof prototypeCtor === 'function' && prototypeCtor.name) {
    return prototypeCtor.name;
  }
  return undefined;
}

function isDataViewLike(value: unknown): value is DataViewSnapshot {
  if (!value || typeof value !== 'object') {
    return false;
  }
  if (value instanceof DataView) {
    return true;
  }
  return getConstructorName(value) === 'DataView';
}

function isTypedArrayLike(value: unknown): value is TypedArray {
  if (!value || typeof value !== 'object') {
    return false;
  }
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return true;
  }
  const ctorName = getConstructorName(value);
  return ctorName !== undefined && TYPED_ARRAY_CTOR_NAMES.has(ctorName);
}

function isArrayBufferViewLike(value: unknown): value is ArrayBufferViewSnapshot {
  return isDataViewLike(value) || isTypedArrayLike(value);
}

function copyDataViewContents(target: DataViewSnapshot, source: DataViewSnapshot): void {
  if (ArrayBuffer.isView(target) && ArrayBuffer.isView(source)) {
    const targetBytes = new Uint8Array(
      target.buffer,
      target.byteOffset,
      target.byteLength,
    );
    targetBytes.set(
      new Uint8Array(
        source.buffer,
        source.byteOffset,
        source.byteLength,
      ),
    );
    return;
  }

  const byteLength = source.byteLength;
  for (let i = 0; i < byteLength; i += 1) {
    target.setUint8(i, source.getUint8(i));
  }
}

function copyTypedArrayContents(target: TypedArray, source: TypedArray): void {
  const maybeSet = (target as {
    set?(
      data: ArrayLike<number | bigint>,
      offset?: number,
    ): void;
  }).set;

  if (typeof maybeSet === 'function') {
    try {
      maybeSet.call(
        target,
        source as unknown as ArrayLike<number | bigint>,
        0,
      );
      return;
    } catch (error) {
      if (
        !(error instanceof TypeError) &&
        !(error instanceof RangeError)
      ) {
        throw error;
      }
    }
  }

  const length = getTypedArrayLength(target);
  for (let i = 0; i < length; i += 1) {
    (target as Record<number, unknown>)[i] = (source as Record<
      number,
      unknown
    >)[i];
  }
}

function canReuseDataView(
  current: DataViewSnapshot,
  next: DataViewSnapshot,
): boolean {
  try {
    return current.byteLength === next.byteLength;
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }
    return false;
  }
}

function canReuseTypedArray(
  current: TypedArray,
  next: TypedArray,
): boolean {
  const currentCtorName = getConstructorName(current as object);
  const nextCtorName = getConstructorName(next as object);
  if (!currentCtorName || currentCtorName !== nextCtorName) {
    return false;
  }
  return getTypedArrayLength(current) === getTypedArrayLength(next);
}

function getTypedArrayLength(typed: TypedArray): number {
  try {
    const directLength = (typed as { length?: number }).length;
    if (typeof directLength === 'number' && Number.isFinite(directLength)) {
      return directLength;
    }
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }
  }

  let maxIndex = -1;
  for (const key of Object.keys(typed as unknown as Record<string, unknown>)) {
    const index = Number(key);
    if (Number.isInteger(index) && index >= 0) {
      if (index > maxIndex) {
        maxIndex = index;
      }
    }
  }

  return maxIndex + 1;
}

export class CommandRecorder {
  private readonly recorded: FrozenCommand[] = [];
  private readonly recordedClones: Command[] = [];
  private readonly recordedEventFrames: RecordedRuntimeEventFrame[] = [];
  private readonly frozenEventFrames: ImmutablePayload<RecordedRuntimeEventFrame>[] =
    [];
  private pendingReplayEventFrames: readonly RecordedRuntimeEventFrame[] | null =
    null;
  private replayEventFrameCursor = 0;
  private startState: StateSnapshot;
  private rngSeed: number | undefined;
  private lastRecordedStep = -1;
  private refreshSeedSnapshot(): void {
    if (this.rngSeed !== undefined) {
      return;
    }
    const currentSeed = getCurrentRNGSeed();
    if (currentSeed !== undefined) {
      this.rngSeed = currentSeed;
    }
  }

  constructor(currentState: unknown, options?: { seed?: number }) {
    const startClone = cloneStructured(currentState);
    this.startState = freezeSnapshot(startClone);
    this.rngSeed = options?.seed;
    this.refreshSeedSnapshot();
  }

  record(command: Command): void {
    this.refreshSeedSnapshot();
    const rawClone = cloneStructured(command);
    const snapshot = freezeSnapshot(
      cloneStructured(rawClone),
    ) as FrozenCommand;
    this.recorded.push(snapshot);
    this.recordedClones.push(rawClone);
    this.lastRecordedStep = Math.max(this.lastRecordedStep, command.step);
  }

  recordEventFrame(frame: RuntimeEventFrame): void {
    if (frame.manifestHash !== GENERATED_RUNTIME_EVENT_MANIFEST.hash) {
      telemetry.recordError('RuntimeEventManifestMismatch', {
        expected: GENERATED_RUNTIME_EVENT_MANIFEST.hash,
        received: frame.manifestHash,
      });
      throw new Error(
        'Runtime event manifest hash mismatch. Re-run `pnpm generate` and rebuild content packages.',
      );
    }
    const clone = createRecordedEventFrame(frame);
    const snapshot = freezeSnapshot(clone);
    this.recordedEventFrames.push(clone);
    this.frozenEventFrames.push(snapshot);
  }

  beginReplayEventValidation(log: CommandLog): void {
    this.pendingReplayEventFrames = log.events;
    this.replayEventFrameCursor = 0;
  }

  endReplayEventValidation(): void {
    if (this.pendingReplayEventFrames === null) {
      return;
    }
    if (this.replayEventFrameCursor !== this.pendingReplayEventFrames.length) {
      telemetry.recordError('ReplayMissingEventFrames', {
        expected: this.pendingReplayEventFrames.length,
        consumed: this.replayEventFrameCursor,
      });
      throw new Error('Replay did not consume all recorded event frames.');
    }
    this.pendingReplayEventFrames = null;
  }

  consumeReplayEventFrame(frame: RuntimeEventFrame): void {
    if (this.pendingReplayEventFrames === null) {
      telemetry.recordError('ReplayUnexpectedEventFrame', {
        tick: frame.tick,
        reason: 'replay-not-in-progress',
      });
      throw new Error('Received replay event frame before replay was initialised.');
    }

    const expected = this.pendingReplayEventFrames[this.replayEventFrameCursor];
    if (!expected) {
      telemetry.recordError('ReplayUnexpectedEventFrame', {
        tick: frame.tick,
        reason: 'no-more-expected-frames',
      });
      throw new Error('Replay produced more event frames than were recorded.');
    }

    if (frame.manifestHash !== GENERATED_RUNTIME_EVENT_MANIFEST.hash) {
      telemetry.recordError('ReplayEventManifestMismatch', {
        expected: GENERATED_RUNTIME_EVENT_MANIFEST.hash,
        received: frame.manifestHash,
        tick: frame.tick,
      });
      throw new Error('Replay event frame manifest hash does not match the recorded manifest.');
    }

    const actual = createRecordedEventFrame(frame);
    if (!areRecordedEventFramesEqual(actual, expected)) {
      telemetry.recordError('ReplayEventFrameMismatch', {
        tick: frame.tick,
      });
      throw new Error('Replay event frame does not match the recorded log.');
    }

    this.replayEventFrameCursor += 1;
  }

  export(): CommandLog {
    this.refreshSeedSnapshot();
    const exportedLog = {
      version: COMMAND_LOG_VERSION,
      startState: cloneSnapshotToMutable(this.startState),
      commands: this.recordedClones.map(cloneStructured),
      events: this.recordedEventFrames.map(cloneStructured),
      metadata: {
        recordedAt: Date.now(),
        seed: this.rngSeed,
        lastStep: this.lastRecordedStep,
      },
    };

    return deepFreezeInPlace(exportedLog) as CommandLog;
  }

  replay(
    log: CommandLog,
    dispatcher: CommandDispatcher,
    runtimeContext?: RuntimeReplayContext,
  ): void {
    const mutableState = cloneSnapshotToMutable(log.startState);
    restoreState(mutableState);

    const seedRestorer = createReplaySeedRestorer(log.metadata.seed);
    seedRestorer.applyReplaySeed();

    const queue = runtimeContext?.commandQueue ?? new CommandQueue();

    const readDiagnosticsDelta = runtimeContext?.readDiagnosticsDelta;
    const attachDiagnosticsDelta = runtimeContext?.attachDiagnosticsDelta;
    const baselineDiagnostics =
      typeof readDiagnosticsDelta === 'function'
        ? readDiagnosticsDelta()
        : undefined;
    const baselineDiagnosticsHead = baselineDiagnostics?.head;
    const baselineDiagnosticsConfiguration = baselineDiagnostics?.configuration;

    assertReplayQueueEmpty(queue, seedRestorer.restorePreviousSeed);

    const sandboxedEnqueues: FrozenCommand[] = [];
    const restoreEnqueue = sandboxQueueEnqueue(queue, sandboxedEnqueues);
    const finalStep = resolveReplayFinalStep(log);
    const runtimeStepSnapshot = captureRuntimeStepSnapshot(runtimeContext);
    const replayOutcome: ReplayOutcome = {
      replayFailed: true,
      stateAdvanced: false,
      finalizationComplete: false,
    };
    const matchedFutureCommandIndices = new Set<number>();
    const eventBus = runtimeContext?.eventBus;
    let activeEventBusTick: number | undefined;
    let processedSinceLastTelemetry = 0;
    let diagnosticsError: Error | undefined;

    const revertRuntimeContext = createReplayReverter({
      stateSnapshot: mutableState,
      seedRestorer,
      runtimeContext,
      runtimeStepSnapshot,
      replayOutcome,
    });

    const recordReplayFailure = (command: FrozenCommand, error: unknown): void => {
      replayOutcome.replayFailed = true;
      telemetry.recordError('ReplayExecutionFailed', {
        type: command.type,
        step: command.step,
        error: error instanceof Error ? error.message : String(error),
      });

      if (replayOutcome.finalizationComplete) {
        if (replayOutcome.stateAdvanced) {
          revertRuntimeContext();
        } else {
          seedRestorer.restorePreviousSeed();
        }
      }
    };

    try {
      for (let i = 0; i < log.commands.length; i += 1) {
        const cmd = log.commands[i];
        processedSinceLastTelemetry += 1;

        activeEventBusTick = beginReplayTick(eventBus, cmd.step, activeEventBusTick);

        const context = createReplayExecutionContext(cmd, runtimeContext);
        executeReplayCommand(cmd, dispatcher, context, recordReplayFailure);
        verifyReplaySandboxedEnqueues(
          log.commands,
          sandboxedEnqueues,
          i,
          matchedFutureCommandIndices,
        );

        processedSinceLastTelemetry = recordReplayProgressIfNeeded(
          processedSinceLastTelemetry,
          i + 1,
        );
      }

      recordReplayProgressAtEnd(processedSinceLastTelemetry, log.commands.length);
      replayOutcome.replayFailed = false;
    } finally {
      diagnosticsError = tryAttachReplayDiagnosticsDelta({
        readDiagnosticsDelta,
        attachDiagnosticsDelta,
        baselineHead: baselineDiagnosticsHead,
        baselineConfiguration: baselineDiagnosticsConfiguration,
      });

      if (diagnosticsError) {
        replayOutcome.replayFailed = true;
      }

      restoreEnqueue();
      finalizeReplayOutcome(replayOutcome, runtimeContext, finalStep, revertRuntimeContext);
      replayOutcome.finalizationComplete = true;
    }

    if (diagnosticsError) {
      throw diagnosticsError;
    }
  }

  clear(nextState: unknown, options?: { seed?: number }): void {
    this.recorded.length = 0;
    this.recordedClones.length = 0;
    this.recordedEventFrames.length = 0;
    this.frozenEventFrames.length = 0;
    this.pendingReplayEventFrames = null;
    this.replayEventFrameCursor = 0;
    const startClone = cloneStructured(nextState);
    this.startState = freezeSnapshot(startClone);
    this.rngSeed = options?.seed;
    this.refreshSeedSnapshot();
    this.lastRecordedStep = -1;
  }
}

interface ReplayOutcome {
  replayFailed: boolean;
  stateAdvanced: boolean;
  finalizationComplete: boolean;
}

interface RuntimeStepSnapshot {
  readonly currentStep?: number;
  readonly nextExecutableStep?: number;
}

interface ReplaySeedRestorer {
  readonly hasReplaySeed: boolean;
  applyReplaySeed(): void;
  restorePreviousSeed(): void;
}

function createReplaySeedRestorer(replaySeed: number | undefined): ReplaySeedRestorer {
  if (replaySeed === undefined) {
    return {
      hasReplaySeed: false,
      applyReplaySeed() {},
      restorePreviousSeed() {},
    };
  }

  const previousSeed = getCurrentRNGSeed();
  let seedRestored = false;

  return {
    hasReplaySeed: true,
    applyReplaySeed() {
      setRNGSeed(replaySeed);
    },
    restorePreviousSeed() {
      if (seedRestored) {
        return;
      }

      if (previousSeed === undefined) {
        resetRNG();
      } else {
        setRNGSeed(previousSeed);
      }
      seedRestored = true;
    },
  };
}

function assertReplayQueueEmpty(queue: CommandQueue, restoreReplaySeed: () => void): void {
  if (queue.size === 0) {
    return;
  }

  telemetry.recordError('ReplayQueueNotEmpty', { pending: queue.size });
  restoreReplaySeed();
  throw new Error('Command queue must be empty before replay begins.');
}

function sandboxQueueEnqueue(
  queue: CommandQueue,
  sandboxedEnqueues: FrozenCommand[],
): () => void {
  const originalEnqueue = queue.enqueue.bind(queue);

  (queue as CommandQueue & {
    enqueue: (command: Command) => void;
  }).enqueue = (cmd: Command) => {
    const snapshot = freezeSnapshot(cloneStructured(cmd)) as FrozenCommand;
    sandboxedEnqueues.push(snapshot);
  };

  return () => {
    (queue as CommandQueue & {
      enqueue: (command: Command) => void;
    }).enqueue = originalEnqueue;
  };
}

function resolveReplayFinalStep(log: CommandLog): number {
  const recordedFinalStep = log.metadata.lastStep ?? -1;
  if (recordedFinalStep >= 0) {
    return recordedFinalStep;
  }

  return log.commands.reduce((max, cmd) => Math.max(max, cmd.step), -1);
}

function captureRuntimeStepSnapshot(runtimeContext?: RuntimeReplayContext): RuntimeStepSnapshot {
  return {
    currentStep: runtimeContext?.getCurrentStep?.(),
    nextExecutableStep: runtimeContext?.getNextExecutableStep?.(),
  };
}

function createReplayReverter(options: {
  stateSnapshot: unknown;
  seedRestorer: ReplaySeedRestorer;
  runtimeContext: RuntimeReplayContext | undefined;
  runtimeStepSnapshot: RuntimeStepSnapshot;
  replayOutcome: ReplayOutcome;
}): () => void {
  const {
    stateSnapshot,
    seedRestorer,
    runtimeContext,
    runtimeStepSnapshot,
    replayOutcome,
  } = options;

  return () => {
    restoreState(stateSnapshot);
    seedRestorer.restorePreviousSeed();

    if (runtimeContext) {
      if (runtimeStepSnapshot.currentStep !== undefined) {
        runtimeContext.setCurrentStep?.(runtimeStepSnapshot.currentStep);
      }
      if (runtimeStepSnapshot.nextExecutableStep !== undefined) {
        runtimeContext.setNextExecutableStep?.(runtimeStepSnapshot.nextExecutableStep);
      }
    }

    replayOutcome.stateAdvanced = false;
  };
}

function beginReplayTick(
  eventBus: EventBus | undefined,
  tick: number,
  activeTick: number | undefined,
): number | undefined {
  if (!eventBus || tick === activeTick) {
    return activeTick;
  }

  eventBus.beginTick(tick);
  return tick;
}

function createReplayExecutionContext(
  command: FrozenCommand,
  runtimeContext: RuntimeReplayContext | undefined,
): ExecutionContext {
  return {
    step: command.step,
    timestamp: command.timestamp,
    priority: command.priority,
    events: runtimeContext?.eventPublisher ?? DEFAULT_REPLAY_EVENT_PUBLISHER,
  };
}

function executeReplayCommand(
  command: FrozenCommand,
  dispatcher: CommandDispatcher,
  context: ExecutionContext,
  onFailure: (command: FrozenCommand, error: unknown) => void,
): void {
  const handler = dispatcher.getHandler(command.type);
  if (!handler) {
    telemetry.recordError('ReplayUnknownCommandType', {
      type: command.type,
      step: command.step,
    });
    return;
  }

  if (
    !authorizeCommand(command as Command, {
      phase: 'replay',
      reason: 'replay',
    })
  ) {
    return;
  }

  try {
    const result = handler(command.payload, context);
    if (isPromiseLike(result)) {
      result.catch((error: unknown) => {
        onFailure(command, error);
      });
    }
  } catch (error) {
    onFailure(command, error);
  }
}

function verifyReplaySandboxedEnqueues(
  commands: readonly CommandSnapshot[],
  sandboxedEnqueues: FrozenCommand[],
  currentIndex: number,
  claimedIndices: Set<number>,
): void {
  if (sandboxedEnqueues.length === 0) {
    return;
  }

  for (const queued of sandboxedEnqueues) {
    const matchIndex = findMatchingFutureCommandIndex(
      commands,
      queued,
      currentIndex + 1,
      claimedIndices,
    );

    if (matchIndex === -1) {
      telemetry.recordError('ReplayMissingFollowupCommand', {
        type: queued.type,
        step: queued.step,
      });
      throw new Error(
        'Replay log is missing a command that was enqueued during handler execution.',
      );
    }

    claimedIndices.add(matchIndex);
  }

  sandboxedEnqueues.length = 0;
}

function recordReplayProgressIfNeeded(
  processedSinceLastTelemetry: number,
  processed: number,
): number {
  if (processedSinceLastTelemetry < REPLAY_TELEMETRY_BATCH_SIZE) {
    return processedSinceLastTelemetry;
  }

  telemetry.recordProgress('CommandReplay', { processed });
  return 0;
}

function recordReplayProgressAtEnd(
  processedSinceLastTelemetry: number,
  total: number,
): void {
  if (processedSinceLastTelemetry <= 0) {
    return;
  }

  telemetry.recordProgress('CommandReplay', { processed: total });
}

function tryAttachReplayDiagnosticsDelta(options: {
  readDiagnosticsDelta: RuntimeReplayContext['readDiagnosticsDelta'] | undefined;
  attachDiagnosticsDelta: RuntimeReplayContext['attachDiagnosticsDelta'] | undefined;
  baselineHead: number | undefined;
  baselineConfiguration: ResolvedDiagnosticTimelineOptions | undefined;
}): Error | undefined {
  const {
    readDiagnosticsDelta,
    attachDiagnosticsDelta,
    baselineHead,
    baselineConfiguration,
  } = options;

  if (typeof readDiagnosticsDelta !== 'function') {
    return undefined;
  }

  try {
    const delta = readDiagnosticsDelta(baselineHead);
    if (!attachDiagnosticsDelta) {
      return undefined;
    }

    const hasEntries = delta.entries.length > 0;
    const hasDrops = delta.dropped > 0;
    const headChanged =
      baselineHead !== undefined && delta.head !== baselineHead;
    const configurationChanged =
      baselineConfiguration !== undefined &&
      delta.configuration !== baselineConfiguration;

    if (hasEntries || hasDrops || headChanged || configurationChanged) {
      attachDiagnosticsDelta(delta);
    }

    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function finalizeReplayOutcome(
  replayOutcome: ReplayOutcome,
  runtimeContext: RuntimeReplayContext | undefined,
  finalStep: number,
  revertRuntimeContext: () => void,
): void {
  if (replayOutcome.replayFailed) {
    revertRuntimeContext();
    return;
  }

  if (finalStep >= 0 && runtimeContext) {
    runtimeContext.setCurrentStep?.(finalStep + 1);
    runtimeContext.setNextExecutableStep?.(finalStep + 1);
    replayOutcome.stateAdvanced = true;
  }
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PromiseLike<T>).then === 'function'
  );
}

function createRecordedEventFrame(frame: RuntimeEventFrame): RecordedRuntimeEventFrame {
  if (frame.format === 'object-array') {
    const events: RecordedRuntimeEvent[] = new Array(frame.count);

    for (let index = 0; index < frame.events.length; index += 1) {
      const event = frame.events[index];
      const payload = freezeSnapshot(
        cloneStructured(event.payload),
      );

      events[index] = {
        type: event.type,
        channel: event.channel,
        issuedAt: event.issuedAt,
        dispatchOrder: event.dispatchOrder,
        payload,
      };
    }

    return {
      tick: frame.tick,
      manifestHash: frame.manifestHash,
      events,
    };
  }

  const events: RecordedRuntimeEvent[] = new Array(frame.count);

  for (let index = 0; index < frame.count; index += 1) {
    const typeIndex = frame.typeIndices[index];
    const type = frame.stringTable[typeIndex];
    const payload = freezeSnapshot(
      cloneStructured(frame.payloads[index]),
    );

    events[index] = {
      type: type as RuntimeEventType,
      channel: frame.channelIndices[index],
      issuedAt: frame.issuedAt[index],
      dispatchOrder: frame.dispatchOrder[index],
      payload,
    };
  }

  return {
    tick: frame.tick,
    manifestHash: frame.manifestHash,
    events,
  };
}

function areRecordedEventFramesEqual(
  actual: RecordedRuntimeEventFrame,
  expected: RecordedRuntimeEventFrame,
): boolean {
  if (actual.tick !== expected.tick) {
    return false;
  }
  if (actual.manifestHash !== expected.manifestHash) {
    return false;
  }
  if (actual.events.length !== expected.events.length) {
    return false;
  }

  for (let index = 0; index < actual.events.length; index += 1) {
    const left = actual.events[index];
    const right = expected.events[index];

    if (
      left.type !== right.type ||
      left.channel !== right.channel ||
      left.issuedAt !== right.issuedAt ||
      left.dispatchOrder !== right.dispatchOrder
    ) {
      return false;
    }

    if (!areImmutablePayloadsEqual(left.payload, right.payload)) {
      return false;
    }
  }

  return true;
}

function areImmutablePayloadsEqual(
  left: ImmutablePayload<unknown>,
  right: ImmutablePayload<unknown>,
): boolean {
  try {
    const leftValue = cloneSnapshotToMutable(left);
    const rightValue = cloneSnapshotToMutable(right);
    return JSON.stringify(leftValue) === JSON.stringify(rightValue);
  } catch (error) {
    telemetry.recordError('ReplayEventPayloadComparisonFailed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export function restoreState<TState>(
  snapshot: StateSnapshot<TState>,
): TState;
export function restoreState<TState>(
  target: TState,
  snapshot: StateSnapshot<TState>,
): TState;
export function restoreState<TState>(
  targetOrSnapshot: TState | StateSnapshot<TState>,
  maybeSnapshot?: StateSnapshot<TState>,
): TState {
  let target: TState;
  let snapshot: StateSnapshot<TState>;

  if (maybeSnapshot === undefined) {
    snapshot = targetOrSnapshot as StateSnapshot<TState>;
    target = getGameState<TState>();
  } else {
    target = targetOrSnapshot as TState;
    snapshot = maybeSnapshot;
  }

  const mutableSnapshot = cloneSnapshotToMutable(snapshot);
  const reconciled = reconcileValue(
    target,
    mutableSnapshot,
    new WeakMap<object, unknown>(),
  ) as TState;

  if (maybeSnapshot === undefined) {
    if (reconciled !== target) {
      setGameState(reconciled);
    }
  }

  return reconciled;
}

function freezeSnapshot<T>(value: T): StateSnapshot<T> {
  return deepFreezeInPlace(value);
}

function cloneSnapshotToMutable<T>(
  value: ImmutablePayload<T>,
  seen = new WeakMap<object, unknown>(),
): T {
  return cloneSnapshotInternal(value, seen) as T;
}

function tryCloneImmutableArrayBuffer(
  value: unknown,
  seen: WeakMap<object, unknown>,
): ArrayBuffer | undefined {
  if (!isImmutableArrayBufferSnapshot(value)) {
    return undefined;
  }

  const buffer = value.toArrayBuffer();
  seen.set(value as object, buffer);
  return buffer;
}

function tryCloneImmutableSharedArrayBuffer(
  value: unknown,
  seen: WeakMap<object, unknown>,
): ArrayBufferLike | undefined {
  if (!isImmutableSharedArrayBufferSnapshot(value)) {
    return undefined;
  }

  const clone =
    typeof value.toSharedArrayBuffer === 'function'
      ? value.toSharedArrayBuffer()
      : value.toArrayBuffer();
  seen.set(value as object, clone);
  return clone;
}

function tryCloneArrayBuffer(
  value: unknown,
  seen: WeakMap<object, unknown>,
): ArrayBuffer | undefined {
  if (!(value instanceof ArrayBuffer)) {
    return undefined;
  }

  const clone = value.slice(0);
  seen.set(value, clone);
  return clone;
}

function tryCloneSharedArrayBuffer(
  value: unknown,
  seen: WeakMap<object, unknown>,
): SharedArrayBuffer | undefined {
  if (
    typeof sharedArrayBufferCtor !== 'function' ||
    !(value instanceof sharedArrayBufferCtor)
  ) {
    return undefined;
  }

  const clone = cloneSharedArrayBuffer(value as SharedArrayBuffer);
  seen.set(value as object, clone);
  return clone;
}

function tryCloneDate(
  value: unknown,
  seen: WeakMap<object, unknown>,
): Date | undefined {
  if (!(value instanceof Date)) {
    return undefined;
  }

  const clone = new Date(value.getTime());
  seen.set(value, clone);
  return clone;
}

function tryCloneRegExp(
  value: unknown,
  seen: WeakMap<object, unknown>,
): RegExp | undefined {
  if (!(value instanceof RegExp)) {
    return undefined;
  }

  const clone = new RegExp(value.source, value.flags);
  clone.lastIndex = value.lastIndex;
  seen.set(value, clone);
  return clone;
}

function tryCloneDataView(
  value: unknown,
  seen: WeakMap<object, unknown>,
): DataViewSnapshot | undefined {
  if (!isDataViewLike(value)) {
    return undefined;
  }

  // The immutable proxy strips typed-array identity, so we fall back to `any`
  // to peek at runtime-only properties before cloning.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dataView = value as any;

  if (ArrayBuffer.isView(dataView)) {
    const bufferClone = cloneSnapshotInternal(
      dataView.buffer,
      seen,
    ) as ArrayBufferLike;
    const view = new DataView(
      bufferClone,
      dataView.byteOffset,
      dataView.byteLength,
    );
    seen.set(dataView, view);
    return view;
  }

  const fallbackBuffer = new ArrayBuffer(dataView.byteLength);
  const fallbackView = new DataView(
    fallbackBuffer,
    0,
    dataView.byteLength,
  );
  for (let i = 0; i < dataView.byteLength; i += 1) {
    fallbackView.setUint8(i, dataView.getUint8(i));
  }
  seen.set(dataView, fallbackView);
  return fallbackView;
}

function tryCloneTypedArray(
  value: unknown,
  seen: WeakMap<object, unknown>,
): TypedArray | undefined {
  if (!isTypedArrayLike(value)) {
    return undefined;
  }

  const typed = value;
  const ctor = typed.constructor as {
    new(buffer: ArrayBufferLike, byteOffset?: number, length?: number): TypedArray;
    new(length: number): TypedArray;
  };
  let clone: TypedArray;
  const isSnapshot = isImmutableTypedArraySnapshot(typed);

  if (ArrayBuffer.isView(typed) || isSnapshot) {
    const source = isSnapshot
      ? (typed as ImmutableTypedArraySnapshot<TypedArray>)
      : typed;
    const bufferClone = cloneSnapshotInternal(
      source.buffer,
      seen,
    ) as ArrayBufferLike;
    clone = new ctor(
      bufferClone,
      (source as unknown as TypedArray).byteOffset,
      getTypedArrayLength(source as unknown as TypedArray),
    );
  } else {
    const length = getTypedArrayLength(typed);
    clone = new ctor(length);
    for (let i = 0; i < length; i += 1) {
      clone[i] = typed[i];
    }
  }

  seen.set(typed as object, clone);
  return clone;
}

function tryCloneMap(
  value: unknown,
  seen: WeakMap<object, unknown>,
): Map<unknown, unknown> | undefined {
  if (!(value instanceof Map)) {
    return undefined;
  }

  const clone = new Map<unknown, unknown>();
  seen.set(value as object, clone);
  for (const [key, entryValue] of value.entries()) {
    clone.set(
      cloneSnapshotInternal(key, seen),
      cloneSnapshotInternal(entryValue, seen),
    );
  }
  return clone;
}

function tryCloneSet(
  value: unknown,
  seen: WeakMap<object, unknown>,
): Set<unknown> | undefined {
  if (!(value instanceof Set)) {
    return undefined;
  }

  const clone = new Set<unknown>();
  seen.set(value as object, clone);
  for (const entry of value.values()) {
    clone.add(cloneSnapshotInternal(entry, seen));
  }
  return clone;
}

function tryCloneArray(
  value: unknown,
  seen: WeakMap<object, unknown>,
): unknown[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const clone: unknown[] = [];
  seen.set(value as object, clone);
  for (const item of value) {
    clone.push(cloneSnapshotInternal(item, seen));
  }
  return clone;
}

function cloneObjectWithDescriptors(
  value: object,
  seen: WeakMap<object, unknown>,
): unknown {
  const proto = Object.getPrototypeOf(value);
  const clone =
    proto === null ? Object.create(null) : Object.create(proto);
  seen.set(value, clone);

  const keys: PropertyKey[] = [
    ...Object.getOwnPropertyNames(value),
    ...Object.getOwnPropertySymbols(value),
  ];

  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) {
      continue;
    }

    if ('value' in descriptor) {
      descriptor.value = cloneSnapshotInternal(descriptor.value, seen);
    }

    Object.defineProperty(clone, key, descriptor);
  }

  return clone;
}

function cloneSnapshotInternal(
  value: unknown,
  seen: WeakMap<object, unknown>,
): unknown {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return value;
  }

  if (typeof value === 'function') {
    return value;
  }

  if (seen.has(value as object)) {
    return seen.get(value as object);
  }

  const cloned =
    tryCloneImmutableArrayBuffer(value, seen) ??
    tryCloneImmutableSharedArrayBuffer(value, seen) ??
    tryCloneArrayBuffer(value, seen) ??
    tryCloneSharedArrayBuffer(value, seen) ??
    tryCloneDate(value, seen) ??
    tryCloneRegExp(value, seen) ??
    tryCloneDataView(value, seen) ??
    tryCloneTypedArray(value, seen) ??
    tryCloneMap(value, seen) ??
    tryCloneSet(value, seen) ??
    tryCloneArray(value, seen);

  if (cloned !== undefined) {
    return cloned;
  }

  return cloneObjectWithDescriptors(value as object, seen);
}

function cloneSharedArrayBuffer(
  buffer: SharedArrayBuffer,
): SharedArrayBuffer {
  if (typeof sharedArrayBufferCtor !== 'function') {
    throw new Error('SharedArrayBuffer is not supported in this environment.');
  }

  const clone = new sharedArrayBufferCtor(buffer.byteLength);
  new Uint8Array(clone).set(new Uint8Array(buffer));
  return clone;
}

function isImmutableArrayBufferSnapshot(
  value: unknown,
): value is ImmutableArrayBufferSnapshot {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as ImmutableArrayBufferSnapshot).toArrayBuffer === 'function' &&
    (value as { [Symbol.toStringTag]?: unknown })[Symbol.toStringTag] ===
      'ImmutableArrayBufferSnapshot'
  );
}

function isImmutableSharedArrayBufferSnapshot(
  value: unknown,
): value is ImmutableSharedArrayBufferSnapshot {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as ImmutableSharedArrayBufferSnapshot).toSharedArrayBuffer ===
      'function' &&
    (value as { [Symbol.toStringTag]?: unknown })[Symbol.toStringTag] ===
      'ImmutableSharedArrayBufferSnapshot'
  );
}

function cloneStructured<T>(value: T): T {
  const structuredCloneGlobal = (globalThis as {
    structuredClone?: <TClone>(input: TClone) => TClone;
  }).structuredClone;

  if (typeof structuredCloneGlobal !== 'function') {
    throw new Error(
      'structuredClone is required for CommandRecorder snapshots.',
    );
  }

  if (containsSymbolProperties(value)) {
    return cloneSnapshotToMutable(
      value as ImmutablePayload<T>,
    );
  }

  try {
    return structuredCloneGlobal(value);
  } catch (error) {
    if (isStructuredCloneDataError(error)) {
      return cloneSnapshotToMutable(
        value as ImmutablePayload<T>,
      );
    }
    throw error;
  }
}

function isStructuredCloneDataError(error: unknown): boolean {
  if (
    typeof DOMException === 'undefined' ||
    !(error instanceof DOMException)
  ) {
    return false;
  }
  return error.name === 'DataCloneError';
}

function containsSymbolProperties(
  value: unknown,
  seen = new WeakSet<object>(),
): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const objectValue = value;
  if (seen.has(objectValue)) {
    return false;
  }
  seen.add(objectValue);

  const collectionScan =
    scanMapForSymbolProperties(value, seen) ??
    scanSetForSymbolProperties(value, seen) ??
    scanArrayForSymbolProperties(value, seen);
  if (collectionScan !== undefined) {
    return collectionScan;
  }

  if (isTerminalSymbolScanValue(value)) {
    return false;
  }

  return scanObjectForSymbolProperties(value as Record<PropertyKey, unknown>, seen);
}

function scanMapForSymbolProperties(
  value: unknown,
  seen: WeakSet<object>,
): boolean | undefined {
  if (!(value instanceof Map)) {
    return undefined;
  }

  for (const [key, entryValue] of value.entries()) {
    if (containsSymbolProperties(key, seen) || containsSymbolProperties(entryValue, seen)) {
      return true;
    }
  }
  return false;
}

function scanSetForSymbolProperties(
  value: unknown,
  seen: WeakSet<object>,
): boolean | undefined {
  if (!(value instanceof Set)) {
    return undefined;
  }

  for (const entry of value.values()) {
    if (containsSymbolProperties(entry, seen)) {
      return true;
    }
  }
  return false;
}

function scanArrayForSymbolProperties(
  value: unknown,
  seen: WeakSet<object>,
): boolean | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  for (const item of value) {
    if (containsSymbolProperties(item, seen)) {
      return true;
    }
  }
  return false;
}

function isTerminalSymbolScanValue(value: object): boolean {
  return (
    ArrayBuffer.isView(value) ||
    isImmutableTypedArraySnapshot(value) ||
    value instanceof ArrayBuffer ||
    value instanceof Date ||
    value instanceof RegExp
  );
}

function scanObjectForSymbolProperties(
  value: Record<PropertyKey, unknown>,
  seen: WeakSet<object>,
): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === 'symbol')) {
    return true;
  }

  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) {
      continue;
    }
    if (containsSymbolProperties(descriptor.value, seen)) {
      return true;
    }
  }

  return false;
}

function findMatchingFutureCommandIndex(
  commands: readonly CommandSnapshot[],
  candidate: CommandSnapshot,
  startIndex: number,
  claimedIndices: Set<number>,
): number {
  for (let i = startIndex; i < commands.length; i += 1) {
    if (claimedIndices.has(i)) {
      continue;
    }
    if (commandsEqual(commands[i], candidate)) {
      return i;
    }
  }
  return -1;
}

function commandsEqual(
  left: CommandSnapshot,
  right: CommandSnapshot,
): boolean {
  return (
    left.type === right.type &&
    left.priority === right.priority &&
    left.step === right.step &&
    left.timestamp === right.timestamp &&
    payloadsMatch(left.payload, right.payload)
  );
}

function getArrayBufferViewBytes(view: ArrayBufferViewSnapshot): Uint8Array {
  const baseView = view as {
    buffer?: unknown;
    byteOffset: number;
    byteLength: number;
    getUint8?(index: number): number;
    [index: number]: unknown;
  };

  if (ArrayBuffer.isView(view)) {
    return new Uint8Array(
      baseView.buffer as ArrayBufferLike,
      baseView.byteOffset,
      baseView.byteLength,
    );
  }

  const maybeBuffer = baseView.buffer;

  if (isImmutableArrayBufferSnapshot(maybeBuffer)) {
    const bytes = maybeBuffer.toUint8Array();
    return bytes.subarray(
      baseView.byteOffset,
      baseView.byteOffset + baseView.byteLength,
    );
  }

  if (isImmutableSharedArrayBufferSnapshot(maybeBuffer)) {
    const bytes = maybeBuffer.toUint8Array();
    return bytes.subarray(
      baseView.byteOffset,
      baseView.byteOffset + baseView.byteLength,
    );
  }

  if (isDataViewLike(view)) {
    const copy = new Uint8Array(baseView.byteLength);
    for (let i = 0; i < copy.length; i += 1) {
      const reader = baseView.getUint8;
      copy[i] = typeof reader === 'function' ? reader.call(view, i) : 0;
    }
    return copy;
  }

  const bytes = new Uint8Array(baseView.byteLength);
  for (let i = 0; i < bytes.length; i += 1) {
    const value = baseView[i];
    if (typeof value === 'number') {
      bytes[i] = value & 0xff;
      continue;
    }
    if (typeof value === 'bigint') {
      bytes[i] = Number(value & BigInt(0xff));
      continue;
    }
    const numeric = Number(value);
    bytes[i] = Number.isNaN(numeric) ? 0 : numeric & 0xff;
  }
  return bytes;
}

function payloadsMatch(
  left: unknown,
  right: unknown,
  seen = new WeakMap<object, unknown>(),
): boolean {
  if (Object.is(left, right)) {
    return true;
  }

  if (typeof left !== typeof right) {
    return false;
  }

  if (!left || !right || typeof left !== 'object') {
    return left === right;
  }

  const objectLeft = left as object;
  const objectRight = right as object;
  if (seen.has(objectLeft)) {
    return seen.get(objectLeft) === right;
  }
  seen.set(objectLeft, right);

  return (
    tryMatchMapPayloads(left, right, seen) ??
    tryMatchSetPayloads(left, right, seen) ??
    tryMatchArrayPayloads(left, right, seen) ??
    tryMatchArrayBufferViewPayloads(left, right) ??
    tryMatchDatePayloads(left, right) ??
    matchObjectPayloads(objectLeft as Record<PropertyKey, unknown>, objectRight as Record<PropertyKey, unknown>, seen)
  );
}

function tryMatchMapPayloads(
  left: unknown,
  right: unknown,
  seen: WeakMap<object, unknown>,
): boolean | undefined {
  if (!(left instanceof Map) || !(right instanceof Map)) {
    return undefined;
  }
  if (left.size !== right.size) {
    return false;
  }

  const rightEntries = Array.from(right.entries());
  return Array.from(left.entries()).every(([lk, lv], index) => {
    const [rk, rv] = rightEntries[index];
    return payloadsMatch(lk, rk, seen) && payloadsMatch(lv, rv, seen);
  });
}

function tryMatchSetPayloads(
  left: unknown,
  right: unknown,
  seen: WeakMap<object, unknown>,
): boolean | undefined {
  if (!(left instanceof Set) || !(right instanceof Set)) {
    return undefined;
  }
  if (left.size !== right.size) {
    return false;
  }

  const rightValues = Array.from(right.values());
  return Array.from(left.values()).every((lv, index) =>
    payloadsMatch(lv, rightValues[index], seen),
  );
}

function tryMatchArrayPayloads(
  left: unknown,
  right: unknown,
  seen: WeakMap<object, unknown>,
): boolean | undefined {
  if (!Array.isArray(left) || !Array.isArray(right)) {
    return undefined;
  }
  if (left.length !== right.length) {
    return false;
  }
  for (let i = 0; i < left.length; i += 1) {
    if (!payloadsMatch(left[i], right[i], seen)) {
      return false;
    }
  }
  return true;
}

function tryMatchArrayBufferViewPayloads(
  left: unknown,
  right: unknown,
): boolean | undefined {
  if (!isArrayBufferViewLike(left) || !isArrayBufferViewLike(right)) {
    return undefined;
  }
  if (left.byteLength !== right.byteLength) {
    return false;
  }

  const leftBytes = getArrayBufferViewBytes(left);
  const rightBytes = getArrayBufferViewBytes(right);
  for (let i = 0; i < leftBytes.length; i += 1) {
    if (leftBytes[i] !== rightBytes[i]) {
      return false;
    }
  }
  return true;
}

function tryMatchDatePayloads(left: unknown, right: unknown): boolean | undefined {
  if (!(left instanceof Date) || !(right instanceof Date)) {
    return undefined;
  }
  return left.getTime() === right.getTime();
}

function matchObjectPayloads(
  left: Record<PropertyKey, unknown>,
  right: Record<PropertyKey, unknown>,
  seen: WeakMap<object, unknown>,
): boolean {
  const leftKeys = Reflect.ownKeys(left);
  const rightKeys = Reflect.ownKeys(right);

  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(right, key)) {
      return false;
    }
    if (!payloadsMatch(Reflect.get(left, key), Reflect.get(right, key), seen)) {
      return false;
    }
  }

  return true;
}

function reconcileValue(
  current: unknown,
  next: unknown,
  seen: WeakMap<object, unknown>,
): unknown {
  if (!next || typeof next !== 'object') {
    return next;
  }

  const objectNext = next;

  if (seen.has(objectNext)) {
    return seen.get(objectNext);
  }

  return (
    tryReconcileMap(current, next, seen) ??
    tryReconcileSet(current, next, seen) ??
    tryReconcileArray(current, next, seen) ??
    tryReconcileDataView(current, next, seen) ??
    tryReconcileTypedArray(current, next, seen) ??
    tryReconcileDate(next) ??
    tryReconcilePlainObject(current, next, seen) ??
    reconcileByCloning(next, seen)
  );
}

function tryReconcileMap(
  current: unknown,
  next: unknown,
  seen: WeakMap<object, unknown>,
): Map<unknown, unknown> | undefined {
  if (!(next instanceof Map)) {
    return undefined;
  }

  const map = current instanceof Map ? current : new Map();
  seen.set(next as object, map);

  const existingEntries =
    current instanceof Map ? Array.from(current.entries()) : [];
  const matchedEntryIndices = new Set<number>();

  map.clear();
  for (const [key, value] of next.entries()) {
    const existingEntry = findMatchingMapEntry(
      existingEntries,
      key,
      matchedEntryIndices,
    );
    const resolvedKey = reconcileValue(existingEntry?.[0], key, seen);
    const resolvedValue = reconcileValue(existingEntry?.[1], value, seen);
    map.set(resolvedKey, resolvedValue);
  }

  return map;
}

function tryReconcileSet(
  current: unknown,
  next: unknown,
  seen: WeakMap<object, unknown>,
): Set<unknown> | undefined {
  if (!(next instanceof Set)) {
    return undefined;
  }

  const set = current instanceof Set ? current : new Set();
  seen.set(next as object, set);

  const existingItems =
    current instanceof Set ? Array.from(current.values()) : [];
  const matchedItemIndices = new Set<number>();

  set.clear();
  for (const item of next.values()) {
    const existingItem = findMatchingSetItem(
      existingItems,
      item,
      matchedItemIndices,
    );
    const resolvedItem = reconcileValue(existingItem ?? undefined, item, seen);
    set.add(resolvedItem);
  }

  return set;
}

function tryReconcileArray(
  current: unknown,
  next: unknown,
  seen: WeakMap<object, unknown>,
): unknown[] | undefined {
  if (!Array.isArray(next)) {
    return undefined;
  }

  const array = Array.isArray(current) ? current : [];
  seen.set(next as object, array);
  array.length = next.length;
  for (let i = 0; i < next.length; i += 1) {
    array[i] = reconcileValue(array[i], next[i], seen);
  }
  return array;
}

function tryReconcileDataView(
  current: unknown,
  next: unknown,
  seen: WeakMap<object, unknown>,
): DataViewSnapshot | undefined {
  if (!isDataViewLike(next)) {
    return undefined;
  }

  // Immutable DataView proxies lose their native type at runtime.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nextView = next as any;
  let resolvedView: DataViewSnapshot;

  if (isDataViewLike(current) && canReuseDataView(current, nextView)) {
    const currentView = current;
    copyDataViewContents(currentView, nextView);
    resolvedView = currentView;
  } else if (ArrayBuffer.isView(nextView)) {
    const clonedBuffer = cloneSnapshotInternal(nextView.buffer, seen) as ArrayBufferLike;
    resolvedView = new DataView(
      clonedBuffer,
      nextView.byteOffset,
      nextView.byteLength,
    );
  } else {
    const fallbackBuffer = new ArrayBuffer(nextView.byteLength);
    const fallbackView = new DataView(
      fallbackBuffer,
      0,
      nextView.byteLength,
    );
    for (let i = 0; i < nextView.byteLength; i += 1) {
      fallbackView.setUint8(i, nextView.getUint8(i));
    }
    resolvedView = fallbackView;
  }

  seen.set(next as object, resolvedView);
  return resolvedView;
}

function tryReconcileTypedArray(
  current: unknown,
  next: unknown,
  seen: WeakMap<object, unknown>,
): TypedArray | undefined {
  if (!isTypedArrayLike(next)) {
    return undefined;
  }

  const typed = next;
  let resolvedView: TypedArray;

  if (isTypedArrayLike(current) && canReuseTypedArray(current, typed)) {
    const currentTyped = current;
    copyTypedArrayContents(currentTyped, typed);
    resolvedView = currentTyped;
  } else {
    const ctor = typed.constructor as {
      new(buffer: ArrayBufferLike, byteOffset?: number, length?: number): TypedArray;
      new(length: number): TypedArray;
    };

    if (ArrayBuffer.isView(typed)) {
      const clonedBuffer = cloneSnapshotInternal(typed.buffer, seen) as ArrayBufferLike;
      resolvedView = new ctor(clonedBuffer, typed.byteOffset, typed.length);
    } else if (isImmutableTypedArraySnapshot(typed)) {
      const source = typed as ImmutableTypedArraySnapshot<TypedArray>;
      const clonedBuffer = cloneSnapshotInternal(source.buffer, seen) as ArrayBufferLike;
      resolvedView = new ctor(
        clonedBuffer,
        (source as unknown as TypedArray).byteOffset,
        getTypedArrayLength(source as unknown as TypedArray),
      );
    } else {
      const length = getTypedArrayLength(typed);
      const clone = new ctor(length);
      for (let i = 0; i < length; i += 1) {
        clone[i] = typed[i];
      }
      resolvedView = clone;
    }
  }

  seen.set(next as object, resolvedView);
  return resolvedView;
}

function tryReconcileDate(next: unknown): Date | undefined {
  if (!(next instanceof Date)) {
    return undefined;
  }
  return new Date(next.getTime());
}

function tryReconcilePlainObject(
  current: unknown,
  next: unknown,
  seen: WeakMap<object, unknown>,
): Record<PropertyKey, unknown> | undefined {
  if (!isPlainObject(next)) {
    return undefined;
  }

  const target = isPlainObject(current) ? (current as Record<PropertyKey, unknown>) : {};
  seen.set(next as object, target);

  const nextObject = next as Record<PropertyKey, unknown>;

  for (const key of Reflect.ownKeys(target)) {
    if (!Reflect.has(nextObject, key)) {
      Reflect.deleteProperty(target, key);
    }
  }

  for (const key of Reflect.ownKeys(nextObject)) {
    const currentValue = Reflect.get(target, key);
    const nextValue = Reflect.get(nextObject, key);
    const reconciled = reconcileValue(currentValue, nextValue, seen);
    Reflect.set(target, key, reconciled);
  }

  return target;
}

function reconcileByCloning(next: unknown, seen: WeakMap<object, unknown>): unknown {
  const clone = cloneStructured(next);
  if (typeof clone === 'object' && clone !== null) {
    seen.set(next as object, clone);
  }
  return clone;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function findMatchingMapEntry(
  entries: [unknown, unknown][],
  candidateKey: unknown,
  matchedIndices: Set<number>,
): [unknown, unknown] | undefined {
  for (let i = 0; i < entries.length; i += 1) {
    if (matchedIndices.has(i)) {
      continue;
    }
    const [existingKey] = entries[i];
    if (
      Object.is(existingKey, candidateKey) ||
      payloadsMatch(existingKey, candidateKey)
    ) {
      matchedIndices.add(i);
      return entries[i];
    }
  }
  return undefined;
}

function findMatchingSetItem(
  items: unknown[],
  candidate: unknown,
  matchedIndices: Set<number>,
): unknown | undefined {
  for (let i = 0; i < items.length; i += 1) {
    if (matchedIndices.has(i)) {
      continue;
    }
    const existing = items[i];
    if (
      Object.is(existing, candidate) ||
      payloadsMatch(existing, candidate)
    ) {
      matchedIndices.add(i);
      return existing;
    }
  }
  return undefined;
}
