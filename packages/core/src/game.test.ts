import { describe, expect, it, vi } from 'vitest';

import { createAutomation, createTransform } from '@idle-engine/content-schema';

import {
  createContentPack,
  createGeneratorDefinition,
  createResourceDefinition,
  createUpgradeDefinition,
  literalOne,
} from './content-test-helpers.js';
import { CommandPriority, RUNTIME_COMMAND_TYPES } from './command.js';
import { createGame } from './index.js';
import { resetRNG, setRNGSeed } from './rng.js';

function createTestAutomation() {
  return createAutomation({
    id: 'automation.test',
    name: { default: 'Test Automation' },
    description: { default: 'Test Automation' },
    targetType: 'collectResource',
    targetId: 'resource.gold',
    targetAmount: literalOne,
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

function createTestContent() {
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
    upgrades: [createUpgradeDefinition('upgrade.test')],
    automations: [createTestAutomation()],
    transforms: [createTestTransform()],
  });
}

describe('createGame', () => {
  it('builds snapshots from wired runtime state', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1234);

    const game = createGame(
      createContentPack({
        resources: [createResourceDefinition('resource.energy', { startAmount: 0 })],
      }),
      { stepSizeMs: 100 },
    );

    const snapshot = game.getSnapshot();
    expect(snapshot.step).toBe(0);
    expect(snapshot.publishedAt).toBe(1234);
    expect(snapshot.resources).toHaveLength(1);

    game.stop();
    vi.useRealTimers();
  });

  it('enqueues player commands via facade actions', () => {
    const game = createGame(createTestContent(), { stepSizeMs: 100 });

    expect(
      game.internals.commandDispatcher.getHandler(
        RUNTIME_COMMAND_TYPES.PURCHASE_GENERATOR,
      ),
    ).toBeTypeOf('function');
    expect(
      game.internals.commandDispatcher.getHandler(
        RUNTIME_COMMAND_TYPES.PURCHASE_UPGRADE,
      ),
    ).toBeTypeOf('function');
    expect(
      game.internals.commandDispatcher.getHandler(
        RUNTIME_COMMAND_TYPES.TOGGLE_AUTOMATION,
      ),
    ).toBeTypeOf('function');
    expect(
      game.internals.commandDispatcher.getHandler(
        RUNTIME_COMMAND_TYPES.RUN_TRANSFORM,
      ),
    ).toBeTypeOf('function');

    expect(game.purchaseGenerator('generator.mine', 1)).toEqual({ success: true });
    expect(game.purchaseUpgrade('upgrade.test')).toEqual({ success: true });
    expect(game.toggleAutomation('automation.test', true)).toEqual({ success: true });
    expect(game.startTransform('transform.test')).toEqual({ success: true });

    expect(game.internals.commandQueue.exportForSave()).toEqual({
      schemaVersion: 1,
      entries: [
        {
          type: RUNTIME_COMMAND_TYPES.PURCHASE_GENERATOR,
          priority: CommandPriority.PLAYER,
          timestamp: 0,
          step: 0,
          payload: { generatorId: 'generator.mine', count: 1 },
        },
        {
          type: RUNTIME_COMMAND_TYPES.PURCHASE_UPGRADE,
          priority: CommandPriority.PLAYER,
          timestamp: 0,
          step: 0,
          payload: { upgradeId: 'upgrade.test' },
        },
        {
          type: RUNTIME_COMMAND_TYPES.TOGGLE_AUTOMATION,
          priority: CommandPriority.PLAYER,
          timestamp: 0,
          step: 0,
          payload: { automationId: 'automation.test', enabled: true },
        },
        {
          type: RUNTIME_COMMAND_TYPES.RUN_TRANSFORM,
          priority: CommandPriority.PLAYER,
          timestamp: 0,
          step: 0,
          payload: { transformId: 'transform.test' },
        },
      ],
    });
  });

  it('returns a clear error when a facade action has no registered handler', () => {
    const noAutomation = createGame(createTestContent(), {
      stepSizeMs: 100,
      systems: { automation: false },
    });

    expect(
      noAutomation.internals.commandDispatcher.getHandler(
        RUNTIME_COMMAND_TYPES.TOGGLE_AUTOMATION,
      ),
    ).toBeUndefined();
    expect(noAutomation.toggleAutomation('automation.test', true)).toEqual({
      success: false,
      error: expect.objectContaining({ code: 'COMMAND_UNSUPPORTED' }),
    });

    const noTransforms = createGame(createTestContent(), {
      stepSizeMs: 100,
      systems: { transforms: false },
    });

    expect(
      noTransforms.internals.commandDispatcher.getHandler(
        RUNTIME_COMMAND_TYPES.RUN_TRANSFORM,
      ),
    ).toBeUndefined();
    expect(noTransforms.startTransform('transform.test')).toEqual({
      success: false,
      error: expect.objectContaining({ code: 'COMMAND_UNSUPPORTED' }),
    });

    const noUpgrades = createGame(
      createContentPack({
        resources: [createResourceDefinition('resource.energy', { startAmount: 0 })],
      }),
      { stepSizeMs: 100 },
    );

    expect(
      noUpgrades.internals.commandDispatcher.getHandler(
        RUNTIME_COMMAND_TYPES.PURCHASE_UPGRADE,
      ),
    ).toBeUndefined();
    expect(noUpgrades.purchaseUpgrade('upgrade.test')).toEqual({
      success: false,
      error: expect.objectContaining({ code: 'COMMAND_UNSUPPORTED' }),
    });
  });

  it('ticks queued commands through the wired dispatcher', () => {
    const game = createGame(
      createContentPack({
        resources: [
          createResourceDefinition('resource.energy', { startAmount: 1 }),
          createResourceDefinition('resource.gold', { startAmount: 0 }),
        ],
        transforms: [createTestTransform()],
      }),
      { stepSizeMs: 100 },
    );

    const energyIndex = game.internals.coordinator.resourceState.getIndex(
      'resource.energy',
    )!;
    const goldIndex = game.internals.coordinator.resourceState.getIndex(
      'resource.gold',
    )!;

    expect(game.internals.coordinator.resourceState.getAmount(energyIndex)).toBe(1);
    expect(game.internals.coordinator.resourceState.getAmount(goldIndex)).toBe(0);

    expect(game.startTransform('transform.test')).toEqual({ success: true });
    game.tick(game.internals.runtime.getStepSizeMs());

    expect(game.internals.coordinator.resourceState.getAmount(energyIndex)).toBe(0);
    expect(game.internals.coordinator.resourceState.getAmount(goldIndex)).toBe(1);
  });

  it('rejects commands when the queue cannot make room', () => {
    const game = createGame(createTestContent(), {
      stepSizeMs: 100,
      config: {
        limits: {
          maxCommandQueueSize: 1,
        },
      },
    });

    game.internals.commandQueue.enqueue({
      type: 'test:system',
      payload: {},
      priority: CommandPriority.SYSTEM,
      timestamp: 0,
      step: game.internals.runtime.getNextExecutableStep(),
    });

    expect(game.purchaseGenerator('generator.mine', 1)).toEqual({
      success: false,
      error: expect.objectContaining({
        code: 'COMMAND_REJECTED',
      }),
    });
  });

  it('round-trips serialized saves', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1234);
    resetRNG();
    setRNGSeed(42);

    const content = createTestContent();
    const game = createGame(content, { stepSizeMs: 100 });
    game.tick(game.internals.runtime.getStepSizeMs() * 3);
    expect(game.startTransform('transform.test')).toEqual({ success: true });
    game.tick(game.internals.runtime.getStepSizeMs());

    vi.setSystemTime(5678);
    const save = game.serialize();

    const restored = createGame(content, { stepSizeMs: 100 });
    restored.hydrate(save);

    vi.setSystemTime(5678);
    expect(restored.serialize()).toEqual(save);

    restored.stop();
    game.stop();
    vi.useRealTimers();
  });

  it('hydrates legacy v0 saves (embedded automation state)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1234);
    resetRNG();
    setRNGSeed(42);

    const content = createTestContent();
    const game = createGame(content, { stepSizeMs: 100 });
    expect(game.toggleAutomation('automation.test', true)).toEqual({ success: true });
    game.tick(game.internals.runtime.getStepSizeMs());

    const save = game.serialize();
    const legacySave = {
      savedAt: save.savedAt,
      resources: {
        ...save.resources,
        automationState: save.automation,
      },
      progression: {
        ...save.progression,
        resources: {
          ...save.progression.resources,
          automationState: save.automation,
        },
      },
      transforms: save.transforms,
      prd: save.prd,
      commandQueue: save.commandQueue,
      runtime: save.runtime,
    };

    const restored = createGame(content, { stepSizeMs: 100 });
    restored.hydrate(legacySave);

    const automationState = restored.internals.automationSystem
      ?.getState()
      .get('automation.test');
    expect(automationState?.enabled).toBe(true);

    restored.stop();
    game.stop();
    vi.useRealTimers();
  });

  it('rejects hydrating a save from an earlier step than the current runtime', () => {
    const content = createContentPack({
      resources: [createResourceDefinition('resource.energy', { startAmount: 0 })],
    });

    const saveSource = createGame(content, { stepSizeMs: 100 });
    const save = saveSource.serialize();

    const advanced = createGame(content, { stepSizeMs: 100 });
    advanced.tick(advanced.internals.runtime.getStepSizeMs() * 2);

    expect(() => advanced.hydrate(save)).toThrowError(
      /Cannot hydrate a save from step 0 into a runtime currently at step 2\./,
    );
  });

  it('hydrates very large saves (high step + large command queue)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1234);
    resetRNG();
    setRNGSeed(42);

    const extraResources = Array.from({ length: 1500 }, (_, index) =>
      createResourceDefinition(`resource.extra.${index}`, { startAmount: index }),
    );
    const content = createContentPack({
      resources: [
        createResourceDefinition('resource.energy', { startAmount: 1000 }),
        createResourceDefinition('resource.gold', { startAmount: 0 }),
        ...extraResources,
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
      upgrades: [createUpgradeDefinition('upgrade.test')],
    });

    const game = createGame(content, { stepSizeMs: 100 });
    const targetStep = 50_000;
    game.internals.runtime.fastForward(targetStep * game.internals.runtime.getStepSizeMs());
    game.internals.coordinator.updateForStep(targetStep);

    for (let index = 0; index < 8000; index += 1) {
      game.purchaseGenerator('generator.mine', 1);
    }
    expect(game.internals.commandQueue.size).toBe(8000);

    const save = game.serialize();

    const restored = createGame(content, { stepSizeMs: 100 });
    restored.hydrate(save);

    expect(restored.internals.runtime.getCurrentStep()).toBe(targetStep);
    expect(restored.internals.commandQueue.size).toBe(save.commandQueue.entries.length);

    const energyIndex = restored.internals.coordinator.resourceState.getIndex('resource.energy')!;
    expect(restored.internals.coordinator.resourceState.getAmount(energyIndex)).toBe(1000);

    const lastExtraId = 'resource.extra.1499';
    const extraIndex = restored.internals.coordinator.resourceState.getIndex(lastExtraId)!;
    expect(restored.internals.coordinator.resourceState.getAmount(extraIndex)).toBe(1499);

    const restoredQueue = restored.internals.commandQueue.exportForSave();
    expect(restoredQueue.entries).toHaveLength(save.commandQueue.entries.length);
    expect(restoredQueue.entries[0]).toEqual(save.commandQueue.entries[0]);
    expect(restoredQueue.entries[restoredQueue.entries.length - 1]).toEqual(
      save.commandQueue.entries[save.commandQueue.entries.length - 1],
    );

    restored.stop();
    game.stop();
    vi.useRealTimers();
  });

  it('uses scheduler interval overrides and falls back on invalid values', () => {
    vi.useFakeTimers();

    const content = createContentPack({
      resources: [createResourceDefinition('resource.energy', { startAmount: 0 })],
    });

    const customInterval = createGame(content, {
      stepSizeMs: 100,
      scheduler: { intervalMs: 60 },
    });

    customInterval.start();
    vi.advanceTimersByTime(500);
    expect(customInterval.internals.runtime.getCurrentStep()).toBe(4);
    customInterval.stop();

    const fallbackInterval = createGame(content, {
      stepSizeMs: 80,
      scheduler: { intervalMs: 0 },
    });

    fallbackInterval.start();
    vi.advanceTimersByTime(400);
    expect(fallbackInterval.internals.runtime.getCurrentStep()).toBe(5);
    fallbackInterval.stop();

    vi.useRealTimers();
  });

  it('starts and stops the built-in scheduler', () => {
    vi.useFakeTimers();

    const game = createGame(
      createContentPack({
        resources: [createResourceDefinition('resource.energy', { startAmount: 0 })],
      }),
      { stepSizeMs: 100 },
    );

    expect(game.internals.runtime.getCurrentStep()).toBe(0);
    game.start();
    vi.advanceTimersByTime(500);
    expect(game.internals.runtime.getCurrentStep()).toBe(5);

    game.stop();
    vi.advanceTimersByTime(500);
    expect(game.internals.runtime.getCurrentStep()).toBe(5);

    vi.useRealTimers();
  });
});
