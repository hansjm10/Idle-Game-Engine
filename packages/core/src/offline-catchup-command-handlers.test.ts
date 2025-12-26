import { describe, expect, it } from 'vitest';

import type { NumericFormula } from '@idle-engine/content-schema';

import { CommandDispatcher } from './command-dispatcher.js';
import { CommandPriority, RUNTIME_COMMAND_TYPES } from './command.js';
import { CommandQueue } from './command-queue.js';
import { registerOfflineCatchupCommandHandler } from './offline-catchup-command-handlers.js';
import { applyOfflineProgress } from './offline-progress.js';
import { createProductionSystem } from './production-system.js';
import { createProgressionCoordinator } from './progression-coordinator.js';
import {
  createContentPack,
  createGeneratorDefinition,
  createResourceDefinition,
  createUpgradeDefinition,
} from './content-test-helpers.js';
import {
  hydrateProgressionCoordinatorState,
  serializeProgressionCoordinatorState,
} from './progression-coordinator-save.js';
import { IdleEngineRuntime } from './index.js';

const STEP_SIZE_MS = 100;

const literal = (value: number): NumericFormula => ({
  kind: 'constant',
  value,
});

function createTestContent() {
  return createContentPack({
    resources: [
      createResourceDefinition('resource.energy', {
        startAmount: 1000,
        capacity: null,
        unlocked: true,
        visible: true,
      }),
      createResourceDefinition('resource.gold', {
        startAmount: 0,
        capacity: null,
        unlocked: true,
        visible: true,
      }),
    ],
    generators: [
      createGeneratorDefinition('generator.mine', {
        purchase: {
          currencyId: 'resource.energy',
          costMultiplier: 10,
          costCurve: literal(1),
        },
        produces: [{ resourceId: 'resource.gold', rate: literal(4) }],
        consumes: [],
        baseUnlock: { kind: 'always' },
      }),
    ],
    upgrades: [
      createUpgradeDefinition('upgrade.double-mine', {
        cost: {
          currencyId: 'resource.energy',
          costMultiplier: 100,
          costCurve: literal(1),
        },
        effects: [
          {
            kind: 'modifyGeneratorRate',
            generatorId: 'generator.mine',
            operation: 'multiply',
            value: literal(2),
          },
        ],
      }),
    ],
  });
}

function createHarness(initialStep = 0) {
  const content = createTestContent();
  const coordinator = createProgressionCoordinator({
    content,
    stepDurationMs: STEP_SIZE_MS,
  });

  const queue = new CommandQueue();
  const dispatcher = new CommandDispatcher();
  const runtime = new IdleEngineRuntime({
    stepSizeMs: STEP_SIZE_MS,
    initialStep,
    commandQueue: queue,
    commandDispatcher: dispatcher,
  });

  const productionSystem = createProductionSystem({
    systemId: 'test-production',
    generators: () =>
      (coordinator.state.generators ?? []).map((generator) => ({
        id: generator.id,
        owned: generator.owned,
        enabled: generator.enabled,
        produces: generator.produces ?? [],
        consumes: generator.consumes ?? [],
      })),
    resourceState: coordinator.resourceState,
    applyThreshold: 1,
  });
  runtime.addSystem(productionSystem);

  runtime.addSystem({
    id: 'progression-coordinator',
    tick: ({ step }) => {
      coordinator.updateForStep(step + 1);
    },
  });

  registerOfflineCatchupCommandHandler({
    dispatcher,
    coordinator,
    runtime,
  });

  return { coordinator, runtime, productionSystem, queue, dispatcher };
}

function runFrameDeltas(
  runtime: IdleEngineRuntime,
  coordinator: ReturnType<typeof createProgressionCoordinator>,
  deltas: readonly number[],
) {
  for (const deltaMs of deltas) {
    const before = runtime.getCurrentStep();
    runtime.tick(deltaMs);
    const after = runtime.getCurrentStep();
    if (after !== before) {
      coordinator.updateForStep(after);
    }
  }
}

