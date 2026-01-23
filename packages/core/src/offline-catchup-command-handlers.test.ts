import { afterEach, describe, expect, it, vi } from 'vitest';

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
import { resetTelemetry, setTelemetry } from './telemetry.js';

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

function createTelemetryCapture() {
  const recordError = vi.fn();

  setTelemetry({
    recordError,
    recordWarning: vi.fn(),
    recordProgress: vi.fn(),
    recordCounters: vi.fn(),
    recordTick: vi.fn(),
  });

  return { recordError };
}

function createDirectHandlerHarness(stepSizeMs = STEP_SIZE_MS) {
  const dispatcher = new CommandDispatcher();

  const coordinator = {
    resourceState: {
      getIndex: () => undefined,
      addAmount: () => {},
      getAmount: () => 0,
      spendAmount: () => {},
    },
  } as unknown as ReturnType<typeof createProgressionCoordinator>;

  const runtime = {
    getStepSizeMs: vi.fn(() => stepSizeMs),
    creditTime: vi.fn(),
  };

  registerOfflineCatchupCommandHandler({
    dispatcher,
    coordinator,
    runtime,
  });

  const handler = dispatcher.getHandler(RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP);
  if (!handler) {
    throw new Error('Expected OFFLINE_CATCHUP handler to be registered');
  }

  const context = {
    step: 10,
    timestamp: 0,
    priority: CommandPriority.SYSTEM,
    events: {
      publish: () => {
        throw new Error('Expected events publisher to be unused');
      },
    },
  } as const;

  return { handler, runtime, context };
}

describe('OFFLINE_CATCHUP command handler', () => {
  afterEach(() => {
    resetTelemetry();
  });

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

  it('records telemetry and ignores invalid payload types', () => {
    const { handler, runtime, context } = createDirectHandlerHarness();
    const { recordError } = createTelemetryCapture();

    handler('invalid' as any, context);

    expect(recordError).toHaveBeenCalledWith(
      'OfflineCatchupInvalidPayload',
      expect.objectContaining({
        payloadType: 'string',
        step: context.step,
        priority: context.priority,
      }),
    );
    expect(runtime.creditTime).not.toHaveBeenCalled();
  });

  it('records telemetry and ignores invalid resourceDeltas shapes', () => {
    const { handler, runtime, context } = createDirectHandlerHarness();
    const { recordError } = createTelemetryCapture();

    handler({ elapsedMs: STEP_SIZE_MS, resourceDeltas: [] } as any, context);

    expect(recordError).toHaveBeenCalledWith(
      'OfflineCatchupInvalidResourceDeltas',
      expect.objectContaining({
        step: context.step,
        priority: context.priority,
      }),
    );
    expect(runtime.creditTime).not.toHaveBeenCalled();
  });

  it('ignores invalid elapsedMs without querying step size', () => {
    const { handler, runtime, context } = createDirectHandlerHarness();

    handler({ elapsedMs: Number.NaN, resourceDeltas: {} } as any, context);

    expect(runtime.getStepSizeMs).not.toHaveBeenCalled();
    expect(runtime.creditTime).not.toHaveBeenCalled();
  });

  it('ignores offline catchup when runtime step size is invalid', () => {
    const { handler, runtime, context } = createDirectHandlerHarness(0);

    handler({ elapsedMs: STEP_SIZE_MS, resourceDeltas: {} } as any, context);

    expect(runtime.getStepSizeMs).toHaveBeenCalled();
    expect(runtime.creditTime).not.toHaveBeenCalled();
  });

  it('credits remaining offline time beyond the current tick', () => {
    const { handler, runtime, context } = createDirectHandlerHarness();

    handler(
      { elapsedMs: STEP_SIZE_MS * 2 + 50, resourceDeltas: {} } as any,
      context,
    );

    expect(runtime.creditTime).toHaveBeenCalledWith(STEP_SIZE_MS + 50);
  });

  it('does not credit time when maxSteps is zero', () => {
    const { handler, runtime, context } = createDirectHandlerHarness();

    handler(
      { elapsedMs: STEP_SIZE_MS * 5, maxSteps: 0, resourceDeltas: {} } as any,
      context,
    );

    expect(runtime.creditTime).not.toHaveBeenCalled();
  });
});
