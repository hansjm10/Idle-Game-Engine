import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TelemetryFacade } from './index.js';
import {
  createProgressionCoordinator,
  resetTelemetry,
  setTelemetry,
} from './index.js';
import {
  createContentPack,
  createGeneratorDefinition,
  createPrestigeLayerDefinition,
  createResourceDefinition,
  createUpgradeDefinition,
  literalOne,
} from './content-test-helpers.js';

describe('Integration: prestige reset with missing entities', () => {
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

  it('records telemetry warning when resetGenerators references non-existent generator', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 0,
    });

    const prestigeFlux = createResourceDefinition('resource.prestige-flux', {
      name: 'Prestige Flux',
      startAmount: 0,
    });

    const prestigeCount = createResourceDefinition('prestige.missing-gen-prestige-count', {
      name: 'Missing Gen Count',
      startAmount: 0,
    });

    const prestigeLayer = createPrestigeLayerDefinition('prestige.missing-gen', {
      name: 'Missing Gen Layer',
      resetTargets: [energy.id],
      resetGenerators: ['generator.does-not-exist'], // References non-existent generator
      unlockCondition: { kind: 'always' },
      reward: {
        resourceId: prestigeFlux.id,
        baseReward: literalOne,
      },
    });

    const content = createContentPack({
      resources: [energy, prestigeFlux, prestigeCount],
      generators: [], // No generators defined
      prestigeLayers: [prestigeLayer],
    });

    const coordinator = createProgressionCoordinator({
      content,
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);

    // Apply prestige - should log warning but not throw
    expect(() => {
      coordinator.prestigeEvaluator!.applyPrestige('prestige.missing-gen', 'test-token');
    }).not.toThrow();

    // Verify warning was recorded
    expect(telemetryStub.recordWarning).toHaveBeenCalledWith(
      'PrestigeResetGeneratorSkipped',
      expect.objectContaining({
        layerId: 'prestige.missing-gen',
        generatorId: 'generator.does-not-exist',
      }),
    );
  });

  it('records telemetry warning when resetUpgrades references non-existent upgrade', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 0,
    });

    const prestigeFlux = createResourceDefinition('resource.prestige-flux', {
      name: 'Prestige Flux',
      startAmount: 0,
    });

    const prestigeCount = createResourceDefinition('prestige.missing-upgrade-prestige-count', {
      name: 'Missing Upgrade Count',
      startAmount: 0,
    });

    const prestigeLayer = createPrestigeLayerDefinition('prestige.missing-upgrade', {
      name: 'Missing Upgrade Layer',
      resetTargets: [energy.id],
      resetUpgrades: ['upgrade.does-not-exist'], // References non-existent upgrade
      unlockCondition: { kind: 'always' },
      reward: {
        resourceId: prestigeFlux.id,
        baseReward: literalOne,
      },
    });

    const content = createContentPack({
      resources: [energy, prestigeFlux, prestigeCount],
      upgrades: [], // No upgrades defined
      prestigeLayers: [prestigeLayer],
    });

    const coordinator = createProgressionCoordinator({
      content,
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);

    // Apply prestige - should log warning but not throw
    expect(() => {
      coordinator.prestigeEvaluator!.applyPrestige('prestige.missing-upgrade', 'test-token');
    }).not.toThrow();

    // Verify warning was recorded
    expect(telemetryStub.recordWarning).toHaveBeenCalledWith(
      'PrestigeResetUpgradeSkipped',
      expect.objectContaining({
        layerId: 'prestige.missing-upgrade',
        upgradeId: 'upgrade.does-not-exist',
      }),
    );
  });

  it('continues resetting other entities even when some are missing', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 0,
    });

    const prestigeFlux = createResourceDefinition('resource.prestige-flux', {
      name: 'Prestige Flux',
      startAmount: 0,
    });

    const prestigeCount = createResourceDefinition('prestige.partial-prestige-count', {
      name: 'Partial Count',
      startAmount: 0,
    });

    const validGenerator = createGeneratorDefinition('generator.valid', {
      purchase: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
    });

    const validUpgrade = createUpgradeDefinition('upgrade.valid', {
      cost: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      effects: [],
    });

    const prestigeLayer = createPrestigeLayerDefinition('prestige.partial', {
      name: 'Partial Layer',
      resetTargets: [energy.id],
      resetGenerators: ['generator.does-not-exist', validGenerator.id],
      resetUpgrades: ['upgrade.does-not-exist', validUpgrade.id],
      unlockCondition: { kind: 'always' },
      reward: {
        resourceId: prestigeFlux.id,
        baseReward: literalOne,
      },
    });

    const content = createContentPack({
      resources: [energy, prestigeFlux, prestigeCount],
      generators: [validGenerator],
      upgrades: [validUpgrade],
      prestigeLayers: [prestigeLayer],
    });

    const coordinator = createProgressionCoordinator({
      content,
      stepDurationMs: 100,
    }) as unknown as {
      updateForStep(step: number): void;
      generatorEvaluator: { applyPurchase(id: string, count: number): void };
      upgradeEvaluator?: { applyPurchase(id: string): void };
      prestigeEvaluator?: { applyPrestige(layerId: string, token?: string): void };
      getGeneratorRecord(id: string): { state: { owned: number } } | undefined;
      getUpgradeRecord(id: string): { purchases: number } | undefined;
    };

    // Build up state
    coordinator.generatorEvaluator.applyPurchase(validGenerator.id, 5);
    coordinator.upgradeEvaluator?.applyPurchase(validUpgrade.id);

    expect(coordinator.getGeneratorRecord(validGenerator.id)?.state.owned).toBe(5);
    expect(coordinator.getUpgradeRecord(validUpgrade.id)?.purchases).toBe(1);

    // Apply prestige
    coordinator.prestigeEvaluator?.applyPrestige('prestige.partial', 'test-token');

    // Valid entities should have been reset despite the missing ones
    expect(coordinator.getGeneratorRecord(validGenerator.id)?.state.owned).toBe(0);
    expect(coordinator.getUpgradeRecord(validUpgrade.id)?.purchases).toBe(0);

    // Both warnings should be recorded
    expect(telemetryStub.recordWarning).toHaveBeenCalledWith(
      'PrestigeResetGeneratorSkipped',
      expect.objectContaining({
        generatorId: 'generator.does-not-exist',
      }),
    );
    expect(telemetryStub.recordWarning).toHaveBeenCalledWith(
      'PrestigeResetUpgradeSkipped',
      expect.objectContaining({
        upgradeId: 'upgrade.does-not-exist',
      }),
    );
  });
});
