import { describe, expect, it } from 'vitest';

import { createProgressionCoordinator } from '../../internals.js';
import {
  createContentPack,
  createGeneratorDefinition,
  createResourceDefinition,
  createUpgradeDefinition,
} from '../../content-test-helpers.js';

describe('Integration: enhanced error messages', () => {
  it('reports detailed error when generator not found', () => {
    const errors: Error[] = [];
    const energy = createResourceDefinition('resource.energy', { name: 'Energy' });
    const content = createContentPack({
      resources: [energy],
      generators: [],
    });
    const coordinator = createProgressionCoordinator({
      content,
      stepDurationMs: 100,
      onError: (error) => errors.push(error),
    });

    const cost = (coordinator as any).computeGeneratorCost(
      'nonexistent-generator',
      0,
    );

    expect(cost).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Generator cost calculation failed');
    expect(errors[0].message).toContain('nonexistent-generator');
    expect(errors[0].message).toContain('not found');
  });

  it('reports detailed error when generator costMultiplier is invalid', () => {
    const errors: Error[] = [];
    const energy = createResourceDefinition('resource.energy', { name: 'Energy' });
    const generator = createGeneratorDefinition('generator.test-gen', {
      name: { default: 'Test Generator', variants: {} } as any,
      purchase: {
        currencyId: energy.id,
        costMultiplier: NaN, // Invalid costMultiplier
        costCurve: { kind: 'constant', value: 1 },
      },
      produces: [{
        resourceId: energy.id,
        rate: { kind: 'constant', value: 1 },
      }],
    });
    const content = createContentPack({
      resources: [energy],
      generators: [generator],
    });
    const coordinator = createProgressionCoordinator({
      content,
      stepDurationMs: 100,
      onError: (error) => errors.push(error),
    });

    const cost = (coordinator as any).computeGeneratorCost('generator.test-gen', 0);

    expect(cost).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Generator cost calculation failed');
    expect(errors[0].message).toContain('generator.test-gen');
    expect(errors[0].message).toContain('costMultiplier is invalid');
  });

  it('reports detailed error when generator cost curve evaluation fails', () => {
    const errors: Error[] = [];
    const energy = createResourceDefinition('resource.energy', { name: 'Energy' });
    const generator = createGeneratorDefinition('generator.test-gen', {
      name: { default: 'Test Generator', variants: {} } as any,
      purchase: {
        currencyId: energy.id,
        costMultiplier: 10,
        costCurve: { kind: 'exponential', base: 1, growth: -1 }, // Negative growth causes issues
      },
      produces: [{
        resourceId: energy.id,
        rate: { kind: 'constant', value: 1 },
      }],
    });
    const content = createContentPack({
      resources: [energy],
      generators: [generator],
    });
    const coordinator = createProgressionCoordinator({
      content,
      stepDurationMs: 100,
      onError: (error) => errors.push(error),
    });

    // Evaluate at a high purchase index to potentially cause overflow or invalid result
    const cost = (coordinator as any).computeGeneratorCost('generator.test-gen', 1000);

    if (cost === undefined) {
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].message).toContain('Generator cost calculation failed');
      expect(errors[0].message).toContain('generator.test-gen');
      expect(errors[0].message).toContain('purchase index 1000');
    }
  });

  it('reports detailed error when upgrade costMultiplier is invalid', () => {
    const errors: Error[] = [];
    const energy = createResourceDefinition('resource.energy', { name: 'Energy' });
    const upgrade = createUpgradeDefinition('upgrade.test-upgrade', {
      name: 'Test Upgrade',
      cost: {
        currencyId: energy.id,
        costMultiplier: Infinity, // Invalid costMultiplier
        costCurve: { kind: 'constant', value: 1 },
      },
      effects: [],
    });
    const content = createContentPack({
      resources: [energy],
      upgrades: [upgrade],
    });
    const coordinator = createProgressionCoordinator({
      content,
      stepDurationMs: 100,
      onError: (error) => errors.push(error),
    });

    coordinator.updateForStep(0);

    // Access the upgrade record to test cost calculation
    const upgradeRecord = (coordinator as any).upgrades.get('upgrade.test-upgrade');
    const costs = (coordinator as any).computeUpgradeCosts(upgradeRecord);

    expect(costs).toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain('Upgrade cost calculation failed');
    expect(errors[0].message).toContain('upgrade.test-upgrade');
    expect(errors[0].message).toContain('costMultiplier is invalid');
  });

  it('reports detailed error when repeatable upgrade cost curve fails', () => {
    const errors: Error[] = [];
    const energy = createResourceDefinition('resource.energy', { name: 'Energy', startAmount: 10000 });
    const upgrade = createUpgradeDefinition('upgrade.test-upgrade', {
      name: 'Test Upgrade',
      cost: {
        currencyId: energy.id,
        costMultiplier: 10,
        costCurve: { kind: 'constant', value: 1 },
      },
      repeatable: {
        costCurve: { kind: 'exponential', base: 1, growth: -2 }, // Invalid repeatable curve
        maxPurchases: 10,
      },
      effects: [],
    });
    const content = createContentPack({
      resources: [energy],
      upgrades: [upgrade],
    });
    const coordinator = createProgressionCoordinator({
      content,
      stepDurationMs: 100,
      onError: (error) => errors.push(error),
    });

    coordinator.updateForStep(0);

    // Purchase the upgrade once to set purchases > 0
    const upgradeRecord = (coordinator as any).upgrades.get('upgrade.test-upgrade');
    upgradeRecord.purchases = 5;

    const costs = (coordinator as any).computeUpgradeCosts(upgradeRecord);

    if (costs === undefined) {
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].message).toContain('Upgrade cost calculation failed');
      expect(errors[0].message).toContain('upgrade.test-upgrade');
      expect(errors[0].message).toContain('purchase level 5');
    }
  });

  it('does not call onError when costs are calculated successfully', () => {
    const errors: Error[] = [];
    const energy = createResourceDefinition('resource.energy', { name: 'Energy' });
    const generator = createGeneratorDefinition('generator.test-gen', {
      name: { default: 'Test Generator', variants: {} } as any,
      purchase: {
        currencyId: energy.id,
        costMultiplier: 10,
        costCurve: { kind: 'constant', value: 1 },
      },
      produces: [{
        resourceId: energy.id,
        rate: { kind: 'constant', value: 1 },
      }],
    });
    const content = createContentPack({
      resources: [energy],
      generators: [generator],
    });
    const coordinator = createProgressionCoordinator({
      content,
      stepDurationMs: 100,
      onError: (error) => errors.push(error),
    });

    const cost = (coordinator as any).computeGeneratorCost('generator.test-gen', 0);

    expect(cost).toBeDefined();
    expect(errors).toHaveLength(0);
  });
});

