import { describe, expect, it } from 'vitest';

import {
  CommandPriority,
  IdleEngineRuntime,
  RUNTIME_COMMAND_TYPES,
  createAutomationSystem,
  createMockEventPublisher,
  createProgressionCoordinator,
  createResourceStateAdapter,
  registerResourceCommandHandlers,
} from './index.js';
import {
  createAchievementDefinition,
  createContentPack,
  createResourceDefinition,
  createUpgradeDefinition,
  literalOne,
} from './content-test-helpers.js';

describe('Integration: upgrade effects', () => {
  it('applies grantFlag so flag conditions can gate upgrades', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const flagUpgrade = createUpgradeDefinition('upgrade.grant-flag', {
      name: 'Grant Flag',
      cost: {
        currencyId: energy.id,
        costMultiplier: 0,
        costCurve: literalOne,
      },
      effects: [
        {
          kind: 'grantFlag',
          flagId: 'flag.gated',
          value: true,
        },
      ],
    });

    const gatedUpgrade = createUpgradeDefinition('upgrade.gated-by-flag', {
      name: 'Gated Upgrade',
      cost: {
        currencyId: energy.id,
        costMultiplier: 0,
        costCurve: literalOne,
      },
      unlockCondition: {
        kind: 'flag',
        flagId: 'flag.gated',
      },
      effects: [],
    });

    const pack = createContentPack({
      resources: [energy],
      upgrades: [flagUpgrade, gatedUpgrade],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    expect(coordinator.upgradeEvaluator?.getPurchaseQuote(gatedUpgrade.id)?.status).toBe(
      'locked',
    );

    coordinator.upgradeEvaluator?.applyPurchase(flagUpgrade.id);

    expect(coordinator.upgradeEvaluator?.getPurchaseQuote(gatedUpgrade.id)?.status).toBe(
      'available',
    );
  });
  it('applies grantAutomation upgrade effects to the automation system via unlock hook', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const automation = {
      id: 'automation.test',
      name: { default: 'Test Automation', variants: {} },
      description: { default: 'Test', variants: {} },
      targetType: 'system',
      systemTargetId: 'offline-catchup',
      trigger: { kind: 'commandQueueEmpty' },
      unlockCondition: { kind: 'never' },
      enabledByDefault: false,
    } as any;

    const upgrade = createUpgradeDefinition('upgrade.grant-automation', {
      name: 'Grant Automation',
      cost: {
        currencyId: energy.id,
        costMultiplier: 0,
        costCurve: literalOne,
      },
      effects: [
        {
          kind: 'grantAutomation',
          automationId: automation.id,
        },
      ],
    });

    const pack = createContentPack({
      resources: [energy],
      automations: [automation],
      upgrades: [upgrade],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    const runtime = new IdleEngineRuntime({ stepSizeMs: 100 });
    const automationSystem = createAutomationSystem({
      automations: pack.automations,
      commandQueue: runtime.getCommandQueue(),
      resourceState: createResourceStateAdapter(coordinator.resourceState),
      stepDurationMs: 100,
      isAutomationUnlocked: (automationId) =>
        coordinator.getGrantedAutomationIds().has(automationId),
    });

    const events = createMockEventPublisher();

    automationSystem.tick({ step: 0, deltaMs: 100, events });
    expect(automationSystem.getState().get(automation.id)?.unlocked).toBe(false);

    coordinator.incrementUpgradePurchases(upgrade.id);

    automationSystem.tick({ step: 1, deltaMs: 100, events });
    expect(automationSystem.getState().get(automation.id)?.unlocked).toBe(true);
  });

  it('emits runtime events when purchasing upgrades with emitEvent effects', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const upgrade = createUpgradeDefinition('upgrade.emit', {
      name: 'Emit Event',
      cost: {
        currencyId: energy.id,
        costMultiplier: 0,
        costCurve: literalOne,
      },
      effects: [
        {
          kind: 'emitEvent',
          eventId: 'sample:reactor-primed',
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

    const runtime = new IdleEngineRuntime({ stepSizeMs: 100, initialStep: 0 });
    registerResourceCommandHandlers({
      dispatcher: runtime.getCommandDispatcher(),
      resources: coordinator.resourceState,
      generatorPurchases: coordinator.generatorEvaluator,
      generatorToggles: coordinator,
      upgradePurchases: coordinator.upgradeEvaluator,
    });

    const commandQueue = runtime.getCommandQueue();
    commandQueue.enqueue({
      type: RUNTIME_COMMAND_TYPES.PURCHASE_UPGRADE,
      payload: { upgradeId: upgrade.id },
      priority: CommandPriority.PLAYER,
      timestamp: 0,
      step: runtime.getNextExecutableStep(),
    });

    const manifest = runtime.getEventBus().getManifest();
    const entry = manifest.entries.find(
      (candidate) => candidate.type === 'sample:reactor-primed',
    );
    expect(entry).toBeDefined();

    runtime.tick(100);

    const buffer = runtime.getEventBus().getOutboundBuffer(entry!.channel);
    expect(buffer.length).toBe(1);
    expect(buffer.at(0).type).toBe('sample:reactor-primed');
    expect(buffer.at(0).issuedAt).toBe(0);
    expect(buffer.at(0).payload).toEqual({});
  });

  it('emits runtime events from achievement emitEvent rewards with deterministic issuedAt', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 0,
    });

    const achievement = createAchievementDefinition('achievement.emit-event', {
      reward: {
        kind: 'emitEvent',
        eventId: 'sample:reactor-primed',
      },
    });

    const pack = createContentPack({
      resources: [energy],
      achievements: [achievement],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    const runtime = new IdleEngineRuntime({ stepSizeMs: 100, initialStep: 0 });
    const energyIndex = coordinator.resourceState.requireIndex(energy.id);

    runtime.addSystem({
      id: 'progression-coordinator',
      tick: ({ step, events }) => {
        if (step === 0) {
          coordinator.resourceState.addAmount(energyIndex, 1);
        }
        coordinator.updateForStep(step, { events });
      },
    });

    const manifest = runtime.getEventBus().getManifest();
    const entry = manifest.entries.find(
      (candidate) => candidate.type === 'sample:reactor-primed',
    );
    expect(entry).toBeDefined();

    runtime.tick(100);

    const buffer = runtime.getEventBus().getOutboundBuffer(entry!.channel);
    expect(buffer.length).toBe(1);
    expect(buffer.at(0).type).toBe('sample:reactor-primed');
    expect(buffer.at(0).issuedAt).toBe(0);
    expect(buffer.at(0).payload).toEqual({});
  });
});
