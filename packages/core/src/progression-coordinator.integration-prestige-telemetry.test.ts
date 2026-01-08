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

describe('Integration: prestige telemetry', () => {
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

  it('emits telemetry when confirmationToken is provided', () => {
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

    // Apply prestige with a confirmation token
    coordinator.prestigeEvaluator!.applyPrestige('prestige.ascension', 'test-token-abc123');

    expect(telemetryStub.recordProgress).toHaveBeenCalledWith(
      'PrestigeResetTokenReceived',
      expect.objectContaining({
        layerId: 'prestige.ascension',
        tokenLength: 17, // 'test-token-abc123'.length
      }),
    );
  });
});

