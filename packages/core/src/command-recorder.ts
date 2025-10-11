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

export class CommandRecorder {
  private readonly recorded: FrozenCommand[] = [];
  private readonly recordedClones: Command[] = [];
  private startState: StateSnapshot;
  private startStateClone: unknown;
  private rngSeed: number | undefined;
  private lastRecordedStep = -1;

  constructor(currentState: unknown, options?: { seed?: number }) {
    const startClone = cloneStructured(currentState);
    this.startStateClone = startClone;
    this.startState = freezeSnapshot(cloneStructured(startClone));
    this.rngSeed = options?.seed ?? getCurrentRNGSeed();
  }

  record(command: Command): void {
    const rawClone = cloneStructured(command);
    const snapshot = freezeSnapshot(
      cloneStructured(rawClone),
    ) as FrozenCommand;
    this.recorded.push(snapshot);
    this.recordedClones.push(rawClone);
    this.lastRecordedStep = Math.max(this.lastRecordedStep, command.step);
  }

  export(): CommandLog {
    const exportedLog = {
      version: COMMAND_LOG_VERSION,
      startState: cloneStructured(this.startStateClone),
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
    const matchedFutureCommandIndices = new Set<number>();

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
            handler(cmd.payload, context);
          } catch (error) {
            telemetry.recordError('ReplayExecutionFailed', {
              type: cmd.type,
              step: cmd.step,
              error:
                error instanceof Error ? error.message : String(error),
            });
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
        if (previousStep !== undefined) {
          runtimeContext?.setCurrentStep?.(previousStep);
        }
        if (previousNextStep !== undefined) {
          runtimeContext?.setNextExecutableStep?.(previousNextStep);
        }
      } else if (finalStep >= 0 && runtimeContext) {
        runtimeContext.setCurrentStep?.(finalStep + 1);
        runtimeContext.setNextExecutableStep?.(finalStep + 1);
      }
    }
  }

  clear(nextState: unknown, options?: { seed?: number }): void {
    this.recorded.length = 0;
    this.recordedClones.length = 0;
    const startClone = cloneStructured(nextState);
    this.startStateClone = startClone;
    this.startState = freezeSnapshot(cloneStructured(startClone));
    this.rngSeed = options?.seed ?? getCurrentRNGSeed();
    this.lastRecordedStep = -1;
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
  );

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

  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView) {
      const bufferClone = cloneSnapshotInternal(
        value.buffer,
        seen,
      ) as ArrayBufferLike;
      const view = new DataView(bufferClone, value.byteOffset, value.byteLength);
      seen.set(value, view);
      return view;
    }

    const typed = value as ArrayBufferView & {
      constructor: new (
        buffer: ArrayBufferLike,
        byteOffset?: number,
        length?: number,
      ) => ArrayBufferView;
    };

    const bufferClone = cloneSnapshotInternal(
      typed.buffer,
      seen,
    ) as ArrayBufferLike;
    const ctor = typed.constructor;
    const length =
      typeof (typed as { length?: number }).length === 'number'
        ? (typed as { length: number }).length
        : undefined;
    const clone =
      length !== undefined
        ? new ctor(bufferClone, typed.byteOffset, length)
        : new ctor(bufferClone, typed.byteOffset);
    seen.set(value as object, clone);
    return clone;
  }

  if (value instanceof Map) {
    const clone = new Map();
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
    const clone = new Set();
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

  return structuredCloneGlobal(value);
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
    payloadsMatch(left.payload, right.payload)
  );
}

function payloadsMatch(
  left: unknown,
  right: unknown,
  seen: WeakMap<any, any> = new WeakMap(),
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

  const existing = seen.get(left);
  if (existing) {
    return existing === right;
  }
  seen.set(left, right);

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

  if (ArrayBuffer.isView(left) && ArrayBuffer.isView(right)) {
    if (left.byteLength !== right.byteLength) {
      return false;
    }
    const leftBytes = new Uint8Array(
      left.buffer,
      left.byteOffset,
      left.byteLength,
    );
    const rightBytes = new Uint8Array(
      right.buffer,
      right.byteOffset,
      right.byteLength,
    );
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

  const leftKeys = Object.keys(left as Record<string, unknown>);
  const rightKeys = Object.keys(right as Record<string, unknown>);

  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(right, key)) {
      return false;
    }
    if (
      !payloadsMatch(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
        seen,
      )
    ) {
      return false;
    }
  }

  return true;
}

function reconcileValue(
  current: any,
  next: any,
  seen: WeakMap<object, unknown>,
): any {
  if (!next || typeof next !== 'object') {
    return next;
  }

  if (seen.has(next)) {
    return seen.get(next);
  }

  if (next instanceof Map) {
    const map = current instanceof Map ? current : new Map();
    seen.set(next, map);

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
      const resolvedKey =
        existingEntry !== undefined
          ? existingEntry[0]
          : reconcileValue(undefined, key, seen);
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
    seen.set(next, set);

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
    seen.set(next, array);
    array.length = next.length;
    for (let i = 0; i < next.length; i += 1) {
      array[i] = reconcileValue(array[i], next[i], seen);
    }
    return array;
  }

  if (ArrayBuffer.isView(next)) {
    if (typeof (next as { slice?: () => unknown }).slice === 'function') {
      return (next as { slice: () => unknown }).slice();
    }

    const ctor = next.constructor as {
      new(buffer: ArrayBufferLike, byteOffset?: number, length?: number): any;
    };
    return new ctor(
      next.buffer.slice(next.byteOffset, next.byteOffset + next.byteLength),
    );
  }

  if (next instanceof Date) {
    return new Date(next.getTime());
  }

  if (isPlainObject(next)) {
    const target = isPlainObject(current) ? current : {};
    seen.set(next, target);

    for (const key of Object.keys(target)) {
      if (!(key in next)) {
        delete target[key];
      }
    }

    for (const [key, value] of Object.entries(next)) {
      target[key] = reconcileValue(target[key], value, seen);
    }

    return target;
  }

  const clone = cloneStructured(next);
  if (typeof clone === 'object' && clone !== null) {
    seen.set(next, clone);
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
  entries: Array<[any, any]>,
  candidateKey: any,
  matchedIndices: Set<number>,
): [any, any] | undefined {
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
  items: any[],
  candidate: any,
  matchedIndices: Set<number>,
): any | undefined {
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
