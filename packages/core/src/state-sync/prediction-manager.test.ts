import { describe, expect, it } from 'vitest';

import {
  CommandPriority,
  RUNTIME_COMMAND_TYPES,
  type Command,
} from '../command.js';
import type { SerializedCommandQueueV1 } from '../command-queue.js';
import type { SerializedProgressionCoordinatorStateV2 } from '../progression-coordinator-save.js';
import type { SerializedResourceState } from '../resource-state.js';
import {
  captureGameStateSnapshot,
  createGameRuntime,
  restoreGameRuntimeFromSnapshot,
  type IdleEngineRuntime,
  type PredictionReplayWiring,
} from '../index.js';
import {
  createContentPack,
  createResourceDefinition,
} from '../content-test-helpers.js';
import type { GameStateSnapshot } from './types.js';

import { createPredictionManager } from './prediction-manager.js';

const createResources = (
  amount = 10,
): SerializedResourceState => ({
  ids: ['resource.energy'],
  amounts: [amount],
  capacities: [null],
  flags: [0],
});

const baseProgression: SerializedProgressionCoordinatorStateV2 = {
  schemaVersion: 2,
  step: 0,
  resources: createResources(),
  generators: [],
  upgrades: [],
  achievements: [],
};

const baseCommandQueue: SerializedCommandQueueV1 = {
  schemaVersion: 1,
  entries: [],
};

const createSnapshot = (
  step: number,
  resources: SerializedResourceState = createResources(),
): GameStateSnapshot => ({
  version: 1,
  capturedAt: 0,
  runtime: {
    step,
    stepSizeMs: 100,
    rngSeed: 1,
    rngState: 1,
  },
  resources,
  progression: {
    ...baseProgression,
    step,
    resources,
  },
  automation: [],
  transforms: [],
  commandQueue: baseCommandQueue,
});

const emptyState = new Map<string, never>();

const captureWiringSnapshot = (
  wiring: PredictionReplayWiring,
): GameStateSnapshot =>
  captureGameStateSnapshot({
    runtime: wiring.runtime as IdleEngineRuntime,
    progressionCoordinator: wiring.coordinator,
    commandQueue: wiring.commandQueue,
    getAutomationState: () =>
      wiring.automationSystem?.getState() ?? emptyState,
    getTransformState: () =>
      wiring.transformSystem?.getState() ?? emptyState,
    ...(wiring.productionSystem
      ? { productionSystem: wiring.productionSystem }
      : {}),
  });

const createCommand = (
  step: number,
  timestamp: number,
  requestId?: string,
) =>
  ({
    type: 'command.test',
    priority: CommandPriority.PLAYER,
    payload: { value: step },
    timestamp,
    step,
    requestId,
  } satisfies Command);

