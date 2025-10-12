import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type { Command, CommandSnapshotPayload } from './command.js';
import { CommandPriority, COMMAND_AUTHORIZATIONS } from './command.js';
import { CommandQueue } from './command-queue.js';
import {
  resetTelemetry,
  setTelemetry,
  type TelemetryFacade,
} from './telemetry.js';

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
  afterEach(() => {
    resetTelemetry();
    vi.restoreAllMocks();
  });

  it('dequeues commands in priority order', () => {
    const queue = new CommandQueue();

    queue.enqueue(
      createCommand({
        type: 'automation',
        priority: CommandPriority.AUTOMATION,
        timestamp: 1,
      }),
    );
    queue.enqueue(
      createCommand({
        type: 'player',
        priority: CommandPriority.PLAYER,
        timestamp: 1,
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

  it('maintains priority ordering across high-volume enqueues', () => {
    const queue = new CommandQueue();
    const priorities = [
      CommandPriority.SYSTEM,
      CommandPriority.PLAYER,
      CommandPriority.AUTOMATION,
    ] as const;

    const expectedTypes: Record<CommandPriority, string[]> = {
      [CommandPriority.SYSTEM]: [],
      [CommandPriority.PLAYER]: [],
      [CommandPriority.AUTOMATION]: [],
    };
    const labelFor = (priority: CommandPriority) => {
      switch (priority) {
        case CommandPriority.SYSTEM:
          return 'system';
        case CommandPriority.PLAYER:
          return 'player';
        case CommandPriority.AUTOMATION:
          return 'automation';
        default:
          return 'unknown';
      }
    };

    const perPriority = 600;
    for (let index = 0; index < perPriority; index += 1) {
      for (const priority of priorities) {
        const label = labelFor(priority);
        const type = `${label}-${index}`;
        queue.enqueue(
          createCommand({
            type,
            priority,
            // Interleave timestamps and steps to mirror real runtime conditions.
            timestamp: Math.floor(index / 10),
            step: index % 5,
          }),
        );

        expectedTypes[priority].push(type);
      }
    }

    const drained = queue.dequeueAll();
    expect(drained).toHaveLength(perPriority * priorities.length);
    expect(queue.size).toBe(0);

    const drainedPriorities = drained.map((command) => command.priority);
    expect(drainedPriorities).toEqual([
      ...new Array(perPriority).fill(CommandPriority.SYSTEM),
      ...new Array(perPriority).fill(CommandPriority.PLAYER),
      ...new Array(perPriority).fill(CommandPriority.AUTOMATION),
    ]);

    for (const priority of priorities) {
      const drainedForPriority = drained.filter(
        (command) => command.priority === priority,
      );

      const drainedTypes = drainedForPriority.map(
        (command) => command.type,
      );
      expect(drainedTypes).toEqual(expectedTypes[priority]);

      for (let i = 1; i < drainedForPriority.length; i += 1) {
        const previous = drainedForPriority[i - 1]!;
        const current = drainedForPriority[i]!;
        expect(previous.timestamp).toBeLessThanOrEqual(current.timestamp);
      }
    }
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

  it('drops lowest-priority commands when capacity is exceeded', () => {
    const telemetryStub: TelemetryFacade = {
      recordError: vi.fn(),
      recordWarning: vi.fn(),
      recordProgress: vi.fn(),
      recordTick: vi.fn(),
    };
    setTelemetry(telemetryStub);

    const queue = new CommandQueue({ maxSize: 2 });

    queue.enqueue(
      createCommand({
        type: 'system-1',
        priority: CommandPriority.SYSTEM,
        timestamp: 1,
      }),
    );
    queue.enqueue(
      createCommand({
        type: 'automation-1',
        priority: CommandPriority.AUTOMATION,
        timestamp: 2,
      }),
    );

    queue.enqueue(
      createCommand({
        type: 'player-1',
        priority: CommandPriority.PLAYER,
        timestamp: 3,
      }),
    );

    expect(queue.size).toBe(2);
    expect(queue.dequeueAll().map((cmd) => cmd.type)).toEqual([
      'system-1',
      'player-1',
    ]);

    expect(telemetryStub.recordWarning).toHaveBeenCalledTimes(2);
    expect(telemetryStub.recordWarning).toHaveBeenNthCalledWith(
      1,
      'CommandQueueOverflow',
      expect.objectContaining({
        size: 2,
        maxSize: 2,
        priority: CommandPriority.PLAYER,
      }),
    );
    expect(telemetryStub.recordWarning).toHaveBeenNthCalledWith(
      2,
      'CommandDropped',
      {
        type: 'automation-1',
        priority: CommandPriority.AUTOMATION,
        timestamp: 2,
      },
    );
  });

  it('rejects lower-priority commands when the queue is full of higher-priority entries', () => {
    const telemetryStub: TelemetryFacade = {
      recordError: vi.fn(),
      recordWarning: vi.fn(),
      recordProgress: vi.fn(),
      recordTick: vi.fn(),
    };
    setTelemetry(telemetryStub);

    const queue = new CommandQueue({ maxSize: 2 });

    queue.enqueue(
      createCommand({
        type: 'system-1',
        priority: CommandPriority.SYSTEM,
        timestamp: 1,
      }),
    );
    queue.enqueue(
      createCommand({
        type: 'player-1',
        priority: CommandPriority.PLAYER,
        timestamp: 2,
      }),
    );

    queue.enqueue(
      createCommand({
        type: 'automation-1',
        priority: CommandPriority.AUTOMATION,
        timestamp: 3,
      }),
    );

    expect(queue.size).toBe(2);
    expect(queue.dequeueAll().map((cmd) => cmd.type)).toEqual([
      'system-1',
      'player-1',
    ]);

    expect(telemetryStub.recordWarning).toHaveBeenCalledTimes(2);
    expect(telemetryStub.recordWarning).toHaveBeenNthCalledWith(
      1,
      'CommandQueueOverflow',
      expect.objectContaining({
        size: 2,
        maxSize: 2,
        priority: CommandPriority.AUTOMATION,
      }),
    );
    expect(telemetryStub.recordWarning).toHaveBeenNthCalledWith(
      2,
      'CommandRejected',
      {
        type: 'automation-1',
        priority: CommandPriority.AUTOMATION,
        timestamp: 3,
        size: 2,
        maxSize: 2,
      },
    );
  });

  it('exhausts higher-priority lanes last when dropping on overflow', () => {
    const telemetryStub: TelemetryFacade = {
      recordError: vi.fn(),
      recordWarning: vi.fn(),
      recordProgress: vi.fn(),
      recordTick: vi.fn(),
    };
    setTelemetry(telemetryStub);

    const queue = new CommandQueue({ maxSize: 2 });

    queue.enqueue(
      createCommand({
        type: 'system-1',
        priority: CommandPriority.SYSTEM,
        timestamp: 1,
      }),
    );
    queue.enqueue(
      createCommand({
        type: 'player-1',
        priority: CommandPriority.PLAYER,
        timestamp: 2,
      }),
    );

    queue.enqueue(
      createCommand({
        type: 'system-2',
        priority: CommandPriority.SYSTEM,
        timestamp: 3,
      }),
    );

    expect(queue.size).toBe(2);
    expect(queue.dequeueAll().map((cmd) => cmd.type)).toEqual([
      'system-1',
      'system-2',
    ]);

    expect(telemetryStub.recordWarning).toHaveBeenCalledTimes(2);
    expect(telemetryStub.recordWarning).toHaveBeenNthCalledWith(
      2,
      'CommandDropped',
      {
        type: 'player-1',
        priority: CommandPriority.PLAYER,
        timestamp: 2,
      },
    );
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

  it('returns immutable snapshots from typed array map and filter helpers', () => {
    const queue = new CommandQueue();

    queue.enqueue(
      createCommand({
        type: 'typed-map-filter',
        payload: {
          typed: new Uint8Array([1, 2, 3, 4]),
        },
      }),
    );

    const [snapshot] = queue.dequeueAll();
    const typedProxy = (
      snapshot.payload as CommandSnapshotPayload<{ typed: Uint8Array }>
    ).typed;

    const mapped = typedProxy.map((value, index, arrayRef) => {
      expect(arrayRef).toBe(typedProxy);
      return value * 2;
    });
    expect(mapped).not.toBe(typedProxy);
    expect(Array.from(mapped)).toEqual([2, 4, 6, 8]);
    expect(() => mapped.set([99], 0)).toThrow(TypeError);

    const filtered = typedProxy.filter((value, index, arrayRef) => {
      expect(arrayRef).toBe(typedProxy);
      return index % 2 === 0;
    });
    expect(Array.from(filtered)).toEqual([1, 3]);
    expect(() => {
      filtered[0] = 42;
    }).toThrow(TypeError);
  });

  it('exposes typed array buffer facades that require explicit copying', () => {
    const queue = new CommandQueue();

    queue.enqueue(
      createCommand({
        type: 'typed-buffer',
        payload: {
          typed: new Uint16Array([10, 20, 30, 40]),
        },
      }),
    );

    const [snapshot] = queue.dequeueAll();
    const typedProxy = (
      snapshot.payload as CommandSnapshotPayload<{ typed: Uint16Array }>
    ).typed;

    const bufferFacade = typedProxy.buffer;
    expect(Object.prototype.toString.call(bufferFacade)).toBe(
      '[object ImmutableArrayBufferSnapshot]',
    );
    expect(Array.from(typedProxy)).toEqual([10, 20, 30, 40]);
    expect(Array.from(bufferFacade.toUint8Array())).toEqual([
      10, 0, 20, 0, 30, 0, 40, 0,
    ]);

    const mutableCopy = bufferFacade.toArrayBuffer();
    new Uint8Array(mutableCopy)[0] = 123;
    expect(Array.from(typedProxy)).toEqual([10, 20, 30, 40]);

    // Mutators are removed from the TypeScript surface; attempting to access them should be a type error.
    // @ts-expect-error Mutating helpers are absent on immutable snapshots
    void typedProxy.set;
    // @ts-expect-error Buffer facades are not directly ArrayBuffer instances
    const directBuffer: ArrayBuffer = typedProxy.buffer;
    void directBuffer;

    if (typeof SharedArrayBuffer === 'function') {
      const shared = new SharedArrayBuffer(8);
      new Uint16Array(shared).set([1, 2, 3, 4]);

      queue.enqueue(
        createCommand({
          type: 'shared-typed-buffer',
          payload: {
            typed: new Uint16Array(shared),
          },
        }),
      );

      const [sharedSnapshot] = queue.dequeueAll();
      const sharedProxy = (
        sharedSnapshot.payload as CommandSnapshotPayload<{ typed: Uint16Array }>
      ).typed;

      const sharedBufferFacade = sharedProxy.buffer;
      expect(Object.prototype.toString.call(sharedBufferFacade)).toBe(
        '[object ImmutableSharedArrayBufferSnapshot]',
      );
      const sharedCopy = sharedBufferFacade.toSharedArrayBuffer();
      new Uint8Array(sharedCopy)[0] = 255;
      expect(Array.from(sharedProxy)).toEqual([1, 2, 3, 4]);
    }
  });

  it('throws when enqueuing a command with an unknown priority', () => {
    const queue = new CommandQueue();

    expect(() =>
      queue.enqueue({
        ...baseCommand,
        priority: 99 as CommandPriority,
      }),
    ).toThrow('Invalid command priority: 99');
  });

  it('handles dequeueUpToStep boundary conditions', () => {
    const queue = new CommandQueue();

    queue.enqueue(
      createCommand({
        type: 'negative',
        step: -1,
        timestamp: 1,
      }),
    );
    queue.enqueue(
      createCommand({
        type: 'zero',
        step: 0,
        timestamp: 2,
      }),
    );
    queue.enqueue(
      createCommand({
        type: 'future',
        step: 2,
        timestamp: 3,
      }),
    );

    const negative = queue.dequeueUpToStep(-1);
    expect(negative.map((command) => command.step)).toEqual([-1]);
    expect(queue.size).toBe(2);

    const zero = queue.dequeueUpToStep(0);
    expect(zero.map((command) => command.step)).toEqual([0]);
    expect(queue.size).toBe(1);

    const allRemaining = queue.dequeueUpToStep(Number.MAX_SAFE_INTEGER);
    expect(allRemaining.map((command) => command.step)).toEqual([2]);
    expect(queue.size).toBe(0);

    expect(queue.dequeueUpToStep(10)).toEqual([]);
  });

  it('rejects automation attempts to trigger prestige reset', () => {
    const warnings: Array<{ event: string; data?: unknown }> = [];

    const telemetryStub: TelemetryFacade = {
      recordError: vi.fn(),
      recordWarning(event, data) {
        warnings.push({ event, data });
      },
      recordProgress: vi.fn(),
      recordTick: vi.fn(),
    };
    setTelemetry(telemetryStub);

    const queue = new CommandQueue();

    queue.enqueue(
      createCommand({
        type: 'PRESTIGE_RESET',
        priority: CommandPriority.AUTOMATION,
        timestamp: 100,
        step: 0,
      }),
    );

    expect(queue.size).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.event).toBe('AutomationPrestigeBlocked');
    expect(warnings[0]?.data).toEqual(
      expect.objectContaining({
        type: 'PRESTIGE_RESET',
        attemptedPriority: CommandPriority.AUTOMATION,
        allowedPriorities: COMMAND_AUTHORIZATIONS.PRESTIGE_RESET.allowedPriorities,
        phase: 'live',
        reason: 'queue',
      }),
    );
  });

  it('rejects system-only commands from non-system priorities', () => {
    const warnings: Array<{ event: string; data?: unknown }> = [];

    const telemetryStub: TelemetryFacade = {
      recordError: vi.fn(),
      recordWarning(event, data) {
        warnings.push({ event, data });
      },
      recordProgress: vi.fn(),
      recordTick: vi.fn(),
    };
    setTelemetry(telemetryStub);

    const queue = new CommandQueue();

    queue.enqueue(
      createCommand({
        type: 'OFFLINE_CATCHUP',
        priority: CommandPriority.PLAYER,
        timestamp: 50,
        step: 0,
      }),
    );

    expect(queue.size).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.event).toBe('UnauthorizedSystemCommand');
    expect(warnings[0]?.data).toEqual(
      expect.objectContaining({
        type: 'OFFLINE_CATCHUP',
        attemptedPriority: CommandPriority.PLAYER,
        allowedPriorities: COMMAND_AUTHORIZATIONS.OFFLINE_CATCHUP.allowedPriorities,
        phase: 'live',
        reason: 'queue',
      }),
    );
  });
});
