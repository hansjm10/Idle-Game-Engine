import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TelemetryFacade } from '../../internals.js';
import {
  createProgressionCoordinator,
  resetTelemetry,
  setTelemetry,
} from '../../internals.js';
import {
  createContentPack,
  createPrestigeLayerDefinition,
  createResourceDefinition,
} from '../../content-test-helpers.js';

describe('Integration: PRESTIGE_RESET command handler with real evaluator', () => {
  // These tests exercise the full command flow through registerResourceCommandHandlers
  // using the real ContentPrestigeEvaluator, verifying end-to-end resource mutations.

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

  it('executes prestige reset via command dispatcher and mutates resource state', async () => {
    // Import command infrastructure
    const { CommandDispatcher, registerResourceCommandHandlers, RUNTIME_COMMAND_TYPES, CommandPriority } = await import('../../internals.js');

    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 10,
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
        baseReward: { kind: 'constant', value: 5 },
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

    // Setup: Give player 1000 energy
    const energyIndex = coordinator.resourceState.requireIndex('resource.energy');
    const prestigeFluxIndex = coordinator.resourceState.requireIndex('resource.prestige-flux');
    coordinator.resourceState.addAmount(energyIndex, 1000);
    coordinator.updateForStep(0);

    // Wire up command dispatcher with real prestige evaluator
    const dispatcher = new CommandDispatcher();
    registerResourceCommandHandlers({
      dispatcher,
      resources: coordinator.resourceState,
      generatorPurchases: coordinator.generatorEvaluator,
      prestigeSystem: coordinator.prestigeEvaluator,
    });

    // Verify pre-prestige state
    expect(coordinator.resourceState.getAmount(energyIndex)).toBe(1010); // 1000 + 10 startAmount
    expect(coordinator.resourceState.getAmount(prestigeFluxIndex)).toBe(0);

    // Execute PRESTIGE_RESET command
    dispatcher.execute({
      type: RUNTIME_COMMAND_TYPES.PRESTIGE_RESET,
      payload: { layerId: 'prestige.ascension', confirmationToken: 'test-token' },
      priority: CommandPriority.PLAYER,
      timestamp: Date.now(),
      step: 1,
    });

    // Verify post-prestige state
    // Energy should be reset to startAmount (10)
    expect(coordinator.resourceState.getAmount(energyIndex)).toBe(10);
    // Prestige flux should be granted (5)
    expect(coordinator.resourceState.getAmount(prestigeFluxIndex)).toBe(5);

    // Verify telemetry was emitted
    expect(telemetryStub.recordProgress).toHaveBeenCalledWith(
      'PrestigeResetConfirmed',
      expect.objectContaining({
        layerId: 'prestige.ascension',
      }),
    );
  });

  it('rejects locked prestige layer via command dispatcher', async () => {
    const { CommandDispatcher, registerResourceCommandHandlers, RUNTIME_COMMAND_TYPES, CommandPriority } = await import('../../internals.js');

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
      // Requires 1000 energy to unlock
      unlockCondition: {
        kind: 'resourceThreshold',
        resourceId: 'resource.energy',
        comparator: 'gte',
        amount: { kind: 'constant', value: 1000 },
      },
      reward: {
        resourceId: 'resource.prestige-flux',
        baseReward: { kind: 'constant', value: 5 },
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

    // Only 100 energy - not enough to unlock
    const energyIndex = coordinator.resourceState.requireIndex('resource.energy');
    coordinator.resourceState.addAmount(energyIndex, 100);
    coordinator.updateForStep(0);

    const dispatcher = new CommandDispatcher();
    registerResourceCommandHandlers({
      dispatcher,
      resources: coordinator.resourceState,
      generatorPurchases: coordinator.generatorEvaluator,
      prestigeSystem: coordinator.prestigeEvaluator,
    });

    // Execute PRESTIGE_RESET command on locked layer
    dispatcher.execute({
      type: RUNTIME_COMMAND_TYPES.PRESTIGE_RESET,
      payload: { layerId: 'prestige.ascension', confirmationToken: 'test-token' },
      priority: CommandPriority.PLAYER,
      timestamp: Date.now(),
      step: 1,
    });

    // Energy should remain unchanged (not reset)
    expect(coordinator.resourceState.getAmount(energyIndex)).toBe(100);

    // Verify PrestigeResetLocked warning was emitted
    expect(telemetryStub.recordWarning).toHaveBeenCalledWith(
      'PrestigeResetLocked',
      expect.objectContaining({
        layerId: 'prestige.ascension',
      }),
    );
  });

  it('handles repeatable prestige (completed status) via command dispatcher', async () => {
    const { CommandDispatcher, registerResourceCommandHandlers, RUNTIME_COMMAND_TYPES, CommandPriority } = await import('../../internals.js');

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
        baseReward: { kind: 'constant', value: 10 },
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

    const energyIndex = coordinator.resourceState.requireIndex('resource.energy');
    const prestigeFluxIndex = coordinator.resourceState.requireIndex('resource.prestige-flux');
    const countIndex = coordinator.resourceState.requireIndex('prestige.ascension-prestige-count');

    const dispatcher = new CommandDispatcher();
    registerResourceCommandHandlers({
      dispatcher,
      resources: coordinator.resourceState,
      generatorPurchases: coordinator.generatorEvaluator,
      prestigeSystem: coordinator.prestigeEvaluator,
    });

    // First prestige
    coordinator.resourceState.addAmount(energyIndex, 500);
    coordinator.updateForStep(0);

    dispatcher.execute({
      type: RUNTIME_COMMAND_TYPES.PRESTIGE_RESET,
      payload: { layerId: 'prestige.ascension', confirmationToken: 'test-token-1' },
      priority: CommandPriority.PLAYER,
      timestamp: Date.now(),
      step: 1,
    });

    expect(coordinator.resourceState.getAmount(prestigeFluxIndex)).toBe(10);
    expect(coordinator.resourceState.getAmount(countIndex)).toBe(1);

    // Second prestige (layer status is now 'completed')
    coordinator.resourceState.addAmount(energyIndex, 500);
    coordinator.updateForStep(1);

    // Verify status is 'completed' before second prestige
    const quote = coordinator.prestigeEvaluator!.getPrestigeQuote('prestige.ascension');
    expect(quote!.status).toBe('completed');

    dispatcher.execute({
      type: RUNTIME_COMMAND_TYPES.PRESTIGE_RESET,
      payload: { layerId: 'prestige.ascension', confirmationToken: 'test-token-2' },
      priority: CommandPriority.PLAYER,
      timestamp: Date.now(),
      step: 2,
    });

    // Flux should accumulate (10 + 10 = 20)
    expect(coordinator.resourceState.getAmount(prestigeFluxIndex)).toBe(20);
    // Count should increment to 2
    expect(coordinator.resourceState.getAmount(countIndex)).toBe(2);
  });

  it('passes confirmationToken through full command flow', async () => {
    const { CommandDispatcher, registerResourceCommandHandlers, RUNTIME_COMMAND_TYPES, CommandPriority } = await import('../../internals.js');

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

    const dispatcher = new CommandDispatcher();
    registerResourceCommandHandlers({
      dispatcher,
      resources: coordinator.resourceState,
      generatorPurchases: coordinator.generatorEvaluator,
      prestigeSystem: coordinator.prestigeEvaluator,
    });

    // Execute with confirmationToken
    dispatcher.execute({
      type: RUNTIME_COMMAND_TYPES.PRESTIGE_RESET,
      payload: {
        layerId: 'prestige.ascension',
        confirmationToken: 'user-confirmed-prestige-token',
      },
      priority: CommandPriority.PLAYER,
      timestamp: Date.now(),
      step: 1,
    });

    // Token receipt should be logged via telemetry
    expect(telemetryStub.recordProgress).toHaveBeenCalledWith(
      'PrestigeResetTokenReceived',
      expect.objectContaining({
        layerId: 'prestige.ascension',
        tokenLength: 'user-confirmed-prestige-token'.length,
      }),
    );
  });
});
