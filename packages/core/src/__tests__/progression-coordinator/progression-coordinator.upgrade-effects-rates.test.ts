import { describe, expect, it } from 'vitest';

import { createProgressionCoordinator } from '../../index.js';
import {
  createContentPack,
  createGeneratorDefinition,
  createResourceDefinition,
  createUpgradeDefinition,
  literalOne,
} from '../../content-test-helpers.js';

describe('Integration: upgrade effects', () => {
  it('applies modifyGeneratorRate upgrade effects to generator rates', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const generator = createGeneratorDefinition('generator.boosted', {
      name: 'Boosted Generator',
      purchase: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      produces: [
        {
          resourceId: energy.id,
          rate: { kind: 'constant', value: 1 },
        },
      ],
    });

    const upgrade = createUpgradeDefinition('upgrade.generator-boost', {
      name: 'Generator Boost',
      category: 'generator',
      targets: [{ kind: 'generator', id: generator.id }],
      cost: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      effects: [
        {
          kind: 'modifyGeneratorRate',
          generatorId: generator.id,
          operation: 'multiply',
          value: { kind: 'constant', value: 2 },
        },
      ],
    });

    const pack = createContentPack({
      resources: [energy],
      generators: [generator],
      upgrades: [upgrade],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);
    expect(coordinator.state.generators?.[0]?.produces?.[0]?.rate).toBeCloseTo(1);

    coordinator.incrementUpgradePurchases(upgrade.id);
    coordinator.updateForStep(1);
    expect(coordinator.state.generators?.[0]?.produces?.[0]?.rate).toBeCloseTo(2);

    coordinator.updateForStep(2);
    expect(coordinator.state.generators?.[0]?.produces?.[0]?.rate).toBeCloseTo(2);
  });

  it('stacks repeatable modifyGeneratorRate effects per purchase', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const generator = createGeneratorDefinition('generator.scaling', {
      name: 'Scaling Generator',
      purchase: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      produces: [
        {
          resourceId: energy.id,
          rate: { kind: 'constant', value: 1 },
        },
      ],
    });

    const upgrade = createUpgradeDefinition('upgrade.scaling-boost', {
      name: 'Scaling Boost',
      category: 'generator',
      targets: [{ kind: 'generator', id: generator.id }],
      cost: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      repeatable: {
        costCurve: literalOne,
      },
      effects: [
        {
          kind: 'modifyGeneratorRate',
          generatorId: generator.id,
          operation: 'multiply',
          value: { kind: 'linear', base: 1, slope: 1 },
        },
      ],
    });

    const pack = createContentPack({
      resources: [energy],
      generators: [generator],
      upgrades: [upgrade],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);
    expect(coordinator.state.generators?.[0]?.produces?.[0]?.rate).toBeCloseTo(1);

    coordinator.incrementUpgradePurchases(upgrade.id);
    coordinator.updateForStep(1);
    expect(coordinator.state.generators?.[0]?.produces?.[0]?.rate).toBeCloseTo(2);

    coordinator.incrementUpgradePurchases(upgrade.id);
    coordinator.updateForStep(2);
    expect(coordinator.state.generators?.[0]?.produces?.[0]?.rate).toBeCloseTo(6);
  });

  it('stacks constant modifyGeneratorRate repeatables multiplicatively', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const generator = createGeneratorDefinition('generator.constant-repeatable', {
      name: 'Constant Repeatable Generator',
      purchase: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      produces: [
        {
          resourceId: energy.id,
          rate: { kind: 'constant', value: 1 },
        },
      ],
    });

    const upgrade = createUpgradeDefinition('upgrade.constant-repeatable-boost', {
      name: 'Constant Repeatable Boost',
      category: 'generator',
      targets: [{ kind: 'generator', id: generator.id }],
      cost: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      repeatable: {
        costCurve: literalOne,
      },
      effects: [
        {
          kind: 'modifyGeneratorRate',
          generatorId: generator.id,
          operation: 'multiply',
          value: { kind: 'constant', value: 2 },
        },
      ],
    });

    const pack = createContentPack({
      resources: [energy],
      generators: [generator],
      upgrades: [upgrade],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);
    expect(coordinator.state.generators?.[0]?.produces?.[0]?.rate).toBeCloseTo(1);

    coordinator.incrementUpgradePurchases(upgrade.id);
    coordinator.updateForStep(1);
    expect(coordinator.state.generators?.[0]?.produces?.[0]?.rate).toBeCloseTo(2);

    coordinator.incrementUpgradePurchases(upgrade.id);
    coordinator.updateForStep(2);
    expect(coordinator.state.generators?.[0]?.produces?.[0]?.rate).toBeCloseTo(4);
  });

  it('applies repeatable effectCurve to multiply operations', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const generator = createGeneratorDefinition('generator.effect-curve-multiply', {
      name: 'Effect Curve (Multiply)',
      purchase: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      produces: [
        {
          resourceId: energy.id,
          rate: { kind: 'constant', value: 1 },
        },
      ],
    });

    const upgrade = createUpgradeDefinition('upgrade.effect-curve-multiply', {
      name: 'Effect Curve Multiply',
      category: 'generator',
      targets: [{ kind: 'generator', id: generator.id }],
      cost: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      repeatable: {
        costCurve: literalOne,
        effectCurve: { kind: 'linear', base: 1, slope: 1 },
      },
      effects: [
        {
          kind: 'modifyGeneratorRate',
          generatorId: generator.id,
          operation: 'multiply',
          value: { kind: 'linear', base: 1, slope: 1 },
        },
      ],
    });

    const pack = createContentPack({
      resources: [energy],
      generators: [generator],
      upgrades: [upgrade],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);
    expect(coordinator.state.generators?.[0]?.produces?.[0]?.rate).toBeCloseTo(1);

    coordinator.incrementUpgradePurchases(upgrade.id);
    coordinator.updateForStep(1);
    expect(coordinator.state.generators?.[0]?.produces?.[0]?.rate).toBeCloseTo(4);

    coordinator.incrementUpgradePurchases(upgrade.id);
    coordinator.updateForStep(2);
    expect(coordinator.state.generators?.[0]?.produces?.[0]?.rate).toBeCloseTo(36);
  });

  it('applies repeatable effectCurve to add operations', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const generator = createGeneratorDefinition('generator.effect-curve-add', {
      name: 'Effect Curve (Add)',
      purchase: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      produces: [
        {
          resourceId: energy.id,
          rate: { kind: 'constant', value: 1 },
        },
      ],
    });

    const upgrade = createUpgradeDefinition('upgrade.effect-curve-add', {
      name: 'Effect Curve Add',
      category: 'generator',
      targets: [{ kind: 'generator', id: generator.id }],
      cost: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      repeatable: {
        costCurve: literalOne,
        effectCurve: { kind: 'linear', base: 1, slope: 1 },
      },
      effects: [
        {
          kind: 'modifyGeneratorRate',
          generatorId: generator.id,
          operation: 'add',
          value: { kind: 'constant', value: 0.1 },
        },
      ],
    });

    const pack = createContentPack({
      resources: [energy],
      generators: [generator],
      upgrades: [upgrade],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);
    expect(coordinator.state.generators?.[0]?.produces?.[0]?.rate).toBeCloseTo(1);

    coordinator.incrementUpgradePurchases(upgrade.id);
    coordinator.updateForStep(1);
    expect(coordinator.state.generators?.[0]?.produces?.[0]?.rate).toBeCloseTo(1.2);

    coordinator.incrementUpgradePurchases(upgrade.id);
    coordinator.updateForStep(2);
    expect(coordinator.state.generators?.[0]?.produces?.[0]?.rate).toBeCloseTo(1.5);
  });

  it('applies repeatable effectCurve to set operations', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const generator = createGeneratorDefinition('generator.effect-curve-set', {
      name: 'Effect Curve (Set)',
      purchase: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      produces: [
        {
          resourceId: energy.id,
          rate: { kind: 'constant', value: 1 },
        },
      ],
    });

    const upgrade = createUpgradeDefinition('upgrade.effect-curve-set', {
      name: 'Effect Curve Set',
      category: 'generator',
      targets: [{ kind: 'generator', id: generator.id }],
      cost: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      repeatable: {
        costCurve: literalOne,
        effectCurve: { kind: 'linear', base: 10, slope: 1 },
      },
      effects: [
        {
          kind: 'modifyGeneratorRate',
          generatorId: generator.id,
          operation: 'set',
          value: { kind: 'constant', value: 1 },
        },
      ],
    });

    const pack = createContentPack({
      resources: [energy],
      generators: [generator],
      upgrades: [upgrade],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);
    expect(coordinator.state.generators?.[0]?.produces?.[0]?.rate).toBeCloseTo(1);

    coordinator.incrementUpgradePurchases(upgrade.id);
    coordinator.updateForStep(1);
    expect(coordinator.state.generators?.[0]?.produces?.[0]?.rate).toBeCloseTo(11);

    coordinator.incrementUpgradePurchases(upgrade.id);
    coordinator.updateForStep(2);
    expect(coordinator.state.generators?.[0]?.produces?.[0]?.rate).toBeCloseTo(12);
  });
});

