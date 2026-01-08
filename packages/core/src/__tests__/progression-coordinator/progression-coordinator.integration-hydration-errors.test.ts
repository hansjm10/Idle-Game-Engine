import { describe, expect, it } from 'vitest';

import type { SerializedResourceState } from '../../index.js';
import { createProgressionCoordinator } from '../../index.js';
import {
  createContentPack,
  createGeneratorDefinition,
  createResourceDefinition,
} from '../../content-test-helpers.js';

describe('Integration: hydration error scenarios', () => {
  it('detects invalid save format with missing required fields', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const pack = createContentPack({
      resources: [energy],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    // Try to hydrate with invalid/incomplete save data
    const invalidSave = {
      ids: ['resource.energy'],
      // Missing amounts, capacities, flags arrays
    } as any;

    // Should detect missing fields and throw
    expect(() => {
      coordinator.hydrateResources(invalidSave);
    }).toThrow();
  });

  it('detects missing resource definitions (resource removed from content)', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });
    const crystal = createResourceDefinition('resource.crystal', {
      name: 'Crystal',
    });

    // Create content pack with both resources
    const packWithBoth = createContentPack({
      resources: [energy, crystal],
    });

    const coordinator1 = createProgressionCoordinator({
      content: packWithBoth,
      stepDurationMs: 100,
    });

    const energyIndex = coordinator1.resourceState.requireIndex(energy.id);
    const crystalIndex = coordinator1.resourceState.requireIndex(crystal.id);

    coordinator1.resourceState.addAmount(energyIndex, 100);
    coordinator1.resourceState.addAmount(crystalIndex, 50);
    coordinator1.updateForStep(0);

    // Export save with both resources
    const save = coordinator1.resourceState.exportForSave();
    expect(save.ids).toContain('resource.energy');
    expect(save.ids).toContain('resource.crystal');

    // Create new coordinator with only energy (crystal removed from content)
    const packWithoutCrystal = createContentPack({
      resources: [energy],
    });

    const coordinator2 = createProgressionCoordinator({
      content: packWithoutCrystal,
      stepDurationMs: 100,
    });

    // Hydration should detect incompatible definitions and throw
    expect(() => {
      coordinator2.hydrateResources(save);
    }).toThrow('incompatible');
  });

  it('detects negative amounts in save data', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const pack = createContentPack({
      resources: [energy],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    // Create save with negative amount
    const corruptedSave = {
      ids: ['resource.energy'],
      amounts: [-100], // Invalid negative amount
      capacities: [1000],
      flags: [0],
      unlocked: [true],
      visible: [true],
    };

    // Negative amounts are valid in the current implementation (clamped to 0 on access)
    // But let's verify they don't crash the system
    expect(() => {
      coordinator.hydrateResources(corruptedSave);
    }).not.toThrow();

    // Amount should be clamped to valid range
    const energyIndex = coordinator.resourceState.requireIndex(energy.id);
    const amount = coordinator.resourceState.getAmount(energyIndex);
    expect(amount).toBeGreaterThanOrEqual(0);
  });

  it('detects corrupted state data with NaN values', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const pack = createContentPack({
      resources: [energy],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    // Create save with NaN values
    const corruptedSave = {
      ids: ['resource.energy'],
      amounts: [NaN], // Invalid NaN amount
      capacities: [1000],
      flags: [0],
      unlocked: [true],
      visible: [true],
    };

    // Should detect and reject invalid NaN values
    expect(() => {
      coordinator.hydrateResources(corruptedSave);
    }).toThrow('finite numbers');
  });

  it('detects corrupted state data with Infinity values', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const pack = createContentPack({
      resources: [energy],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    // Create save with Infinity values
    const corruptedSave = {
      ids: ['resource.energy'],
      amounts: [Infinity],
      capacities: [1000],
      flags: [0],
      unlocked: [true],
      visible: [true],
    };

    // Should detect and reject invalid Infinity values
    expect(() => {
      coordinator.hydrateResources(corruptedSave);
    }).toThrow('finite numbers');
  });

  it('detects corrupted unlocked/visible flag data', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const pack = createContentPack({
      resources: [energy],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    // Create save with invalid unlocked values (Uint8Array instead of boolean[])
    const corruptedSave = {
      ids: ['resource.energy'],
      amounts: [100],
      capacities: [1000],
      flags: [0],
      unlocked: new Uint8Array([1]), // Invalid type
      visible: new Uint8Array([1]),
    };

    // Should detect and reject invalid unlocked values
    expect(() => {
      coordinator.hydrateResources(
        corruptedSave as unknown as SerializedResourceState,
      );
    }).toThrow('boolean');
  });

  it('preserves progression state across save/restore cycle with generators', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const generator = createGeneratorDefinition('generator.reactor', {
      name: {
        default: 'Reactor',
        variants: { 'en-US': 'Reactor' },
      } as any,
      purchase: {
        currencyId: energy.id,
        costMultiplier: 10,
        costCurve: {
          kind: 'exponential',
          base: 1,
          growth: 1.15,
        },
      },
      produces: [
        {
          resourceId: energy.id,
          rate: { kind: 'constant', value: 2 },
        },
      ],
    });

    const pack = createContentPack({
      resources: [energy],
      generators: [generator],
    });

    // First coordinator - build up state
    const coordinator1 = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    const energyIndex1 = coordinator1.resourceState.requireIndex(energy.id);
    coordinator1.resourceState.addAmount(energyIndex1, 1000);
    coordinator1.incrementGeneratorOwned(generator.id, 25);
    coordinator1.updateForStep(0);

    // Export save
    const save = coordinator1.resourceState.exportForSave();
    const generatorState = coordinator1.state.generators?.find(
      (g) => g.id === generator.id,
    );
    expect(generatorState?.owned).toBe(25);

    // Create second coordinator and restore
    const coordinator2 = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
      initialState: coordinator1.state,
    });

    coordinator2.hydrateResources(save);
    coordinator2.updateForStep(0);

    // Verify restored state
    const energyIndex2 = coordinator2.resourceState.requireIndex(energy.id);
    expect(coordinator2.resourceState.getAmount(energyIndex2)).toBe(1000);

    const generatorState2 = coordinator2.state.generators?.find(
      (g) => g.id === generator.id,
    );
    expect(generatorState2?.owned).toBe(25);

    // Verify can continue purchasing from restored state
    const quote = coordinator2.generatorEvaluator.getPurchaseQuote(
      generator.id,
      5,
    );
    expect(quote).toBeDefined();

    // Cost should be calculated from level 25 (current owned), not from 0
    expect(quote?.costs[0].amount).toBeGreaterThan(50);
  });
});

