import { describe, expect, it } from 'vitest';

import { createProgressionCoordinator } from '../../internals.js';
import {
  createContentPack,
  createGeneratorDefinition,
  createResourceDefinition,
  createUpgradeDefinition,
  literalOne,
} from '../../content-test-helpers.js';

describe('Integration: upgrade effects', () => {
  it('applies modifyGeneratorCost upgrade effects to generator purchase quotes', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const generator = createGeneratorDefinition('generator.discounted', {
      name: 'Discounted Generator',
      purchase: {
        currencyId: energy.id,
        costMultiplier: 10,
        costCurve: literalOne,
      },
      produces: [],
      consumes: [],
    });

    const upgrade = createUpgradeDefinition('upgrade.generator-discount', {
      name: 'Generator Discount',
      category: 'generator',
      targets: [{ kind: 'generator', id: generator.id }],
      cost: {
        currencyId: energy.id,
        costMultiplier: 0,
        costCurve: literalOne,
      },
      effects: [
        {
          kind: 'modifyGeneratorCost',
          generatorId: generator.id,
          operation: 'multiply',
          value: { kind: 'constant', value: 0.5 },
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

    const before = coordinator.generatorEvaluator.getPurchaseQuote(generator.id, 1);
    expect(before?.costs[0]?.amount).toBeCloseTo(10);

    coordinator.incrementUpgradePurchases(upgrade.id);

    const after = coordinator.generatorEvaluator.getPurchaseQuote(generator.id, 1);
    expect(after?.costs[0]?.amount).toBeCloseTo(5);
  });

  it('applies modifyResourceRate upgrade effects to generator resource rates', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });
    const gold = createResourceDefinition('resource.gold', {
      name: 'Gold',
    });

    const generator = createGeneratorDefinition('generator.gold-mine', {
      name: 'Gold Mine',
      purchase: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      produces: [
        {
          resourceId: gold.id,
          rate: { kind: 'constant', value: 1 },
        },
      ],
    });

    const upgrade = createUpgradeDefinition('upgrade.gold-rate', {
      name: 'Gold Rate Boost',
      category: 'resource',
      targets: [{ kind: 'resource', id: gold.id }],
      cost: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      effects: [
        {
          kind: 'modifyResourceRate',
          resourceId: gold.id,
          operation: 'multiply',
          value: { kind: 'constant', value: 2 },
        },
      ],
    });

    const pack = createContentPack({
      resources: [energy, gold],
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
  });

  it('applies modifyGeneratorConsumption effects to generator consumption rates', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });
    const fuel = createResourceDefinition('resource.fuel', {
      name: 'Fuel',
    });
    const output = createResourceDefinition('resource.output', {
      name: 'Output',
    });

    const generator = createGeneratorDefinition('generator.consumer', {
      name: 'Consumer',
      purchase: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      produces: [
        {
          resourceId: output.id,
          rate: { kind: 'constant', value: 1 },
        },
      ],
      consumes: [
        {
          resourceId: energy.id,
          rate: { kind: 'constant', value: 4 },
        },
        {
          resourceId: fuel.id,
          rate: { kind: 'constant', value: 2 },
        },
      ],
    });

    const baseConsumptionUpgrade = createUpgradeDefinition('upgrade.consume-base', {
      name: 'Consume Base',
      category: 'generator',
      targets: [{ kind: 'generator', id: generator.id }],
      cost: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      effects: [
        {
          kind: 'modifyGeneratorConsumption',
          generatorId: generator.id,
          operation: 'multiply',
          value: { kind: 'constant', value: 0.5 },
        },
      ],
    });

    const fuelConsumptionUpgrade = createUpgradeDefinition('upgrade.consume-fuel', {
      name: 'Consume Fuel',
      category: 'generator',
      targets: [{ kind: 'generator', id: generator.id }],
      cost: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      effects: [
        {
          kind: 'modifyGeneratorConsumption',
          generatorId: generator.id,
          resourceId: fuel.id,
          operation: 'add',
          value: { kind: 'constant', value: 0.5 },
        },
      ],
    });

    const energyRateUpgrade = createUpgradeDefinition('upgrade.energy-rate', {
      name: 'Energy Rate',
      category: 'resource',
      targets: [{ kind: 'resource', id: energy.id }],
      cost: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      effects: [
        {
          kind: 'modifyResourceRate',
          resourceId: energy.id,
          operation: 'multiply',
          value: { kind: 'constant', value: 3 },
        },
      ],
    });

    const pack = createContentPack({
      resources: [energy, fuel, output],
      generators: [generator],
      upgrades: [baseConsumptionUpgrade, fuelConsumptionUpgrade, energyRateUpgrade],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);
    const initialGenerator = coordinator.state.generators?.[0];
    expect(initialGenerator?.produces?.[0]?.rate).toBeCloseTo(1);
    expect(
      initialGenerator?.consumes?.find((rate) => rate.resourceId === energy.id)?.rate,
    ).toBeCloseTo(4);
    expect(
      initialGenerator?.consumes?.find((rate) => rate.resourceId === fuel.id)?.rate,
    ).toBeCloseTo(2);

    coordinator.incrementUpgradePurchases(baseConsumptionUpgrade.id);
    coordinator.incrementUpgradePurchases(fuelConsumptionUpgrade.id);
    coordinator.incrementUpgradePurchases(energyRateUpgrade.id);
    coordinator.updateForStep(1);

    const updatedGenerator = coordinator.state.generators?.[0];
    expect(updatedGenerator?.produces?.[0]?.rate).toBeCloseTo(1);
    expect(
      updatedGenerator?.consumes?.find((rate) => rate.resourceId === energy.id)?.rate,
    ).toBeCloseTo(6);
    expect(
      updatedGenerator?.consumes?.find((rate) => rate.resourceId === fuel.id)?.rate,
    ).toBeCloseTo(1.5);
  });
});

