import type { Command, CommandSnapshot } from './command.js';
import type {
  CommandDispatcher,
  ExecutionContext,
} from './command-dispatcher.js';
import { CommandQueue, deepFreezeInPlace } from './command-queue.js';
import type { ImmutablePayload } from './command.js';
import type {
  ImmutableArrayBufferSnapshot,
  ImmutableSharedArrayBufferSnapshot,
  TypedArray,
} from './immutable-snapshots.js';
import { telemetry } from './telemetry.js';
import {
  getCurrentRNGSeed,
  setRNGSeed,
} from './rng.js';
import { getGameState, setGameState } from './runtime-state.js';

export type StateSnapshot<TState = unknown> = ImmutablePayload<TState>;

export interface CommandLog {
  readonly version: string;
  readonly startState: StateSnapshot;
  readonly commands: readonly CommandSnapshot[];
  readonly metadata: {
    readonly recordedAt: number;
    readonly seed?: number;
    readonly lastStep: number;
  };
}

export interface RuntimeReplayContext {
  readonly commandQueue: CommandQueue;
  getCurrentStep?(): number;
  getNextExecutableStep?(): number;
  setCurrentStep?(step: number): void;
  setNextExecutableStep?(step: number): void;
}

const COMMAND_LOG_VERSION = '0.1.0';

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

  export(): CommandLog {
    this.refreshSeedSnapshot();
    const exportedLog = {
      version: COMMAND_LOG_VERSION,
      startState: cloneSnapshotToMutable(this.startState),
      commands: this.recordedClones.map(cloneStructured),
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

    if (log.metadata.seed !== undefined) {
      setRNGSeed(log.metadata.seed);
    }

    const queue =
      runtimeContext?.commandQueue ??
      new CommandQueue();

    if (queue.size > 0) {
      telemetry.recordError('ReplayQueueNotEmpty', { pending: queue.size });
      throw new Error('Command queue must be empty before replay begins.');
    }

    const sandboxedEnqueues: FrozenCommand[] = [];
    const originalEnqueue = queue.enqueue.bind(queue);
    const recordedFinalStep = log.metadata.lastStep ?? -1;
    const derivedFinalStep =
      log.commands.length > 0
        ? log.commands.reduce(
            (max, cmd) => Math.max(max, cmd.step),
            -1,
          )
        : -1;
    const finalStep =
      recordedFinalStep >= 0 ? recordedFinalStep : derivedFinalStep;
    const previousStep = runtimeContext?.getCurrentStep?.();
    const previousNextStep = runtimeContext?.getNextExecutableStep?.();
    let replayFailed = true;
    let stateAdvanced = false;
    let finalizationComplete = false;
    const matchedFutureCommandIndices = new Set<number>();

    const revertRuntimeContext = (): void => {
      if (!runtimeContext) {
        return;
      }
      if (previousStep !== undefined) {
        runtimeContext.setCurrentStep?.(previousStep);
      }
      if (previousNextStep !== undefined) {
        runtimeContext.setNextExecutableStep?.(previousNextStep);
      }
      stateAdvanced = false;
    };

    const recordReplayFailure = (
      command: FrozenCommand,
      error: unknown,
    ): void => {
      replayFailed = true;
      telemetry.recordError('ReplayExecutionFailed', {
        type: command.type,
        step: command.step,
        error:
          error instanceof Error ? error.message : String(error),
      });

      if (finalizationComplete && stateAdvanced) {
        revertRuntimeContext();
      }
    };

    (queue as CommandQueue & {
      enqueue: (command: Command) => void;
    }).enqueue = (cmd: Command) => {
      const snapshot = freezeSnapshot(
        cloneStructured(cmd),
      ) as FrozenCommand;
      sandboxedEnqueues.push(snapshot);
    };

    try {
      for (let i = 0; i < log.commands.length; i += 1) {
        const cmd = log.commands[i];

        const context: ExecutionContext = {
          step: cmd.step,
          timestamp: cmd.timestamp,
          priority: cmd.priority,
        };

        const handler = dispatcher.getHandler(cmd.type);
        if (!handler) {
          telemetry.recordError('ReplayUnknownCommandType', {
            type: cmd.type,
            step: cmd.step,
          });
        } else {
          try {
            const result = handler(cmd.payload, context);
            if (isPromiseLike(result)) {
              result.catch((error: unknown) => {
                recordReplayFailure(cmd, error);
              });
            }
          } catch (error) {
            recordReplayFailure(cmd, error);
          }
        }

        if (sandboxedEnqueues.length > 0) {
          for (const queued of sandboxedEnqueues) {
            const matchIndex = findMatchingFutureCommandIndex(
              log.commands,
              queued,
              i + 1,
              matchedFutureCommandIndices,
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

            matchedFutureCommandIndices.add(matchIndex);
          }

          sandboxedEnqueues.length = 0;
        }
      }

      replayFailed = false;
    } finally {
      (queue as CommandQueue & {
        enqueue: (command: Command) => void;
      }).enqueue = originalEnqueue;

      if (replayFailed) {
        revertRuntimeContext();
      } else if (finalStep >= 0 && runtimeContext) {
        runtimeContext.setCurrentStep?.(finalStep + 1);
        runtimeContext.setNextExecutableStep?.(finalStep + 1);
        stateAdvanced = true;
      }
      finalizationComplete = true;
    }
  }

  clear(nextState: unknown, options?: { seed?: number }): void {
    this.recorded.length = 0;
    this.recordedClones.length = 0;
    const startClone = cloneStructured(nextState);
    this.startState = freezeSnapshot(startClone);
    this.rngSeed = options?.seed;
    this.refreshSeedSnapshot();
    this.lastRecordedStep = -1;
  }
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PromiseLike<T>).then === 'function'
  );
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
  seen: WeakMap<object, unknown> = new WeakMap(),
): T {
  return cloneSnapshotInternal(value, seen) as T;
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

  const cached = seen.get(value as object);
  if (cached) {
    return cached;
  }

  if (isImmutableArrayBufferSnapshot(value)) {
    const buffer = value.toArrayBuffer();
    seen.set(value as object, buffer);
    return buffer;
  }

  if (isImmutableSharedArrayBufferSnapshot(value)) {
    const clone =
      typeof value.toSharedArrayBuffer === 'function'
        ? value.toSharedArrayBuffer()
        : value.toArrayBuffer();
    seen.set(value as object, clone);
    return clone;
  }

  if (value instanceof ArrayBuffer) {
    const clone = value.slice(0);
    seen.set(value, clone);
    return clone;
  }

  if (
    typeof sharedArrayBufferCtor === 'function' &&
    value instanceof sharedArrayBufferCtor
  ) {
    const clone = cloneSharedArrayBuffer(value);
    seen.set(value, clone);
    return clone;
  }

  if (value instanceof Date) {
    const clone = new Date(value.getTime());
    seen.set(value, clone);
    return clone;
  }

  if (value instanceof RegExp) {
    const clone = new RegExp(value.source, value.flags);
    clone.lastIndex = value.lastIndex;
    seen.set(value, clone);
    return clone;
  }

  if (isDataViewLike(value)) {
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

  if (isTypedArrayLike(value)) {
    const typed = value as TypedArray;
    const ctor = typed.constructor as {
      new(buffer: ArrayBufferLike, byteOffset?: number, length?: number): TypedArray;
      new(length: number): TypedArray;
    };
    let clone: TypedArray;
    if (ArrayBuffer.isView(typed)) {
      const bufferClone = cloneSnapshotInternal(
        typed.buffer,
        seen,
      ) as ArrayBufferLike;
      clone = new ctor(bufferClone, typed.byteOffset, typed.length);
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

  if (value instanceof Map) {
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

  if (value instanceof Set) {
    const clone = new Set<unknown>();
    seen.set(value as object, clone);
    for (const entry of value.values()) {
      clone.add(cloneSnapshotInternal(entry, seen));
    }
    return clone;
  }

  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value as object, clone);
    for (const item of value) {
      clone.push(cloneSnapshotInternal(item, seen));
    }
    return clone;
  }

  const proto = Object.getPrototypeOf(value);
  const clone =
    proto === null ? Object.create(null) : Object.create(proto);
  seen.set(value as object, clone);

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
  seen: WeakSet<object> = new WeakSet(),
): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const objectValue = value as object;
  if (seen.has(objectValue)) {
    return false;
  }
  seen.add(objectValue);

  if (value instanceof Map) {
    for (const [key, entryValue] of value.entries()) {
      if (containsSymbolProperties(key, seen)) {
        return true;
      }
      if (containsSymbolProperties(entryValue, seen)) {
        return true;
      }
    }
    return false;
  }

  if (value instanceof Set) {
    for (const entry of value.values()) {
      if (containsSymbolProperties(entry, seen)) {
        return true;
      }
    }
    return false;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (containsSymbolProperties(item, seen)) {
        return true;
      }
    }
    return false;
  }

  if (
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer ||
    value instanceof Date ||
    value instanceof RegExp
  ) {
    return false;
  }

  const keys = Reflect.ownKeys(
    value as Record<PropertyKey, unknown>,
  );
  if (keys.some((key) => typeof key === 'symbol')) {
    return true;
  }

  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(
      value as Record<PropertyKey, unknown>,
      key,
    );
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
  seen: WeakMap<object, unknown> = new WeakMap(),
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

  if (left instanceof Map && right instanceof Map) {
    if (left.size !== right.size) {
      return false;
    }
    const rightEntries = Array.from(right.entries());
    return Array.from(left.entries()).every(([lk, lv], index) => {
      const [rk, rv] = rightEntries[index];
      return (
        payloadsMatch(lk, rk, seen) &&
        payloadsMatch(lv, rv, seen)
      );
    });
  }

  if (left instanceof Set && right instanceof Set) {
    if (left.size !== right.size) {
      return false;
    }
    const rightValues = Array.from(right.values());
    return Array.from(left.values()).every((lv, index) =>
      payloadsMatch(lv, rightValues[index], seen),
    );
  }

  if (Array.isArray(left) && Array.isArray(right)) {
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

  if (isArrayBufferViewLike(left) && isArrayBufferViewLike(right)) {
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

  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime();
  }

  const leftKeys = Reflect.ownKeys(objectLeft);
  const rightKeys = Reflect.ownKeys(objectRight);

  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(objectRight, key)) {
      return false;
    }
    if (
      !payloadsMatch(
        Reflect.get(objectLeft, key),
        Reflect.get(objectRight, key),
        seen,
      )
    ) {
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

  const objectNext = next as object;

  if (seen.has(objectNext)) {
    return seen.get(objectNext);
  }

  if (next instanceof Map) {
    const map = current instanceof Map ? current : new Map();
    seen.set(objectNext, map);

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
      const resolvedKey = reconcileValue(
        existingEntry?.[0],
        key,
        seen,
      );
      const resolvedValue = reconcileValue(
        existingEntry?.[1],
        value,
        seen,
      );
      map.set(resolvedKey, resolvedValue);
    }

    return map;
  }

  if (next instanceof Set) {
    const set = current instanceof Set ? current : new Set();
    seen.set(objectNext, set);

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
      const resolvedItem = reconcileValue(
        existingItem ?? undefined,
        item,
        seen,
      );
      set.add(resolvedItem);
    }

    return set;
  }

  if (Array.isArray(next)) {
    const array = Array.isArray(current) ? current : [];
    seen.set(objectNext, array);
    array.length = next.length;
    for (let i = 0; i < next.length; i += 1) {
      array[i] = reconcileValue(array[i], next[i], seen);
    }
    return array;
  }

  if (isDataViewLike(next)) {
    // Immutable DataView proxies lose their native type at runtime.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nextView = next as any;
    let resolvedView: DataViewSnapshot;
    if (
      isDataViewLike(current) &&
      canReuseDataView(current as DataViewSnapshot, nextView)
    ) {
      const currentView = current as DataViewSnapshot;
      copyDataViewContents(currentView, nextView);
      resolvedView = currentView;
    } else if (ArrayBuffer.isView(nextView)) {
      const clonedBuffer = cloneSnapshotInternal(
        nextView.buffer,
        seen,
      ) as ArrayBufferLike;
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

    seen.set(objectNext, resolvedView);
    return resolvedView;
  }

  if (isTypedArrayLike(next)) {
    const typed = next as TypedArray;
    let resolvedView: TypedArray;
    if (
      isTypedArrayLike(current) &&
      canReuseTypedArray(current as TypedArray, typed)
    ) {
      const currentTyped = current as TypedArray;
      copyTypedArrayContents(currentTyped, typed);
      resolvedView = currentTyped;
    } else {
      const ctor = typed.constructor as {
        new(buffer: ArrayBufferLike, byteOffset?: number, length?: number): TypedArray;
        new(length: number): TypedArray;
      };
      if (ArrayBuffer.isView(typed)) {
        const clonedBuffer = cloneSnapshotInternal(
          typed.buffer,
          seen,
        ) as ArrayBufferLike;
        resolvedView = new ctor(
          clonedBuffer,
          typed.byteOffset,
          typed.length,
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

    seen.set(objectNext, resolvedView);
    return resolvedView;
  }

  if (next instanceof Date) {
    return new Date(next.getTime());
  }

  if (isPlainObject(next)) {
    const target = isPlainObject(current) ? current : {};
    seen.set(objectNext, target);

    const targetObject = target as Record<PropertyKey, unknown>;
    const nextObject = next as Record<PropertyKey, unknown>;

    for (const key of Reflect.ownKeys(targetObject)) {
      if (!Reflect.has(nextObject, key)) {
        Reflect.deleteProperty(targetObject, key);
      }
    }

    for (const key of Reflect.ownKeys(nextObject)) {
      const currentValue = Reflect.get(targetObject, key);
      const nextValue = Reflect.get(nextObject, key);
      const reconciled = reconcileValue(currentValue, nextValue, seen);
      Reflect.set(targetObject, key, reconciled);
    }

    return target;
  }

  const clone = cloneStructured(next);
  if (typeof clone === 'object' && clone !== null) {
    seen.set(objectNext, clone);
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
  entries: Array<[unknown, unknown]>,
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
