import { describe, expect, it } from 'vitest';

import { createProgressionCoordinator } from '../../index.js';
import {
  createContentPack,
  createPrestigeLayerDefinition,
  createResourceDefinition,
} from '../../content-test-helpers.js';

describe('Integration: prestige system applyPrestige', () => {
  it('throws error when prestige layer is locked', () => {
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
        baseReward: { kind: 'constant', value: 1 },
      },
      retention: [],
    });

    const pack = createContentPack({
      resources: [energy, prestigeFlux, prestigeCount],
      prestigeLayers: [prestigeLayer],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    // Only add 500 energy - not enough to unlock
    const energyIndex = coordinator.resourceState.requireIndex('resource.energy');
    coordinator.resourceState.addAmount(energyIndex, 500);
    coordinator.updateForStep(0);

    // Verify layer is locked
    const quote = coordinator.prestigeEvaluator!.getPrestigeQuote('prestige.ascension');
    expect(quote!.status).toBe('locked');

    // Attempting to apply prestige should throw
    expect(() => {
      coordinator.prestigeEvaluator!.applyPrestige('prestige.ascension', 'test-token');
    }).toThrow('locked');
  });

  it('throws error when prestige layer not found', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
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
        resourceId: 'resource.energy',
        baseReward: { kind: 'constant', value: 1 },
      },
    });

    const pack = createContentPack({
      resources: [energy, prestigeCount],
      prestigeLayers: [prestigeLayer],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);

    expect(() => {
      coordinator.prestigeEvaluator!.applyPrestige('prestige.nonexistent', 'test-token');
    }).toThrow('not found');
  });

  it('resets non-retained resources to startAmount', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 50, // Custom startAmount
    });

    const crystal = createResourceDefinition('resource.crystal', {
      name: 'Crystal',
      startAmount: 25,
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
      resetTargets: ['resource.energy', 'resource.crystal'],
      unlockCondition: { kind: 'always' },
      reward: {
        resourceId: 'resource.prestige-flux',
        baseReward: { kind: 'constant', value: 10 },
      },
      retention: [], // No retention - all reset targets should reset
    });

    const pack = createContentPack({
      resources: [energy, crystal, prestigeFlux, prestigeCount],
      prestigeLayers: [prestigeLayer],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    // Setup: energy = 1000, crystal = 500
    const energyIndex = coordinator.resourceState.requireIndex('resource.energy');
    const crystalIndex = coordinator.resourceState.requireIndex('resource.crystal');
    coordinator.resourceState.addAmount(energyIndex, 1000);
    coordinator.resourceState.addAmount(crystalIndex, 500);
    coordinator.updateForStep(0);

    // Apply prestige
    coordinator.prestigeEvaluator!.applyPrestige('prestige.ascension', 'test-token');

    // Energy should reset to startAmount (50)
    expect(coordinator.resourceState.getAmount(energyIndex)).toBe(50);

    // Crystal should reset to startAmount (25)
    expect(coordinator.resourceState.getAmount(crystalIndex)).toBe(25);
  });

  it('skips resetting resources that are in retention list', () => {
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
      // Retain energy with no formula (keep existing value)
      retention: [
        {
          kind: 'resource',
          resourceId: 'resource.energy',
          // No amount formula = don't modify after reset skip
        },
      ],
    });

    const pack = createContentPack({
      resources: [energy, prestigeFlux, prestigeCount],
      prestigeLayers: [prestigeLayer],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    // Setup: energy = 1000
    const energyIndex = coordinator.resourceState.requireIndex('resource.energy');
    coordinator.resourceState.addAmount(energyIndex, 1000);
    coordinator.updateForStep(0);

    // Apply prestige
    coordinator.prestigeEvaluator!.applyPrestige('prestige.ascension', 'test-token');

    // Energy should be unchanged because it's in retention without a formula
    expect(coordinator.resourceState.getAmount(energyIndex)).toBe(1000);
  });
});

