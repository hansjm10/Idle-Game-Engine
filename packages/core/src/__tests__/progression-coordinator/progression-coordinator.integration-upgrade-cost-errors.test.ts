import { describe, expect, it } from 'vitest';

import { createProgressionCoordinator } from '../../internals.js';
import {
  createContentPack,
  createResourceDefinition,
  createUpgradeDefinition,
  literalOne,
} from '../../content-test-helpers.js';

describe('Integration: upgrade cost calculation error paths', () => {
  it('reports error when upgrade has invalid costMultiplier (negative)', () => {
    const errors: Error[] = [];
    const energy = createResourceDefinition('resource.energy', { name: 'Energy' });

    const upgrade = createUpgradeDefinition('upgrade.negative-multiplier', {
      name: 'Negative Multiplier Upgrade',
      cost: {
        currencyId: energy.id,
        costMultiplier: -10, // Invalid negative
        costCurve: literalOne,
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

    const upgradeRecord = (coordinator as any).upgrades.get('upgrade.negative-multiplier');
    const costs = (coordinator as any).computeUpgradeCosts(upgradeRecord);

    expect(costs).toBeUndefined();
    expect(errors.length).toBeGreaterThanOrEqual(1);
    // Find the specific error about costMultiplier
    const multiplierError = errors.find((e) => e.message.includes('costMultiplier is invalid'));
    expect(multiplierError).toBeDefined();
    expect(multiplierError!.message).toContain('Upgrade cost calculation failed');
    expect(multiplierError!.message).toContain('upgrade.negative-multiplier');
  });

  it('reports error when upgrade cost curve returns negative value', () => {
    const errors: Error[] = [];
    const energy = createResourceDefinition('resource.energy', { name: 'Energy' });

    const upgrade = createUpgradeDefinition('upgrade.negative-curve', {
      name: 'Negative Curve Upgrade',
      cost: {
        currencyId: energy.id,
        costMultiplier: 10,
        costCurve: { kind: 'constant', value: -50 }, // Negative cost curve
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

    const upgradeRecord = (coordinator as any).upgrades.get('upgrade.negative-curve');
    const costs = (coordinator as any).computeUpgradeCosts(upgradeRecord);

    expect(costs).toBeUndefined();
    expect(errors.length).toBeGreaterThanOrEqual(1);
    // Find the specific error about cost curve evaluation
    const curveError = errors.find((e) => e.message.includes('cost curve evaluation returned'));
    expect(curveError).toBeDefined();
    expect(curveError!.message).toContain('Upgrade cost calculation failed');
    expect(curveError!.message).toContain('upgrade.negative-curve');
  });

  it('reports error when upgrade final amount overflows to non-finite', () => {
    const errors: Error[] = [];
    const energy = createResourceDefinition('resource.energy', { name: 'Energy' });

    const upgrade = createUpgradeDefinition('upgrade.overflow', {
      name: 'Overflow Upgrade',
      cost: {
        currencyId: energy.id,
        costMultiplier: 1e308, // Very large multiplier
        costCurve: { kind: 'constant', value: 1e308 }, // Very large base
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

    const upgradeRecord = (coordinator as any).upgrades.get('upgrade.overflow');
    const costs = (coordinator as any).computeUpgradeCosts(upgradeRecord);

    expect(costs).toBeUndefined();
    expect(errors.length).toBeGreaterThanOrEqual(1);
    // Find the specific error about final amount
    const overflowError = errors.find((e) => e.message.includes('final amount is invalid'));
    expect(overflowError).toBeDefined();
    expect(overflowError!.message).toContain('Upgrade cost calculation failed');
    expect(overflowError!.message).toContain('upgrade.overflow');
  });

  it('reports error when repeatable upgrade cost curve returns negative', () => {
    const errors: Error[] = [];
    const energy = createResourceDefinition('resource.energy', { name: 'Energy' });

    const upgrade = createUpgradeDefinition('upgrade.repeatable-negative', {
      name: 'Repeatable Negative Upgrade',
      cost: {
        currencyId: energy.id,
        costMultiplier: 10,
        costCurve: literalOne,
      },
      repeatable: {
        costCurve: { kind: 'constant', value: -1 }, // Negative repeatable curve
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

    const upgradeRecord = (coordinator as any).upgrades.get('upgrade.repeatable-negative');
    const costs = (coordinator as any).computeUpgradeCosts(upgradeRecord);

    expect(costs).toBeUndefined();
    expect(errors.length).toBeGreaterThanOrEqual(1);
    // Find the specific error about repeatable cost curve
    const repeatableError = errors.find((e) => e.message.includes('repeatable cost curve evaluation returned'));
    expect(repeatableError).toBeDefined();
    expect(repeatableError!.message).toContain('Upgrade cost calculation failed');
    expect(repeatableError!.message).toContain('upgrade.repeatable-negative');
  });

  it('reports error when multi-cost upgrade has invalid entry costMultiplier', () => {
    const errors: Error[] = [];
    const energy = createResourceDefinition('resource.energy', { name: 'Energy' });
    const parts = createResourceDefinition('resource.parts', { name: 'Parts' });

    const upgrade = createUpgradeDefinition('upgrade.multi-invalid', {
      name: 'Multi Invalid Upgrade',
      cost: {
        costs: [
          { resourceId: energy.id, costMultiplier: 10, costCurve: literalOne },
          { resourceId: parts.id, costMultiplier: NaN, costCurve: literalOne }, // Invalid NaN
        ],
      },
      effects: [],
    });

    const content = createContentPack({
      resources: [energy, parts],
      upgrades: [upgrade],
    });

    const coordinator = createProgressionCoordinator({
      content,
      stepDurationMs: 100,
      onError: (error) => errors.push(error),
    });

    const upgradeRecord = (coordinator as any).upgrades.get('upgrade.multi-invalid');
    const costs = (coordinator as any).computeUpgradeCosts(upgradeRecord);

    expect(costs).toBeUndefined();
    expect(errors.length).toBeGreaterThanOrEqual(1);
    // Find the specific error about costMultiplier
    const multiplierError = errors.find(
      (e) => e.message.includes('costMultiplier is invalid') && e.message.includes('resource.parts'),
    );
    expect(multiplierError).toBeDefined();
    expect(multiplierError!.message).toContain('Upgrade cost calculation failed');
    expect(multiplierError!.message).toContain('upgrade.multi-invalid');
  });
});

