import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAutomation } from '@idle-engine/content-schema';

import {
  CommandPriority,
  RUNTIME_COMMAND_TYPES,
  type Command,
} from '../command.js';
import type { SerializedCommandQueueV1 } from '../command-queue.js';
import type { EventPublisher } from '../events/event-bus.js';
import type { SerializedProgressionCoordinatorStateV2 } from '../progression-coordinator-save.js';
import type { SerializedResourceState } from '../resource-state.js';
import {
  captureGameStateSnapshot,
  createGameRuntime,
  restoreGameRuntimeFromSnapshot,
  type IdleEngineRuntime,
  type PredictionReplayWiring,
} from '../index.js';
import { createDefinitionDigest } from '../resource-state.js';
import { createContextualTelemetry, resetTelemetry, setTelemetry } from '../telemetry.js';
import type { TelemetryEventData, TelemetryFacade } from '../telemetry.js';
import { RUNTIME_VERSION } from '../version.js';
import {
  createContentPack,
  createResourceDefinition,
  literalOne,
} from '../content-test-helpers.js';
import type { GameStateSnapshot } from './types.js';

import {
  createPredictionManager,
  TELEMETRY_CHECKSUM_MATCH,
  TELEMETRY_CHECKSUM_MISMATCH,
  TELEMETRY_ROLLBACK,
  TELEMETRY_RESYNC,
  TELEMETRY_BUFFER_OVERFLOW,
} from './prediction-manager.js';

type RecordedTelemetry = Readonly<{
  kind: 'error' | 'progress' | 'warning';
  event: string;
  data?: TelemetryEventData;
}>;

const createTelemetryRecorder = (
  context: TelemetryEventData = {},
): RecordedTelemetry[] => {
  const entries: RecordedTelemetry[] = [];
  const facade: TelemetryFacade = {
    recordError(event, data) {
      entries.push({ kind: 'error', event, data });
    },
    recordWarning(event, data) {
      entries.push({ kind: 'warning', event, data });
    },
    recordProgress(event, data) {
      entries.push({ kind: 'progress', event, data });
    },
    recordCounters() {},
    recordTick() {},
  };
  setTelemetry(createContextualTelemetry(facade, context));
  return entries;
};

const expectTelemetryPayload = (
  data: TelemetryEventData | undefined,
  expected: Readonly<{
    confirmedStep: number;
    localStep: number;
    pendingCommands: number;
    replayedSteps: number;
    snapshotVersion: number;
    definitionDigest: unknown;
    queueSize: number;
    runtimeVersion?: string;
    clientId?: string;
  }>,
  replayDurationExpectation: 'zero' | 'non-negative' = 'non-negative',
): void => {
  expect(data).toBeDefined();
  const payload = data as Record<string, unknown>;
  expect(payload).toMatchObject(expected);
  const replayDurationMs = payload.replayDurationMs as number;
  expect(typeof replayDurationMs).toBe('number');
  if (replayDurationExpectation === 'zero') {
    expect(replayDurationMs).toBe(0);
  } else {
    expect(replayDurationMs).toBeGreaterThanOrEqual(0);
  }
};

const createResources = (
  amount = 10,
): SerializedResourceState => ({
  ids: ['resource.energy'],
  amounts: [amount],
  capacities: [null],
  flags: [0],
});

const DEFAULT_DEFINITION_DIGEST = createDefinitionDigest(
  createResources().ids,
);

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
  options: Readonly<{
    definitionDigest?: SerializedResourceState['definitionDigest'] | null;
    queueEntries?: SerializedCommandQueueV1['entries'];
  }> = {},
): GameStateSnapshot => {
  const resolvedDefinitionDigest =
    options.definitionDigest !== undefined
      ? options.definitionDigest
      : resources.definitionDigest ?? createDefinitionDigest(resources.ids);
  const resolvedResources =
    resolvedDefinitionDigest === null
      ? { ...resources, definitionDigest: undefined }
      : { ...resources, definitionDigest: resolvedDefinitionDigest };

  return {
    version: 1,
    capturedAt: 0,
    runtime: {
      step,
      stepSizeMs: 100,
      rngSeed: 1,
      rngState: 1,
    },
    resources: resolvedResources,
    progression: {
      ...baseProgression,
      step,
      resources: resolvedResources,
    },
    automation: [],
    transforms: [],
    commandQueue: {
      ...baseCommandQueue,
      entries: options.queueEntries ?? baseCommandQueue.entries,
    },
  };
};

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

