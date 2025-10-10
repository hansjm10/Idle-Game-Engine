import type { Command, CommandQueueEntry } from './command.js';
import { CommandPriority } from './command.js';

const PRIORITY_ORDER: readonly CommandPriority[] = [
  CommandPriority.SYSTEM,
  CommandPriority.PLAYER,
  CommandPriority.AUTOMATION,
];

/**
 * Queue implementation that maintains per-priority FIFO lanes as documented in
 * docs/runtime-command-queue-design.md §4.2.
 *
 * Commands are cloned on enqueue to preserve determinism and to prevent
 * call-sites from mutating queued payloads.
 */
export class CommandQueue {
  private readonly lanes: Map<CommandPriority, CommandQueueEntry[]> = new Map([
    [CommandPriority.SYSTEM, []],
    [CommandPriority.PLAYER, []],
    [CommandPriority.AUTOMATION, []],
  ]);

  private nextSequence = 0;
  private totalSize = 0;

  enqueue(command: Command): void {
    const queue = this.lanes.get(command.priority);
    if (!queue) {
      throw new Error(`Invalid command priority: ${command.priority}`);
    }

    const entry: CommandQueueEntry = {
      command: cloneCommand(command),
      sequence: this.nextSequence++,
    };

    // Deterministic insertion by timestamp, then sequence as a stable tie-breaker.
    let low = 0;
    let high = queue.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const other = queue[mid]!;
      if (
        other.command.timestamp < entry.command.timestamp ||
        (other.command.timestamp === entry.command.timestamp &&
          other.sequence < entry.sequence)
      ) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    queue.splice(low, 0, entry);
    this.totalSize += 1;
  }

  dequeueAll(): Command[] {
    if (this.totalSize === 0) {
      return [];
    }

    const drained: Command[] = [];
    for (const priority of PRIORITY_ORDER) {
      const queue = this.lanes.get(priority);
      if (!queue || queue.length === 0) {
        continue;
      }

      for (const entry of queue) {
        drained.push(entry.command);
      }
      this.totalSize -= queue.length;
      queue.length = 0; // Clear lane deterministically.
    }
    return drained;
  }

  clear(): void {
    if (this.totalSize === 0) {
      return;
    }
    for (const queue of this.lanes.values()) {
      this.totalSize -= queue.length;
      queue.length = 0;
    }
    this.totalSize = 0;
  }

  get size(): number {
    return this.totalSize;
  }
}

/**
 * Freeze plain objects/arrays in-place while handling cycles, Maps, and Sets.
 * Typed arrays are left mutable in accordance with docs/runtime-command-queue-design.md §3.1.
 */
export function deepFreezeInPlace<T>(value: T): T {
  const seen = new WeakSet<object>();

  const freeze = (node: unknown): void => {
    if (!node || typeof node !== 'object') {
      return;
    }

    const objectNode = node as Record<PropertyKey, unknown>;
    if (seen.has(objectNode)) {
      return;
    }
    seen.add(objectNode);

    if (ArrayBuffer.isView(objectNode)) {
      // TypedArrays cannot be frozen; rely on cloning for isolation (see design doc §3.1).
      return;
    }

    Object.freeze(objectNode);

    if (objectNode instanceof Map) {
      for (const [key, mapValue] of objectNode.entries()) {
        freeze(key);
        freeze(mapValue);
      }
      return;
    }

    if (objectNode instanceof Set) {
      for (const item of objectNode.values()) {
        freeze(item);
      }
      return;
    }

    for (const name of Object.getOwnPropertyNames(objectNode)) {
      freeze(objectNode[name]);
    }
    for (const symbol of Object.getOwnPropertySymbols(objectNode)) {
      freeze(objectNode[symbol]);
    }
  };

  freeze(value);
  return value;
}

function cloneCommand(command: Command): Command {
  const snapshot = cloneStructured(command);
  const isProduction =
    (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env
      ?.NODE_ENV === 'production';

  if (!isProduction) {
    deepFreezeInPlace(snapshot);
  }

  return snapshot;
}

function cloneStructured<T>(value: T): T {
  const structuredCloneGlobal = (globalThis as {
    structuredClone?: <U>(input: U) => U;
  }).structuredClone;

  if (typeof structuredCloneGlobal !== 'function') {
    throw new Error(
      'structuredClone is required for deterministic command queue snapshots.',
    );
  }

  return structuredCloneGlobal(value);
}
