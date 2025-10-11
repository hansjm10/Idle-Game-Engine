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
        step: 5,
      });

      runtime.tick(10);

      expect(handler).not.toHaveBeenCalled();
      expect(errors).toEqual([
        {
          event: 'CommandStepMismatch',
          data: {
            commandStep: 5,
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
});