describe('OFFLINE_CATCHUP command handler', () => {
  it('matches applyOfflineProgress outcomes after save/load', () => {
    const baseline = createHarness(0);
    baseline.coordinator.incrementGeneratorOwned('generator.mine', 1);
    baseline.coordinator.setUpgradePurchases('upgrade.double-mine', 1);
    baseline.coordinator.updateForStep(baseline.runtime.getCurrentStep());

    runFrameDeltas(baseline.runtime, baseline.coordinator, [
      STEP_SIZE_MS,
      STEP_SIZE_MS,
      STEP_SIZE_MS,
    ]);

    const saved = serializeProgressionCoordinatorState(
      baseline.coordinator,
      baseline.productionSystem,
    );

    const offlineElapsedMs = 1234;

    const restoredWithHelper = createHarness(saved.step);
    hydrateProgressionCoordinatorState(
      saved,
      restoredWithHelper.coordinator,
      restoredWithHelper.productionSystem,
    );

    applyOfflineProgress({
      elapsedMs: offlineElapsedMs,
      coordinator: restoredWithHelper.coordinator,
      runtime: restoredWithHelper.runtime,
    });

    const restoredWithCommand = createHarness(saved.step);
    hydrateProgressionCoordinatorState(
      saved,
      restoredWithCommand.coordinator,
      restoredWithCommand.productionSystem,
    );
    restoredWithCommand.coordinator.updateForStep(
      restoredWithCommand.runtime.getCurrentStep(),
    );

    restoredWithCommand.queue.enqueue({
      type: RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP,
      priority: CommandPriority.SYSTEM,
      payload: { elapsedMs: offlineElapsedMs, resourceDeltas: {} },
      timestamp: 0,
      step: restoredWithCommand.runtime.getCurrentStep(),
    });

    restoredWithCommand.runtime.tick(STEP_SIZE_MS);
    restoredWithCommand.coordinator.updateForStep(
      restoredWithCommand.runtime.getCurrentStep(),
    );

    expect(restoredWithCommand.runtime.getCurrentStep()).toBe(
      restoredWithHelper.runtime.getCurrentStep(),
    );
    expect(restoredWithCommand.coordinator.resourceState.exportForSave()).toEqual(
      restoredWithHelper.coordinator.resourceState.exportForSave(),
    );
    expect(restoredWithCommand.productionSystem.exportAccumulators()).toEqual(
      restoredWithHelper.productionSystem.exportAccumulators(),
    );
  });

  it('applies resource deltas and clamps spends to available amounts', () => {
    const harness = createHarness(0);
    const state = harness.coordinator.resourceState;
    const energyIndex = state.requireIndex('resource.energy');
    const goldIndex = state.requireIndex('resource.gold');

    harness.queue.enqueue({
      type: RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP,
      priority: CommandPriority.SYSTEM,
      payload: {
        elapsedMs: STEP_SIZE_MS,
        resourceDeltas: {
          'resource.gold': 5,
          'resource.energy': -2000,
          'resource.unknown': 10,
        },
      },
      timestamp: 0,
      step: harness.runtime.getCurrentStep(),
    });

    harness.runtime.tick(STEP_SIZE_MS);

    expect(state.getAmount(goldIndex)).toBe(5);
    expect(state.getAmount(energyIndex)).toBe(0);
  });

  it('caps offline elapsed time with maxElapsedMs', () => {
    const harness = createHarness(0);

    harness.queue.enqueue({
      type: RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP,
      priority: CommandPriority.SYSTEM,
      payload: {
        elapsedMs: STEP_SIZE_MS * 5 + 20,
        maxElapsedMs: STEP_SIZE_MS * 2 + 50,
        resourceDeltas: {},
      },
      timestamp: 0,
      step: harness.runtime.getCurrentStep(),
    });

    harness.runtime.tick(STEP_SIZE_MS);

    expect(harness.runtime.getCurrentStep()).toBe(2);
  });

  it('caps offline elapsed time with maxSteps', () => {
    const harness = createHarness(0);

    harness.queue.enqueue({
      type: RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP,
      priority: CommandPriority.SYSTEM,
      payload: {
        elapsedMs: STEP_SIZE_MS * 6,
        maxSteps: 3,
        resourceDeltas: {},
      },
      timestamp: 0,
      step: harness.runtime.getCurrentStep(),
    });

    harness.runtime.tick(STEP_SIZE_MS);

    expect(harness.runtime.getCurrentStep()).toBe(3);
  });
});
