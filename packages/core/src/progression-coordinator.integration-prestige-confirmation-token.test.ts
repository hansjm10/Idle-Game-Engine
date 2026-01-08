import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TelemetryFacade } from './index.js';
import {
  createProgressionCoordinator,
  resetTelemetry,
  setTelemetry,
} from './index.js';
import {
  createContentPack,
  createPrestigeLayerDefinition,
  createResourceDefinition,
} from './content-test-helpers.js';

describe('Integration: prestige confirmationToken validation', () => {
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

  it('rejects prestige when no confirmation token provided', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 0,
    });

    const prestigeFlux = createResourceDefinition('resource.prestige-flux', {
      name: 'Prestige Flux',
      startAmount: 0,
    });

    const prestigeCount = createResourceDefinition('prestige.ascension-prestige-count', {
      name: 'Ascension Count',
      startAmount: 0,
    });

    const prestigeLayer = createPrestigeLayerDefinition('prestige.ascension', {
      name: 'Ascension',
      resetTargets: ['resource.energy'],
      unlockCondition: { kind: 'always' },
      reward: {
        resourceId: 'resource.prestige-flux',
        baseReward: { kind: 'constant', value: 1 },
      },
    });

    const pack = createContentPack({
      resources: [energy, prestigeFlux, prestigeCount],
      prestigeLayers: [prestigeLayer],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);

    // Attempt prestige without a token - should throw
    expect(() => {
      coordinator.prestigeEvaluator!.applyPrestige('prestige.ascension');
    }).toThrow('Prestige operation requires a confirmation token');
  });

  it('rejects prestige with duplicate confirmation token', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 0,
    });

    const prestigeFlux = createResourceDefinition('resource.prestige-flux', {
      name: 'Prestige Flux',
      startAmount: 0,
    });

    const prestigeCount = createResourceDefinition('prestige.ascension-prestige-count', {
      name: 'Ascension Count',
      startAmount: 0,
    });

    const prestigeLayer = createPrestigeLayerDefinition('prestige.ascension', {
      name: 'Ascension',
      resetTargets: ['resource.energy'],
      unlockCondition: { kind: 'always' },
      reward: {
        resourceId: 'resource.prestige-flux',
        baseReward: { kind: 'constant', value: 1 },
      },
    });

    const pack = createContentPack({
      resources: [energy, prestigeFlux, prestigeCount],
      prestigeLayers: [prestigeLayer],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);

    // First prestige with a token - should succeed
    coordinator.prestigeEvaluator!.applyPrestige('prestige.ascension', 'unique-token-123');

    // Second prestige with the same token - should throw
    expect(() => {
      coordinator.prestigeEvaluator!.applyPrestige('prestige.ascension', 'unique-token-123');
    }).toThrow('Confirmation token has already been used');

    // Verify telemetry warning was emitted
    expect(telemetryStub.recordWarning).toHaveBeenCalledWith(
      'PrestigeResetDuplicateToken',
      expect.objectContaining({ layerId: 'prestige.ascension' }),
    );
  });

  it('cleans up expired tokens from storage', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 100, // Start with enough to prestige multiple times
    });

    const prestigeFlux = createResourceDefinition('resource.prestige-flux', {
      name: 'Prestige Flux',
      startAmount: 0,
    });

    const prestigeCount = createResourceDefinition('prestige.ascension-prestige-count', {
      name: 'Ascension Count',
      startAmount: 0,
    });

    const prestigeLayer = createPrestigeLayerDefinition('prestige.ascension', {
      name: 'Ascension',
      resetTargets: ['resource.energy'],
      unlockCondition: { kind: 'always' },
      reward: {
        resourceId: 'resource.prestige-flux',
        baseReward: { kind: 'constant', value: 1 },
      },
    });

    const pack = createContentPack({
      resources: [energy, prestigeFlux, prestigeCount],
      prestigeLayers: [prestigeLayer],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);

    // Mock Date.now to control time
    let currentTime = 1000000;
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => currentTime);

    try {
      // First prestige at t=1000000
      coordinator.prestigeEvaluator!.applyPrestige('prestige.ascension', 'token-to-expire');

      // Try to use same token again at t=1000000 - should fail (duplicate)
      expect(() => {
        coordinator.prestigeEvaluator!.applyPrestige('prestige.ascension', 'token-to-expire');
      }).toThrow('Confirmation token has already been used');

      // Advance time by 61 seconds (past the 60 second expiration)
      currentTime += 61_000;

      // Restore enough energy to prestige again
      const energyIndex = coordinator.resourceState.requireIndex('resource.energy');
      coordinator.resourceState.addAmount(energyIndex, 100);
      coordinator.updateForStep(1);

      // Use a new token to trigger cleanup of expired tokens
      coordinator.prestigeEvaluator!.applyPrestige('prestige.ascension', 'trigger-cleanup');

      // Now the old token should have been cleaned up, so using it again should work
      // (it's no longer in the usedTokens map)
      coordinator.resourceState.addAmount(energyIndex, 100);
      coordinator.updateForStep(2);
      coordinator.prestigeEvaluator!.applyPrestige('prestige.ascension', 'token-to-expire');

      // If we got here without throwing, the test passes
      // The token was successfully reused after expiration
    } finally {
      dateNowSpy.mockRestore();
    }
  });
});
