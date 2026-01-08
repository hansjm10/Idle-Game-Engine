import { describe, expect, it } from 'vitest';

import { createProgressionCoordinator } from '../../index.js';
import {
  createContentPack,
  createGeneratorDefinition,
  createResourceDefinition,
  createUpgradeDefinition,
  literalOne,
} from '../../content-test-helpers.js';
import { buildProgressionSnapshot } from '../../progression.js';

describe('Integration: upgrade effects', () => {
  it('applies modifyResourceCapacity add effects to resource capacity and clamping', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      capacity: 10,
    });

    const upgrade = createUpgradeDefinition('upgrade.capacity-add', {
      name: 'Capacity Boost',
      cost: {
        currencyId: energy.id,
        costMultiplier: 0,
        costCurve: literalOne,
      },
      effects: [
        {
          kind: 'modifyResourceCapacity',
          resourceId: energy.id,
          operation: 'add',
          value: { kind: 'constant', value: 5 },
        },
      ],
    });

    const pack = createContentPack({
      resources: [energy],
      upgrades: [upgrade],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    const energyIndex = coordinator.resourceState.requireIndex(energy.id);
    coordinator.resourceState.addAmount(energyIndex, 20);
    expect(coordinator.resourceState.getAmount(energyIndex)).toBe(10);

    coordinator.incrementUpgradePurchases(upgrade.id);

    expect(coordinator.resourceState.getCapacity(energyIndex)).toBeCloseTo(15);
    coordinator.resourceState.addAmount(energyIndex, 10);
    expect(coordinator.resourceState.getAmount(energyIndex)).toBe(15);

    const snapshot = buildProgressionSnapshot(0, 0, coordinator.state);
    const view = snapshot.resources.find((resource) => resource.id === energy.id);
    expect(view?.capacity).toBeCloseTo(15);
  });

  it('applies modifyResourceCapacity multiply effects to resource capacity', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      capacity: 12,
    });

    const upgrade = createUpgradeDefinition('upgrade.capacity-multiply', {
      name: 'Capacity Multiplier',
      cost: {
        currencyId: energy.id,
        costMultiplier: 0,
        costCurve: literalOne,
      },
      effects: [
        {
          kind: 'modifyResourceCapacity',
          resourceId: energy.id,
          operation: 'multiply',
          value: { kind: 'constant', value: 2 },
        },
      ],
    });

    const pack = createContentPack({
      resources: [energy],
      upgrades: [upgrade],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    const energyIndex = coordinator.resourceState.requireIndex(energy.id);
    coordinator.incrementUpgradePurchases(upgrade.id);

    expect(coordinator.resourceState.getCapacity(energyIndex)).toBeCloseTo(24);
    coordinator.resourceState.addAmount(energyIndex, 30);
    expect(coordinator.resourceState.getAmount(energyIndex)).toBe(24);
  });

  it('applies unlockResource and unlockGenerator upgrade effects immediately', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });
    const hidden = createResourceDefinition('resource.hidden', {
      name: 'Hidden',
      unlocked: false,
      visible: false,
      unlockCondition: { kind: 'never' },
      visibilityCondition: { kind: 'never' },
    });

    const generator = createGeneratorDefinition('generator.hidden', {
      name: 'Hidden Generator',
      purchase: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      baseUnlock: { kind: 'never' },
      visibilityCondition: { kind: 'never' },
    });

    const upgrade = createUpgradeDefinition('upgrade.unlock-stuff', {
      name: 'Unlock Stuff',
      cost: {
        currencyId: energy.id,
        costMultiplier: 0,
        costCurve: literalOne,
      },
      effects: [
        { kind: 'unlockResource', resourceId: hidden.id },
        { kind: 'unlockGenerator', generatorId: generator.id },
      ],
    });

    const pack = createContentPack({
      resources: [energy, hidden],
      generators: [generator],
      upgrades: [upgrade],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    const hiddenIndex = coordinator.resourceState.requireIndex(hidden.id);
    expect(coordinator.resourceState.isUnlocked(hiddenIndex)).toBe(false);
    expect(coordinator.resourceState.isVisible(hiddenIndex)).toBe(false);
    expect(coordinator.generatorEvaluator.getPurchaseQuote(generator.id, 1)).toBeUndefined();

    coordinator.incrementUpgradePurchases(upgrade.id);

    expect(coordinator.resourceState.isUnlocked(hiddenIndex)).toBe(true);
    expect(coordinator.resourceState.isVisible(hiddenIndex)).toBe(true);
    expect(coordinator.generatorEvaluator.getPurchaseQuote(generator.id, 1)).toBeDefined();
  });

  it('applies alterDirtyTolerance upgrade effects to resource state', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      dirtyTolerance: 0.001,
    });

    const upgrade = createUpgradeDefinition('upgrade.dirty-tolerance', {
      name: 'Dirty Tolerance Override',
      cost: {
        currencyId: energy.id,
        costMultiplier: 0,
        costCurve: literalOne,
      },
      effects: [
        {
          kind: 'alterDirtyTolerance',
          resourceId: energy.id,
          operation: 'set',
          value: { kind: 'constant', value: 0.01 },
        },
      ],
    });

    const pack = createContentPack({
      resources: [energy],
      upgrades: [upgrade],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    const energyIndex = coordinator.resourceState.requireIndex(energy.id);
    expect(coordinator.resourceState.getDirtyTolerance(energyIndex)).toBeCloseTo(0.001);

    coordinator.incrementUpgradePurchases(upgrade.id);

    expect(coordinator.resourceState.getDirtyTolerance(energyIndex)).toBeCloseTo(0.01);
  });
});
