import { describe, expect, it } from 'vitest';

import { CommandPriority, type Command } from '../command.js';
import type { SerializedCommandQueueV1 } from '../command-queue.js';
import type { SerializedProgressionCoordinatorStateV2 } from '../progression-coordinator-save.js';
import type { SerializedResourceState } from '../resource-state.js';
import type { GameStateSnapshot } from './types.js';

import { createPredictionManager } from './prediction-manager.js';

const baseResources: SerializedResourceState = {
  ids: ['resource.energy'],
  amounts: [10],
  capacities: [null],
  flags: [0],
};

const baseProgression: SerializedProgressionCoordinatorStateV2 = {
  schemaVersion: 2,
  step: 0,
  resources: baseResources,
  generators: [],
  upgrades: [],
  achievements: [],
};

const baseCommandQueue: SerializedCommandQueueV1 = {
  schemaVersion: 1,
  entries: [],
};

const createSnapshot = (step: number): GameStateSnapshot => ({
  version: 1,
  capturedAt: 0,
  runtime: {
    step,
    stepSizeMs: 100,
    rngSeed: 1,
    rngState: 1,
  },
  resources: baseResources,
  progression: {
    ...baseProgression,
    step,
    resources: baseResources,
  },
  automation: [],
  transforms: [],
  commandQueue: baseCommandQueue,
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
});
