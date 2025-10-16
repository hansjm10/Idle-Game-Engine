import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EventDiagnostics } from './event-diagnostics.js';
import {
  resetTelemetry,
  setTelemetry,
  type TelemetryFacade,
} from '../telemetry.js';

describe('EventDiagnostics', () => {
  const telemetryMock: TelemetryFacade = {
    recordError: vi.fn(),
    recordWarning: vi.fn(),
    recordProgress: vi.fn(),
    recordCounters: vi.fn(),
    recordTick: vi.fn(),
  };

  beforeEach(() => {
    resetTelemetry();
    for (const method of Object.values(telemetryMock)) {
      method.mockReset?.();
    }
    setTelemetry(telemetryMock);
  });

  afterEach(() => {
    resetTelemetry();
  });

  it('emits exponential backoff for repeated soft limit breaches', () => {
    const diagnostics = new EventDiagnostics([
      {
        maxEventsPerTick: 4,
        maxEventsPerSecond: 8,
        cooldownTicks: 1,
        maxCooldownTicks: 8,
      },
    ]);

    diagnostics.beginTick(0);
    diagnostics.handleSoftLimit({
      channel: 0,
      tick: 0,
      eventType: 'resource:threshold-reached',
      timestamp: 0,
      reason: 'soft-limit',
      bufferSize: 4,
      capacity: 8,
      softLimit: 4,
      remainingCapacity: 4,
    });

    expect(telemetryMock.recordWarning).toHaveBeenCalledTimes(1);
    expect(telemetryMock.recordWarning).toHaveBeenLastCalledWith(
      'EventSoftLimitBreach',
      expect.objectContaining({
        channel: 0,
        tick: 0,
        cooldownTicks: 1,
      }),
    );
    expect(telemetryMock.recordCounters).toHaveBeenCalledWith(
      'events.soft_limit_breaches',
      expect.objectContaining({ 'channel:0': 1 }),
    );

    diagnostics.handleSoftLimit({
      channel: 0,
      tick: 0,
      eventType: 'resource:threshold-reached',
      timestamp: 1,
      reason: 'soft-limit',
      bufferSize: 5,
      capacity: 8,
      softLimit: 4,
      remainingCapacity: 3,
    });

    expect(telemetryMock.recordWarning).toHaveBeenCalledTimes(1);

    diagnostics.beginTick(1);
    diagnostics.handleSoftLimit({
      channel: 0,
      tick: 1,
      eventType: 'resource:threshold-reached',
      timestamp: 2,
      reason: 'soft-limit',
      bufferSize: 6,
      capacity: 8,
      softLimit: 4,
      remainingCapacity: 2,
    });

    expect(telemetryMock.recordWarning).toHaveBeenCalledTimes(2);
    expect(telemetryMock.recordWarning).toHaveBeenLastCalledWith(
      'EventSoftLimitBreach',
      expect.objectContaining({
        channel: 0,
        tick: 1,
        cooldownTicks: 2,
      }),
    );

    diagnostics.beginTick(2);
    diagnostics.handleSoftLimit({
      channel: 0,
      tick: 2,
      eventType: 'resource:threshold-reached',
      timestamp: 3,
      reason: 'soft-limit',
      bufferSize: 6,
      capacity: 8,
      softLimit: 4,
      remainingCapacity: 2,
    });

    expect(telemetryMock.recordWarning).toHaveBeenCalledTimes(2);

    diagnostics.beginTick(3);
    diagnostics.handleSoftLimit({
      channel: 0,
      tick: 3,
      eventType: 'resource:threshold-reached',
      timestamp: 4,
      reason: 'soft-limit',
      bufferSize: 6,
      capacity: 8,
      softLimit: 4,
      remainingCapacity: 2,
    });

    expect(telemetryMock.recordWarning).toHaveBeenCalledTimes(3);
    expect(telemetryMock.recordWarning).toHaveBeenLastCalledWith(
      'EventSoftLimitBreach',
      expect.objectContaining({
        channel: 0,
        tick: 3,
        cooldownTicks: 4,
      }),
    );

    const snapshot = diagnostics.getChannelSnapshot(0, 3);
    expect(snapshot).toEqual(
      expect.objectContaining({
        channel: 0,
        breaches: 3,
        cooldownTicksRemaining: 4,
      }),
    );
  });

  it('logs rate-per-second breaches once per cooldown window', () => {
    const diagnostics = new EventDiagnostics([
      {
        maxEventsPerTick: 8,
        maxEventsPerSecond: 3,
        cooldownTicks: 1,
        maxCooldownTicks: 4,
      },
    ]);

    diagnostics.beginTick(0);
    diagnostics.recordPublish(0, 0, 0, 'resource:threshold-reached');
    diagnostics.recordPublish(0, 0, 50, 'resource:threshold-reached');
    diagnostics.recordPublish(0, 0, 75, 'resource:threshold-reached');

    expect(telemetryMock.recordWarning).toHaveBeenCalledTimes(1);
    expect(telemetryMock.recordWarning).toHaveBeenCalledWith(
      'EventSoftLimitBreach',
      expect.objectContaining({ reason: 'rate-per-second' }),
    );

    diagnostics.recordPublish(0, 0, 100, 'resource:threshold-reached');
    expect(telemetryMock.recordWarning).toHaveBeenCalledTimes(1);

    diagnostics.beginTick(1);
    diagnostics.recordPublish(0, 1, 1100, 'resource:threshold-reached');
    diagnostics.recordPublish(0, 1, 1150, 'resource:threshold-reached');
    diagnostics.recordPublish(0, 1, 1200, 'resource:threshold-reached');

    expect(telemetryMock.recordWarning).toHaveBeenCalledTimes(2);
  });
});
