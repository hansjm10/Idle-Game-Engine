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
    const handler = vi.fn();

    dispatcher.register('TEST', handler);
    dispatcher.execute(baseCommand);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(baseCommand.payload, {
      step: baseCommand.step,
      timestamp: baseCommand.timestamp,
      priority: baseCommand.priority,
    });
  });

  it('records telemetry when handler throws', () => {
    const dispatcher = new CommandDispatcher();
    const telemetryStub: TelemetryFacade = {
      recordError: vi.fn(),
      recordWarning: vi.fn(),
      recordProgress: vi.fn(),
      recordTick: vi.fn(),
    };
    setTelemetry(telemetryStub);

    dispatcher.register('FAIL', () => {
      throw new Error('boom');
    });

    dispatcher.execute({ ...baseCommand, type: 'FAIL' });

    expect(telemetryStub.recordError).toHaveBeenCalledWith(
      'CommandExecutionFailed',
      {
        type: 'FAIL',
        error: 'boom',
      },
    );
  });

  it('records telemetry when command type is unknown', () => {
    const dispatcher = new CommandDispatcher();
    const telemetryStub: TelemetryFacade = {
      recordError: vi.fn(),
      recordWarning: vi.fn(),
      recordProgress: vi.fn(),
      recordTick: vi.fn(),
    };
    setTelemetry(telemetryStub);

    dispatcher.execute({ ...baseCommand, type: 'UNKNOWN' });

    expect(telemetryStub.recordError).toHaveBeenCalledWith(
      'UnknownCommandType',
      { type: 'UNKNOWN' },
    );
  });

  it('records telemetry when async handler rejects', async () => {
    const dispatcher = new CommandDispatcher();
    const telemetryStub: TelemetryFacade = {
      recordError: vi.fn(),
      recordWarning: vi.fn(),
      recordProgress: vi.fn(),
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
      recordTick: vi.fn(),
    };
    setTelemetry(telemetryStub);

    dispatcher.register('PRESTIGE_RESET', handler);

    dispatcher.execute({
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
