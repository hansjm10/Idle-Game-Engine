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
  type StateSnapshot,
} from './command-recorder.js';
import type {
  DiagnosticTimelineEntry,
  DiagnosticTimelineResult,
} from './diagnostics/diagnostic-timeline.js';
import { EventBus } from './events/event-bus.js';
import { DEFAULT_EVENT_BUS_OPTIONS } from './events/runtime-event-catalog.js';
import { buildRuntimeEventFrame } from './events/runtime-event-frame.js';
import { TransportBufferPool } from './transport-buffer-pool.js';
import {
  clearGameState,
  getGameState,
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
import {
  createImmutableTypedArrayView,
  isImmutableTypedArraySnapshot,
} from './immutable-snapshots.js';
import type { RuntimeEventManifestHash } from './events/runtime-event.js';

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

function buildToggleFrame(enabled: boolean, tick = 0) {
  const pool = new TransportBufferPool();
  const bus = new EventBus(DEFAULT_EVENT_BUS_OPTIONS);
  bus.beginTick(tick);
  bus.publish('automation:toggled', {
    automationId: 'auto:1',
    enabled,
  });
  bus.dispatch({ tick });

  return buildRuntimeEventFrame(bus, pool, {
    tick,
    manifestHash: bus.getManifestHash(),
    owner: 'test-suite',
  });
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

  it('supports constructing from exported immutable snapshots', () => {
    const state = setGameState({
      resources: new Map<string, number>([['energy', 1]]),
      tags: new Set(['alpha']),
    });
    const recorder = new CommandRecorder(state);

    const log = recorder.export();
    expect(() => new CommandRecorder(log.startState)).not.toThrow();
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

  it('reconciles symbol-keyed properties on plain objects', () => {
    const FLAGS = Symbol.for('flags');
    const EXTRA = Symbol('extra');
    const state = setGameState({
      meta: {
        [FLAGS]: { stealth: true },
      },
    });
    const recorder = new CommandRecorder(state);
    const snapshot = recorder.export().startState;
    const snapshotMeta = snapshot.meta as Record<PropertyKey, unknown>;
    expect(Reflect.has(snapshotMeta, FLAGS)).toBe(true);

    const meta = state.meta as Record<PropertyKey, unknown>;
    const mutatedFlags = { stealth: false };
    Reflect.set(meta, FLAGS, mutatedFlags);
    Reflect.set(meta, EXTRA, 'temporary');

    const restored = restoreState(state, snapshot);
    expect(restored.meta).toBe(state.meta);

    const restoredMeta = restored.meta as Record<PropertyKey, unknown>;
    expect(Reflect.has(restoredMeta, FLAGS)).toBe(true);
    const flags = Reflect.get(restoredMeta, FLAGS) as { stealth: boolean };
    expect(flags.stealth).toBe(true);
    expect(mutatedFlags.stealth).toBe(true);
    expect(Reflect.has(restoredMeta, EXTRA)).toBe(false);
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

  it('preserves typed array aliases when restoring snapshots', () => {
    const buffer = new ArrayBuffer(8);
    const shared = new Uint8Array(buffer);
    shared.set([1, 2, 3, 4]);

    const view = new DataView(buffer);
    const state = setGameState({
      main: shared,
      mirror: shared,
      view,
      viewAlias: view,
    });
    const recorder = new CommandRecorder(state);
    const snapshot = recorder.export().startState;

    shared.fill(9);
    state.mirror = new Uint8Array(new ArrayBuffer(8));
    state.view = new DataView(new ArrayBuffer(8));
    state.viewAlias = state.view;

    const restored = restoreState(state, snapshot);

    expect(restored.main).toBe(restored.mirror);
    expect(Array.from(restored.main)).toEqual([1, 2, 3, 4, 0, 0, 0, 0]);
    expect(restored.view).toBe(restored.viewAlias);
    expect(restored.view.getUint8(0)).toBe(1);

    restored.main[0] = 42;
    expect(restored.mirror[0]).toBe(42);
  });

  it('preserves shared buffers for distinct typed array views when restoring snapshots', () => {
    const buffer = new ArrayBuffer(16);
    const source = new Uint32Array(buffer);
    source.set([1, 2, 3, 4]);

    const snapshot = {
      a: createImmutableTypedArrayView(new Uint32Array(buffer, 0, 2)),
      b: createImmutableTypedArrayView(new Uint32Array(buffer, 8, 2)),
    } as StateSnapshot<{ a: Uint32Array; b: Uint32Array }>;

    expect(isImmutableTypedArraySnapshot(snapshot.a)).toBe(true);
    expect(isImmutableTypedArraySnapshot(snapshot.b)).toBe(true);

    const restored = restoreState(
      {} as { a: Uint32Array; b: Uint32Array },
      snapshot,
    );

    expect(restored.a.buffer).toBe(restored.b.buffer);
    expect(restored.a.byteOffset).toBe(0);
    expect(restored.b.byteOffset).toBe(8);
    expect(Array.from(restored.a)).toEqual([1, 2]);
    expect(Array.from(restored.b)).toEqual([3, 4]);

    restored.b[0] = 99;
    expect(new Uint32Array(restored.a.buffer)[2]).toBe(99);
  });

  it('reconciles typed arrays in place during replay', () => {
    const state = setGameState({
      buf: new Uint8Array([1, 2]),
    });
    const bytes = state.buf;
    const recorder = new CommandRecorder(state);
    const dispatcher = new CommandDispatcher();

    const log = recorder.export();

    bytes[0] = 99;

    recorder.replay(log, dispatcher);

    const liveState = getGameState<typeof state>();
    expect(liveState).toBe(state);
    expect(liveState.buf).toBe(bytes);
    expect(Array.from(bytes)).toEqual([1, 2]);
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

  it('attaches diagnostics deltas from the replay context when provided', () => {
    const recorder = new CommandRecorder(setGameState({ value: 0 }));
    const log = recorder.export();
    const dispatcher = new CommandDispatcher();
    const queue = new CommandQueue();

    const attachments: DiagnosticTimelineResult[] = [];
    const configuration = Object.freeze({
      capacity: 4,
      slowTickBudgetMs: 5,
      enabled: true,
      slowSystemBudgetMs: 2,
      systemHistorySize: 8,
      tickBudgetMs: 5,
    });

    const baseline: DiagnosticTimelineResult = Object.freeze({
      entries: Object.freeze([]),
      head: 12,
      dropped: 0,
      configuration,
    });

    const entry: DiagnosticTimelineEntry = Object.freeze({
      tick: 3,
      startedAt: 0,
      endedAt: 6,
      durationMs: 6,
      budgetMs: 4,
      isSlow: true,
      overBudgetMs: 2,
      error: undefined,
      metadata: undefined,
    });

    const delta: DiagnosticTimelineResult = Object.freeze({
      entries: Object.freeze([entry]),
      head: 13,
      dropped: 0,
      configuration,
    });

    let diagnosticCallCount = 0;
    recorder.replay(log, dispatcher, {
      commandQueue: queue,
      readDiagnosticsDelta: (sinceHead?: number) => {
        if (diagnosticCallCount === 0) {
          diagnosticCallCount += 1;
          expect(sinceHead).toBeUndefined();
          return baseline;
        }

        diagnosticCallCount += 1;
        expect(sinceHead).toBe(baseline.head);
        return delta;
      },
      attachDiagnosticsDelta(result) {
        attachments.push(result);
      },
    });

    expect(diagnosticCallCount).toBe(2);
    expect(attachments).toEqual([delta]);
  });

  it('attaches diagnostics deltas when configuration changes without new entries', () => {
    const recorder = new CommandRecorder(setGameState({ value: 0 }));
    const log = recorder.export();
    const dispatcher = new CommandDispatcher();
    const queue = new CommandQueue();

    const attachments: DiagnosticTimelineResult[] = [];
    const configurationEnabled = Object.freeze({
      capacity: 4,
      slowTickBudgetMs: 5,
      enabled: true,
      slowSystemBudgetMs: 2,
      systemHistorySize: 8,
      tickBudgetMs: 5,
    });
    const configurationDisabled = Object.freeze({
      capacity: 4,
      slowTickBudgetMs: 5,
      enabled: false,
      slowSystemBudgetMs: 2,
      systemHistorySize: 8,
      tickBudgetMs: 5,
    });

    const baseline: DiagnosticTimelineResult = Object.freeze({
      entries: Object.freeze([]),
      head: 12,
      dropped: 0,
      configuration: configurationEnabled,
    });

    const configurationOnlyDelta: DiagnosticTimelineResult = Object.freeze({
      entries: Object.freeze([]),
      head: 0,
      dropped: 0,
      configuration: configurationDisabled,
    });

    let diagnosticCallCount = 0;
    recorder.replay(log, dispatcher, {
      commandQueue: queue,
      readDiagnosticsDelta: (sinceHead?: number) => {
        if (diagnosticCallCount === 0) {
          diagnosticCallCount += 1;
          expect(sinceHead).toBeUndefined();
          return baseline;
        }

        diagnosticCallCount += 1;
        expect(sinceHead).toBe(baseline.head);
        return configurationOnlyDelta;
      },
      attachDiagnosticsDelta(result) {
        attachments.push(result);
      },
    });

    expect(diagnosticCallCount).toBe(2);
    expect(attachments).toEqual([configurationOnlyDelta]);
  });

  it('restores the command queue when diagnostics callbacks throw', () => {
    const recorder = new CommandRecorder(setGameState({ value: 0 }));
    const log = recorder.export();
    const dispatcher = new CommandDispatcher();
    const queue = new CommandQueue();
    const configuration = Object.freeze({
      capacity: 4,
      slowTickBudgetMs: 5,
      enabled: true,
      slowSystemBudgetMs: 2,
      systemHistorySize: 8,
      tickBudgetMs: 5,
    });

    const baseline: DiagnosticTimelineResult = Object.freeze({
      entries: Object.freeze([]),
      head: 12,
      dropped: 0,
      configuration,
    });

    const entry: DiagnosticTimelineEntry = Object.freeze({
      tick: 3,
      startedAt: 0,
      endedAt: 6,
      durationMs: 6,
      budgetMs: 4,
      isSlow: true,
      overBudgetMs: 2,
      error: undefined,
      metadata: undefined,
    });

    const delta: DiagnosticTimelineResult = Object.freeze({
      entries: Object.freeze([entry]),
      head: 13,
      dropped: 0,
      configuration,
    });

    const diagnosticsError = new Error('diagnostics failed');
    let readCallCount = 0;

    expect(() =>
      recorder.replay(log, dispatcher, {
        commandQueue: queue,
        readDiagnosticsDelta: (sinceHead?: number) => {
          readCallCount += 1;
          if (sinceHead === undefined) {
            return baseline;
          }
          expect(sinceHead).toBe(baseline.head);
          return delta;
        },
        attachDiagnosticsDelta() {
          throw diagnosticsError;
        },
      }),
    ).toThrow(diagnosticsError);

    expect(readCallCount).toBe(2);

    const command = createCommand({ step: 1 });
    queue.enqueue(command);
    expect(queue.size).toBe(1);
  });

  it('rolls back runtime state when diagnostics callbacks throw', () => {
    const state = setGameState({ value: 0 });
    const recorder = new CommandRecorder(state);
    const dispatcher = new CommandDispatcher();
    const queue = new CommandQueue();

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
    const configuration = Object.freeze({
      capacity: 4,
      slowTickBudgetMs: 5,
      enabled: true,
      slowSystemBudgetMs: 2,
      systemHistorySize: 8,
      tickBudgetMs: 5,
    });

    const baseline: DiagnosticTimelineResult = Object.freeze({
      entries: Object.freeze([]),
      head: 12,
      dropped: 0,
      configuration,
    });

    const entry: DiagnosticTimelineEntry = Object.freeze({
      tick: 3,
      startedAt: 0,
      endedAt: 6,
      durationMs: 6,
      budgetMs: 4,
      isSlow: true,
      overBudgetMs: 2,
      error: undefined,
      metadata: undefined,
    });

    const delta: DiagnosticTimelineResult = Object.freeze({
      entries: Object.freeze([entry]),
      head: 13,
      dropped: 0,
      configuration,
    });

    const diagnosticsError = new Error('diagnostics failed');
    let readCallCount = 0;
    const previousStep = 10;
    const previousNextStep = 11;
    let currentStep = previousStep;
    let nextExecutableStep = previousNextStep;
    const setCurrentStep = vi.fn((step: number) => {
      currentStep = step;
    });
    const setNextExecutableStep = vi.fn((step: number) => {
      nextExecutableStep = step;
    });

    expect(() =>
      recorder.replay(log, dispatcher, {
        commandQueue: queue,
        getCurrentStep: () => currentStep,
        getNextExecutableStep: () => nextExecutableStep,
        setCurrentStep,
        setNextExecutableStep,
        readDiagnosticsDelta: (sinceHead?: number) => {
          readCallCount += 1;
          if (sinceHead === undefined) {
            return baseline;
          }
          expect(sinceHead).toBe(baseline.head);
          return delta;
        },
        attachDiagnosticsDelta() {
          throw diagnosticsError;
        },
      }),
    ).toThrow(diagnosticsError);

    expect(readCallCount).toBe(2);
    expect(state.value).toBe(0);
    expect(currentStep).toBe(previousStep);
    expect(nextExecutableStep).toBe(previousNextStep);
    expect(setCurrentStep).toHaveBeenCalledWith(previousStep);
    expect(setCurrentStep).not.toHaveBeenCalledWith(log.metadata.lastStep + 1);
    expect(setNextExecutableStep).toHaveBeenCalledWith(previousNextStep);
    expect(setNextExecutableStep).not.toHaveBeenCalledWith(log.metadata.lastStep + 1);
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

  it('captures RNG seed set after construction', () => {
    const state = setGameState({ value: 0 });
    const recorder = new CommandRecorder(state);

    setRNGSeed(5555);
    recorder.record(createCommand());

    const log = recorder.export();
    expect(log.metadata.seed).toBe(5555);

    setRNGSeed(9999);
    recorder.replay(log, new CommandDispatcher());
    expect(getCurrentRNGSeed()).toBe(5555);
  });

  it('restores RNG seed when replay fails before completion', () => {
    const state = setGameState({ value: 0 });
    const recorder = new CommandRecorder(state);
    const dispatcher = new CommandDispatcher();
    const queue = new CommandQueue();

    setRNGSeed(1111);
    recorder.record(createCommand());
    const log = recorder.export();

    queue.enqueue(createCommand({ step: 1 }));

    setRNGSeed(2222);

    expect(() =>
      recorder.replay(log, dispatcher, { commandQueue: queue }),
    ).toThrowError(/Command queue must be empty/);

    expect(getCurrentRNGSeed()).toBe(2222);
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
      recordCounters: vi.fn(),
      recordTick: vi.fn(),
    };
    setTelemetry(telemetryStub);

    recorder.replay(recorder.export(), dispatcher);

    expect(telemetryStub.recordError).toHaveBeenCalledWith(
      'ReplayExecutionFailed',
      expect.objectContaining({ type: 'FAIL' }),
    );
  });

  it('records telemetry when handler rejects asynchronously during replay', async () => {
    const state = setGameState({ value: 0 });
    const recorder = new CommandRecorder(state);
    const dispatcher = new CommandDispatcher();
    const commandQueue = new CommandQueue();

    dispatcher.register('ASYNC_FAIL', () =>
      Promise.reject(new Error('boom')),
    );

    setRNGSeed(1111);
    recorder.record(
      createCommand({
        type: 'ASYNC_FAIL',
        step: 2,
      }),
    );
    const log = recorder.export();

    setRNGSeed(2222);

    const telemetryStub: TelemetryFacade = {
      recordError: vi.fn(),
      recordWarning: vi.fn(),
      recordProgress: vi.fn(),
      recordCounters: vi.fn(),
      recordTick: vi.fn(),
    };
    setTelemetry(telemetryStub);

    const setCurrentStep = vi.fn();
    const setNextExecutableStep = vi.fn();

    recorder.replay(log, dispatcher, {
      commandQueue,
      getCurrentStep: () => 10,
      getNextExecutableStep: () => 11,
      setCurrentStep,
      setNextExecutableStep,
    });

    expect(getCurrentRNGSeed()).toBe(1111);

    await Promise.resolve();

    expect(telemetryStub.recordError).toHaveBeenCalledWith(
      'ReplayExecutionFailed',
      expect.objectContaining({ type: 'ASYNC_FAIL' }),
    );
    expect(setCurrentStep).toHaveBeenCalledWith(3);
    expect(setCurrentStep).toHaveBeenLastCalledWith(10);
    expect(setNextExecutableStep).toHaveBeenCalledWith(3);
    expect(setNextExecutableStep).toHaveBeenLastCalledWith(11);
    expect(getCurrentRNGSeed()).toBe(2222);
  });

  it('skips unauthorized commands during replay and records telemetry', () => {
    const state = setGameState({ value: 0 });
    const recorder = new CommandRecorder(state);
    const dispatcher = new CommandDispatcher();
    const handler = vi.fn();

    dispatcher.register('PRESTIGE_RESET', handler);

    recorder.record(
      createCommand({
        type: 'PRESTIGE_RESET',
        priority: CommandPriority.AUTOMATION,
      }),
    );

    const telemetryStub: TelemetryFacade = {
      recordError: vi.fn(),
      recordWarning: vi.fn(),
      recordProgress: vi.fn(),
      recordCounters: vi.fn(),
      recordTick: vi.fn(),
    };
    setTelemetry(telemetryStub);

    recorder.replay(recorder.export(), dispatcher);

    expect(handler).not.toHaveBeenCalled();
    expect(telemetryStub.recordWarning).toHaveBeenCalledWith(
      'AutomationPrestigeBlocked',
      expect.objectContaining({
        type: 'PRESTIGE_RESET',
        attemptedPriority: CommandPriority.AUTOMATION,
        phase: 'replay',
        reason: 'replay',
      }),
    );
  });

  it('emits replay progress telemetry in batches', () => {
    const state = setGameState({ value: 0 });
    const recorder = new CommandRecorder(state);
    const dispatcher = new CommandDispatcher();

    dispatcher.register('NO_OP', () => {});

    for (let index = 0; index < 1500; index += 1) {
      recorder.record(
        createCommand({
          type: 'NO_OP',
          step: index,
          timestamp: index,
        }),
      );
    }

    const telemetryStub: TelemetryFacade = {
      recordError: vi.fn(),
      recordWarning: vi.fn(),
      recordProgress: vi.fn(),
      recordCounters: vi.fn(),
      recordTick: vi.fn(),
    };
    setTelemetry(telemetryStub);

    recorder.replay(recorder.export(), dispatcher);

    expect(telemetryStub.recordProgress).toHaveBeenCalledTimes(2);
    expect(telemetryStub.recordProgress).toHaveBeenNthCalledWith(
      1,
      'CommandReplay',
      { processed: 1000 },
    );
    expect(telemetryStub.recordProgress).toHaveBeenNthCalledWith(
      2,
      'CommandReplay',
      { processed: 1500 },
    );
  });

  it('records runtime event frames in exported logs', () => {
    const state = setGameState({ counter: 0 });
    const recorder = new CommandRecorder(state);
    const frameResult = buildToggleFrame(true, 2);

    try {
      recorder.recordEventFrame(frameResult.frame);
      const log = recorder.export();

      expect(log.events).toHaveLength(1);
      const frame = log.events[0];
      expect(frame.tick).toBe(2);
      expect(frame.events).toHaveLength(1);
      const event = frame.events[0];
      expect(event).toMatchObject({
        type: 'automation:toggled',
        channel: 1,
        issuedAt: frameResult.frame.issuedAt[0],
        dispatchOrder: 0,
        payload: {
          automationId: 'auto:1',
          enabled: true,
        },
      });
    } finally {
      frameResult.release();
    }
  });

  it('throws when recording an event frame with an unexpected manifest hash', () => {
    const state = setGameState({ counter: 0 });
    const recorder = new CommandRecorder(state);
    const frameResult = buildToggleFrame(true, 4);

    try {
      Reflect.set(
        frameResult.frame as Record<string, unknown>,
        'manifestHash',
        'ffffffff' as RuntimeEventManifestHash,
      );

      expect(() => recorder.recordEventFrame(frameResult.frame)).toThrowError(
        /manifest hash mismatch/i,
      );
    } finally {
      frameResult.release();
    }
  });

  it('validates replay event frames against the recorded log', () => {
    const state = setGameState({ counter: 0 });
    const recorder = new CommandRecorder(state);
    const recordedFrame = buildToggleFrame(false, 1);

    try {
      recorder.recordEventFrame(recordedFrame.frame);
      const log = recorder.export();

      const replayFrame = buildToggleFrame(false, 1);
      try {
        replayFrame.frame.issuedAt.set(recordedFrame.frame.issuedAt);
        recorder.beginReplayEventValidation(log);
        recorder.consumeReplayEventFrame(replayFrame.frame);
        expect(() => recorder.endReplayEventValidation()).not.toThrow();
      } finally {
        replayFrame.release();
      }
    } finally {
      recordedFrame.release();
    }
  });

  it('detects issuedAt drift during replay event validation', () => {
    const state = setGameState({ counter: 0 });
    const recorder = new CommandRecorder(state);
    const recordedFrame = buildToggleFrame(true, 3);

    try {
      recorder.recordEventFrame(recordedFrame.frame);
      const log = recorder.export();

      const driftedFrame = buildToggleFrame(true, 3);
      try {
        driftedFrame.frame.issuedAt[0] =
          recordedFrame.frame.issuedAt[0] + 1;

        recorder.beginReplayEventValidation(log);
        expect(() =>
          recorder.consumeReplayEventFrame(driftedFrame.frame),
        ).toThrowError(/Replay event frame does not match/);
      } finally {
        driftedFrame.release();
      }
    } finally {
      recordedFrame.release();
    }
  });

  it('throws when replay event frames differ from the recorded log', () => {
    const state = setGameState({ counter: 0 });
    const recorder = new CommandRecorder(state);
    const recordedFrame = buildToggleFrame(true, 3);

    try {
      recorder.recordEventFrame(recordedFrame.frame);
      const log = recorder.export();

      const mismatchedFrame = buildToggleFrame(false, 3);
      try {
        recorder.beginReplayEventValidation(log);
        expect(() =>
          recorder.consumeReplayEventFrame(mismatchedFrame.frame),
        ).toThrow();
      } finally {
        mismatchedFrame.release();
      }
    } finally {
      recordedFrame.release();
    }
  });

  it('fails fast when replay event frames provide a mismatched manifest hash', () => {
    const state = setGameState({ counter: 0 });
    const recorder = new CommandRecorder(state);
    const recordedFrame = buildToggleFrame(false, 6);

    try {
      recorder.recordEventFrame(recordedFrame.frame);
      const log = recorder.export();

      const mismatchedManifestFrame = buildToggleFrame(false, 6);
      try {
        Reflect.set(
          mismatchedManifestFrame.frame as Record<string, unknown>,
          'manifestHash',
          'ffffffff' as RuntimeEventManifestHash,
        );
        recorder.beginReplayEventValidation(log);
        expect(() =>
          recorder.consumeReplayEventFrame(mismatchedManifestFrame.frame),
        ).toThrowError(/manifest hash does not match/i);
      } finally {
        mismatchedManifestFrame.release();
      }
    } finally {
      recordedFrame.release();
    }
  });

  it('records multi-channel frames with dispatch order preserved', () => {
    const state = setGameState({ counter: 0 });
    const recorder = new CommandRecorder(state);

    let now = 0;
    const clock = {
      now(): number {
        now += 1;
        return now;
      },
    };

    const bus = new EventBus({
      clock,
      channels: DEFAULT_EVENT_BUS_OPTIONS.channels,
    });
    const pool = new TransportBufferPool();

    bus.beginTick(8);
    bus.publish('resource:threshold-reached', {
      resourceId: 'energy',
      threshold: 21,
    });
    bus.publish('automation:toggled', {
      automationId: 'auto:21',
      enabled: true,
    });
    bus.dispatch({ tick: 8 });

    const frameResult = buildRuntimeEventFrame(bus, pool, {
      tick: 8,
      manifestHash: bus.getManifestHash(),
      owner: 'recorder-test',
    });

    try {
      recorder.recordEventFrame(frameResult.frame);
      const log = recorder.export();
      expect(log.events).toHaveLength(1);
      const frame = log.events[0];
      expect(frame.tick).toBe(8);
      expect(frame.manifestHash).toBe(bus.getManifestHash());
      expect(frame.events).toEqual([
        {
          type: 'resource:threshold-reached',
          channel: 0,
          issuedAt: 1,
          dispatchOrder: 0,
          payload: {
            resourceId: 'energy',
            threshold: 21,
          },
        },
        {
          type: 'automation:toggled',
          channel: 1,
          issuedAt: 2,
          dispatchOrder: 1,
          payload: {
            automationId: 'auto:21',
            enabled: true,
          },
        },
      ]);
    } finally {
      frameResult.release();
    }
  });
});
