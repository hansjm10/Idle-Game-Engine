import { describe, expect, it, vi } from 'vitest';

import { CommandPriority } from './command.js';
import { CommandDispatcher } from './command-dispatcher.js';
import { CommandQueue } from './command-queue.js';
import {
  IdleEngineRuntime,
  type IdleEngineRuntimeOptions,
} from './index.js';
import {
  resetTelemetry,
  setTelemetry,
  type TelemetryFacade,
} from './telemetry.js';

function createRuntime(
  overrides: Partial<IdleEngineRuntimeOptions> = {},
): {
  runtime: IdleEngineRuntime;
  queue: CommandQueue;
  dispatcher: CommandDispatcher;
} {
  const queue = overrides.commandQueue ?? new CommandQueue();
  const dispatcher =
    overrides.commandDispatcher ?? new CommandDispatcher();
  const runtime = new IdleEngineRuntime({
    stepSizeMs: 10,
    maxStepsPerFrame: 4,
    commandQueue: queue,
    commandDispatcher: dispatcher,
    ...overrides,
  });

  return { runtime, queue, dispatcher };
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
});
