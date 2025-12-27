import { describe, expect, it, vi } from 'vitest';

import { CommandPriority } from './command.js';
import { CommandDispatcher } from './command-dispatcher.js';
import { CommandQueue } from './command-queue.js';
import {
  IdleEngineRuntime,
  type IdleEngineRuntimeOptions,
  type AutomationState,
} from './index.js';
import {
  DEFAULT_EVENT_BUS_OPTIONS,
  type AutomationToggledEventPayload,
} from './events/runtime-event-catalog.js';
import {
  buildRuntimeEventFrame,
  type RuntimeEventFrame,
} from './events/runtime-event-frame.js';
import { TransportBufferPool } from './transport-buffer-pool.js';
import {
  resetTelemetry,
  setTelemetry,
  type TelemetryFacade,
} from './telemetry.js';
import type {
  DiagnosticTimelineResult,
} from './diagnostics/diagnostic-timeline.js';
import type {
  IdleEngineRuntimeDiagnosticsOptions,
  RuntimeDiagnosticsTimelineOptions,
} from './diagnostics/runtime-diagnostics-controller.js';

type RuntimeTestDiagnosticsOption =
  | RuntimeDiagnosticsTimelineOptions
  | false
  | undefined;

type CreateRuntimeOptions = Omit<IdleEngineRuntimeOptions, 'diagnostics'> & {
  diagnostics?: RuntimeTestDiagnosticsOption;
};

interface RuntimeTestDiagnosticsContext {
  readonly options: RuntimeDiagnosticsTimelineOptions | false | undefined;
  head: number;
  readonly configuration: DiagnosticTimelineResult['configuration'];
  readDelta(sinceHead?: number): DiagnosticTimelineResult;
}

function normalizeDiagnosticsOptions(
  option: RuntimeTestDiagnosticsOption,
): IdleEngineRuntimeDiagnosticsOptions | undefined {
  if (option === undefined) {
    return undefined;
  }

  if (option === false) {
    return { timeline: false };
  }

  if (option.enabled === false) {
    return { timeline: false };
  }

  const { enabled: _enabled, ...timeline } = option;
  return {
    timeline: {
      enabled: true,
      ...timeline,
    },
  };
}

function createRuntime(
  overrides: CreateRuntimeOptions = {},
): {
  runtime: IdleEngineRuntime;
  queue: CommandQueue;
  dispatcher: CommandDispatcher;
  diagnostics: RuntimeTestDiagnosticsContext;
} {
  const {
    diagnostics: diagnosticsOverride,
    commandQueue: providedQueue,
    commandDispatcher: providedDispatcher,
    ...runtimeOverrides
  } = overrides;

  const queue = providedQueue ?? new CommandQueue();
  const dispatcher =
    providedDispatcher ?? new CommandDispatcher();

  const normalizedDiagnostics =
    normalizeDiagnosticsOptions(diagnosticsOverride);

  const runtime = new IdleEngineRuntime({
    stepSizeMs: 10,
    maxStepsPerFrame: 4,
    commandQueue: queue,
    commandDispatcher: dispatcher,
    ...runtimeOverrides,
    diagnostics: normalizedDiagnostics,
  });

  const initialDelta = runtime.readDiagnosticsDelta();
  const { head: initialHead } = readBacklog(runtime);
  let head = initialHead;
  let configuration = initialDelta.configuration;

  const diagnosticsOptions =
    normalizedDiagnostics?.timeline ?? undefined;

  const diagnostics: RuntimeTestDiagnosticsContext = {
    options: diagnosticsOptions,
    get head(): number {
      return head;
    },
    set head(value: number) {
      head = value;
    },
    get configuration() {
      return configuration;
    },
    readDelta(sinceHead?: number) {
      const result = runtime.readDiagnosticsDelta(
        sinceHead ?? head,
      );
      head = result.head;
      configuration = result.configuration;
      return result;
    },
  };

  return { runtime, queue, dispatcher, diagnostics };
}

class TestClock {
  private current = 0;

  now(): number {
    return this.current;
  }

  advance(byMs: number): void {
    this.current += byMs;
  }

  set(toMs: number): void {
    this.current = toMs;
  }
}

function readBacklog(
  runtime: IdleEngineRuntime,
  head?: number,
): {
  entries: DiagnosticTimelineResult['entries'];
  head: number;
} {
  const result = runtime.readDiagnosticsDelta(head);
  return { entries: result.entries, head: result.head };
}

