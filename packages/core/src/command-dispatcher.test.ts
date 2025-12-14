import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Command } from './command.js';
import { CommandPriority } from './command.js';
import { CommandDispatcher } from './command-dispatcher.js';
import type { TelemetryFacade } from './telemetry.js';
import { resetTelemetry, setTelemetry } from './telemetry.js';

const baseCommand: Command = {
  type: 'TEST',
  priority: CommandPriority.PLAYER,
  payload: { value: 1 },
  timestamp: 123,
  step: 42,
};

afterEach(() => {
  resetTelemetry();
});

describe('CommandDispatcher', () => {
  it('executes registered handlers with command metadata context', () => {
    const dispatcher = new CommandDispatcher();
    const events = { publish: vi.fn() };
    dispatcher.setEventPublisher(events);
    const handler = vi.fn();

    dispatcher.register('TEST', handler);
    dispatcher.execute(baseCommand);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      baseCommand.payload,
      expect.objectContaining({
        step: baseCommand.step,
        timestamp: baseCommand.timestamp,
        priority: baseCommand.priority,
        events,
      }),
    );
  });

  it('returns a success result for handlers that return void', () => {
    const dispatcher = new CommandDispatcher();
    dispatcher.register('TEST', () => {});

    expect(dispatcher.executeWithResult(baseCommand)).toEqual({ success: true });
  });

  it('returns a failure result when handler returns a failure object', () => {
    const dispatcher = new CommandDispatcher();
    dispatcher.register('REJECT', () => ({
      success: false,
      error: {
        code: 'INSUFFICIENT_RESOURCES',
        message: 'Insufficient resources.',
      },
    }));

    expect(dispatcher.executeWithResult({ ...baseCommand, type: 'REJECT' })).toEqual({
      success: false,
      error: {
        code: 'INSUFFICIENT_RESOURCES',
        message: 'Insufficient resources.',
      },
    });
  });

  it('returns a failure result when async handler resolves to a failure object', async () => {
    const dispatcher = new CommandDispatcher();
    dispatcher.register('ASYNC_REJECT', async () => ({
      success: false,
      error: {
        code: 'INSUFFICIENT_RESOURCES',
        message: 'Insufficient resources.',
      },
    }));

    const result = await dispatcher.executeWithResult({
      ...baseCommand,
      type: 'ASYNC_REJECT',
    });

    expect(result).toEqual({
      success: false,
      error: {
        code: 'INSUFFICIENT_RESOURCES',
        message: 'Insufficient resources.',
      },
    });
  });

  it('records telemetry when handler throws', () => {
    const dispatcher = new CommandDispatcher();
    const telemetryStub: TelemetryFacade = {
      recordError: vi.fn(),
      recordWarning: vi.fn(),
      recordProgress: vi.fn(),
      recordCounters: vi.fn(),
      recordTick: vi.fn(),
    };
    setTelemetry(telemetryStub);

    dispatcher.register('FAIL', () => {
      throw new Error('boom');
    });

    const result = dispatcher.executeWithResult({ ...baseCommand, type: 'FAIL' });

    expect(telemetryStub.recordError).toHaveBeenCalledWith(
      'CommandExecutionFailed',
      {
        type: 'FAIL',
        error: 'boom',
      },
    );
    expect(result).toEqual({
      success: false,
      error: expect.objectContaining({
        code: 'COMMAND_EXECUTION_FAILED',
      }),
    });
  });

  it('records telemetry when command type is unknown', () => {
    const dispatcher = new CommandDispatcher();
    const telemetryStub: TelemetryFacade = {
      recordError: vi.fn(),
      recordWarning: vi.fn(),
      recordProgress: vi.fn(),
      recordCounters: vi.fn(),
      recordTick: vi.fn(),
    };
    setTelemetry(telemetryStub);

    const result = dispatcher.executeWithResult({ ...baseCommand, type: 'UNKNOWN' });

    expect(telemetryStub.recordError).toHaveBeenCalledWith(
      'UnknownCommandType',
      { type: 'UNKNOWN' },
    );
    expect(result).toEqual({
      success: false,
      error: expect.objectContaining({
        code: 'UNKNOWN_COMMAND_TYPE',
      }),
    });
  });

  it('returns a failure result and records telemetry when async handler rejects', async () => {
    const dispatcher = new CommandDispatcher();
    const telemetryStub: TelemetryFacade = {
      recordError: vi.fn(),
      recordWarning: vi.fn(),
      recordProgress: vi.fn(),
      recordCounters: vi.fn(),
      recordTick: vi.fn(),
    };
    setTelemetry(telemetryStub);

    dispatcher.register('ASYNC_THROW', () => Promise.reject(new Error('boom')));

    const result = await dispatcher.executeWithResult({
      ...baseCommand,
      type: 'ASYNC_THROW',
    });

    expect(telemetryStub.recordError).toHaveBeenCalledWith(
      'CommandExecutionFailed',
      {
        type: 'ASYNC_THROW',
        error: 'boom',
      },
    );
    expect(result).toEqual({
      success: false,
      error: expect.objectContaining({
        code: 'COMMAND_EXECUTION_FAILED',
      }),
    });
  });

  it('records telemetry when async handler rejects', async () => {
    const dispatcher = new CommandDispatcher();
    const telemetryStub: TelemetryFacade = {
      recordError: vi.fn(),
      recordWarning: vi.fn(),
      recordProgress: vi.fn(),
      recordCounters: vi.fn(),
      recordTick: vi.fn(),
    };
    setTelemetry(telemetryStub);

    dispatcher.register('ASYNC_FAIL', () => Promise.reject(new Error('boom')));

    dispatcher.execute({ ...baseCommand, type: 'ASYNC_FAIL' });

    await Promise.resolve();

    expect(telemetryStub.recordError).toHaveBeenCalledWith(
      'CommandExecutionFailed',
      {
        type: 'ASYNC_FAIL',
        error: 'boom',
      },
    );
  });

  it('skips execution and records telemetry when authorization fails', () => {
    const dispatcher = new CommandDispatcher();
    const handler = vi.fn();

    const telemetryStub: TelemetryFacade = {
      recordError: vi.fn(),
      recordWarning: vi.fn(),
      recordProgress: vi.fn(),
      recordCounters: vi.fn(),
      recordTick: vi.fn(),
    };
    setTelemetry(telemetryStub);

    dispatcher.register('PRESTIGE_RESET', handler);

    const result = dispatcher.executeWithResult({
      ...baseCommand,
      type: 'PRESTIGE_RESET',
      priority: CommandPriority.AUTOMATION,
    });

    expect(handler).not.toHaveBeenCalled();
    expect(telemetryStub.recordWarning).toHaveBeenCalledWith(
      'AutomationPrestigeBlocked',
      expect.objectContaining({
        type: 'PRESTIGE_RESET',
        attemptedPriority: CommandPriority.AUTOMATION,
        phase: 'live',
        reason: 'dispatcher',
      }),
    );
    expect(result).toEqual({
      success: false,
      error: expect.objectContaining({
        code: 'COMMAND_UNAUTHORIZED',
      }),
    });
  });

  it('exposes registered handlers via forEachHandler', () => {
    const dispatcher = new CommandDispatcher();
    const handlerA = vi.fn();
    const handlerB = vi.fn();
    dispatcher.register('A', handlerA);
    dispatcher.register('B', handlerB);

    const seen = new Map<string, unknown>();
    dispatcher.forEachHandler((type, handler) => {
      seen.set(type, handler);
    });

    expect(seen.get('A')).toBe(handlerA);
    expect(seen.get('B')).toBe(handlerB);
  });
});
