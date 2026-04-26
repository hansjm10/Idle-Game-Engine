import { describe, expect, it, vi } from 'vitest';

import { createAutomation, createTransform } from '@idle-engine/content-schema';

import {
  createAchievementDefinition,
  createContentPack,
  createGeneratorDefinition,
  createPrestigeLayerDefinition,
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

function createSnapshotViewContent() {
  return createContentPack({
    resources: [
      createResourceDefinition('resource.energy', { startAmount: 20 }),
      createResourceDefinition('resource.gold', { startAmount: 0 }),
    ],
    automations: [
      createAutomation({
        id: 'automation.cooldown',
        name: { default: 'Cooldown Automation' },
        description: { default: 'Shows cooldown state' },
        targetType: 'collectResource',
        targetId: 'resource.gold',
        targetAmount: literalOne,
        trigger: {
          kind: 'resourceThreshold',
          resourceId: 'resource.energy',
          comparator: 'gte',
          threshold: { kind: 'constant', value: 999 },
        },
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
        cooldown: { kind: 'constant', value: 400 },
        order: 0,
      }),
      createAutomation({
        id: 'automation.locked',
        name: { default: 'Locked Automation' },
        description: { default: 'Hidden until unlocked' },
        targetType: 'collectResource',
        targetId: 'resource.gold',
        targetAmount: literalOne,
        trigger: { kind: 'commandQueueEmpty' },
        unlockCondition: { kind: 'never' },
        enabledByDefault: false,
        order: 1,
      }),
    ],
    transforms: [
      createTransform({
        id: 'transform.batch',
        name: { default: 'Batch Transform' },
        description: { default: 'Converts energy later' },
        mode: 'batch',
        trigger: { kind: 'manual' },
        inputs: [
          { resourceId: 'resource.energy', amount: { kind: 'constant', value: 5 } },
        ],
        outputs: [
          { resourceId: 'resource.gold', amount: { kind: 'constant', value: 2 } },
        ],
        duration: { kind: 'constant', value: 300 },
        order: 0,
      }),
      createTransform({
        id: 'transform.expensive',
        name: { default: 'Expensive Transform' },
        description: { default: 'Costs more than the player owns' },
        mode: 'instant',
        trigger: { kind: 'manual' },
        inputs: [
          { resourceId: 'resource.energy', amount: { kind: 'constant', value: 999 } },
        ],
        outputs: [
          { resourceId: 'resource.gold', amount: { kind: 'constant', value: 1 } },
        ],
        order: 1,
      }),
    ],
  });
}

function createInitialSnapshotViewContent() {
  return createContentPack({
    resources: [
      createResourceDefinition('resource.energy', { startAmount: 20 }),
      createResourceDefinition('resource.gold', { startAmount: 0 }),
    ],
    automations: [
      createAutomation({
        id: 'automation.initial',
        name: { default: 'Initial Automation' },
        description: { default: 'Available immediately' },
        targetType: 'collectResource',
        targetId: 'resource.gold',
        targetAmount: literalOne,
        trigger: { kind: 'commandQueueEmpty' },
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
        order: 0,
      }),
      createAutomation({
        id: 'automation.locked-initial',
        name: { default: 'Locked Initial Automation' },
        description: { default: 'Locked immediately' },
        targetType: 'collectResource',
        targetId: 'resource.gold',
        targetAmount: literalOne,
        trigger: { kind: 'commandQueueEmpty' },
        unlockCondition: { kind: 'never' },
        enabledByDefault: false,
        order: 1,
      }),
    ],
    transforms: [
      createTransform({
        id: 'transform.initial',
        name: { default: 'Initial Transform' },
        description: { default: 'Available immediately' },
        mode: 'instant',
        trigger: { kind: 'manual' },
        inputs: [{ resourceId: 'resource.energy', amount: literalOne }],
        outputs: [{ resourceId: 'resource.gold', amount: literalOne }],
        unlockCondition: { kind: 'always' },
        order: 0,
      }),
      createTransform({
        id: 'transform.hidden-initial',
        name: { default: 'Hidden Initial Transform' },
        description: { default: 'Hidden immediately' },
        mode: 'instant',
        trigger: { kind: 'manual' },
        inputs: [{ resourceId: 'resource.energy', amount: literalOne }],
        outputs: [{ resourceId: 'resource.gold', amount: literalOne }],
        visibilityCondition: { kind: 'never' },
        order: 1,
      }),
    ],
  });
}

function createTransformVisibilityMutationContent() {
  return createContentPack({
    resources: [
      createResourceDefinition('resource.energy', { startAmount: 10 }),
      createResourceDefinition('resource.gold', { startAmount: 0 }),
    ],
    transforms: [
      createTransform({
        id: 'transform.spend-visible-resource',
        name: { default: 'Spend Visible Resource' },
        description: { default: 'Consumes the resource that controls visibility' },
        mode: 'instant',
        trigger: {
          kind: 'condition',
          condition: { kind: 'always' },
        },
        inputs: [
          { resourceId: 'resource.energy', amount: { kind: 'constant', value: 10 } },
        ],
        outputs: [
          { resourceId: 'resource.gold', amount: { kind: 'constant', value: 1 } },
        ],
        visibilityCondition: {
          kind: 'resourceThreshold',
          resourceId: 'resource.energy',
          comparator: 'gte',
          amount: { kind: 'constant', value: 10 },
        },
      }),
    ],
  });
}

function createAchievementRewardSnapshotViewContent() {
  const unlockAutomationAchievement = createAchievementDefinition(
    'achievement.unlock-automation-view',
    {
      reward: {
        kind: 'unlockAutomation' as const,
        automationId: 'automation.achievement-reward',
      },
      order: 0,
    },
  );
  const unlockTransformAchievement = createAchievementDefinition(
    'achievement.unlock-transform-view',
    {
      reward: {
        kind: 'grantFlag' as const,
        flagId: 'flag.transform-reward',
        value: true,
      },
      order: 1,
    },
  );

  return createContentPack({
    resources: [
      createResourceDefinition('resource.energy', { startAmount: 0 }),
      createResourceDefinition('resource.gold', { startAmount: 0 }),
    ],
    achievements: [unlockAutomationAchievement, unlockTransformAchievement],
    automations: [
      createAutomation({
        id: 'automation.achievement-reward',
        name: { default: 'Achievement Reward Automation' },
        description: { default: 'Unlocked by an achievement reward' },
        targetType: 'collectResource',
        targetId: 'resource.gold',
        targetAmount: literalOne,
        trigger: { kind: 'commandQueueEmpty' },
        unlockCondition: { kind: 'never' },
        enabledByDefault: true,
      }),
    ],
    transforms: [
      createTransform({
        id: 'transform.achievement-reward',
        name: { default: 'Achievement Reward Transform' },
        description: { default: 'Unlocked by an achievement flag reward' },
        mode: 'instant',
        trigger: { kind: 'manual' },
        inputs: [{ resourceId: 'resource.energy', amount: literalOne }],
        outputs: [{ resourceId: 'resource.gold', amount: literalOne }],
        unlockCondition: {
          kind: 'flag',
          flagId: 'flag.transform-reward',
        },
      }),
    ],
  });
}

function createLateTickUnlockPersistenceContent() {
  const unlockFromEnergy = {
    kind: 'resourceThreshold' as const,
    resourceId: 'resource.energy',
    comparator: 'lte' as const,
    amount: { kind: 'constant' as const, value: 0 },
  };

  return createContentPack({
    resources: [
      createResourceDefinition('resource.energy', { startAmount: 1 }),
      createResourceDefinition('resource.gold', { startAmount: 0 }),
    ],
    automations: [
      createAutomation({
        id: 'automation.late-unlocked',
        name: { default: 'Late Unlocked Automation' },
        description: { default: 'Unlocks after transforms run' },
        targetType: 'collectResource',
        targetId: 'resource.gold',
        targetAmount: literalOne,
        trigger: { kind: 'commandQueueEmpty' },
        unlockCondition: unlockFromEnergy,
        enabledByDefault: false,
      }),
    ],
    transforms: [
      createTransform({
        id: 'transform.late-unlocked-spender',
        name: { default: 'Late Unlocked Spender' },
        description: { default: 'Spends the unlock resource' },
        mode: 'instant',
        trigger: { kind: 'manual' },
        inputs: [{ resourceId: 'resource.gold', amount: literalOne }],
        outputs: [{ resourceId: 'resource.energy', amount: literalOne }],
        unlockCondition: unlockFromEnergy,
        order: 0,
      }),
      createTransform({
        id: 'transform.late-resource-spender',
        name: { default: 'Late Resource Spender' },
        description: { default: 'Consumes the unlock resource after locked views run' },
        mode: 'instant',
        trigger: { kind: 'condition', condition: { kind: 'always' } },
        inputs: [{ resourceId: 'resource.energy', amount: literalOne }],
        outputs: [{ resourceId: 'resource.gold', amount: literalOne }],
        cooldown: { kind: 'constant', value: 10_000 },
        order: 1,
      }),
    ],
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

function createTestContentWithPrestige() {
  const layerId = 'prestige.test';

  return createContentPack({
    resources: [
      createResourceDefinition('resource.energy', { startAmount: 1000 }),
      createResourceDefinition('resource.prestige', { startAmount: 0 }),
      createResourceDefinition(`${layerId}-prestige-count`, {
        startAmount: 0,
        visible: false,
        unlocked: true,
      }),
    ],
    prestigeLayers: [createPrestigeLayerDefinition(layerId)],
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

  it('exposes automation and transform view state through snapshots', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);

    const game = createGame(createSnapshotViewContent(), { stepSizeMs: 100 });
    if (!game.internals.automationSystem) {
      throw new Error('Expected automation system to be enabled.');
    }

    game.internals.automationSystem.restoreState([
      {
        id: 'automation.cooldown',
        enabled: true,
        lastFiredStep: 0,
        cooldownExpiresStep: 4,
        unlocked: true,
      },
      {
        id: 'automation.locked',
        enabled: false,
        lastFiredStep: null,
        cooldownExpiresStep: 0,
        unlocked: false,
      },
    ]);

    expect(game.startTransform('transform.batch')).toEqual({ success: true });
    game.tick(game.internals.runtime.getStepSizeMs());

    const snapshot = game.getSnapshot();

    expect(snapshot.automations).toEqual([
      {
        id: 'automation.cooldown',
        displayName: 'Cooldown Automation',
        description: 'Shows cooldown state',
        unlocked: true,
        visible: true,
        enabled: true,
        lastTriggeredAt: 900,
        cooldownRemainingMs: 300,
        isOnCooldown: true,
      },
      {
        id: 'automation.locked',
        displayName: 'Locked Automation',
        description: 'Hidden until unlocked',
        unlocked: false,
        visible: false,
        enabled: false,
        lastTriggeredAt: null,
        cooldownRemainingMs: 0,
        isOnCooldown: false,
      },
    ]);

    expect(snapshot.transforms).toEqual([
      {
        id: 'transform.batch',
        displayName: 'Batch Transform',
        description: 'Converts energy later',
        mode: 'batch',
        unlocked: true,
        visible: true,
        cooldownRemainingMs: 0,
        isOnCooldown: false,
        canAfford: true,
        inputs: [{ resourceId: 'resource.energy', amount: 5 }],
        outputs: [{ resourceId: 'resource.gold', amount: 2 }],
        outstandingBatches: 1,
        nextBatchReadyAtStep: 3,
      },
      {
        id: 'transform.expensive',
        displayName: 'Expensive Transform',
        description: 'Costs more than the player owns',
        mode: 'instant',
        unlocked: true,
        visible: true,
        cooldownRemainingMs: 0,
        isOnCooldown: false,
        canAfford: false,
        inputs: [{ resourceId: 'resource.energy', amount: 999 }],
        outputs: [{ resourceId: 'resource.gold', amount: 1 }],
      },
    ]);

    game.stop();
    vi.useRealTimers();
  });

  it('publishes initial automation and transform view state before the first tick', () => {
    vi.useFakeTimers();
    vi.setSystemTime(2000);

    const game = createGame(createInitialSnapshotViewContent(), { stepSizeMs: 100 });

    try {
      game.start();

      const snapshot = game.getSnapshot();

      expect(snapshot.step).toBe(0);
      expect(
        snapshot.automations.map(({ id, unlocked, visible }) => ({
          id,
          unlocked,
          visible,
        })),
      ).toEqual([
        { id: 'automation.initial', unlocked: true, visible: true },
        { id: 'automation.locked-initial', unlocked: false, visible: false },
      ]);
      expect(
        snapshot.transforms.map(({ id, unlocked, visible }) => ({
          id,
          unlocked,
          visible,
        })),
      ).toEqual([
        { id: 'transform.initial', unlocked: true, visible: true },
        { id: 'transform.hidden-initial', unlocked: true, visible: false },
      ]);
    } finally {
      game.stop();
      vi.useRealTimers();
    }
  });

  it('derives transform visibility from resources mutated earlier in the tick', () => {
    const game = createGame(createTransformVisibilityMutationContent(), {
      stepSizeMs: 100,
    });

    game.tick(game.internals.runtime.getStepSizeMs());

    const snapshot = game.getSnapshot();
    const energy = snapshot.resources.find(
      (resource) => resource.id === 'resource.energy',
    );
    const transform = snapshot.transforms.find(
      (view) => view.id === 'transform.spend-visible-resource',
    );

    expect(energy?.amount).toBe(0);
    expect(transform).toMatchObject({
      visible: false,
      canAfford: false,
    });
  });

  it('projects coordinator reward unlocks into the same tick snapshot', () => {
    const game = createGame(createAchievementRewardSnapshotViewContent(), {
      stepSizeMs: 100,
    });

    expect(game.collectResource('resource.energy', 1)).toEqual({ success: true });
    game.tick(game.internals.runtime.getStepSizeMs());

    const snapshot = game.getSnapshot();
    const automation = snapshot.automations.find(
      (view) => view.id === 'automation.achievement-reward',
    );
    const transform = snapshot.transforms.find(
      (view) => view.id === 'transform.achievement-reward',
    );

    expect(snapshot.achievements?.map(({ id, completions }) => ({
      id,
      completions,
    }))).toEqual([
      { id: 'achievement.unlock-automation-view', completions: 1 },
      { id: 'achievement.unlock-transform-view', completions: 1 },
    ]);
    expect(automation).toMatchObject({
      unlocked: true,
      visible: true,
    });
    expect(transform).toMatchObject({
      unlocked: true,
      visible: true,
    });
  });

  it('persists late-tick automation and transform unlocks before snapshots expose them', () => {
    const game = createGame(createLateTickUnlockPersistenceContent(), {
      stepSizeMs: 100,
    });

    game.tick(game.internals.runtime.getStepSizeMs());

    const unlockedSnapshot = game.getSnapshot();
    const unlockedEnergy = unlockedSnapshot.resources.find(
      (resource) => resource.id === 'resource.energy',
    );
    const unlockedAutomation = unlockedSnapshot.automations.find(
      (view) => view.id === 'automation.late-unlocked',
    );
    const unlockedTransform = unlockedSnapshot.transforms.find(
      (view) => view.id === 'transform.late-unlocked-spender',
    );

    expect(unlockedEnergy?.amount).toBe(0);
    expect(unlockedAutomation).toMatchObject({
      unlocked: true,
      visible: true,
    });
    expect(unlockedTransform).toMatchObject({
      unlocked: true,
      visible: true,
      canAfford: true,
    });

    expect(game.startTransform('transform.late-unlocked-spender')).toEqual({
      success: true,
    });
    game.tick(game.internals.runtime.getStepSizeMs());

    const spentSnapshot = game.getSnapshot();
    const spentEnergy = spentSnapshot.resources.find(
      (resource) => resource.id === 'resource.energy',
    );
    const persistedAutomation = spentSnapshot.automations.find(
      (view) => view.id === 'automation.late-unlocked',
    );
    const persistedTransform = spentSnapshot.transforms.find(
      (view) => view.id === 'transform.late-unlocked-spender',
    );

    expect(spentEnergy?.amount).toBe(1);
    expect(persistedAutomation).toMatchObject({
      unlocked: true,
      visible: true,
    });
    expect(persistedTransform).toMatchObject({
      unlocked: true,
      visible: true,
      canAfford: false,
    });
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
        RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
      ),
    ).toBeTypeOf('function');
    expect(
      game.internals.commandDispatcher.getHandler(
        RUNTIME_COMMAND_TYPES.TOGGLE_GENERATOR,
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
    expect(game.collectResource('resource.gold', 5)).toEqual({ success: true });
    expect(game.toggleGenerator('generator.mine', true)).toEqual({ success: true });
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
          type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
          priority: CommandPriority.PLAYER,
          timestamp: 0,
          step: 0,
          payload: { resourceId: 'resource.gold', amount: 5 },
        },
        {
          type: RUNTIME_COMMAND_TYPES.TOGGLE_GENERATOR,
          priority: CommandPriority.PLAYER,
          timestamp: 0,
          step: 0,
          payload: { generatorId: 'generator.mine', enabled: true },
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

  it('rejects invalid collectResource arguments', () => {
    const game = createGame(createTestContent(), { stepSizeMs: 100 });

    expect(game.collectResource('resource.gold', 0)).toEqual({
      success: false,
      error: expect.objectContaining({ code: 'INVALID_COLLECT_AMOUNT' }),
    });

    expect(game.collectResource('resource.gold', Number.NaN)).toEqual({
      success: false,
      error: expect.objectContaining({ code: 'INVALID_COLLECT_AMOUNT' }),
    });

    expect(game.collectResource('resource.unknown', 1)).toEqual({
      success: false,
      error: expect.objectContaining({ code: 'UNKNOWN_RESOURCE' }),
    });

    expect(game.internals.commandQueue.exportForSave()).toEqual({
      schemaVersion: 1,
      entries: [],
    });
  });

  it('normalizes positive purchase generator counts', () => {
    const game = createGame(createTestContent(), { stepSizeMs: 100 });

    expect(game.purchaseGenerator('generator.mine', 2.9)).toEqual({ success: true });
    expect(game.purchaseGenerator('generator.mine', 1.2)).toEqual({ success: true });

    const entries = game.internals.commandQueue.exportForSave().entries;
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.payload)).toEqual([
      { generatorId: 'generator.mine', count: 2 },
      { generatorId: 'generator.mine', count: 1 },
    ]);
  });

  it('rejects invalid purchase generator counts', () => {
    const game = createGame(createTestContent(), { stepSizeMs: 100 });

    expect(game.purchaseGenerator('generator.mine', 0)).toEqual({
      success: false,
      error: expect.objectContaining({ code: 'INVALID_PURCHASE_COUNT' }),
    });

    expect(game.purchaseGenerator('generator.mine', 0.2)).toEqual({
      success: false,
      error: expect.objectContaining({ code: 'INVALID_PURCHASE_COUNT' }),
    });

    expect(game.purchaseGenerator('generator.mine', -5)).toEqual({
      success: false,
      error: expect.objectContaining({ code: 'INVALID_PURCHASE_COUNT' }),
    });

    expect(game.purchaseGenerator('generator.mine', Number.NaN)).toEqual({
      success: false,
      error: expect.objectContaining({ code: 'INVALID_PURCHASE_COUNT' }),
    });

    expect(game.internals.commandQueue.exportForSave()).toEqual({
      schemaVersion: 1,
      entries: [],
    });
  });

  it('enqueues prestige resets when prestige is enabled', () => {
    const content = createTestContentWithPrestige();
    const game = createGame(content, { stepSizeMs: 100 });

    expect(
      game.internals.commandDispatcher.getHandler(
        RUNTIME_COMMAND_TYPES.PRESTIGE_RESET,
      ),
    ).toBeTypeOf('function');

    expect(game.prestigeReset('prestige.test')).toEqual({ success: true });
    expect(game.prestigeReset('prestige.test', 'token')).toEqual({ success: true });

    expect(game.internals.commandQueue.exportForSave()).toEqual({
      schemaVersion: 1,
      entries: [
        {
          type: RUNTIME_COMMAND_TYPES.PRESTIGE_RESET,
          priority: CommandPriority.PLAYER,
          timestamp: 0,
          step: 0,
          payload: { layerId: 'prestige.test' },
        },
        {
          type: RUNTIME_COMMAND_TYPES.PRESTIGE_RESET,
          priority: CommandPriority.PLAYER,
          timestamp: 0,
          step: 0,
          payload: { layerId: 'prestige.test', confirmationToken: 'token' },
        },
      ],
    });
  });

  it('returns a clear error when prestigeReset is unavailable', () => {
    const game = createGame(createTestContent(), { stepSizeMs: 100 });

    expect(
      game.internals.commandDispatcher.getHandler(
        RUNTIME_COMMAND_TYPES.PRESTIGE_RESET,
      ),
    ).toBeUndefined();

    expect(game.prestigeReset('prestige.test')).toEqual({
      success: false,
      error: expect.objectContaining({ code: 'COMMAND_UNSUPPORTED' }),
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

  it('serializes and restores source-aware runtime backlog', () => {
    const content = createTestContent();
    const source = createGame(content, {
      stepSizeMs: 100,
      maxStepsPerFrame: 2,
    });
    source.internals.runtime.restoreAccumulatorBacklog({
      hostFrameMs: 50,
      creditedMs: 250,
    });

    const save = source.serialize();
    expect(save.runtime.accumulatorBacklogMs).toBe(300);
    expect(save.runtime.hostFrameBacklogMs).toBe(50);
    expect(save.runtime.creditedBacklogMs).toBe(250);

    const restored = createGame(content, {
      stepSizeMs: 100,
      maxStepsPerFrame: 2,
    });
    restored.hydrate(save);

    expect(restored.internals.runtime.getAccumulatorBacklogState()).toEqual({
      totalMs: 300,
      hostFrameMs: 50,
      creditedMs: 250,
    });
    expect(restored.internals.runtime.drainCreditedBacklog()).toBe(2);
    expect(restored.internals.runtime.getAccumulatorBacklogState()).toEqual({
      totalMs: 100,
      hostFrameMs: 50,
      creditedMs: 50,
    });

    restored.stop();
    source.stop();
  });

  it('restarts the scheduler after hydrate when it was running', () => {
    vi.useFakeTimers();
    resetRNG();
    setRNGSeed(42);

    const content = createTestContent();

    const source = createGame(content, { stepSizeMs: 100 });
    source.tick(source.internals.runtime.getStepSizeMs() * 5);
    const save = source.serialize();

    const restored = createGame(content, { stepSizeMs: 100 });
    restored.start();
    vi.advanceTimersByTime(restored.internals.runtime.getStepSizeMs());
    expect(restored.internals.runtime.getCurrentStep()).toBe(1);

    restored.hydrate(save);
    expect(restored.internals.runtime.getCurrentStep()).toBe(save.runtime.step);

    vi.advanceTimersByTime(restored.internals.runtime.getStepSizeMs() * 3);
    expect(restored.internals.runtime.getCurrentStep()).toBe(save.runtime.step + 3);

    restored.stop();
    source.stop();
    vi.useRealTimers();
  });

  it('does not start the scheduler after hydrate when it was not running', () => {
    vi.useFakeTimers();
    resetRNG();
    setRNGSeed(42);

    const content = createTestContent();

    const source = createGame(content, { stepSizeMs: 100 });
    source.tick(source.internals.runtime.getStepSizeMs() * 5);
    const save = source.serialize();

    const restored = createGame(content, { stepSizeMs: 100 });
    restored.hydrate(save);

    const hydratedStep = restored.internals.runtime.getCurrentStep();
    vi.advanceTimersByTime(restored.internals.runtime.getStepSizeMs() * 3);
    expect(restored.internals.runtime.getCurrentStep()).toBe(hydratedStep);

    restored.stop();
    source.stop();
    vi.useRealTimers();
  });

  it('restores scheduler running state after hydrate throws', () => {
    vi.useFakeTimers();
    resetRNG();
    setRNGSeed(42);

    const content = createTestContent();

    const saveSource = createGame(content, { stepSizeMs: 100 });
    const save = saveSource.serialize();

    const running = createGame(content, { stepSizeMs: 100 });
    running.start();
    vi.advanceTimersByTime(running.internals.runtime.getStepSizeMs() * 2);
    expect(running.internals.runtime.getCurrentStep()).toBe(2);

    expect(() => running.hydrate(save)).toThrowError(
      /Cannot hydrate a save from step 0 into a runtime currently at step 2\./,
    );

    vi.advanceTimersByTime(running.internals.runtime.getStepSizeMs());
    expect(running.internals.runtime.getCurrentStep()).toBe(3);

    running.stop();
    saveSource.stop();
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
