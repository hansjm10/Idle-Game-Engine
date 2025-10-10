import { describe, expect, it } from 'vitest';

import type { Command, CommandSnapshotPayload } from './command.js';
import { CommandPriority } from './command.js';
import { CommandQueue } from './command-queue.js';

const baseCommand: Command = {
  type: 'BASE',
  priority: CommandPriority.PLAYER,
  payload: {},
  timestamp: 0,
  step: 0,
};

function createCommand(
  overrides: Partial<Command> & Pick<Command, 'type'>,
): Command {
  return {
    ...baseCommand,
    ...overrides,
    payload: overrides.payload ?? {},
    timestamp: overrides.timestamp ?? baseCommand.timestamp,
    step: overrides.step ?? baseCommand.step,
    priority: overrides.priority ?? baseCommand.priority,
  };
}

describe('CommandQueue', () => {
  it('dequeues commands in priority order', () => {
    const queue = new CommandQueue();

    queue.enqueue(
      createCommand({
        type: 'automation',
        priority: CommandPriority.AUTOMATION,
        timestamp: 3,
      }),
    );
    queue.enqueue(
      createCommand({
        type: 'player',
        priority: CommandPriority.PLAYER,
        timestamp: 2,
      }),
    );
    queue.enqueue(
      createCommand({
        type: 'system',
        priority: CommandPriority.SYSTEM,
        timestamp: 1,
      }),
    );

    const drained = queue.dequeueAll();
    expect(drained.map((cmd) => cmd.type)).toEqual([
      'system',
      'player',
      'automation',
    ]);
    expect(queue.size).toBe(0);
  });

  it('preserves FIFO ordering within a priority lane', () => {
    const queue = new CommandQueue();

    queue.enqueue(
      createCommand({
        type: 'player-1',
        priority: CommandPriority.PLAYER,
        timestamp: 10,
      }),
    );
    queue.enqueue(
      createCommand({
        type: 'player-2',
        priority: CommandPriority.PLAYER,
        timestamp: 20,
      }),
    );
    queue.enqueue(
      createCommand({
        type: 'player-3',
        priority: CommandPriority.PLAYER,
        timestamp: 20,
      }),
    );

    const drained = queue.dequeueAll();
    expect(drained.map((cmd) => cmd.type)).toEqual([
      'player-1',
      'player-2',
      'player-3',
    ]);
  });

  it('clones enqueued commands to prevent caller mutation', () => {
    const queue = new CommandQueue();

    const command = createCommand({
      type: 'player',
      priority: CommandPriority.PLAYER,
      payload: { value: 1 },
      timestamp: 0,
    });

    queue.enqueue(command);

    // Mutate the original command after enqueue; queue snapshot must remain stable.
    (command.payload as { value: number }).value = 42;

    const [drained] = queue.dequeueAll();
    expect((drained.payload as { value: number }).value).toBe(1);

    // Frozen snapshot should throw when mutated in tests (non-production environment).
    expect(() => {
      (drained.payload as { value: number }).value = 99;
    }).toThrow(TypeError);
  });

  it('tracks size across enqueue, dequeueAll, and clear', () => {
    const queue = new CommandQueue();

    expect(queue.size).toBe(0);

    queue.enqueue(createCommand({ type: 'a' }));
    queue.enqueue(createCommand({ type: 'b' }));
    expect(queue.size).toBe(2);

    queue.dequeueAll();
    expect(queue.size).toBe(0);

    queue.enqueue(createCommand({ type: 'c' }));
    expect(queue.size).toBe(1);

    queue.clear();
    expect(queue.size).toBe(0);
    expect(queue.dequeueAll()).toEqual([]);
  });

  it('prevents mutation of complex payload structures', () => {
    const queue = new CommandQueue();

    const payload = {
      map: new Map<string, unknown>([
        [
          'items',
          {
            set: new Set<number>([1, 2]),
          },
        ],
      ]),
      date: new Date('2025-01-01T00:00:00.000Z'),
      typed: new Uint8Array([5, 6, 7]),
    };

    queue.enqueue(
      createCommand({
        type: 'complex',
        payload,
      }),
    );

    const [snapshot] = queue.dequeueAll();
    const snapshotPayload = snapshot.payload as CommandSnapshotPayload<
      typeof payload
    >;

    expect(() => snapshotPayload.map.set('other', 1)).toThrow(TypeError);

    const snapshotSet = (snapshotPayload.map.get('items') as { set: Set<number> }).set;
    expect(() => snapshotSet.add(3)).toThrow(TypeError);

    expect(() => snapshotPayload.date.setFullYear(2030)).toThrow(TypeError);

    const typedView = snapshotPayload.typed;
    expect(() => {
      typedView[0] = 42;
    }).toThrow(TypeError);
    expect(() => typedView.set([9], 1)).toThrow(TypeError);

    const subView = typedView.subarray(0, 2);
    expect(() => {
      subView[0] = 99;
    }).toThrow(TypeError);

    expect(Array.from(typedView)).toEqual([5, 6, 7]);
  });

  it('prevents mutation via callback-provided containers', () => {
    const queue = new CommandQueue();

    const payload = {
      map: new Map<string, { set: Set<number> }>([
        ['items', { set: new Set<number>([1, 2]) }],
      ]),
      typed: new Uint8Array([3, 4, 5]),
    };

    queue.enqueue(
      createCommand({
        type: 'callback-leak',
        payload,
      }),
    );

    const [snapshot] = queue.dequeueAll();
    const snapshotPayload = snapshot.payload as CommandSnapshotPayload<
      typeof payload
    >;

    let observedMap: unknown;
    snapshotPayload.map.forEach((_value, _key, mapRef) => {
      observedMap = mapRef;
    });
    expect(observedMap).toBe(snapshotPayload.map);

    expect(() =>
      snapshotPayload.map.forEach((_value, _key, mapRef) => {
        (mapRef as unknown as Map<string, unknown>).set('escape', 1);
      }),
    ).toThrow(TypeError);

    const nestedSet = snapshotPayload.map.get('items')?.set;
    expect(nestedSet).toBeDefined();
    const setProxy = nestedSet!;

    let observedSet: unknown;
    setProxy.forEach((_value, _dup, setRef) => {
      observedSet = setRef;
    });
    expect(observedSet).toBe(setProxy);

    expect(() =>
      setProxy.forEach((_value, _dup, setRef) => {
        (setRef as unknown as Set<number>).add(3);
      }),
    ).toThrow(TypeError);

    let observedTypedArray: unknown;
    const typedProxy = snapshotPayload.typed;
    typedProxy.forEach((_value, _index, arrayRef) => {
      observedTypedArray = arrayRef;
    });
    expect(observedTypedArray).toBe(typedProxy);

    expect(() =>
      typedProxy.forEach((_value, index, arrayRef) => {
        (arrayRef as unknown as Uint8Array)[index] = 42;
      }),
    ).toThrow(TypeError);

    let reduceArrayRef: unknown;
    const reduceResult = typedProxy.reduce(
      (acc, value, _index, arrayRef) => {
        reduceArrayRef = arrayRef;
        return acc + value;
      },
      0,
    );
    expect(reduceArrayRef).toBe(typedProxy);
    expect(reduceResult).toBe(12);

    let mapArrayRef: unknown;
    const mapped = typedProxy.map((value, _index, arrayRef) => {
      mapArrayRef = arrayRef;
      return value * 2;
    });
    expect(mapArrayRef).toBe(typedProxy);
    expect(Array.from(mapped)).toEqual([6, 8, 10]);

    expect(() =>
      typedProxy.map((_value, index, arrayRef) => {
        (arrayRef as unknown as Uint8Array)[index] = 7;
        return _value;
      }),
    ).toThrow(TypeError);

    expect(Array.from(typedProxy)).toEqual([3, 4, 5]);
  });

  it('prevents escape via valueOf helpers', () => {
    const queue = new CommandQueue();

    const payload = {
      map: new Map<string, { set: Set<number> }>([
        ['items', { set: new Set<number>([1, 2]) }],
      ]),
      typed: new Uint8Array([5, 6, 7]),
    };

    queue.enqueue(
      createCommand({
        type: 'valueof-escape',
        payload,
      }),
    );

    const [snapshot] = queue.dequeueAll();
    const snapshotPayload = snapshot.payload as CommandSnapshotPayload<
      typeof payload
    >;

    const mapProxy = snapshotPayload.map;
    const leakedMap = mapProxy.valueOf();
    expect(leakedMap).toBe(mapProxy);
    expect(() => leakedMap.set('escape', 1)).toThrow(TypeError);

    const nestedSet = snapshotPayload.map.get('items')?.set;
    expect(nestedSet).toBeDefined();
    const leakedSet = nestedSet!.valueOf();
    expect(leakedSet).toBe(nestedSet);
    expect(() => leakedSet.add(3)).toThrow(TypeError);

    const typedProxy = snapshotPayload.typed;
    const leakedTyped = typedProxy.valueOf();
    expect(leakedTyped).toBe(typedProxy);
    expect(() => {
      leakedTyped[0] = 42;
    }).toThrow(TypeError);
  });

  it('preserves callable behavior for non-plain objects', () => {
    const queue = new CommandQueue();

    const buffer = new ArrayBuffer(8);
    new Uint8Array(buffer).set([1, 2, 3, 4, 5, 6, 7, 8]);

    const payload = {
      buffer,
      shared:
        typeof SharedArrayBuffer === 'function'
          ? new SharedArrayBuffer(16)
          : undefined,
      regex: /queue-(\d+)/g,
    };

    queue.enqueue(
      createCommand({
        type: 'non-plain',
        payload,
      }),
    );

    const [snapshot] = queue.dequeueAll();
    const snapshotPayload = snapshot.payload as CommandSnapshotPayload<
      typeof payload
    >;

    const immutableBuffer = snapshotPayload.buffer;
    expect(Object.prototype.toString.call(immutableBuffer)).toBe(
      '[object ImmutableArrayBufferSnapshot]',
    );
    expect(immutableBuffer.byteLength).toBe(8);
    expect(Array.from(immutableBuffer.toUint8Array())).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);

    if (snapshotPayload.shared) {
      expect(
        Object.prototype.toString.call(snapshotPayload.shared),
      ).toBe('[object ImmutableSharedArrayBufferSnapshot]');
      expect(snapshotPayload.shared.byteLength).toBe(16);
    }

    const result = snapshotPayload.regex.exec('queue-42');
    expect(result?.[1]).toBe('42');
  });

  it('prevents mutation of ArrayBuffer payload snapshots', () => {
    const queue = new CommandQueue();

    const buffer = new ArrayBuffer(4);
    new Uint8Array(buffer).set([7, 8, 9, 10]);

    queue.enqueue(
      createCommand({
        type: 'array-buffer',
        payload: { buffer },
      }),
    );

    const [snapshot] = queue.dequeueAll();
    const immutableBuffer = (snapshot.payload as CommandSnapshotPayload<{
      buffer: ArrayBuffer;
    }>).buffer;

    expect(immutableBuffer.byteLength).toBe(4);
    expect(Array.from(immutableBuffer.toUint8Array())).toEqual([7, 8, 9, 10]);

    const firstLeak = immutableBuffer.toArrayBuffer();
    new Uint8Array(firstLeak)[0] = 42;
    expect(Array.from(immutableBuffer.toUint8Array())).toEqual([7, 8, 9, 10]);

    const secondLeak = immutableBuffer.valueOf();
    new Uint8Array(secondLeak)[1] = 99;
    expect(Array.from(immutableBuffer.toUint8Array())).toEqual([7, 8, 9, 10]);

    const slice = immutableBuffer.slice(1, 3);
    expect(Array.from(slice.toUint8Array())).toEqual([8, 9]);

    const nanSlice = immutableBuffer.slice(NaN, NaN);
    expect(nanSlice.byteLength).toBe(0);
  });

  it('prevents mutation of SharedArrayBuffer payload snapshots', () => {
    if (typeof SharedArrayBuffer !== 'function') {
      return;
    }

    const queue = new CommandQueue();

    const buffer = new SharedArrayBuffer(6);
    new Uint8Array(buffer).set([11, 12, 13, 14, 15, 16]);

    queue.enqueue(
      createCommand({
        type: 'shared-array-buffer',
        payload: { buffer },
      }),
    );

    const [snapshot] = queue.dequeueAll();
    const immutableBuffer = (snapshot.payload as CommandSnapshotPayload<{
      buffer: SharedArrayBuffer;
    }>).buffer;

    expect(immutableBuffer.byteLength).toBe(6);
    expect(Array.from(immutableBuffer.toUint8Array())).toEqual([
      11, 12, 13, 14, 15, 16,
    ]);

    const leakedArrayBuffer = immutableBuffer.toArrayBuffer();
    new Uint8Array(leakedArrayBuffer)[0] = 0;
    expect(Array.from(immutableBuffer.toUint8Array())).toEqual([
      11, 12, 13, 14, 15, 16,
    ]);

    const leakedShared = immutableBuffer.toSharedArrayBuffer();
    new Uint8Array(leakedShared)[1] = 55;
    expect(Array.from(immutableBuffer.toUint8Array())).toEqual([
      11, 12, 13, 14, 15, 16,
    ]);

    const slice = immutableBuffer.slice(-3);
    expect(Array.from(slice.toUint8Array())).toEqual([14, 15, 16]);

    const nanSlice = immutableBuffer.slice(NaN);
    expect(Array.from(nanSlice.toUint8Array())).toEqual([
      11, 12, 13, 14, 15, 16,
    ]);
  });
});
