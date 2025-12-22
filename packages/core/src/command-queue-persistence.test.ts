import { describe, expect, it } from 'vitest';

import type { AutomationDefinition, NumericFormula } from '@idle-engine/content-schema';

import { CommandDispatcher } from './command-dispatcher.js';
import { CommandPriority } from './command.js';
import { CommandQueue } from './command-queue.js';
import { createResourceStateAdapter } from './automation-resource-state-adapter.js';
import { createAutomationSystem } from './automation-system.js';
import {
  createContentPack,
  createResourceDefinition,
} from './content-test-helpers.js';
import { IdleEngineRuntime } from './index.js';
import { createProgressionCoordinator } from './progression-coordinator.js';

const STEP_SIZE_MS = 100;

const literal = (value: number): NumericFormula => ({
  kind: 'constant',
  value,
});

function createAutomation(options: {
  readonly withResourceCost: boolean;
  readonly cooldownMs: number;
}): AutomationDefinition {
  return {
    id: 'automation.research',
    name: { default: 'Research', variants: {} },
    description: { default: 'Research automation', variants: {} },
    targetType: 'system',
    systemTargetId: 'research-daemon',
    trigger: {
      kind: 'interval',
      interval: literal(STEP_SIZE_MS),
    },
    cooldown: literal(options.cooldownMs),
    resourceCost: options.withResourceCost
      ? {
          resourceId: 'resource.coins',
          rate: literal(10),
        }
      : undefined,
    unlockCondition: { kind: 'always' },
    enabledByDefault: true,
  } as unknown as AutomationDefinition;
}

function createHarness(options: {
  readonly startingCoins: number;
  readonly withResourceCost: boolean;
}) {
  const content = createContentPack({
    resources: [
      createResourceDefinition('resource.coins', {
        startAmount: options.startingCoins,
        capacity: null,
        unlocked: true,
        visible: true,
      }),
      createResourceDefinition('resource.research', {
        startAmount: 0,
        capacity: null,
        unlocked: true,
        visible: true,
      }),
    ],
    automations: [createAutomation({ withResourceCost: options.withResourceCost, cooldownMs: 1000 })],
  });

  const coordinator = createProgressionCoordinator({
    content,
    stepDurationMs: STEP_SIZE_MS,
  });

  const queue = new CommandQueue();
  const dispatcher = new CommandDispatcher();
  const runtime = new IdleEngineRuntime({
    stepSizeMs: STEP_SIZE_MS,
    commandQueue: queue,
    commandDispatcher: dispatcher,
  });

  const coinsIndex = coordinator.resourceState.requireIndex('resource.coins');
  const researchIndex =
    coordinator.resourceState.requireIndex('resource.research');

  dispatcher.register('RESEARCH_DAEMON', () => {
    coordinator.resourceState.addAmount(researchIndex, 1);
  });

  const automationSystem = createAutomationSystem({
    automations: content.automations,
    stepDurationMs: STEP_SIZE_MS,
    commandQueue: queue,
    resourceState: createResourceStateAdapter(coordinator.resourceState),
  });

  runtime.addSystem(automationSystem);

  return {
    coordinator,
    runtime,
    queue,
    dispatcher,
    automationSystem,
    coinsIndex,
    researchIndex,
  };
}

describe('CommandQueue persistence', () => {
  it('restores a pending automation command between steps', () => {
    const baseline = createHarness({ startingCoins: 0, withResourceCost: false });

    baseline.runtime.tick(STEP_SIZE_MS);

    const snapshotStep = baseline.runtime.getCurrentStep();
    const resourceSave = baseline.coordinator.resourceState.exportForSave(
      baseline.automationSystem.getState(),
    );
    const queueSave = baseline.queue.exportForSave();

    expect(queueSave.entries.length).toBeGreaterThan(0);
    expect(resourceSave.automationState?.length ?? 0).toBeGreaterThan(0);

    baseline.runtime.tick(STEP_SIZE_MS);
    const baselineResearch = baseline.coordinator.resourceState.getAmount(
      baseline.researchIndex,
    );

    const restored = createHarness({ startingCoins: 0, withResourceCost: false });
    restored.coordinator.hydrateResources(resourceSave);
    if (resourceSave.automationState) {
      restored.automationSystem.restoreState(resourceSave.automationState, {
        savedWorkerStep: snapshotStep,
        currentStep: restored.runtime.getCurrentStep(),
      });
    }

    restored.queue.restoreFromSave(queueSave, {
      isCommandTypeSupported: (type) =>
        restored.dispatcher.getHandler(type) !== undefined,
      rebaseStep: {
        savedStep: snapshotStep,
        currentStep: restored.runtime.getCurrentStep(),
      },
    });

    restored.runtime.tick(STEP_SIZE_MS);

    const restoredResearch = restored.coordinator.resourceState.getAmount(
      restored.researchIndex,
    );

    expect(restoredResearch).toBe(baselineResearch);
  });

  it('restores a resourceCost automation command so the spend is not lost', () => {
    const baseline = createHarness({ startingCoins: 100, withResourceCost: true });

    baseline.runtime.tick(STEP_SIZE_MS);

    const snapshotStep = baseline.runtime.getCurrentStep();
    const resourceSave = baseline.coordinator.resourceState.exportForSave(
      baseline.automationSystem.getState(),
    );
    const queueSave = baseline.queue.exportForSave();

    expect(queueSave.entries.length).toBeGreaterThan(0);

    baseline.runtime.tick(STEP_SIZE_MS);

    const baselineCoins = baseline.coordinator.resourceState.getAmount(
      baseline.coinsIndex,
    );
    const baselineResearch = baseline.coordinator.resourceState.getAmount(
      baseline.researchIndex,
    );

    const restored = createHarness({ startingCoins: 0, withResourceCost: true });
    restored.coordinator.hydrateResources(resourceSave);
    if (resourceSave.automationState) {
      restored.automationSystem.restoreState(resourceSave.automationState, {
        savedWorkerStep: snapshotStep,
        currentStep: restored.runtime.getCurrentStep(),
      });
    }

    restored.queue.restoreFromSave(queueSave, {
      isCommandTypeSupported: (type) =>
        restored.dispatcher.getHandler(type) !== undefined,
      rebaseStep: {
        savedStep: snapshotStep,
        currentStep: restored.runtime.getCurrentStep(),
      },
    });

    restored.runtime.tick(STEP_SIZE_MS);

    const restoredCoins = restored.coordinator.resourceState.getAmount(
      restored.coinsIndex,
    );
    const restoredResearch = restored.coordinator.resourceState.getAmount(
      restored.researchIndex,
    );

    expect(restoredCoins).toBe(baselineCoins);
    expect(restoredResearch).toBe(baselineResearch);
  });

  it('ignores unknown command types when requested', () => {
    const queue = new CommandQueue();
    const serialized = {
      schemaVersion: 1,
      entries: [
        {
          type: 'FUTURE_COMMAND',
          priority: CommandPriority.PLAYER,
          timestamp: 1,
          step: 0,
          payload: { ok: true },
        },
      ],
    } as const;

    const result = queue.restoreFromSave(serialized, {
      isCommandTypeSupported: (type) => type === 'KNOWN_COMMAND',
    });

    expect(result.restored).toBe(0);
    expect(result.skipped).toBe(1);
    expect(queue.size).toBe(0);
  });
});
