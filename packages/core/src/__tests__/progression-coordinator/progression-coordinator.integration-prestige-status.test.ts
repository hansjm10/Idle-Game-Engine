import { describe, expect, it } from 'vitest';

import { createProgressionCoordinator } from '../../internals.js';
import {
  createContentPack,
  createPrestigeLayerDefinition,
  createResourceDefinition,
} from '../../content-test-helpers.js';

describe('Integration: prestige layer status transitions', () => {
  it('prestige layer state includes isUnlocked property', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 100,
    });

    const prestigeFlux = createResourceDefinition('resource.prestige-flux', {
      name: 'Prestige Flux',
    });

    const prestigeCount = createResourceDefinition('prestige.ascension-prestige-count', {
      name: 'Ascension Count',
      startAmount: 0,
    });

    const prestigeLayer = createPrestigeLayerDefinition('prestige.ascension', {
      name: 'Ascension',
      resetTargets: ['resource.energy'],
      unlockCondition: {
        kind: 'resourceThreshold',
        resourceId: 'resource.energy',
        comparator: 'gte',
        amount: { kind: 'constant', value: 500 },
      },
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

    // Initially locked (energy = 100, requirement = 500)
    coordinator.updateForStep(0);
    const layerState = coordinator.state.prestigeLayers?.find(
      (l) => l.id === 'prestige.ascension',
    );
    expect(layerState).toBeDefined();
    expect(layerState!.isUnlocked).toBe(false);
    expect(layerState!.isVisible).toBe(false);

    // Add enough energy to unlock
    const energyIndex = coordinator.resourceState.requireIndex('resource.energy');
    coordinator.resourceState.addAmount(energyIndex, 500);
    coordinator.updateForStep(1);

    const updatedLayerState = coordinator.state.prestigeLayers?.find(
      (l) => l.id === 'prestige.ascension',
    );
    expect(updatedLayerState!.isUnlocked).toBe(true);
    expect(updatedLayerState!.isVisible).toBe(true);
  });

  it('status is locked when prestige layer unlock condition is not met', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 100,
    });

    const prestigeFlux = createResourceDefinition('resource.prestige-flux', {
      name: 'Prestige Flux',
    });

    const prestigeCount = createResourceDefinition('prestige.ascension-prestige-count', {
      name: 'Ascension Count',
      startAmount: 0,
    });

    const prestigeLayer = createPrestigeLayerDefinition('prestige.ascension', {
      name: 'Ascension',
      resetTargets: ['resource.energy'],
      unlockCondition: {
        kind: 'resourceThreshold',
        resourceId: 'resource.energy',
        comparator: 'gte',
        amount: { kind: 'constant', value: 500 },
      },
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

    const quote = coordinator.prestigeEvaluator!.getPrestigeQuote('prestige.ascension');
    expect(quote).toBeDefined();
    expect(quote!.status).toBe('locked');
  });

  it('status is available when unlocked but never prestiged', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 0,
    });

    const prestigeFlux = createResourceDefinition('resource.prestige-flux', {
      name: 'Prestige Flux',
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

    const quote = coordinator.prestigeEvaluator!.getPrestigeQuote('prestige.ascension');
    expect(quote).toBeDefined();
    expect(quote!.status).toBe('available');
  });

  it('status is completed after applying prestige (with prestige count resource)', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 0,
    });

    const prestigeFlux = createResourceDefinition('resource.prestige-flux', {
      name: 'Prestige Flux',
    });

    // Prestige count resource tracks number of times prestige has been applied
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

    // Before prestige: status should be 'available'
    let quote = coordinator.prestigeEvaluator!.getPrestigeQuote('prestige.ascension');
    expect(quote!.status).toBe('available');

    // Apply prestige
    coordinator.prestigeEvaluator!.applyPrestige('prestige.ascension', 'test-token');
    coordinator.updateForStep(1);

    // After prestige: status should be 'completed' (prestige count >= 1)
    quote = coordinator.prestigeEvaluator!.getPrestigeQuote('prestige.ascension');
    expect(quote!.status).toBe('completed');
  });

  it('throws error when prestige count resource does not exist', () => {
    // Fail-fast validation ensures content authors don't forget the prestige count resource
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 0,
    });

    const prestigeFlux = createResourceDefinition('resource.prestige-flux', {
      name: 'Prestige Flux',
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
      resources: [energy, prestigeFlux],
      // Missing: prestige.ascension-prestige-count resource
      prestigeLayers: [prestigeLayer],
    });

    // Should throw during initialization due to missing prestige count resource
    expect(() => {
      createProgressionCoordinator({
        content: pack,
        stepDurationMs: 100,
      });
    }).toThrow('prestige.ascension-prestige-count');
  });

  it('prestige counter is preserved when included in resetTargets', () => {
    // This test verifies that the prestige counter resource is automatically
    // protected from being reset, even if it's included in resetTargets.
    // Without this protection, multi-prestige tracking would break:
    // - First prestige: counter reset to 0, then incremented to 1
    // - Second prestige: counter reset to 0, then incremented to 1 (should be 2!)

    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 0,
    });

    const prestigeFlux = createResourceDefinition('resource.prestige-flux', {
      name: 'Prestige Flux',
      startAmount: 0,
    });

    // The prestige counter resource follows the convention: {layerId}-prestige-count
    const prestigeCount = createResourceDefinition('prestige.ascension-prestige-count', {
      name: 'Ascension Count',
      startAmount: 0,
    });

    const prestigeLayer = createPrestigeLayerDefinition('prestige.ascension', {
      name: 'Ascension',
      // Bug scenario: resetTargets includes the prestige counter
      resetTargets: ['resource.energy', 'prestige.ascension-prestige-count'],
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

    const energyIndex = coordinator.resourceState.requireIndex('resource.energy');
    const countIndex = coordinator.resourceState.requireIndex('prestige.ascension-prestige-count');

    // First prestige
    coordinator.resourceState.addAmount(energyIndex, 100);
    coordinator.updateForStep(0);
    coordinator.prestigeEvaluator!.applyPrestige('prestige.ascension', 'test-token-1');

    // Count should be 1 after first prestige
    expect(coordinator.resourceState.getAmount(countIndex)).toBe(1);

    // Second prestige
    coordinator.resourceState.addAmount(energyIndex, 100);
    coordinator.updateForStep(1);
    coordinator.prestigeEvaluator!.applyPrestige('prestige.ascension', 'test-token-2');

    // Key assertion: count should be 2, NOT 1
    // If the counter is being reset before increment, this would fail
    expect(coordinator.resourceState.getAmount(countIndex)).toBe(2);

    // Third prestige for good measure
    coordinator.resourceState.addAmount(energyIndex, 100);
    coordinator.updateForStep(2);
    coordinator.prestigeEvaluator!.applyPrestige('prestige.ascension', 'test-token-3');

    expect(coordinator.resourceState.getAmount(countIndex)).toBe(3);
  });

  it('bonus layer with empty resetTargets grants reward without resetting any resources', () => {
    // Bonus layers have empty resetTargets - they grant rewards without sacrifice.
    // Use cases: milestone rewards, achievement-style prestige, tutorial layers.
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 0,
    });

    const crystal = createResourceDefinition('resource.crystal', {
      name: 'Crystal',
      startAmount: 0,
    });

    const prestigeFlux = createResourceDefinition('resource.prestige-flux', {
      name: 'Prestige Flux',
      startAmount: 0,
    });

    const prestigeCount = createResourceDefinition('prestige.bonus-prestige-count', {
      name: 'Bonus Prestige Count',
      startAmount: 0,
    });

    const bonusLayer = createPrestigeLayerDefinition('prestige.bonus', {
      name: 'Bonus Layer',
      resetTargets: [], // Empty - no resources are reset
      unlockCondition: { kind: 'always' },
      reward: {
        resourceId: 'resource.prestige-flux',
        baseReward: { kind: 'constant', value: 50 },
      },
    });

    const pack = createContentPack({
      resources: [energy, crystal, prestigeFlux, prestigeCount],
      prestigeLayers: [bonusLayer],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    // Setup: Give player resources
    const energyIndex = coordinator.resourceState.requireIndex('resource.energy');
    const crystalIndex = coordinator.resourceState.requireIndex('resource.crystal');
    const prestigeFluxIndex = coordinator.resourceState.requireIndex('resource.prestige-flux');

    coordinator.resourceState.addAmount(energyIndex, 500);
    coordinator.resourceState.addAmount(crystalIndex, 200);
    coordinator.updateForStep(0);

    // Verify initial state
    expect(coordinator.resourceState.getAmount(energyIndex)).toBe(500);
    expect(coordinator.resourceState.getAmount(crystalIndex)).toBe(200);
    expect(coordinator.resourceState.getAmount(prestigeFluxIndex)).toBe(0);

    // Apply bonus prestige
    coordinator.prestigeEvaluator!.applyPrestige('prestige.bonus', 'token-bonus');

    // Reward should be granted
    expect(coordinator.resourceState.getAmount(prestigeFluxIndex)).toBe(50);

    // All other resources should remain unchanged (empty resetTargets = no resets)
    expect(coordinator.resourceState.getAmount(energyIndex)).toBe(500);
    expect(coordinator.resourceState.getAmount(crystalIndex)).toBe(200);
  });
});