describe('IdleEngineRuntime', () => {
  it('executes queued commands for the current step and advances counters', () => {
    const { runtime, queue, dispatcher } = createRuntime();
    const executed: Array<{ step: number; type: string }> = [];

    dispatcher.register<{ type: string }>('TEST', (payload, ctx) => {
      executed.push({ step: ctx.step, type: payload.type });
    });

    queue.enqueue({
      type: 'TEST',
      priority: CommandPriority.PLAYER,
      payload: { type: 'TEST' },
      timestamp: 1,
      step: 0,
    });

    runtime.tick(10);

    expect(executed).toEqual([{ step: 0, type: 'TEST' }]);
    expect(runtime.getCurrentStep()).toBe(1);
    expect(runtime.getNextExecutableStep()).toBe(1);
  });

  it('returns 0 steps when deltaMs does not cross a step boundary', () => {
    const { runtime } = createRuntime();

    const stepsProcessed = runtime.tick(5);

    expect(stepsProcessed).toBe(0);
    expect(runtime.getCurrentStep()).toBe(0);
  });

  it('returns steps processed when deltaMs spans multiple steps', () => {
    const { runtime } = createRuntime();

    const stepsProcessed = runtime.tick(25);

    expect(stepsProcessed).toBe(2);
    expect(runtime.getCurrentStep()).toBe(2);
  });

  it('fastForward returns 0 when delta does not reach a step', () => {
    const { runtime } = createRuntime();

    const stepsProcessed = runtime.fastForward(5);

    expect(stepsProcessed).toBe(0);
    expect(runtime.getCurrentStep()).toBe(0);
    expect(runtime.getNextExecutableStep()).toBe(0);
  });

  it('fastForward accumulates remainder and advances steps', () => {
    const { runtime } = createRuntime();

    const firstAdvance = runtime.fastForward(25);

    expect(firstAdvance).toBe(2);
    expect(runtime.getCurrentStep()).toBe(2);
    expect(runtime.getNextExecutableStep()).toBe(2);

    const secondAdvance = runtime.fastForward(5);

    expect(secondAdvance).toBe(1);
    expect(runtime.getCurrentStep()).toBe(3);
    expect(runtime.getNextExecutableStep()).toBe(3);
  });

  it('records command outcomes for sync handlers', () => {
    const { runtime, queue, dispatcher } = createRuntime();

    dispatcher.register('SYNC_SUCCESS', () => undefined);
    dispatcher.register('SYNC_FAIL', () => ({
      success: false,
      error: {
        code: 'TEST_FAILURE',
        message: 'Nope',
      },
    }));

    queue.enqueue({
      type: 'SYNC_SUCCESS',
      priority: CommandPriority.PLAYER,
      payload: {},
      timestamp: 1,
      step: 0,
      requestId: 'command:sync-success',
    });

    queue.enqueue({
      type: 'SYNC_FAIL',
      priority: CommandPriority.PLAYER,
      payload: {},
      timestamp: 2,
      step: 0,
      requestId: 'command:sync-fail',
    });

    runtime.tick(10);

    expect(runtime.drainCommandOutcomes()).toEqual([
      {
        success: true,
        requestId: 'command:sync-success',
        serverStep: 0,
      },
      {
        success: false,
        requestId: 'command:sync-fail',
        serverStep: 0,
        error: {
          code: 'TEST_FAILURE',
          message: 'Nope',
        },
      },
    ]);
    expect(runtime.drainCommandOutcomes()).toEqual([]);
  });

  it('records command failures when async handlers resolve to a failure result', async () => {
    const { runtime, queue, dispatcher } = createRuntime();

    dispatcher.register('ASYNC_FAIL', async () => ({
      success: false,
      error: {
        code: 'TEST_FAILURE',
        message: 'Nope',
      },
    }));

    queue.enqueue({
      type: 'ASYNC_FAIL',
      priority: CommandPriority.PLAYER,
      payload: {},
      timestamp: 1,
      step: 0,
      requestId: 'command:async',
    });

    runtime.tick(10);

    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.drainCommandFailures()).toEqual([
      expect.objectContaining({
        requestId: 'command:async',
        type: 'ASYNC_FAIL',
        priority: CommandPriority.PLAYER,
        timestamp: 1,
        step: 0,
        error: expect.objectContaining({
          code: 'TEST_FAILURE',
          message: 'Nope',
        }),
      }),
    ]);
    expect(runtime.drainCommandOutcomes()).toEqual([
      expect.objectContaining({
        success: false,
        requestId: 'command:async',
        serverStep: 0,
        error: expect.objectContaining({
          code: 'TEST_FAILURE',
          message: 'Nope',
        }),
      }),
    ]);
  });

  it('records command failures when async handlers reject', async () => {
    const { runtime, queue, dispatcher } = createRuntime();

    dispatcher.register('ASYNC_THROW', () => Promise.reject(new Error('boom')));

    queue.enqueue({
      type: 'ASYNC_THROW',
      priority: CommandPriority.PLAYER,
      payload: {},
      timestamp: 1,
      step: 0,
    });

    runtime.tick(10);

    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.drainCommandFailures()).toEqual([
      expect.objectContaining({
        type: 'ASYNC_THROW',
        error: expect.objectContaining({
          code: 'COMMAND_EXECUTION_FAILED',
        }),
      }),
    ]);
  });

  it('records command outcomes when async handlers resolve', async () => {
    const { runtime, queue, dispatcher } = createRuntime();

    dispatcher.register('ASYNC_SUCCESS', async () => ({
      success: true,
    }));

    queue.enqueue({
      type: 'ASYNC_SUCCESS',
      priority: CommandPriority.PLAYER,
      payload: {},
      timestamp: 1,
      step: 0,
      requestId: 'command:async-success',
    });

    runtime.tick(10);

    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.drainCommandOutcomes()).toEqual([
      {
        success: true,
        requestId: 'command:async-success',
        serverStep: 0,
      },
    ]);
  });

  it('skips commands whose step does not match the executing tick', () => {
    const { runtime, queue, dispatcher } = createRuntime();
    const handler = vi.fn();
    dispatcher.register('TEST', handler);

    const errors: Array<{ event: string; data?: unknown }> = [];
    const telemetry: TelemetryFacade = {
      recordError(event, data) {
        errors.push({ event, data });
      },
      recordWarning() {},
      recordProgress() {},
      recordCounters() {},
      recordTick() {},
    };

    setTelemetry(telemetry);

    try {
      queue.enqueue({
        type: 'TEST',
        priority: CommandPriority.PLAYER,
        payload: {},
        timestamp: 1,
        step: -1,
      });

      runtime.tick(10);

      expect(handler).not.toHaveBeenCalled();
      expect(errors).toEqual([
        {
          event: 'CommandStepMismatch',
          data: {
            commandStep: -1,
            expectedStep: 0,
            type: 'TEST',
          },
        },
      ]);
    } finally {
      resetTelemetry();
    }
  });

  it('advances nextExecutableStep before handlers execute', () => {
    const { runtime, queue, dispatcher } = createRuntime();
    expect(runtime.getNextExecutableStep()).toBe(0);

    let observedDuringHandler: number | null = null;
    dispatcher.register('TEST', (_, ctx) => {
      expect(ctx.step).toBe(0);
      observedDuringHandler = runtime.getNextExecutableStep();
    });

    queue.enqueue({
      type: 'TEST',
      priority: CommandPriority.PLAYER,
      payload: {},
      timestamp: 1,
      step: 0,
    });

    runtime.tick(10);

    expect(observedDuringHandler).toBe(1);
    expect(runtime.getNextExecutableStep()).toBe(1);
  });

  it('executes future-step commands on their scheduled ticks', () => {
    const { runtime, queue, dispatcher } = createRuntime();
    const executed: Array<{ step: number; id: string }> = [];

    dispatcher.register<{ id: string }>('TEST', (payload, ctx) => {
      executed.push({ step: ctx.step, id: payload.id });
    });

    queue.enqueue({
      type: 'TEST',
      priority: CommandPriority.PLAYER,
      payload: { id: 'step-0' },
      timestamp: 1,
      step: 0,
    });
    queue.enqueue({
      type: 'TEST',
      priority: CommandPriority.PLAYER,
      payload: { id: 'step-1' },
      timestamp: 2,
      step: 1,
    });
    queue.enqueue({
      type: 'TEST',
      priority: CommandPriority.PLAYER,
      payload: { id: 'step-2' },
      timestamp: 3,
      step: 2,
    });

    runtime.tick(10);
    expect(executed).toEqual([{ step: 0, id: 'step-0' }]);
    expect(queue.size).toBe(2);

    runtime.tick(10);
    expect(executed).toEqual([
      { step: 0, id: 'step-0' },
      { step: 1, id: 'step-1' },
    ]);
    expect(queue.size).toBe(1);

    runtime.tick(10);
    expect(executed).toEqual([
      { step: 0, id: 'step-0' },
      { step: 1, id: 'step-1' },
      { step: 2, id: 'step-2' },
    ]);
    expect(queue.size).toBe(0);
  });

  it('clamps execution to maxStepsPerFrame to prevent spiral of death', () => {
    const { runtime, queue, dispatcher } = createRuntime({
      maxStepsPerFrame: 3,
    });
    const executed: number[] = [];

    dispatcher.register('TEST', (_, ctx) => {
      executed.push(ctx.step);
    });

    for (let i = 0; i < 10; i += 1) {
      queue.enqueue({
        type: 'TEST',
        priority: CommandPriority.PLAYER,
        payload: {},
        timestamp: i,
        step: i,
      });
    }

    runtime.tick(100);
    expect(executed).toEqual([0, 1, 2]);
    expect(runtime.getCurrentStep()).toBe(3);
    expect(queue.size).toBe(7);

    runtime.tick(100);
    expect(executed).toEqual([0, 1, 2, 3, 4, 5]);
    expect(runtime.getCurrentStep()).toBe(6);
    expect(queue.size).toBe(4);
  });

  it('resets outbound events between tick batches when time is credited mid-tick', () => {
    const { runtime, queue, dispatcher } = createRuntime({
      stepSizeMs: 10,
      maxStepsPerFrame: 4,
    });

    const manifest = runtime.getEventBus().getManifest();
    const automationChannel = manifest.entries.find(
      (entry) => entry.type === 'automation:toggled',
    );
    expect(automationChannel).toBeDefined();

    const outboundAfterStep0: Array<{ tick: number }> = [];
    const outboundAtStep1Start: Array<{ tick: number }> = [];

    dispatcher.register('PUBLISH', (_, ctx) => {
      ctx.events.publish('automation:toggled', {
        automationId: 'auto-1',
        enabled: true,
      } satisfies AutomationToggledEventPayload);
    });

    dispatcher.register('CREDIT', () => {
      runtime.creditTime(10);
    });

    dispatcher.register('SNAPSHOT_STEP0', () => {
      const buffer = runtime
        .getEventBus()
        .getOutboundBuffer(automationChannel!.channel);
      for (let index = 0; index < buffer.length; index += 1) {
        outboundAfterStep0.push({ tick: buffer.at(index).tick });
      }
    });

    dispatcher.register('SNAPSHOT_STEP1', () => {
      const buffer = runtime
        .getEventBus()
        .getOutboundBuffer(automationChannel!.channel);
      for (let index = 0; index < buffer.length; index += 1) {
        outboundAtStep1Start.push({ tick: buffer.at(index).tick });
      }
    });

    queue.enqueue({
      type: 'PUBLISH',
      priority: CommandPriority.PLAYER,
      payload: {},
      timestamp: 0,
      step: 0,
    });
    queue.enqueue({
      type: 'CREDIT',
      priority: CommandPriority.PLAYER,
      payload: {},
      timestamp: 1,
      step: 0,
    });
    queue.enqueue({
      type: 'SNAPSHOT_STEP0',
      priority: CommandPriority.PLAYER,
      payload: {},
      timestamp: 2,
      step: 0,
    });
    queue.enqueue({
      type: 'SNAPSHOT_STEP1',
      priority: CommandPriority.PLAYER,
      payload: {},
      timestamp: 0,
      step: 1,
    });

    runtime.tick(10);

    expect(runtime.getCurrentStep()).toBe(2);
    expect(outboundAfterStep0).toEqual([{ tick: 0 }]);
    expect(outboundAtStep1Start).toEqual([]);
  });

  it('records accumulator backlog telemetry when clamped by maxStepsPerFrame', () => {
    const clock = new TestClock();
    const { runtime, diagnostics } = createRuntime({
      stepSizeMs: 10,
      maxStepsPerFrame: 2,
      diagnostics: {
        enabled: true,
        capacity: 8,
        clock,
      },
    });

    runtime.tick(45);

    expect(runtime.getCurrentStep()).toBe(2);
    expect(runtime.getNextExecutableStep()).toBe(2);

    const delta = diagnostics.readDelta();
    expect(delta.dropped).toBe(0);
    expect(delta.entries).toHaveLength(2);
    expect(delta.entries.map((entry) => entry.tick)).toEqual([0, 1]);

    for (const entry of delta.entries) {
      expect(entry.metadata?.accumulatorBacklogMs).toBeCloseTo(25, 5);
      expect(entry.metadata?.queue).toEqual({
        sizeBefore: 0,
        sizeAfter: 0,
        captured: 0,
        executed: 0,
        skipped: 0,
      });
    }
  });

  it('drains accumulator backlog deterministically across varied deltas', () => {
    const clock = new TestClock();
    const recordCountersMock = vi.fn<
      (group: string, counters: Readonly<Record<string, number>>) => void
    >();
    const recordTickMock = vi.fn();

    const telemetryFacade: TelemetryFacade = {
      recordError() {},
      recordWarning() {},
      recordProgress() {},
      recordCounters(group, counters) {
        recordCountersMock(group, counters);
      },
      recordTick() {
        recordTickMock();
      },
    };

    setTelemetry(telemetryFacade);

    try {
      const { runtime, diagnostics } = createRuntime({
        stepSizeMs: 10,
        maxStepsPerFrame: 2,
        diagnostics: {
          enabled: true,
          capacity: 8,
          clock,
        },
      });

      const deltas = [45, 10, 10, 5];
      const expectedBacklog = [25, 15, 5, 0];
      const expectedAdvances = [2, 2, 2, 1];

      const observedBacklog: number[] = [];
      const observedAdvances: number[] = [];

      let previousStep = runtime.getCurrentStep();

      deltas.forEach((delta, index) => {
        runtime.tick(delta);

        const deltaResult = diagnostics.readDelta();
        expect(deltaResult.dropped).toBe(0);
        expect(deltaResult.entries.length).toBeGreaterThan(0);

        const lastEntry =
          deltaResult.entries[deltaResult.entries.length - 1];
        expect(lastEntry?.metadata?.accumulatorBacklogMs).toBeDefined();
        const backlog = lastEntry?.metadata?.accumulatorBacklogMs ?? NaN;
        observedBacklog.push(backlog);
        expect(backlog).toBeCloseTo(expectedBacklog[index], 5);

        for (const entry of deltaResult.entries) {
          expect(entry.metadata?.queue).toEqual({
            sizeBefore: 0,
            sizeAfter: 0,
            captured: 0,
            executed: 0,
            skipped: 0,
          });
        }

        const currentStep = runtime.getCurrentStep();
        const advance = currentStep - previousStep;
        observedAdvances.push(advance);
        previousStep = currentStep;
      });

      expectedBacklog.forEach((value, idx) => {
        expect(observedBacklog[idx]).toBeCloseTo(value, 5);
      });
      expect(observedAdvances).toEqual(expectedAdvances);
      expect(runtime.getCurrentStep()).toBe(7);
      expect(runtime.getNextExecutableStep()).toBe(7);

      const totalSteps = expectedAdvances.reduce(
        (sum, value) => sum + value,
        0,
      );
      expect(recordTickMock).toHaveBeenCalledTimes(totalSteps);

      const eventsCalls = recordCountersMock.mock.calls.filter(
        ([group]) => group === 'events',
      );
      expect(eventsCalls).toHaveLength(totalSteps);
      for (const [, counters] of eventsCalls) {
        expect(counters).toEqual({
          published: 0,
          softLimited: 0,
          overflowed: 0,
          subscribers: 0,
        });
      }

      const cooldownCalls = recordCountersMock.mock.calls.filter(
        ([group]) => group === 'events.cooldown_ticks',
      );
      expect(cooldownCalls).toHaveLength(totalSteps);
      for (const [, counters] of cooldownCalls) {
        for (const value of Object.values(counters)) {
          expect(value).toBe(0);
        }
      }
    } finally {
      resetTelemetry();
    }
  });

  it('maintains accumulator precision for fractional cadence ticks', () => {
    const stepSizeMs = 1000 / 60;
    const clock = new TestClock();
    const { runtime, diagnostics } = createRuntime({
      stepSizeMs,
      maxStepsPerFrame: 6,
      diagnostics: {
        enabled: true,
        capacity: 128,
        clock,
      },
    });

    for (let index = 0; index < 60; index += 1) {
      runtime.tick(stepSizeMs);
    }

    expect(runtime.getCurrentStep()).toBe(60);
    expect(runtime.getNextExecutableStep()).toBe(60);

    const delta = diagnostics.readDelta();
    expect(delta.dropped).toBe(0);
    expect(delta.entries).toHaveLength(60);

    const lastEntry = delta.entries[delta.entries.length - 1];
    expect(lastEntry?.metadata?.accumulatorBacklogMs).toBeDefined();
    expect(lastEntry?.metadata?.accumulatorBacklogMs ?? NaN).toBeCloseTo(
      0,
      6,
    );

    for (const entry of delta.entries) {
      expect(entry.metadata?.queue).toEqual({
        sizeBefore: 0,
        sizeAfter: 0,
        captured: 0,
        executed: 0,
        skipped: 0,
      });
    }
  });

  it('executes systems during each tick with the correct context', () => {
    const { runtime } = createRuntime();
    const executedSteps: number[] = [];
    const observedDelta: number[] = [];

    runtime.addSystem({
      id: 'system',
      tick: (context) => {
        executedSteps.push(context.step);
        observedDelta.push(context.deltaMs);
      },
    });

    runtime.tick(20);

    expect(executedSteps).toEqual([0, 1]);
    expect(observedDelta).toEqual([10, 10]);
  });

  it('executes systems in registration order for each step', () => {
    const { runtime } = createRuntime();
    const order: string[] = [];

    runtime.addSystem({
      id: 'a',
      tick: (context) => {
        order.push(`a:${context.step}`);
      },
    });

    runtime.addSystem({
      id: 'b',
      tick: (context) => {
        order.push(`b:${context.step}`);
      },
    });

    runtime.tick(20);

    expect(order).toEqual(['a:0', 'b:0', 'a:1', 'b:1']);
  });

  it('continues executing remaining systems when a system throws', () => {
    const { runtime } = createRuntime();
    const systemA = vi.fn(() => {
      throw new Error('boom');
    });
    const systemB = vi.fn();

    const errors: Array<{ event: string; data?: unknown }> = [];
    const telemetry: TelemetryFacade = {
      recordError(event, data) {
        errors.push({ event, data });
      },
      recordWarning() {},
      recordProgress() {},
      recordCounters() {},
      recordTick() {},
    };

    setTelemetry(telemetry);

    runtime.addSystem({ id: 'a', tick: systemA });
    runtime.addSystem({ id: 'b', tick: systemB });

    try {
      expect(() => runtime.tick(10)).not.toThrow();
    } finally {
      resetTelemetry();
    }

    expect(systemA).toHaveBeenCalledTimes(1);
    expect(systemB).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([
      {
        event: 'SystemExecutionFailed',
        data: {
          systemId: 'a',
          error: expect.any(Error),
        },
      },
    ]);
  });

  it('allows systems to enqueue commands for subsequent steps', () => {
    const { runtime, queue, dispatcher } = createRuntime();
    const executed: string[] = [];

    dispatcher.register<{ id: string }>('TEST', (payload) => {
      executed.push(payload.id);
    });

    runtime.addSystem({
      id: 'enqueuer',
      tick: (context) => {
        queue.enqueue({
          type: 'TEST',
          priority: CommandPriority.PLAYER,
          payload: { id: `step-${context.step}` },
          timestamp: context.step,
          step: context.step + 1,
        });
      },
    });

    runtime.tick(10);
    expect(executed).toEqual([]);

    runtime.tick(10);
    expect(executed).toEqual(['step-0']);

    runtime.tick(10);
    expect(executed).toEqual(['step-0', 'step-1']);
  });

  it('dispatches event bus publications to system subscribers before tick execution', () => {
    const { runtime, queue, dispatcher } = createRuntime();
    const order: string[] = [];

    dispatcher.register('EMIT_EVENT', (_payload, ctx) => {
      ctx.events.publish('automation:toggled', {
        automationId: 'auto:1',
        enabled: true,
      });
    });

    runtime.addSystem({
      id: 'observer',
      setup: ({ events }) => {
        events.on('automation:toggled', (event) => {
          order.push(`event:${event.payload.enabled}`);
        });
      },
      tick: () => {
        order.push('tick');
      },
    });

    queue.enqueue({
      type: 'EMIT_EVENT',
      priority: CommandPriority.PLAYER,
      payload: {},
      timestamp: 1,
      step: 0,
    });

    runtime.tick(10);

    expect(order).toEqual(['event:true', 'tick']);
  });

  it('preserves outbound events across multi-step ticks', () => {
    const { runtime } = createRuntime({ stepSizeMs: 10 });

    runtime.addSystem({
      id: 'event-generator',
      tick: ({ step, events }) => {
        events.publish('automation:toggled', {
          automationId: `auto:${step}`,
          enabled: step % 2 === 0,
        });
      },
    });

    runtime.tick(30);

    const bus = runtime.getEventBus();
    const frameResult = buildRuntimeEventFrame(bus, new TransportBufferPool(), {
      tick: runtime.getCurrentStep(),
      manifestHash: bus.getManifestHash(),
      owner: 'test-suite',
    });

    try {
      expect(frameResult.frame.count).toBe(3);
      const automationIds =
        frameResult.frame.format === 'struct-of-arrays'
          ? frameResult.frame.payloads.map(
              (payload) =>
                (payload as AutomationToggledEventPayload).automationId,
            )
          : frameResult.frame.events.map(
              (event) =>
                (event.payload as AutomationToggledEventPayload).automationId,
            );
      expect(automationIds).toEqual(['auto:0', 'auto:1', 'auto:2']);
    } finally {
      frameResult.release();
    }
  });

  it('throws when systems subscribe to unknown event channels', () => {
    const { runtime } = createRuntime();

    expect(() =>
      runtime.addSystem({
        id: 'invalid-subscriber',
        setup: ({ events }) => {
          events.on('invalid:event' as never, () => {});
        },
        tick: () => {},
      }),
    ).toThrowError(/System "invalid-subscriber" failed to register event subscriptions/);
  });

  it('commands enqueued during execution target the next step', () => {
    const { runtime, queue, dispatcher } = createRuntime();
    const executionOrder: string[] = [];

    dispatcher.register('PARENT', () => {
      executionOrder.push('parent');
      queue.enqueue({
        type: 'CHILD',
        priority: CommandPriority.PLAYER,
        payload: {},
        timestamp: 1,
        step: runtime.getNextExecutableStep(),
      });
    });

    dispatcher.register('CHILD', () => {
      executionOrder.push('child');
    });

    queue.enqueue({
      type: 'PARENT',
      priority: CommandPriority.PLAYER,
      payload: {},
      timestamp: 1,
      step: 0,
    });

    runtime.tick(10);
    expect(executionOrder).toEqual(['parent']);

    runtime.tick(10);
    expect(executionOrder).toEqual(['parent', 'child']);
  });

  it('accumulates fractional time across multiple ticks', () => {
    const { runtime } = createRuntime({ stepSizeMs: 10 });

    runtime.tick(7);
    expect(runtime.getCurrentStep()).toBe(0);

    runtime.tick(5);
    expect(runtime.getCurrentStep()).toBe(1);

    runtime.tick(9);
    expect(runtime.getCurrentStep()).toBe(2);
  });

  it('handles zero and negative deltaMs safely', () => {
    const { runtime } = createRuntime();

    runtime.tick(0);
    expect(runtime.getCurrentStep()).toBe(0);

    runtime.tick(-100);
    expect(runtime.getCurrentStep()).toBe(0);
  });

  it('does not emit diagnostics entries for zero/negative deltaMs', () => {
    const { runtime, diagnostics } = createRuntime({
      diagnostics: {
        enabled: true,
        capacity: 8,
      },
    });

    // Consume any initial baseline so we only observe post-tick entries
    diagnostics.readDelta();

    runtime.tick(0);
    runtime.tick(-5);

    const delta = diagnostics.readDelta();
    expect(delta.entries).toHaveLength(0);
    expect(runtime.getCurrentStep()).toBe(0);
    expect(runtime.getNextExecutableStep()).toBe(0);
  });

  it('executes commands in strict priority order during a single tick', () => {
    const { runtime, queue, dispatcher } = createRuntime();
    const executionOrder: string[] = [];

    dispatcher.register<{ id: string }>('TEST', (payload) => {
      executionOrder.push(payload.id);
    });

    queue.enqueue({
      type: 'TEST',
      priority: CommandPriority.AUTOMATION,
      payload: { id: 'automation' },
      timestamp: 1,
      step: 0,
    });
    queue.enqueue({
      type: 'TEST',
      priority: CommandPriority.SYSTEM,
      payload: { id: 'system' },
      timestamp: 2,
      step: 0,
    });
    queue.enqueue({
      type: 'TEST',
      priority: CommandPriority.PLAYER,
      payload: { id: 'player' },
      timestamp: 3,
      step: 0,
    });

    runtime.tick(10);

    expect(executionOrder).toEqual(['system', 'player', 'automation']);
  });

  it('records diagnostic timeline metadata and warns on slow ticks and systems', () => {
    const clock = new TestClock();
    const warnings: Array<{ event: string; data?: unknown }> = [];
    const telemetryFacade: TelemetryFacade = {
      recordError: vi.fn(),
      recordWarning(event, data) {
        warnings.push({ event, data });
      },
      recordProgress() {},
      recordCounters() {},
      recordTick() {},
    };

    setTelemetry(telemetryFacade);

    try {
      const runtime = new IdleEngineRuntime({
        stepSizeMs: 10,
        maxStepsPerFrame: 1,
        diagnostics: {
          timeline: {
            enabled: true,
            capacity: 8,
            slowTickBudgetMs: 3,
            slowSystemBudgetMs: 2,
            systemHistorySize: 4,
            clock,
          },
        },
      });

      const queue = runtime.getCommandQueue();
      queue.enqueue({
        type: 'EXEC',
        priority: CommandPriority.PLAYER,
        payload: {},
        timestamp: 1,
        step: 0,
      });
      queue.enqueue({
        type: 'SKIP',
        priority: CommandPriority.PLAYER,
        payload: {},
        timestamp: 2,
        step: -1,
      });
      queue.enqueue({
        type: 'FUTURE',
        priority: CommandPriority.PLAYER,
        payload: {},
        timestamp: 3,
        step: 2,
      });

      runtime.addSystem({
        id: 'slow-system',
        tick: ({ events }) => {
          clock.advance(3);
          events.publish('automation:toggled', {
            automationId: 'auto:slow',
            enabled: true,
          });
        },
      });

      runtime.addSystem({
        id: 'fast-system',
        tick: () => {
          clock.advance(1);
        },
      });

      runtime.tick(10);
      runtime.tick(10);

      const timeline = runtime.getDiagnosticTimelineSnapshot();
      expect(timeline.entries.length).toBe(2);

      const firstEntry = timeline.entries[0]!;
      expect(firstEntry.metadata?.queue).toEqual({
        sizeBefore: 3,
        sizeAfter: 1,
        captured: 2,
        executed: 1,
        skipped: 1,
      });
      expect(firstEntry.metadata?.events?.counters.published).toBeGreaterThanOrEqual(1);
      expect(firstEntry.metadata?.systems?.length).toBe(2);
      const firstSlowSpan = firstEntry.metadata?.systems?.find(
        (span) => span.id === 'slow-system',
      );
      expect(firstSlowSpan?.isSlow).toBe(true);
      expect(firstSlowSpan?.history?.sampleCount).toBe(1);

      const secondEntry = timeline.entries[1]!;
      const secondSlowSpan = secondEntry.metadata?.systems?.find(
        (span) => span.id === 'slow-system',
      );
      expect(secondSlowSpan?.history?.sampleCount).toBe(2);
      expect(secondSlowSpan?.history?.averageMs).toBeGreaterThan(0);

      const slowWarnings = warnings.filter(
        (warning) => warning.event === 'SystemExecutionSlow',
      );
      expect(slowWarnings.length).toBe(2);

      const tickWarnings = warnings.filter(
        (warning) => warning.event === 'TickExecutionSlow',
      );
      expect(tickWarnings.length).toBe(2);
      expect(tickWarnings[0]?.data).toMatchObject({
        tick: 0,
        budgetMs: 3,
      });
    } finally {
      resetTelemetry();
    }
  });

  it('toggles diagnostics at runtime and preserves resolved configuration', () => {
    const runtime = new IdleEngineRuntime();

    const initial = runtime.readDiagnosticsDelta();
    expect(initial.configuration.enabled).toBe(false);
    expect(initial.entries.length).toBe(0);

    runtime.enableDiagnostics({
      capacity: 3,
      slowTickBudgetMs: 8,
      slowSystemBudgetMs: 4,
      systemHistorySize: 6,
    });

    const afterEnable = runtime.readDiagnosticsDelta();
    expect(afterEnable.configuration.enabled).toBe(true);
    expect(afterEnable.configuration.capacity).toBe(3);
    expect(afterEnable.configuration.slowSystemBudgetMs).toBe(4);

    runtime.tick(100);

    const delta = runtime.readDiagnosticsDelta(afterEnable.head);
    expect(delta.entries.length).toBeGreaterThan(0);
    expect(delta.configuration.enabled).toBe(true);

    runtime.enableDiagnostics(false);

    const afterDisable = runtime.readDiagnosticsDelta(delta.head);
    expect(afterDisable.entries.length).toBe(0);
    expect(afterDisable.configuration.enabled).toBe(false);
    expect(afterDisable.configuration.capacity).toBe(3);

    runtime.tick(100);
    const disabledDelta = runtime.readDiagnosticsDelta(afterDisable.head);
    expect(disabledDelta.entries.length).toBe(0);
    expect(disabledDelta.configuration.enabled).toBe(false);
  });

  it('restores diagnostics configuration after disabling and re-enabling without arguments', () => {
    const runtime = new IdleEngineRuntime();

    runtime.enableDiagnostics({
      capacity: 5,
      slowTickBudgetMs: 12,
      slowSystemBudgetMs: 3,
      systemHistorySize: 7,
    });

    const initialSnapshot = runtime.getDiagnosticTimelineSnapshot();
    expect(initialSnapshot.configuration).toMatchObject({
      enabled: true,
      capacity: 5,
      slowTickBudgetMs: 12,
      slowSystemBudgetMs: 3,
      systemHistorySize: 7,
      tickBudgetMs: 12,
    });

    runtime.enableDiagnostics(false);

    const afterDisableSnapshot = runtime.getDiagnosticTimelineSnapshot();
    expect(afterDisableSnapshot.configuration.enabled).toBe(false);

    runtime.enableDiagnostics();

    const reenablingSnapshot = runtime.getDiagnosticTimelineSnapshot();
    expect(reenablingSnapshot.configuration.enabled).toBe(true);
    expect(reenablingSnapshot.configuration.capacity).toBe(
      initialSnapshot.configuration.capacity,
    );
    expect(reenablingSnapshot.configuration.slowTickBudgetMs).toBe(
      initialSnapshot.configuration.slowTickBudgetMs,
    );
    expect(reenablingSnapshot.configuration.slowSystemBudgetMs).toBe(
      initialSnapshot.configuration.slowSystemBudgetMs,
    );
    expect(reenablingSnapshot.configuration.systemHistorySize).toBe(
      initialSnapshot.configuration.systemHistorySize,
    );
    expect(reenablingSnapshot.configuration.tickBudgetMs).toBe(
      initialSnapshot.configuration.tickBudgetMs,
    );
  });

  it('retains diagnostics overrides when disabling the timeline with options', () => {
    const runtime = new IdleEngineRuntime();

    runtime.enableDiagnostics({
      capacity: 3,
      slowSystemBudgetMs: 6,
      systemHistorySize: 5,
    });

    runtime.enableDiagnostics({
      enabled: false,
      capacity: 9,
      slowSystemBudgetMs: 2,
      systemHistorySize: 4,
    });

    const disabledSnapshot = runtime.getDiagnosticTimelineSnapshot();
    expect(disabledSnapshot.configuration.enabled).toBe(false);

    runtime.enableDiagnostics();

    const reenablingSnapshot = runtime.getDiagnosticTimelineSnapshot();
    expect(reenablingSnapshot.configuration.enabled).toBe(true);
    expect(reenablingSnapshot.configuration.capacity).toBe(9);
    expect(reenablingSnapshot.configuration.slowSystemBudgetMs).toBe(2);
    expect(reenablingSnapshot.configuration.systemHistorySize).toBe(4);
  });

  it('annotates system errors in the diagnostic timeline and preserves telemetry', () => {
    const clock = new TestClock();
    const errors: Array<{ event: string; data?: unknown }> = [];
    const telemetryFacade: TelemetryFacade = {
      recordError(event, data) {
        errors.push({ event, data });
      },
      recordWarning() {},
      recordProgress() {},
      recordCounters() {},
      recordTick() {},
    };

    setTelemetry(telemetryFacade);

    try {
      const runtime = new IdleEngineRuntime({
        stepSizeMs: 10,
        diagnostics: {
          timeline: {
            enabled: true,
            capacity: 4,
            slowTickBudgetMs: 10,
            slowSystemBudgetMs: 1,
            systemHistorySize: 3,
            clock,
          },
        },
      });

      runtime.addSystem({
        id: 'faulty',
        tick: () => {
          clock.advance(2);
          throw new Error('boom');
        },
      });

      runtime.addSystem({
        id: 'recovery',
        tick: () => {
          clock.advance(1);
        },
      });

      expect(() => runtime.tick(10)).not.toThrow();

      const timeline = runtime.getDiagnosticTimelineSnapshot();
      expect(timeline.entries.length).toBe(1);
      const entry = timeline.entries[0]!;
      const faultySpan = entry.metadata?.systems?.find(
        (span) => span.id === 'faulty',
      );
      expect(faultySpan?.error).toMatchObject({ message: 'boom' });
      expect(faultySpan?.isSlow).toBe(true);
      expect(faultySpan?.history?.sampleCount).toBe(1);

      expect(errors).toEqual([
        {
          event: 'SystemExecutionFailed',
          data: {
            systemId: 'faulty',
            error: expect.any(Error),
          },
        },
      ]);
    } finally {
      resetTelemetry();
    }
  });

  it('produces identical event frames across deterministic runs', () => {
    const first = runDeterministicSimulation();
    const second = runDeterministicSimulation();

    expect(second).toEqual(first);
  });

  it('exports AutomationState type', () => {
    // This is a compile-time test
    const testState: AutomationState = {
      id: 'test',
      enabled: true,
      lastFiredStep: 0,
      cooldownExpiresStep: 0,
      unlocked: true,
      lastThresholdSatisfied: false,
    };

    expect(testState.id).toBe('test');
  });
});

