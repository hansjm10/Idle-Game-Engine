import { describe, expect, it, vi } from 'vitest';

import { createAutomation, createTransform } from '@idle-engine/content-schema';

import {
  createContentPack,
  createGeneratorDefinition,
  createResourceDefinition,
  literalOne,
} from './content-test-helpers.js';
import { createGameRuntime } from './index.js';

function createTestAutomation() {
  return createAutomation({
    id: 'automation.test',
    name: { default: 'Test Automation' },
    description: { default: 'Test Automation' },
    targetType: 'collectResource',
    targetId: 'resource.gold',
    targetAmount: { kind: 'constant', value: 1 },
    trigger: { kind: 'commandQueueEmpty' },
    unlockCondition: { kind: 'always' },
    enabledByDefault: false,
  });
}

function createTestTransform() {
  return createTransform({
    id: 'transform.test',
    name: { default: 'Test Transform' },
    description: { default: 'Test Transform' },
    mode: 'instant',
    trigger: { kind: 'manual' },
    inputs: [{ resourceId: 'resource.energy', amount: literalOne }],
    outputs: [{ resourceId: 'resource.gold', amount: literalOne }],
  });
}

function createContentWithGeneratorAndAutomation() {
  return createContentPack({
    resources: [
      createResourceDefinition('resource.energy', { startAmount: 1000 }),
      createResourceDefinition('resource.gold', { startAmount: 0 }),
    ],
    generators: [
      createGeneratorDefinition('generator.mine', {
        purchase: {
          currencyId: 'resource.energy',
          baseCost: 10,
          costCurve: literalOne,
        },
        produces: [{ resourceId: 'resource.gold', rate: literalOne }],
        consumes: [],
        baseUnlock: { kind: 'always' },
      }),
    ],
    automations: [createTestAutomation()],
  });
}

function createContentWithGeneratorAutomationAndTransform() {
  return createContentPack({
    resources: [
      createResourceDefinition('resource.energy', { startAmount: 1000 }),
      createResourceDefinition('resource.gold', { startAmount: 0 }),
    ],
    generators: [
      createGeneratorDefinition('generator.mine', {
        purchase: {
          currencyId: 'resource.energy',
          baseCost: 10,
          costCurve: literalOne,
        },
        produces: [{ resourceId: 'resource.gold', rate: literalOne }],
        consumes: [],
        baseUnlock: { kind: 'always' },
      }),
    ],
    automations: [createTestAutomation()],
    transforms: [createTestTransform()],
  });
}

describe('createGameRuntime', () => {
  it('wires systems in canonical order', () => {
    const wiring = createGameRuntime({
      content: createContentWithGeneratorAndAutomation(),
      stepSizeMs: 100,
    });

    expect(wiring.systems.map((system) => system.id)).toEqual([
      'production',
      'automation-system',
      'progression-coordinator',
    ]);
  });

  it('includes transform system when transforms are present', () => {
    const wiring = createGameRuntime({
      content: createContentWithGeneratorAutomationAndTransform(),
      stepSizeMs: 100,
    });

    expect(wiring.transformSystem).toBeDefined();
    expect(wiring.systems.map((system) => system.id)).toEqual([
      'production',
      'automation-system',
      'transform-system',
      'progression-coordinator',
    ]);
  });

  it('inserts resource finalize system when applyViaFinalizeTick is enabled', () => {
    const wiring = createGameRuntime({
      content: createContentWithGeneratorAndAutomation(),
      production: { applyViaFinalizeTick: true },
    });

    expect(wiring.runtime.getMaxStepsPerFrame()).toBe(1);
    expect(wiring.systems.map((system) => system.id)).toEqual([
      'production',
      'resource-finalize',
      'automation-system',
      'progression-coordinator',
    ]);
  });

  it('keeps coordinator step aligned under multi-step ticks', () => {
    const wiring = createGameRuntime({
      content: createContentPack({
        resources: [createResourceDefinition('resource.energy', { startAmount: 0 })],
      }),
      stepSizeMs: 100,
    });

    const updateSpy = vi.spyOn(wiring.coordinator, 'updateForStep');

    const stepsProcessed = wiring.runtime.tick(
      wiring.runtime.getStepSizeMs() * 3,
    );

    expect(stepsProcessed).toBe(3);
    expect(wiring.runtime.getCurrentStep()).toBe(3);
    expect(wiring.coordinator.getLastUpdatedStep()).toBe(3);
    expect(updateSpy.mock.calls.map((call) => call[0])).toEqual([1, 2, 3]);

    const firstOptions = updateSpy.mock.calls[0]?.[1];
    expect(firstOptions).toBeDefined();
    expect(firstOptions).toHaveProperty('events');
    expect(typeof firstOptions?.events?.publish).toBe('function');
  });
});