const createQueueEntries = (
  count: number,
): SerializedCommandQueueV1['entries'] =>
  Array.from({ length: count }, (_, index) => ({
    type: 'command.test',
    priority: CommandPriority.PLAYER,
    timestamp: index,
    step: index,
    payload: { value: index },
  }));

const createReplayEventContent = () => {
  const toggleAutomationId = 'automation.toggle';
  const listenerAutomationId = 'automation.listener';

  return createContentPack({
    resources: [createResourceDefinition('resource.energy')],
    automations: [
      createAutomation({
        id: toggleAutomationId,
        name: { default: 'Toggle Automation' },
        description: { default: 'Toggle Automation' },
        targetType: 'collectResource',
        targetId: 'resource.energy',
        targetAmount: literalOne,
        trigger: { kind: 'commandQueueEmpty' },
        unlockCondition: { kind: 'always' },
        enabledByDefault: false,
      }),
      createAutomation({
        id: listenerAutomationId,
        name: { default: 'Listener Automation' },
        description: { default: 'Listener Automation' },
        targetType: 'collectResource',
        targetId: 'resource.energy',
        targetAmount: literalOne,
        trigger: { kind: 'event', eventId: 'automation:toggled' },
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
      }),
    ],
  });
};

const replayWithAutomationEvent = (
  enableReplayEventPublisher: boolean,
) => {
  const content = createReplayEventContent();
  let wiring: PredictionReplayWiring = createGameRuntime({
    content,
    stepSizeMs: 100,
    maxStepsPerFrame: 1,
  });

  const toggleCommand = {
    type: RUNTIME_COMMAND_TYPES.TOGGLE_AUTOMATION,
    priority: CommandPriority.PLAYER,
    payload: { automationId: 'automation.toggle', enabled: false },
    timestamp: 0,
    step: 0,
  } satisfies Command;

  wiring.commandQueue.enqueue(toggleCommand);
  const serverSnapshot = captureWiringSnapshot(wiring);
  const baselineAmount = 5;

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

  let replayBus: EventPublisher | null = null;
  const replayEventPublisher: EventPublisher | undefined =
    enableReplayEventPublisher
      ? {
          publish(eventType, payload, metadata) {
            if (!replayBus) {
              throw new Error('Replay event bus has not been initialized.');
            }
            return replayBus.publish(eventType, payload, metadata);
          },
        }
      : undefined;

  const manager = createPredictionManager({
    captureSnapshot: () => captureWiringSnapshot(wiring),
    getCurrentStep: () => wiring.runtime.getCurrentStep(),
    maxPredictionSteps: 10,
    maxPendingCommands: 10,
    checksumIntervalSteps: 1,
    maxReplayStepsPerTick: 1,
    replay: {
      restoreRuntime: ({ snapshot, eventPublisher }) => {
        const nextWiring = restoreGameRuntimeFromSnapshot({
          content,
          snapshot,
          runtimeOptions: { eventPublisher },
        });

        if (enableReplayEventPublisher) {
          replayBus = nextWiring.runtime.getEventBus();
        }

        return nextWiring;
      },
      captureSnapshot: captureWiringSnapshot,
      onRuntimeReplaced: (nextWiring) => {
        wiring = nextWiring;
      },
      eventPublisher: replayEventPublisher,
    },
  });

  manager.recordPredictedStep(0);
  wiring.runtime.tick(100);
  manager.recordPredictedStep(1);
  wiring.runtime.tick(100);
  manager.recordPredictedStep(2);

  const result = manager.applyServerState(mismatchedSnapshot, 0);
  const energyIndex = wiring.coordinator.resourceState.requireIndex(
    'resource.energy',
  );

  return {
    baselineAmount,
    currentStep: wiring.runtime.getCurrentStep(),
    energy: wiring.coordinator.resourceState.getAmount(energyIndex),
    result,
  };
};