type FrameEventSnapshot = {
  readonly type: string;
  readonly channel: number;
  readonly issuedAt: number;
  readonly dispatchOrder: number;
  readonly payload: unknown;
};

type FrameSnapshot = {
  readonly tick: number;
  readonly manifestHash: string;
  readonly events: readonly FrameEventSnapshot[];
};

function runDeterministicSimulation(ticks = 3): FrameSnapshot[] {
  let timestamp = 0;
  const clock = {
    now(): number {
      timestamp += 1;
      return timestamp;
    },
  };

  const runtime = new IdleEngineRuntime({
    stepSizeMs: 10,
    maxStepsPerFrame: 4,
    eventBusOptions: {
      channels: DEFAULT_EVENT_BUS_OPTIONS.channels,
      clock,
    },
  });

  const bus = runtime.getEventBus();
  const pool = new TransportBufferPool();
  const automationQueue: Array<{ threshold: number }> = [];

  runtime.addSystem({
    id: 'resource-system',
    tick({ events, step }) {
      events.publish('resource:threshold-reached', {
        resourceId: 'energy',
        threshold: step + 1,
      });
    },
  });

  runtime.addSystem({
    id: 'automation-system',
    setup({ events }) {
      events.on('resource:threshold-reached', (event) => {
        automationQueue.push({ threshold: event.payload.threshold });
      });
    },
    tick({ events }) {
      while (automationQueue.length > 0) {
        const { threshold } = automationQueue.shift()!;
        events.publish('automation:toggled', {
          automationId: `collector:${threshold}`,
          enabled: threshold % 2 === 0,
        });
      }
    },
  });

  const frames: FrameSnapshot[] = [];

  for (let index = 0; index < ticks; index += 1) {
    runtime.tick(10);
    const processedStep = runtime.getCurrentStep() - 1;
    const exportState = bus.getFrameExportState();
    const frameResult = buildRuntimeEventFrame(bus, pool, {
      tick: processedStep,
      manifestHash: bus.getManifestHash(),
      owner: 'integration-test',
      format: exportState.format,
      diagnostics: exportState.diagnostics,
    });

    frames.push(snapshotFrame(frameResult.frame));
    frameResult.release();
  }

  return frames;
}

function snapshotFrame(frame: RuntimeEventFrame): FrameSnapshot {
  if (frame.format === 'object-array') {
    const events = frame.events.map((event) => {
      return {
        type: event.type,
        channel: event.channel,
        issuedAt: event.issuedAt,
        dispatchOrder: event.dispatchOrder,
        payload: JSON.parse(JSON.stringify(event.payload)),
      } satisfies FrameEventSnapshot;
    });

    return {
      tick: frame.tick,
      manifestHash: frame.manifestHash,
      events,
    };
  }

  const events: FrameEventSnapshot[] = new Array(frame.count);

  for (let index = 0; index < frame.count; index += 1) {
    const typeIndex = frame.typeIndices[index];

    events[index] = {
      type: frame.stringTable[typeIndex] ?? '',
      channel: frame.channelIndices[index],
      issuedAt: frame.issuedAt[index],
      dispatchOrder: frame.dispatchOrder[index],
      payload: JSON.parse(JSON.stringify(frame.payloads[index])),
    };
  }

  return {
    tick: frame.tick,
    manifestHash: frame.manifestHash,
    events,
  };
}
