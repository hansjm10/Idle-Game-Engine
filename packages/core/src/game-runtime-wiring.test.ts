import { describe, expect, it, vi } from 'vitest';

import { createAutomation, createTransform } from '@idle-engine/content-schema';

import {
  createContentPack,
  createGeneratorDefinition,
  createResourceDefinition,
  literalOne,
} from './content-test-helpers.js';
import { CommandPriority, RUNTIME_COMMAND_TYPES } from './command.js';
import {
  createGameRuntime,
  IdleEngineRuntime,
} from './index.js';
import { createProgressionCoordinator } from './progression-coordinator.js';
import { wireGameRuntime } from './game-runtime-wiring.js';
import { resetRNG, setRNGSeed } from './rng.js';

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

function createContentWithTransform() {
  return createContentPack({
    resources: [
      createResourceDefinition('resource.energy', { startAmount: 1 }),
      createResourceDefinition('resource.gold', { startAmount: 0 }),
    ],
    transforms: [createTestTransform()],
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
          costMultiplier: 10,
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
          costMultiplier: 10,
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
  it('wires systems in canonical order with rate tracking enabled by default', () => {
    const wiring = createGameRuntime({
      content: createContentWithGeneratorAndAutomation(),
      stepSizeMs: 100,
    });

    expect(wiring.runtime.getMaxStepsPerFrame()).toBe(1);
    expect(wiring.systems.map((system) => system.id)).toEqual([
      'production',
      'resource-finalize',
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
      'resource-finalize',
      'automation-system',
      'transform-system',
      'progression-coordinator',
    ]);
  });

  it('executes RUN_TRANSFORM from the command queue when transforms are wired', () => {
    const wiring = createGameRuntime({
      content: createContentWithTransform(),
      stepSizeMs: 100,
    });

    const energyIndex = wiring.coordinator.resourceState.getIndex(
      'resource.energy',
    )!;
    const goldIndex = wiring.coordinator.resourceState.getIndex(
      'resource.gold',
    )!;

    expect(wiring.coordinator.resourceState.getAmount(energyIndex)).toBe(1);
    expect(wiring.coordinator.resourceState.getAmount(goldIndex)).toBe(0);

    wiring.commandQueue.enqueue({
      type: RUNTIME_COMMAND_TYPES.RUN_TRANSFORM,
      payload: { transformId: 'transform.test' },
      priority: CommandPriority.PLAYER,
      timestamp: 0,
      step: wiring.runtime.getNextExecutableStep(),
    });

    wiring.runtime.tick(wiring.runtime.getStepSizeMs());

    expect(wiring.coordinator.resourceState.getAmount(energyIndex)).toBe(0);
    expect(wiring.coordinator.resourceState.getAmount(goldIndex)).toBe(1);
  });

  it('skips resource finalize system when applyViaFinalizeTick is disabled', () => {
    const wiring = createGameRuntime({
      content: createContentWithGeneratorAndAutomation(),
      production: { applyViaFinalizeTick: false },
    });

    expect(wiring.runtime.getMaxStepsPerFrame()).toBeGreaterThan(1);
    expect(wiring.systems.map((system) => system.id)).toEqual([
      'production',
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
      production: { applyViaFinalizeTick: false },
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

  it('serializes and hydrates wiring state with convenience methods', () => {
    resetRNG();
    setRNGSeed(4242);

    const wiring = createGameRuntime({
      content: createContentWithGeneratorAutomationAndTransform(),
      stepSizeMs: 100,
    });

    wiring.runtime.tick(wiring.runtime.getStepSizeMs() * 2);

    const automationSystem = wiring.automationSystem;
    const transformSystem = wiring.transformSystem;
    if (!automationSystem || !transformSystem) {
      throw new Error('Expected automation and transform systems to be wired.');
    }

    const runtimeStep = wiring.runtime.getCurrentStep();
    automationSystem.restoreState(
      [
        {
          id: 'automation.test',
          enabled: true,
          lastFiredStep: runtimeStep - 1,
          cooldownExpiresStep: runtimeStep + 3,
          unlocked: true,
          lastThresholdSatisfied: false,
        },
      ],
      { savedWorkerStep: runtimeStep, currentStep: runtimeStep },
    );

    transformSystem.restoreState(
      [
        {
          id: 'transform.test',
          unlocked: true,
          cooldownExpiresStep: runtimeStep + 2,
        },
      ],
      { savedWorkerStep: runtimeStep, currentStep: runtimeStep },
    );

    wiring.commandQueue.enqueue({
      type: 'test:noop',
      payload: { message: 'hello' },
      priority: CommandPriority.PLAYER,
      timestamp: 1000,
      step: wiring.runtime.getNextExecutableStep(),
    });

    const savedAt = 1234;
    const save = wiring.serialize({ savedAt });

    const restored = createGameRuntime({
      content: createContentWithGeneratorAutomationAndTransform(),
      stepSizeMs: 100,
      initialStep: save.runtime.step,
    });

    restored.hydrate(save);

    const roundTrip = restored.serialize({ savedAt });
    expect(roundTrip).toEqual(save);
  });

  it('hydrates using the saved runtime step by default', () => {
    const wiring = createGameRuntime({
      content: createContentWithGeneratorAutomationAndTransform(),
      stepSizeMs: 100,
    });

    wiring.runtime.tick(wiring.runtime.getStepSizeMs() * 3);

    const automationSystem = wiring.automationSystem;
    const transformSystem = wiring.transformSystem;
    if (!automationSystem || !transformSystem) {
      throw new Error('Expected automation and transform systems to be wired.');
    }

    const runtimeStep = wiring.runtime.getCurrentStep();
    automationSystem.restoreState(
      [
        {
          id: 'automation.test',
          enabled: true,
          lastFiredStep: runtimeStep - 1,
          cooldownExpiresStep: runtimeStep + 3,
          unlocked: true,
          lastThresholdSatisfied: false,
        },
      ],
      { savedWorkerStep: runtimeStep, currentStep: runtimeStep },
    );

    transformSystem.restoreState(
      [
        {
          id: 'transform.test',
          unlocked: true,
          cooldownExpiresStep: runtimeStep + 2,
        },
      ],
      { savedWorkerStep: runtimeStep, currentStep: runtimeStep },
    );

    wiring.commandQueue.enqueue({
      type: 'test:noop',
      payload: { message: 'timeline' },
      priority: CommandPriority.PLAYER,
      timestamp: 0,
      step: runtimeStep + 2,
    });

    const save = wiring.serialize();

    const restored = createGameRuntime({
      content: createContentWithGeneratorAutomationAndTransform(),
      stepSizeMs: 100,
    });

    restored.hydrate(save);

    const restoredAutomation = restored.automationSystem
      ?.getState()
      .get('automation.test');
    const restoredTransform = restored.transformSystem
      ?.getState()
      .get('transform.test');

    expect(restoredAutomation?.lastFiredStep).toBe(runtimeStep - 1);
    expect(restoredAutomation?.cooldownExpiresStep).toBe(runtimeStep + 3);
    expect(restoredTransform?.cooldownExpiresStep).toBe(runtimeStep + 2);
    expect(restored.commandQueue.exportForSave()).toEqual(save.commandQueue);
  });
});

describe('wireGameRuntime', () => {
  it('throws when coordinator step duration is not a positive finite number', () => {
    const content = createContentPack({
      resources: [createResourceDefinition('resource.energy', { startAmount: 0 })],
    });

    const runtime = new IdleEngineRuntime({ stepSizeMs: 100 });
    const coordinator = createProgressionCoordinator({
      content,
      stepDurationMs: 0,
    });

    expect(() =>
      wireGameRuntime({
        content,
        runtime,
        coordinator,
      }),
    ).toThrow(/positive, finite number/);
  });

  it('throws when coordinator step duration mismatches runtime step size', () => {
    const content = createContentPack({
      resources: [createResourceDefinition('resource.energy', { startAmount: 0 })],
    });

    const runtime = new IdleEngineRuntime({ stepSizeMs: 100 });
    const coordinator = createProgressionCoordinator({
      content,
      stepDurationMs: 200,
    });

    expect(() =>
      wireGameRuntime({
        content,
        runtime,
        coordinator,
      }),
    ).toThrow(/must match coordinator stepDurationMs/);
  });
});