describe('createPredictionManager', () => {
  afterEach(() => {
    resetTelemetry();
  });

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

  it('emits telemetry on checksum match', () => {
    const currentStep = 0;
    const captureSnapshot = () => createSnapshot(currentStep);
    const entries = createTelemetryRecorder();
    const manager = createPredictionManager({
      captureSnapshot,
      maxPredictionSteps: 10,
      maxPendingCommands: 10,
      checksumIntervalSteps: 1,
      maxReplayStepsPerTick: 1,
    });

    manager.recordPredictedStep(0);
    manager.applyServerState(createSnapshot(0), 0);

    const matchEvent = entries.find(
      (entry) => entry.event === TELEMETRY_CHECKSUM_MATCH,
    );

    expect(matchEvent?.kind).toBe('progress');
    expectTelemetryPayload(matchEvent?.data, {
      confirmedStep: 0,
      localStep: 0,
      pendingCommands: 0,
      replayedSteps: 0,
      snapshotVersion: 1,
      runtimeVersion: RUNTIME_VERSION,
      definitionDigest: DEFAULT_DEFINITION_DIGEST,
      queueSize: 0,
    }, 'zero');
  });

  it('emits telemetry on checksum match with pending commands', () => {
    let currentStep = 0;
    const captureSnapshot = () => createSnapshot(currentStep);
    const entries = createTelemetryRecorder();
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
    manager.recordLocalCommand(createCommand(1, 1));
    manager.applyServerState(createSnapshot(0), 0);

    const matchEvent = entries.find(
      (entry) => entry.event === TELEMETRY_CHECKSUM_MATCH,
    );

    expect(matchEvent?.kind).toBe('progress');
    expectTelemetryPayload(matchEvent?.data, {
      confirmedStep: 0,
      localStep: 1,
      pendingCommands: 1,
      replayedSteps: 0,
      snapshotVersion: 1,
      runtimeVersion: RUNTIME_VERSION,
      definitionDigest: DEFAULT_DEFINITION_DIGEST,
      queueSize: 0,
    }, 'zero');
  });

  it('emits telemetry with context and snapshot metadata', () => {
    const currentStep = 0;
    const resources = createResources();
    const definitionDigest = createDefinitionDigest(resources.ids);
    const queueEntries = createQueueEntries(2);
    const captureSnapshot = () =>
      createSnapshot(currentStep, resources, {
        definitionDigest,
        queueEntries,
      });
    const entries = createTelemetryRecorder({ clientId: 'client-1' });
    const manager = createPredictionManager({
      captureSnapshot,
      maxPredictionSteps: 10,
      maxPendingCommands: 10,
      checksumIntervalSteps: 1,
      maxReplayStepsPerTick: 1,
    });

    manager.recordPredictedStep(0);
    manager.applyServerState(
      createSnapshot(0, resources, {
        definitionDigest,
        queueEntries,
      }),
      0,
    );

    const matchEvent = entries.find(
      (entry) => entry.event === TELEMETRY_CHECKSUM_MATCH,
    );

    expect(matchEvent?.kind).toBe('progress');
    expectTelemetryPayload(matchEvent?.data, {
      confirmedStep: 0,
      localStep: 0,
      pendingCommands: 0,
      replayedSteps: 0,
      snapshotVersion: 1,
      definitionDigest,
      queueSize: queueEntries.length,
      runtimeVersion: RUNTIME_VERSION,
      clientId: 'client-1',
    }, 'zero');
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

  it('emits telemetry on buffer overflow resync', () => {
    const currentStep = 0;
    const captureSnapshot = () => createSnapshot(currentStep);
    const entries = createTelemetryRecorder();
    const manager = createPredictionManager({
      captureSnapshot,
      maxPredictionSteps: 10,
      maxPendingCommands: 1,
      checksumIntervalSteps: 1,
      maxReplayStepsPerTick: 1,
    });

    manager.recordLocalCommand(createCommand(0, 1));
    manager.recordLocalCommand(createCommand(1, 2));
    manager.applyServerState(createSnapshot(0), 0);

    const overflowEvent = entries.find(
      (entry) => entry.event === TELEMETRY_BUFFER_OVERFLOW,
    );

    expect(overflowEvent?.kind).toBe('warning');
    expectTelemetryPayload(overflowEvent?.data, {
      confirmedStep: 0,
      localStep: 0,
      pendingCommands: 0,
      replayedSteps: 0,
      snapshotVersion: 1,
      runtimeVersion: RUNTIME_VERSION,
      definitionDigest: DEFAULT_DEFINITION_DIGEST,
      queueSize: 0,
    }, 'non-negative');
  });

  it('emits telemetry on buffer overflow resync when maxPendingCommands is zero', () => {
    const currentStep = 0;
    const captureSnapshot = () => createSnapshot(currentStep);
    const entries = createTelemetryRecorder();
    const manager = createPredictionManager({
      captureSnapshot,
      maxPredictionSteps: 10,
      maxPendingCommands: 0,
      checksumIntervalSteps: 1,
      maxReplayStepsPerTick: 1,
    });

    manager.recordLocalCommand(createCommand(0, 1));
    const result = manager.applyServerState(createSnapshot(0), 0);

    const overflowEvent = entries.find(
      (entry) => entry.event === TELEMETRY_BUFFER_OVERFLOW,
    );

    expect(result.status).toBe('resynced');
    expect(manager.getPendingCommands()).toHaveLength(0);
    expect(overflowEvent?.kind).toBe('warning');
    expectTelemetryPayload(overflowEvent?.data, {
      confirmedStep: 0,
      localStep: 0,
      pendingCommands: 0,
      replayedSteps: 0,
      snapshotVersion: 1,
      runtimeVersion: RUNTIME_VERSION,
      definitionDigest: DEFAULT_DEFINITION_DIGEST,
      queueSize: 0,
    }, 'non-negative');
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

  it('emits telemetry on prediction window resync', () => {
    let currentStep = 0;
    const captureSnapshot = () => createSnapshot(currentStep);
    const entries = createTelemetryRecorder();
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
    manager.applyServerState(createSnapshot(1), 1);

    const resyncEvent = entries.find(
      (entry) => entry.event === TELEMETRY_RESYNC,
    );

    expect(resyncEvent?.kind).toBe('warning');
    expectTelemetryPayload(resyncEvent?.data, {
      confirmedStep: 1,
      localStep: 1,
      pendingCommands: 0,
      replayedSteps: 0,
      snapshotVersion: 1,
      runtimeVersion: RUNTIME_VERSION,
      definitionDigest: DEFAULT_DEFINITION_DIGEST,
      queueSize: 0,
    }, 'non-negative');
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

  it('emits telemetry on checksum mismatch and rollback', () => {
    let currentStep = 0;
    const captureSnapshot = () => createSnapshot(currentStep);
    const entries = createTelemetryRecorder();
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

    manager.applyServerState(
      createSnapshot(0, createResources(25)),
      0,
    );

    const mismatchEvent = entries.find(
      (entry) => entry.event === TELEMETRY_CHECKSUM_MISMATCH,
    );
    const rollbackEvent = entries.find(
      (entry) => entry.event === TELEMETRY_ROLLBACK,
    );

    expect(mismatchEvent?.kind).toBe('warning');
    expectTelemetryPayload(mismatchEvent?.data, {
      confirmedStep: 0,
      localStep: 2,
      pendingCommands: 0,
      replayedSteps: 2,
      snapshotVersion: 1,
      runtimeVersion: RUNTIME_VERSION,
      definitionDigest: DEFAULT_DEFINITION_DIGEST,
      queueSize: 0,
    }, 'non-negative');

    expect(rollbackEvent?.kind).toBe('progress');
    expectTelemetryPayload(rollbackEvent?.data, {
      confirmedStep: 0,
      localStep: 2,
      pendingCommands: 0,
      replayedSteps: 2,
      snapshotVersion: 1,
      runtimeVersion: RUNTIME_VERSION,
      definitionDigest: DEFAULT_DEFINITION_DIGEST,
      queueSize: 0,
    }, 'non-negative');
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

  it('resyncs and disables prediction when snapshot version mismatches', () => {
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
    manager.recordLocalCommand(createCommand(1, 1));

    const incompatibleSnapshot = {
      ...createSnapshot(0),
      version: 2,
    } as unknown as GameStateSnapshot;
    const result = manager.applyServerState(incompatibleSnapshot, 0);

    expect(result.status).toBe('resynced');
    expect(result.reason).toBe('snapshot-version-mismatch');
    expect(manager.getPendingCommands()).toHaveLength(0);

    manager.recordLocalCommand(createCommand(1, 2));
    const followUp = manager.applyServerState(createSnapshot(1), 1);

    expect(followUp.status).toBe('resynced');
    expect(followUp.reason).toBe('prediction-disabled');
    expect(manager.getPendingCommands()).toHaveLength(0);
  });

  it('resyncs and disables prediction when definition digest mismatches', () => {
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

    const mismatchedDigest = createDefinitionDigest(['resource.gold']);
    const mismatchedSnapshot = createSnapshot(0, createResources(), {
      definitionDigest: mismatchedDigest,
    });
    const result = manager.applyServerState(mismatchedSnapshot, 0);

    expect(result.status).toBe('resynced');
    expect(result.reason).toBe('definition-digest-mismatch');
  });

  it('resyncs and disables prediction when definition digest is missing', () => {
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

    const missingDigestSnapshot = createSnapshot(0, createResources(), {
      definitionDigest: null,
    });
    const result = manager.applyServerState(missingDigestSnapshot, 0);

    expect(result.status).toBe('resynced');
    expect(result.reason).toBe('definition-digest-missing');
  });

  it('resyncs and disables prediction when runtime version metadata mismatches', () => {
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

    const result = manager.applyServerState(createSnapshot(0), 0, {
      runtimeVersion: '0.0.0',
    });

    expect(result.status).toBe('resynced');
    expect(result.reason).toBe('runtime-version-mismatch');
  });

  it('resyncs and disables prediction when content digest metadata mismatches', () => {
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

    const mismatchedDigest = createDefinitionDigest(['resource.gold']);
    const result = manager.applyServerState(createSnapshot(0), 0, {
      contentDigest: mismatchedDigest,
    });

    expect(result.status).toBe('resynced');
    expect(result.reason).toBe('content-digest-mismatch');
  });

  it('ignores local prediction updates after incompatibility disables prediction', () => {
    const currentStep = 0;
    let captureCalls = 0;
    const captureSnapshot = () => {
      captureCalls += 1;
      return createSnapshot(currentStep);
    };
    const manager = createPredictionManager({
      captureSnapshot,
      maxPredictionSteps: 10,
      maxPendingCommands: 10,
      checksumIntervalSteps: 1,
      maxReplayStepsPerTick: 1,
    });

    const incompatibleSnapshot = {
      ...createSnapshot(0),
      version: 2,
    } as unknown as GameStateSnapshot;
    const result = manager.applyServerState(incompatibleSnapshot, 0);

    manager.recordLocalCommand(createCommand(1, 1));
    manager.recordPredictedStep(1);

    expect(result.status).toBe('resynced');
    expect(result.reason).toBe('snapshot-version-mismatch');
    expect(manager.getPendingCommands()).toHaveLength(0);
    expect(captureCalls).toBe(0);
  });

  it('accepts matching compatibility metadata and continues reconciliation', () => {
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

    const result = manager.applyServerState(createSnapshot(0), 0, {
      runtimeVersion: RUNTIME_VERSION,
      contentDigest: DEFAULT_DEFINITION_DIGEST,
    });

    expect(result.status).toBe('confirmed');
    expect(result.reason).toBe('checksum-match');
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

  it('does not replay or replace runtime when checksum matches (predict-then-confirm)', () => {
    const currentStep = 0;
    const captureSnapshot = () => createSnapshot(currentStep);
    const restoreRuntime = vi.fn(() => {
      throw new Error('restoreRuntime should not be called on checksum match.');
    });
    const onRuntimeReplaced = vi.fn();
    const manager = createPredictionManager({
      captureSnapshot,
      maxPredictionSteps: 10,
      maxPendingCommands: 10,
      checksumIntervalSteps: 1,
      maxReplayStepsPerTick: 1,
      replay: {
        restoreRuntime,
        captureSnapshot: () => {
          throw new Error(
            'Replay snapshot capture should not be called on checksum match.',
          );
        },
        onRuntimeReplaced,
      },
    });

    manager.recordPredictedStep(0);
    manager.recordLocalCommand(createCommand(1, 1));
    const result = manager.applyServerState(createSnapshot(0), 0);

    expect(result.status).toBe('confirmed');
    expect(result.reason).toBe('checksum-match');
    expect(result.replayedSteps).toBe(0);
    expect(result.pendingCommands).toBe(1);
    expect(manager.getPendingCommands().map((command) => command.step)).toEqual([
      1,
    ]);
    expect(restoreRuntime).not.toHaveBeenCalled();
    expect(onRuntimeReplaced).not.toHaveBeenCalled();
  });

  it('preserves requestId across rollback replay', () => {
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

    const requestIdOne = 'request-1';
    const requestIdTwo = 'request-2';
    const pendingCommandOne = {
      type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
      priority: CommandPriority.PLAYER,
      payload: { resourceId: 'resource.energy', amount: 3 },
      timestamp: 2,
      step: 1,
      requestId: requestIdOne,
    } satisfies Command;
    const pendingCommandTwo = {
      type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
      priority: CommandPriority.PLAYER,
      payload: { resourceId: 'resource.energy', amount: 4 },
      timestamp: 3,
      step: 1,
      requestId: requestIdTwo,
    } satisfies Command;

    wiring.commandQueue.enqueue(pendingCommandOne);
    manager.recordLocalCommand(pendingCommandOne);
    wiring.commandQueue.enqueue(pendingCommandTwo);
    manager.recordLocalCommand(pendingCommandTwo);

    wiring.runtime.tick(100);
    manager.recordPredictedStep(1);
    wiring.runtime.tick(100);
    manager.recordPredictedStep(2);

    const baselineAmount = (serverSnapshot.resources.amounts[0] ?? 0) + 1;
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

    expect(result.status).toBe('rolled-back');
    expect(result.reason).toBe('checksum-mismatch');
    expect(result.pendingCommands).toBe(2);
    expect(manager.getPendingCommands().map((command) => command.requestId)).toEqual(
      [requestIdOne, requestIdTwo],
    );

    const outcomes = (wiring.runtime as unknown as IdleEngineRuntime).drainCommandOutcomes();
    const replayOutcomeOne = outcomes.find(
      (outcome) => outcome.requestId === requestIdOne,
    );
    expect(replayOutcomeOne).toMatchObject({
      success: true,
      requestId: requestIdOne,
      serverStep: 1,
    });
    const replayOutcomeTwo = outcomes.find(
      (outcome) => outcome.requestId === requestIdTwo,
    );
    expect(replayOutcomeTwo).toMatchObject({
      success: true,
      requestId: requestIdTwo,
      serverStep: 1,
    });
  });

  it('stress: handles repeated rollback and resync decisions deterministically', () => {
    let currentStep = 0;
    const captureSnapshot = () => createSnapshot(currentStep);
    const manager = createPredictionManager({
      captureSnapshot,
      maxPredictionSteps: 20,
      maxPendingCommands: 50,
      checksumIntervalSteps: 1,
      maxReplayStepsPerTick: 1,
    });

    for (let step = 0; step <= 49; step += 1) {
      currentStep = step;
      manager.recordPredictedStep(step);
    }

    const rollback = manager.applyServerState(
      createSnapshot(35, createResources(25)),
      35,
    );

    expect(rollback.status).toBe('rolled-back');
    expect(rollback.reason).toBe('checksum-mismatch');
    expect(rollback.confirmedStep).toBe(35);
    expect(rollback.localStep).toBe(49);
    expect(rollback.replayedSteps).toBe(14);

    for (let step = 50; step <= 80; step += 1) {
      currentStep = step;
      manager.recordPredictedStep(step);
    }

    const resync = manager.applyServerState(createSnapshot(50), 50);

    expect(resync.status).toBe('resynced');
    expect(resync.reason).toBe('prediction-window-exceeded');
    expect(resync.confirmedStep).toBe(50);
    expect(resync.localStep).toBe(50);
    expect(resync.replayedSteps).toBe(0);
  });

  it('suppresses event-triggered automations during replay by default', () => {
    const { baselineAmount, currentStep, energy, result } =
      replayWithAutomationEvent(false);

    expect(result.status).toBe('rolled-back');
    expect(result.replayedSteps).toBe(2);
    expect(currentStep).toBe(2);
    expect(energy).toBe(baselineAmount);
  });

  it('replays event-triggered automations when an event publisher is provided', () => {
    const { baselineAmount, currentStep, energy, result } =
      replayWithAutomationEvent(true);

    expect(result.status).toBe('rolled-back');
    expect(result.replayedSteps).toBe(2);
    expect(currentStep).toBe(2);
    expect(energy).toBe(baselineAmount + 1);
  });
});