describe('createPredictionManager', () => {
  it('returns resync when confirmed step has no recorded checksum', () => {
    let currentStep = 0;
    const captureSnapshot = () => createSnapshot(currentStep);
    const manager = createPredictionManager({
      captureSnapshot,
      maxPredictionSteps: 10,
      maxPendingCommands: 10,
      checksumIntervalSteps: 2,
      maxReplayStepsPerTick: 1,
    });

    manager.recordPredictedStep(0);
    currentStep = 1;
    manager.recordPredictedStep(1);
    currentStep = 2;
    manager.recordPredictedStep(2);

    const result = manager.applyServerState(createSnapshot(1), 1);

    expect(result.status).toBe('resynced');
    expect(result.reason).toBe('prediction-window-exceeded');
  });

  it('confirms when checksum matches local history', () => {
    const currentStep = 0;
    const captureSnapshot = () => createSnapshot(currentStep);
    const manager = createPredictionManager({
      captureSnapshot,
      maxPredictionSteps: 10,
      maxPendingCommands: 10,
      checksumIntervalSteps: 1,
      maxReplayStepsPerTick: 1,
    });

    manager.recordPredictedStep(0);

    const result = manager.applyServerState(createSnapshot(0), 0);

    expect(result.status).toBe('confirmed');
    expect(result.reason).toBe('checksum-match');
    expect(result.checksumMatch).toBe(true);
  });

  it('returns resync when pending buffer overflows', () => {
    const currentStep = 0;
    const captureSnapshot = () => createSnapshot(currentStep);
    const manager = createPredictionManager({
      captureSnapshot,
      maxPredictionSteps: 10,
      maxPendingCommands: 1,
      checksumIntervalSteps: 1,
      maxReplayStepsPerTick: 1,
    });

    manager.recordLocalCommand(createCommand(0, 1));
    manager.recordLocalCommand(createCommand(1, 2));

    const result = manager.applyServerState(createSnapshot(0), 0);

    expect(result.status).toBe('resynced');
    expect(manager.getPendingCommands()).toHaveLength(0);
  });

  it('returns resync when confirmed step is outside the history window', () => {
    let currentStep = 0;
    const captureSnapshot = () => createSnapshot(currentStep);
    const manager = createPredictionManager({
      captureSnapshot,
      maxPredictionSteps: 2,
      maxPendingCommands: 10,
      checksumIntervalSteps: 1,
      maxReplayStepsPerTick: 1,
    });

    for (let step = 0; step <= 3; step += 1) {
      currentStep = step;
      manager.recordPredictedStep(step);
    }

    const result = manager.applyServerState(createSnapshot(0), 0);

    expect(result.status).toBe('resynced');
    expect(result.reason).toBe('prediction-window-exceeded');
  });

  it('returns rolled-back when checksum mismatches local history', () => {
    let currentStep = 0;
    const captureSnapshot = () => createSnapshot(currentStep);
    const manager = createPredictionManager({
      captureSnapshot,
      maxPredictionSteps: 10,
      maxPendingCommands: 10,
      checksumIntervalSteps: 1,
      maxReplayStepsPerTick: 1,
    });

    for (let step = 0; step <= 2; step += 1) {
      currentStep = step;
      manager.recordPredictedStep(step);
    }

    const mismatchedSnapshot = createSnapshot(
      0,
      createResources(25),
    );
    const result = manager.applyServerState(mismatchedSnapshot, 0);

    expect(result.status).toBe('rolled-back');
    expect(result.reason).toBe('checksum-mismatch');
    expect(result.replayedSteps).toBe(2);
  });

  it('drops pending commands at or before confirmed step on checksum match', () => {
    const currentStep = 1;
    const captureSnapshot = () => createSnapshot(currentStep);
    const manager = createPredictionManager({
      captureSnapshot,
      maxPredictionSteps: 10,
      maxPendingCommands: 10,
      checksumIntervalSteps: 1,
      maxReplayStepsPerTick: 1,
    });

    manager.recordPredictedStep(1);
    manager.recordLocalCommand(createCommand(0, 1));
    manager.recordLocalCommand(createCommand(1, 2));
    manager.recordLocalCommand(createCommand(2, 3));

    const result = manager.applyServerState(createSnapshot(1), 1);

    expect(result.status).toBe('confirmed');
    expect(result.reason).toBe('checksum-match');
    expect(result.confirmedStep).toBe(1);
    expect(result.pendingCommands).toBe(1);
    expect(manager.getPendingCommands().map((command) => command.step)).toEqual(
      [2],
    );
  });

  it('drops pending commands at or before confirmed step on checksum mismatch', () => {
    let currentStep = 0;
    const captureSnapshot = () => createSnapshot(currentStep);
    const manager = createPredictionManager({
      captureSnapshot,
      maxPredictionSteps: 10,
      maxPendingCommands: 10,
      checksumIntervalSteps: 1,
      maxReplayStepsPerTick: 1,
    });

    currentStep = 1;
    manager.recordPredictedStep(1);
    currentStep = 2;
    manager.recordPredictedStep(2);
    manager.recordLocalCommand(createCommand(0, 1));
    manager.recordLocalCommand(createCommand(1, 2));
    manager.recordLocalCommand(createCommand(2, 3));

    const result = manager.applyServerState(
      createSnapshot(1, createResources(25)),
      1,
    );

    expect(result.status).toBe('rolled-back');
    expect(result.reason).toBe('checksum-mismatch');
    expect(result.confirmedStep).toBe(1);
    expect(result.pendingCommands).toBe(1);
    expect(manager.getPendingCommands().map((command) => command.step)).toEqual(
      [2],
    );
  });

  it('treats equal confirmed steps as idempotent when checksum matches', () => {
    const currentStep = 0;
    const captureSnapshot = () => createSnapshot(currentStep);
    const manager = createPredictionManager({
      captureSnapshot,
      maxPredictionSteps: 10,
      maxPendingCommands: 10,
      checksumIntervalSteps: 1,
      maxReplayStepsPerTick: 1,
    });

    manager.recordPredictedStep(0);
    manager.recordLocalCommand(createCommand(1, 2));

    const firstResult = manager.applyServerState(createSnapshot(0), 0);
    const secondResult = manager.applyServerState(createSnapshot(0), 0);

    expect(firstResult.status).toBe('confirmed');
    expect(firstResult.reason).toBe('checksum-match');
    expect(firstResult.confirmedStep).toBe(0);
    expect(secondResult.status).toBe('confirmed');
    expect(secondResult.reason).toBe('checksum-match');
    expect(secondResult.confirmedStep).toBe(0);
    expect(manager.getPendingCommands().map((command) => command.step)).toEqual(
      [1],
    );
  });

  it('rolls back when checksum mismatches for equal confirmed steps', () => {
    const currentStep = 0;
    const captureSnapshot = () => createSnapshot(currentStep);
    const manager = createPredictionManager({
      captureSnapshot,
      maxPredictionSteps: 10,
      maxPendingCommands: 10,
      checksumIntervalSteps: 1,
      maxReplayStepsPerTick: 1,
    });

    manager.recordPredictedStep(0);
    manager.recordLocalCommand(createCommand(1, 2));

    const firstResult = manager.applyServerState(createSnapshot(0), 0);
    const secondResult = manager.applyServerState(
      createSnapshot(0, createResources(25)),
      0,
    );

    expect(firstResult.status).toBe('confirmed');
    expect(firstResult.reason).toBe('checksum-match');
    expect(firstResult.confirmedStep).toBe(0);
    expect(secondResult.status).toBe('rolled-back');
    expect(secondResult.reason).toBe('checksum-mismatch');
    expect(secondResult.confirmedStep).toBe(0);
    expect(manager.getPendingCommands().map((command) => command.step)).toEqual(
      [1],
    );
  });

  it('returns ignored when confirmed step is stale', () => {
    let currentStep = 0;
    const captureSnapshot = () => createSnapshot(currentStep);
    const manager = createPredictionManager({
      captureSnapshot,
      maxPredictionSteps: 10,
      maxPendingCommands: 10,
      checksumIntervalSteps: 1,
      maxReplayStepsPerTick: 1,
    });

    manager.recordPredictedStep(0);
    currentStep = 1;
    manager.recordPredictedStep(1);
    manager.applyServerState(createSnapshot(1), 1);

    const result = manager.applyServerState(createSnapshot(0), 0);

    expect(result.status).toBe('ignored');
    expect(result.reason).toBe('stale-snapshot');
  });

  it('returns resync when pending commands are disabled', () => {
    const currentStep = 0;
    const captureSnapshot = () => createSnapshot(currentStep);
    const manager = createPredictionManager({
      captureSnapshot,
      maxPredictionSteps: 10,
      maxPendingCommands: 0,
      checksumIntervalSteps: 1,
      maxReplayStepsPerTick: 1,
    });

    manager.recordLocalCommand(createCommand(0, 1));

    const result = manager.applyServerState(createSnapshot(0), 0);

    expect(result.status).toBe('resynced');
    expect(result.pendingCommands).toBe(0);
    expect(manager.getPendingCommands()).toHaveLength(0);
  });

  it('replays pending commands after rollback and restores snapshot queue', () => {
    const content = createContentPack({
      resources: [createResourceDefinition('resource.energy')],
    });
    let wiring: PredictionReplayWiring = createGameRuntime({
      content,
      stepSizeMs: 100,
      maxStepsPerFrame: 1,
    });

    const captureSnapshot = () => captureWiringSnapshot(wiring);

    const manager = createPredictionManager({
      captureSnapshot,
      getCurrentStep: () => wiring.runtime.getCurrentStep(),
      maxPredictionSteps: 10,
      maxPendingCommands: 10,
      checksumIntervalSteps: 1,
      maxReplayStepsPerTick: 1,
      replay: {
        restoreRuntime: ({ snapshot, eventPublisher }) =>
          restoreGameRuntimeFromSnapshot({
            content,
            snapshot,
            runtimeOptions: { eventPublisher },
          }),
        captureSnapshot: captureWiringSnapshot,
        onRuntimeReplaced: (nextWiring) => {
          wiring = nextWiring;
        },
      },
    });

    const authoritativeCommand = {
      type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
      priority: CommandPriority.PLAYER,
      payload: { resourceId: 'resource.energy', amount: 5 },
      timestamp: 1,
      step: 0,
    } satisfies Command;

    wiring.commandQueue.enqueue(authoritativeCommand);
    const serverSnapshot = captureWiringSnapshot(wiring);

    manager.recordPredictedStep(0);

    const pendingCommand = {
      type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
      priority: CommandPriority.PLAYER,
      payload: { resourceId: 'resource.energy', amount: 3 },
      timestamp: 2,
      step: 1,
    } satisfies Command;

    wiring.commandQueue.enqueue(pendingCommand);
    manager.recordLocalCommand(pendingCommand);

    wiring.runtime.tick(100);
    manager.recordPredictedStep(1);
    wiring.runtime.tick(100);
    manager.recordPredictedStep(2);

    const baselineAmount = 20;
    const mismatchedSnapshot: GameStateSnapshot = {
      ...serverSnapshot,
      resources: {
        ...serverSnapshot.resources,
        amounts: [baselineAmount],
      },
      progression: {
        ...serverSnapshot.progression,
        resources: {
          ...serverSnapshot.progression.resources,
          amounts: [baselineAmount],
        },
      },
    };

    const result = manager.applyServerState(mismatchedSnapshot, 0);

    const energyIndex = wiring.coordinator.resourceState.requireIndex(
      'resource.energy',
    );

    expect(result.status).toBe('rolled-back');
    expect(result.replayedSteps).toBe(2);
    expect(result.pendingCommands).toBe(1);
    expect(wiring.runtime.getCurrentStep()).toBe(2);
    expect(wiring.coordinator.resourceState.getAmount(energyIndex)).toBe(
      baselineAmount + 5 + 3,
    );
    expect(manager.getPendingCommands().map((command) => command.step)).toEqual([
      1,
    ]);
  });
});
