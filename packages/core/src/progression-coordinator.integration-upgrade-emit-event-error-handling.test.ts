import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TelemetryFacade } from './index.js';
import {
  createMockEventPublisher,
  createProgressionCoordinator,
  resetTelemetry,
  setTelemetry,
} from './index.js';
import {
  createContentPack,
  createResourceDefinition,
  createUpgradeDefinition,
  literalOne,
} from './content-test-helpers.js';

describe('Integration: upgrade emitEvent effect error handling', () => {
  let telemetryStub: TelemetryFacade;

  beforeEach(() => {
    telemetryStub = {
      recordError: vi.fn(),
      recordWarning: vi.fn(),
      recordProgress: vi.fn(),
      recordCounters: vi.fn(),
      recordTick: vi.fn(),
    };
    setTelemetry(telemetryStub);
  });

  afterEach(() => {
    resetTelemetry();
    vi.restoreAllMocks();
  });

  it('records telemetry warning when emitEvent effect fails to publish', () => {
    const energy = createResourceDefinition('resource.energy', { name: 'Energy' });

    const upgrade = createUpgradeDefinition('upgrade.emit-fail', {
      name: 'Emit Fail Upgrade',
      cost: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      effects: [
        {
          kind: 'emitEvent',
          eventId: 'test.event.fail',
        },
      ],
    });

    const content = createContentPack({
      resources: [energy],
      upgrades: [upgrade],
    });

    const coordinator = createProgressionCoordinator({
      content,
      stepDurationMs: 100,
    });

    // Create a mock event publisher that throws
    const mockPublisher = createMockEventPublisher();
    vi.spyOn(mockPublisher, 'publish').mockImplementation(() => {
      throw new Error('Event channel not registered');
    });

    // Apply purchase with event publisher
    coordinator.upgradeEvaluator?.applyPurchase('upgrade.emit-fail', {
      events: mockPublisher,
    });

    // Verify the warning was recorded
    expect(telemetryStub.recordWarning).toHaveBeenCalledWith(
      'UpgradeEmitEventFailed',
      expect.objectContaining({
        upgradeId: 'upgrade.emit-fail',
        eventId: 'test.event.fail',
        message: 'Event channel not registered',
      }),
    );
  });

  it('continues to emit other events even when one fails', () => {
    const energy = createResourceDefinition('resource.energy', { name: 'Energy' });

    const upgrade = createUpgradeDefinition('upgrade.multi-emit', {
      name: 'Multi Emit Upgrade',
      cost: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      effects: [
        { kind: 'emitEvent', eventId: 'test.event.first' },
        { kind: 'emitEvent', eventId: 'test.event.second' },
        { kind: 'grantFlag', flagId: 'flag.test', value: true },
      ],
    });

    const content = createContentPack({
      resources: [energy],
      upgrades: [upgrade],
    });

    const coordinator = createProgressionCoordinator({
      content,
      stepDurationMs: 100,
    });

    const mockPublisher = createMockEventPublisher();
    let callCount = 0;
    vi.spyOn(mockPublisher, 'publish').mockImplementation(((eventType: unknown) => {
      callCount++;
      if (callCount === 1) {
        throw new Error('First event failed');
      }
      // Second event succeeds - return a valid PublishResult
      return {
        accepted: true,
        state: 'accepted' as const,
        type: eventType,
        channel: 0,
        bufferSize: 0,
        remainingCapacity: 100,
        dispatchOrder: 0,
        softLimitActive: false,
      };
    }) as typeof mockPublisher.publish);

    coordinator.upgradeEvaluator?.applyPurchase('upgrade.multi-emit', {
      events: mockPublisher,
    });

    // Both events should have been attempted
    expect(mockPublisher.publish).toHaveBeenCalledTimes(2);
    // Warning should be recorded for the failed one
    expect(telemetryStub.recordWarning).toHaveBeenCalledWith(
      'UpgradeEmitEventFailed',
      expect.objectContaining({
        eventId: 'test.event.first',
      }),
    );
  });
});
