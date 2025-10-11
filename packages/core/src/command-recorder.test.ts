import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type { Command } from './command.js';
import { CommandPriority } from './command.js';
import { CommandDispatcher } from './command-dispatcher.js';
import { CommandQueue } from './command-queue.js';
import {
  CommandRecorder,
  restoreState,
  type CommandLog,
} from './command-recorder.js';
import {
  clearGameState,
  setGameState,
} from './runtime-state.js';
import {
  getCurrentRNGSeed,
  resetRNG,
  setRNGSeed,
} from './rng.js';
import {
  resetTelemetry,
  setTelemetry,
  type TelemetryFacade,
} from './telemetry.js';

function createCommand(
  overrides: Partial<Command> = {},
): Command {
  return {
    type: overrides.type ?? 'TEST',
    priority: overrides.priority ?? CommandPriority.PLAYER,
    payload: overrides.payload ?? { amount: 1 },
    timestamp: overrides.timestamp ?? 1,
    step: overrides.step ?? 0,
  };
}

describe('CommandRecorder', () => {
  beforeEach(() => {
    resetTelemetry();
    resetRNG();
  });

  afterEach(() => {
    clearGameState();
  });

  it('records commands with immutable snapshots', () => {
    const state = setGameState({
      resources: { energy: 0 },
    });
    const recorder = new CommandRecorder(state);

    const command = createCommand({
      payload: { amount: 5 },
    });
    recorder.record(command);

    // Mutate the original command after recording; snapshot should remain frozen.
    (command.payload as { amount: number }).amount = 10;

    const log = recorder.export();
    expect(log.version).toBe('0.1.0');
    expect(log.commands).toHaveLength(1);
    expect(log.metadata.lastStep).toBe(command.step);
   expect(log.metadata.seed).toBeUndefined();
   expect(log.commands[0]).not.toBe(command);
   expect(log.commands[0].payload).toEqual({ amount: 5 });
    expect(() => {
      (log.commands[0].payload as unknown as { amount: number }).amount = 10;
    }).toThrow(TypeError);
    expect((log.commands[0].payload as { amount: number }).amount).toBe(5);

    const secondExport = recorder.export();
    expect(secondExport).not.toBe(log);
    expect(secondExport.commands[0]).not.toBe(log.commands[0]);
  });

  it('guards against mutating map snapshots within exported logs', () => {
    const state = setGameState({
      resources: new Map<string, number>([['energy', 0]]),
    });
    const recorder = new CommandRecorder(state);

    recorder.record(
      createCommand({
        payload: {
          map: new Map<string, number>([['alpha', 1]]),
        },
      }),
    );

    const log = recorder.export();

    const payloadMap = log.commands[0].payload.map as unknown as Map<
      string,
      number
    >;
    expect(() => payloadMap.set('beta', 2)).toThrow(TypeError);

    const stateMap = log.startState.resources as unknown as Map<string, number>;
    expect(() => stateMap.set('energy', 1)).toThrow(TypeError);
  });

  it('clears recorded commands and refreshes snapshot/seed', () => {
    const state = setGameState({
      resources: { energy: 0 },
    });
    const recorder = new CommandRecorder(state);

    recorder.record(createCommand());
    setRNGSeed(123);

    const nextState = { resources: { energy: 42 } };
    recorder.clear(nextState);

    const log = recorder.export();
    expect(log.commands).toHaveLength(0);
    expect(log.startState).toEqual(nextState);
    expect(log.metadata.lastStep).toBe(-1);
    expect(log.metadata.seed).toBe(123);
  });

  it('restores state snapshot and replays commands deterministically', () => {
    const resources = new Map<string, { amount: number }>([
      ['energy', { amount: 0 }],
    ]);
    const state = setGameState({
      resources,
      totals: { produced: 0 },
    });
    const recorder = new CommandRecorder(state);
    const dispatcher = new CommandDispatcher();

    dispatcher.register<{ resourceId: string; amount: number }>(
      'ADD_RESOURCE',
      (payload) => {
        const entry = resources.get(payload.resourceId);
        if (entry) {
          entry.amount += payload.amount;
        }
        state.totals.produced += payload.amount;
      },
    );

    const command = createCommand({
      type: 'ADD_RESOURCE',
      payload: { resourceId: 'energy', amount: 5 },
      step: 4,
      timestamp: 10,
    });

    recorder.record(command);
    dispatcher.execute(command);

    const log = recorder.export();

    // Diverge the state so replay must restore from snapshot.
    resources.get('energy')!.amount = 100;
    state.totals.produced = 10;

    recorder.replay(log, dispatcher);

    expect(resources.get('energy')!.amount).toBe(5);
    expect(state.totals.produced).toBe(5);
  });

  it('preserves map/set references when restoring snapshots', () => {
    const entities = new Map<string, { tags: Set<string> }>([
      ['alpha', { tags: new Set(['a']) }],
    ]);
    const state = setGameState({
      entities,
      list: ['alpha'],
    });

    const recorder = new CommandRecorder(state);
    const snapshot = recorder.export().startState;

    entities.get('alpha')!.tags.add('b');
    entities.set('beta', { tags: new Set(['c']) });
    state.list.push('beta');

    const restored = restoreState(state, snapshot);
    expect(restored.entities).toBe(entities);
    expect(restored.list).toBe(state.list);
    expect(entities.has('beta')).toBe(false);
    expect(Array.from(entities.get('alpha')!.tags)).toEqual(['a']);
    expect(state.list).toEqual(['alpha']);
  });

  it('validates sandboxed enqueues against recorded commands', () => {
    const state = setGameState({ counter: 0 });
    const recorder = new CommandRecorder(state);
    const dispatcher = new CommandDispatcher();
    const queue = new CommandQueue();

    dispatcher.register<{ enqueue?: Command }>('BUMP', (payload) => {
      state.counter += 1;
      if (payload.enqueue) {
        queue.enqueue(payload.enqueue);
      }
    });

    const followup = createCommand({
      type: 'BUMP',
      payload: {},
      step: 2,
      timestamp: 3,
    });
    const initial = createCommand({
      type: 'BUMP',
      payload: { enqueue: followup },
      step: 1,
      timestamp: 2,
    });

    recorder.record(initial);
    dispatcher.execute(initial);
    recorder.record(followup);
    dispatcher.execute(followup);

    const log = recorder.export();
    queue.clear();

    recorder.replay(log, dispatcher, {
      commandQueue: queue,
      getCurrentStep: () => 2,
      getNextExecutableStep: () => 3,
      setCurrentStep: vi.fn(),
      setNextExecutableStep: vi.fn(),
    });

    expect(state.counter).toBe(2);
  });

  it('throws when sandboxed enqueues are missing from the log', () => {
    const state = setGameState({ counter: 0 });
    const recorder = new CommandRecorder(state);
    const dispatcher = new CommandDispatcher();
    const queue = new CommandQueue();

    dispatcher.register<{ enqueue: Command }>('BUMP', (payload) => {
      queue.enqueue(payload.enqueue);
    });

    const initial = createCommand({
      type: 'BUMP',
      payload: { enqueue: createCommand({ type: 'BUMP', step: 1 }) },
    });

    recorder.record(initial);
    queue.clear();

    const log = recorder.export();
    const truncatedLog: CommandLog = {
      ...log,
      commands: log.commands.slice(0, 1),
    };

    expect(() =>
      recorder.replay(truncatedLog, dispatcher, {
        commandQueue: queue,
      }),
    ).toThrowError(
      /Replay log is missing a command that was enqueued/,
    );
  });

  it('throws when replay queue is not empty', () => {
    const state = setGameState({ counter: 0 });
    const recorder = new CommandRecorder(state);
    const dispatcher = new CommandDispatcher();
    const queue = new CommandQueue();

    recorder.record(createCommand());
    queue.enqueue(createCommand({ step: 1 }));

    const log = recorder.export();

    expect(() =>
      recorder.replay(log, dispatcher, { commandQueue: queue }),
    ).toThrowError(/Command queue must be empty/);
  });

  it('updates runtime step counters using metadata lastStep when replay succeeds', () => {
    const state = setGameState({ value: 0 });
    const recorder = new CommandRecorder(state);
    const dispatcher = new CommandDispatcher();

    dispatcher.register('SET', (payload: { value: number }) => {
      state.value = payload.value;
    });

    recorder.record(
      createCommand({
        type: 'SET',
        payload: { value: 42 },
        step: 5,
      }),
    );

    const log = recorder.export();
    let currentStep = 0;
    let nextStep = 0;

    recorder.replay(log, dispatcher, {
      commandQueue: new CommandQueue(),
      getCurrentStep: () => currentStep,
      getNextExecutableStep: () => nextStep,
      setCurrentStep: (value) => {
        currentStep = value;
      },
      setNextExecutableStep: (value) => {
        nextStep = value;
      },
    });

    expect(currentStep).toBe(log.metadata.lastStep + 1);
    expect(nextStep).toBe(log.metadata.lastStep + 1);
  });

  it('captures and restores deterministic RNG seed', () => {
    const state = setGameState({ value: 0 });
    setRNGSeed(9876);
    const recorder = new CommandRecorder(state);

    recorder.record(createCommand());
    const log = recorder.export();
    expect(log.metadata.seed).toBe(9876);

    setRNGSeed(1234);
    recorder.replay(log, new CommandDispatcher());
    expect(getCurrentRNGSeed()).toBe(9876);
  });

  it('records telemetry when handler throws during replay', () => {
    const state = setGameState({ value: 0 });
    const recorder = new CommandRecorder(state);
    const dispatcher = new CommandDispatcher();

    dispatcher.register('FAIL', () => {
      throw new Error('boom');
    });

    recorder.record(
      createCommand({
        type: 'FAIL',
      }),
    );

    const telemetryStub: TelemetryFacade = {
      recordError: vi.fn(),
      recordWarning: vi.fn(),
      recordProgress: vi.fn(),
      recordTick: vi.fn(),
    };
    setTelemetry(telemetryStub);

    recorder.replay(recorder.export(), dispatcher);

    expect(telemetryStub.recordError).toHaveBeenCalledWith(
      'ReplayExecutionFailed',
      expect.objectContaining({ type: 'FAIL' }),
    );
  });
});
