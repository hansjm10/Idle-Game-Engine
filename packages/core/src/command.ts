/**
 * Command interface and priority tiers defined in
 * docs/runtime-command-queue-design.md §4.1.
 *
 * Commands are the sole mechanism for mutating runtime state at tick
 * boundaries. Every command carries the simulation step that will execute it
 * along with a priority lane used to resolve ordering conflicts.
 */
import type {
  ImmutableArrayBufferSnapshot,
  ImmutableMapSnapshot,
  ImmutableSetSnapshot,
  ImmutableSharedArrayBufferSnapshot,
  ImmutableTypedArraySnapshot,
  TypedArray,
} from './immutable-snapshots.js';

export interface Command<TPayload = unknown> {
  readonly type: string;
  readonly priority: CommandPriority;
  readonly payload: TPayload;
  readonly timestamp: number;
  readonly step: number;
}

type ImmutablePrimitive =
  | string
  | number
  | bigint
  | boolean
  | symbol
  | null
  | undefined;

type ImmutableFunction = (...args: unknown[]) => unknown;

type ImmutableArrayLike<T> = readonly ImmutablePayload<T>[];

export type ImmutablePayload<T> = T extends ImmutablePrimitive
  ? T
  : T extends ImmutableFunction
    ? T
    : T extends ArrayBuffer
      ? ImmutableArrayBufferSnapshot
      : T extends SharedArrayBuffer
        ? ImmutableSharedArrayBufferSnapshot
        : T extends Map<infer K, infer V>
          ? ImmutableMapSnapshot<ImmutablePayload<K>, ImmutablePayload<V>>
          : T extends Set<infer V>
            ? ImmutableSetSnapshot<ImmutablePayload<V>>
            : T extends Array<infer U>
              ? ImmutableArrayLike<U>
              : T extends ReadonlyArray<infer U>
                ? ImmutableArrayLike<U>
                : T extends TypedArray
                  ? ImmutableTypedArraySnapshot<T>
                  : T extends DataView
                    ? DataView
                    : T extends ArrayBufferView
                      ? T
                      : T extends object
                        ? { readonly [K in keyof T]: ImmutablePayload<T[K]> }
                        : T;

export type CommandSnapshot<TPayload = unknown> = ImmutablePayload<
  Command<TPayload>
>;

export type CommandSnapshotPayload<TPayload> = ImmutablePayload<TPayload>;

/**
 * Priority tiers are ordered lowest numeric value first to match the design's
 * deterministic execution order:
 * SYSTEM → PLAYER → AUTOMATION (see docs/runtime-command-queue-design.md §4.1).
 */
export enum CommandPriority {
  SYSTEM = 0,
  PLAYER = 1,
  AUTOMATION = 2,
}

/**
 * Local representation of a command snapshot stored in the queue.
 *
 * Sequence numbers provide a deterministic tie breaker when timestamps match.
 */
export interface CommandQueueEntry<TCommand = Command> {
  readonly command: TCommand;
  readonly sequence: number;
}
