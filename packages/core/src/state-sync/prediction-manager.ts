/**
 * Prediction manager API types.
 * See docs/runtime-client-prediction-rollback-design-issue-546.md (Section 6.2).
 */
import type { Command } from '../command.js';
import type { EventPublisher } from '../events/event-bus.js';
import type {
  GameRuntimeWiring,
  RuntimeWiringRuntime,
} from '../game-runtime-wiring.js';
import type { TelemetryEventData } from '../telemetry.js';
import type { GameStateSnapshot } from './types.js';
import { computeStateChecksum } from './checksum.js';
import { telemetry } from '../telemetry.js';
import { RUNTIME_VERSION } from '../version.js';

/**
 * Tracks client prediction state and reconciliation inputs.
 */
export interface PredictionManager {
  /**
   * Record a locally-issued command, optionally at a specific step.
   */
  recordLocalCommand(command: Command, atStep?: number): void;
  /**
   * Record a predicted step advance, optionally specifying the step.
   */
  recordPredictedStep(step?: number): void;
  /**
   * Apply an authoritative server snapshot and return reconciliation details.
   */
  applyServerState(snapshot: GameStateSnapshot, confirmedStep: number): RollbackResult;
  /**
   * Return commands still awaiting confirmation.
   */
  getPendingCommands(): readonly Command[];
  /**
   * Return the configured prediction window limits.
   */
  getPredictionWindow(): PredictionWindow;
}

export type PredictionReplayRuntime = RuntimeWiringRuntime & {
  tick: (deltaMs: number) => number;
};

export type PredictionReplayWiring = GameRuntimeWiring<PredictionReplayRuntime>;

export type PredictionReplayRuntimeFactoryOptions = Readonly<{
  readonly snapshot: GameStateSnapshot;
  readonly eventPublisher: EventPublisher;
}>;

export type PredictionReplayOptions = Readonly<{
  readonly restoreRuntime: (
    options: PredictionReplayRuntimeFactoryOptions,
  ) => PredictionReplayWiring;
  readonly captureSnapshot: (
    wiring: PredictionReplayWiring,
  ) => GameStateSnapshot;
  readonly onRuntimeReplaced?: (wiring: PredictionReplayWiring) => void;
  readonly eventPublisher?: EventPublisher;
}>;

export type PredictionManagerOptions = Readonly<{
  readonly captureSnapshot: () => GameStateSnapshot;
  readonly getCurrentStep?: () => number;
  readonly maxPredictionSteps?: number;
  readonly maxPendingCommands?: number;
  readonly checksumIntervalSteps?: number;
  readonly snapshotHistorySteps?: number;
  readonly maxReplayStepsPerTick?: number;
  readonly replay?: PredictionReplayOptions;
}>;

/**
 * Configuration limits that bound prediction and rollback bookkeeping.
 */
export type PredictionWindow = Readonly<{
  /**
   * Maximum number of predicted steps to retain.
   */
  readonly maxPredictionSteps: number;
  /**
   * Maximum number of pending commands to retain.
   */
  readonly maxPendingCommands: number;
  /**
   * Number of steps between checksum calculations.
   */
  readonly checksumIntervalSteps: number;
  /**
   * Number of steps to keep in snapshot history.
   */
  readonly snapshotHistorySteps: number;
  /**
   * Maximum steps to replay per tick when reconciling.
   */
  readonly maxReplayStepsPerTick: number;
}>;

/**
 * Outcome details after applying server state reconciliation.
 */
export type RollbackResult = Readonly<{
  /**
   * Reconciliation outcome status.
   */
  readonly status: 'confirmed' | 'rolled-back' | 'resynced' | 'ignored';
  /**
   * Step confirmed by the server snapshot.
   */
  readonly confirmedStep: number;
  /**
   * Local step value after reconciliation.
   */
  readonly localStep: number;
  /**
   * Number of steps replayed to reconcile state.
   */
  readonly replayedSteps: number;
  /**
   * Count of commands still pending after reconciliation.
   */
  readonly pendingCommands: number;
  /**
   * Whether a checksum comparison matched, when available.
   */
  readonly checksumMatch?: boolean;
  /**
   * Optional reason describing the outcome.
   */
  readonly reason?:
    | 'checksum-match'
    | 'checksum-mismatch'
    | 'stale-snapshot'
    | 'prediction-window-exceeded';
}>;

type ChecksumEntry = Readonly<{
  step: number;
  checksum: string;
}>;

const DEFAULT_MAX_PREDICTION_STEPS = 50;
const DEFAULT_MAX_PENDING_COMMANDS = 1000;
const DEFAULT_CHECKSUM_INTERVAL_STEPS = 1;
const DEFAULT_SNAPSHOT_HISTORY_STEPS = 0;
const DEFAULT_MAX_REPLAY_STEPS_PER_TICK = 1;
export const TELEMETRY_CHECKSUM_MATCH = 'PredictionChecksumMatch';
export const TELEMETRY_CHECKSUM_MISMATCH = 'PredictionChecksumMismatch';
export const TELEMETRY_ROLLBACK = 'PredictionRollback';
export const TELEMETRY_RESYNC = 'PredictionResync';
export const TELEMETRY_BUFFER_OVERFLOW = 'PredictionBufferOverflow';
const DEFAULT_REPLAY_EVENT_PUBLISHER: EventPublisher = {
  publish(eventType) {
    return {
      accepted: true,
      state: 'accepted',
      type: eventType,
      channel: 0,
      bufferSize: 0,
      remainingCapacity: 0,
      dispatchOrder: 0,
      softLimitActive: false,
    };
  },
};

const now = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

const buildTelemetryPayload = (
  snapshot: GameStateSnapshot,
  result: RollbackResult,
  replayDurationMs: number,
): TelemetryEventData => ({
  confirmedStep: result.confirmedStep,
  localStep: result.localStep,
  pendingCommands: result.pendingCommands,
  replayedSteps: result.replayedSteps,
  snapshotVersion: snapshot.version,
  runtimeVersion: RUNTIME_VERSION,
  definitionDigest: snapshot.resources.definitionDigest ?? null,
  queueSize: snapshot.commandQueue.entries.length,
  replayDurationMs,
});

type TelemetryEventRecord = Readonly<{
  kind: 'progress' | 'warning';
  event: string;
}>;

const recordTelemetryEvents = (
  events: readonly TelemetryEventRecord[],
  snapshot: GameStateSnapshot,
  result: RollbackResult,
  replayDurationMs: number,
): void => {
  if (events.length === 0) {
    return;
  }
  const payload = buildTelemetryPayload(snapshot, result, replayDurationMs);
  for (const { kind, event } of events) {
    if (kind === 'warning') {
      telemetry.recordWarning(event, payload);
    } else {
      telemetry.recordProgress(event, payload);
    }
  }
};

const resolveNonNegativeInteger = (
  value: number | undefined,
  fallback: number,
): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  return fallback;
};

const resolvePositiveInteger = (
  value: number | undefined,
  fallback: number,
): number => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return fallback;
};

const comparePendingCommands = (left: Command, right: Command): number => {
  if (left.step !== right.step) {
    return left.step - right.step;
  }
  if (left.timestamp !== right.timestamp) {
    return left.timestamp - right.timestamp;
  }
  const leftRequest = left.requestId ?? '';
  const rightRequest = right.requestId ?? '';
  if (leftRequest < rightRequest) {
    return -1;
  }
  if (leftRequest > rightRequest) {
    return 1;
  }
  return 0;
};

const resolvePredictionWindow = (
  options: PredictionManagerOptions,
): PredictionWindow =>
  Object.freeze({
    maxPredictionSteps: resolveNonNegativeInteger(
      options.maxPredictionSteps,
      DEFAULT_MAX_PREDICTION_STEPS,
    ),
    maxPendingCommands: resolveNonNegativeInteger(
      options.maxPendingCommands,
      DEFAULT_MAX_PENDING_COMMANDS,
    ),
    checksumIntervalSteps: resolvePositiveInteger(
      options.checksumIntervalSteps,
      DEFAULT_CHECKSUM_INTERVAL_STEPS,
    ),
    snapshotHistorySteps: resolveNonNegativeInteger(
      options.snapshotHistorySteps,
      DEFAULT_SNAPSHOT_HISTORY_STEPS,
    ),
    maxReplayStepsPerTick: resolvePositiveInteger(
      options.maxReplayStepsPerTick,
      DEFAULT_MAX_REPLAY_STEPS_PER_TICK,
    ),
  } satisfies PredictionWindow);

export function createPredictionManager(
  options: PredictionManagerOptions,
): PredictionManager {
  const predictionWindow = resolvePredictionWindow(options);
  const { captureSnapshot, getCurrentStep } = options;
  const replayOptions = options.replay;
  const replayEventPublisher =
    replayOptions?.eventPublisher ?? DEFAULT_REPLAY_EVENT_PUBLISHER;
  const replayCaptureSnapshot = replayOptions?.captureSnapshot;
  const {
    maxPredictionSteps,
    maxPendingCommands,
    checksumIntervalSteps,
    maxReplayStepsPerTick,
  } = predictionWindow;

  const historyCapacity = maxPredictionSteps;
  const history: Array<ChecksumEntry | undefined> =
    new Array(historyCapacity);
  let historyHead = 0;
  let historySize = 0;
  let lastRecordedStep: number | null = null;

  let pendingCommands: Command[] = [];
  let pendingOverflowed = false;
  let localStep = -1;
  let lastConfirmedStep = -1;

  const clearHistory = (): void => {
    if (historyCapacity > 0) {
      history.fill(undefined);
    }
    historyHead = 0;
    historySize = 0;
    lastRecordedStep = null;
  };

  const dropPendingCommands = (confirmedStep: number): void => {
    if (pendingCommands.length === 0) {
      return;
    }
    pendingCommands = pendingCommands.filter(
      (command) => command.step > confirmedStep,
    );
  };

  const pruneHistory = (latestStep: number): void => {
    if (historySize === 0) {
      return;
    }
    const minStep = latestStep - maxPredictionSteps;
    while (historySize > 0) {
      const entry = history[historyHead];
      if (entry && entry.step < minStep) {
        history[historyHead] = undefined;
        historyHead = (historyHead + 1) % historyCapacity;
        historySize -= 1;
      } else {
        break;
      }
    }
  };

  const recordChecksum = (step: number, checksum: string): void => {
    if (historyCapacity === 0) {
      return;
    }
    const index = (historyHead + historySize) % historyCapacity;
    history[index] = { step, checksum };
    if (historySize === historyCapacity) {
      historyHead = (historyHead + 1) % historyCapacity;
    } else {
      historySize += 1;
    }
    pruneHistory(step);
  };

  const recordSnapshotChecksum = (
    step: number,
    snapshot: GameStateSnapshot,
  ): void => {
    localStep = step;
    if (!shouldRecordChecksum(step)) {
      return;
    }
    recordChecksum(step, computeStateChecksum(snapshot));
    lastRecordedStep = step;
  };

  const findChecksum = (step: number): string | undefined => {
    if (historySize === 0 || historyCapacity === 0) {
      return undefined;
    }
    for (let offset = 0; offset < historySize; offset += 1) {
      const index = (historyHead + offset) % historyCapacity;
      const entry = history[index];
      if (entry?.step === step) {
        return entry.checksum;
      }
    }
    return undefined;
  };

  const shouldRecordChecksum = (step: number): boolean => {
    if (checksumIntervalSteps <= 1) {
      return true;
    }
    if (lastRecordedStep === null) {
      return true;
    }
    return step - lastRecordedStep >= checksumIntervalSteps;
  };

  const resetForResync = (confirmedStep: number, snapshotStep: number): void => {
    clearHistory();
    pendingCommands = [];
    pendingOverflowed = false;
    lastConfirmedStep = confirmedStep;
    localStep = snapshotStep;
  };

  const recordReplayStep = (
    step: number,
    wiring: PredictionReplayWiring,
  ): void => {
    localStep = step;
    if (!shouldRecordChecksum(step)) {
      return;
    }
    if (!replayCaptureSnapshot) {
      throw new Error('Prediction replay snapshot capture is not configured.');
    }
    const snapshot = replayCaptureSnapshot(wiring);
    recordChecksum(step, computeStateChecksum(snapshot));
    lastRecordedStep = step;
  };

  const replayToStep = (
    wiring: PredictionReplayWiring,
    targetStep: number,
  ): number => {
    const runtime = wiring.runtime as PredictionReplayRuntime;
    const stepSizeMs = runtime.getStepSizeMs();
    const batchSize = Math.max(1, maxReplayStepsPerTick);
    let replayedSteps = 0;
    let remainingSteps = Math.max(
      0,
      targetStep - runtime.getCurrentStep(),
    );

    while (remainingSteps > 0) {
      const batch = Math.min(batchSize, remainingSteps);
      for (let i = 0; i < batch; i += 1) {
        const processed = runtime.tick(stepSizeMs);
        if (processed <= 0) {
          remainingSteps = 0;
          break;
        }
        replayedSteps += processed;
        remainingSteps -= processed;
        recordReplayStep(runtime.getCurrentStep(), wiring);
      }
    }

    return replayedSteps;
  };

  const reconcileWithReplay = (
    snapshot: GameStateSnapshot,
    confirmedStep: number,
    targetStep: number,
    status: RollbackResult['status'],
    reason?: RollbackResult['reason'],
    checksumMatch?: boolean,
    replayPending = true,
  ): RollbackResult => {
    const snapshotStep = snapshot.runtime.step;

    if (!replayOptions) {
      const fallbackReplayedSteps =
        status === 'rolled-back'
          ? Math.max(0, targetStep - confirmedStep)
          : 0;
      if (status === 'resynced') {
        resetForResync(confirmedStep, snapshotStep);
      } else {
        clearHistory();
      }
      return {
        status,
        confirmedStep,
        localStep,
        replayedSteps: fallbackReplayedSteps,
        pendingCommands: pendingCommands.length,
        ...(checksumMatch === undefined ? {} : { checksumMatch }),
        ...(reason === undefined ? {} : { reason }),
      };
    }

    const wiring = replayOptions.restoreRuntime({
      snapshot,
      eventPublisher: replayEventPublisher,
    });

    clearHistory();
    pendingOverflowed = false;
    lastConfirmedStep = confirmedStep;

    if (!replayPending) {
      pendingCommands = [];
    }

    recordSnapshotChecksum(snapshotStep, snapshot);

    if (replayPending) {
      for (const command of pendingCommands) {
        if (command.step > confirmedStep) {
          wiring.commandQueue.enqueue(command);
        }
      }
    }

    const replayTargetStep = Math.max(snapshotStep, targetStep);
    const replayedSteps = replayToStep(wiring, replayTargetStep);

    replayOptions.onRuntimeReplaced?.(wiring);

    return {
      status,
      confirmedStep,
      localStep,
      replayedSteps,
      pendingCommands: pendingCommands.length,
      ...(checksumMatch === undefined ? {} : { checksumMatch }),
      ...(reason === undefined ? {} : { reason }),
    };
  };

  const reconcileWithTelemetry = (
    snapshot: GameStateSnapshot,
    confirmedStep: number,
    targetStep: number,
    status: RollbackResult['status'],
    reason?: RollbackResult['reason'],
    checksumMatch?: boolean,
    replayPending = true,
  ): Readonly<{ result: RollbackResult; replayDurationMs: number }> => {
    const start = now();
    const result = reconcileWithReplay(
      snapshot,
      confirmedStep,
      targetStep,
      status,
      reason,
      checksumMatch,
      replayPending,
    );
    const replayDurationMs = Math.max(0, now() - start);
    return { result, replayDurationMs };
  };

  return {
    recordLocalCommand(command, atStep) {
      if (maxPendingCommands === 0) {
        pendingOverflowed = true;
        pendingCommands = [];
        return;
      }
      const resolvedStep = atStep ?? command.step;
      const resolvedCommand =
        atStep === undefined ? command : { ...command, step: resolvedStep };
      const insertIndex = pendingCommands.findIndex((existing) => {
        return comparePendingCommands(resolvedCommand, existing) < 0;
      });
      if (insertIndex === -1) {
        pendingCommands.push(resolvedCommand);
      } else {
        pendingCommands.splice(insertIndex, 0, resolvedCommand);
      }

      if (pendingCommands.length > maxPendingCommands) {
        pendingOverflowed = true;
        pendingCommands = [];
      }
    },
    recordPredictedStep(step) {
      let snapshot: GameStateSnapshot | undefined;
      const resolvedStep =
        step ??
        getCurrentStep?.() ??
        (() => {
          snapshot = captureSnapshot();
          return snapshot.runtime.step;
        })();
      if (
        lastRecordedStep !== null &&
        resolvedStep <= lastRecordedStep
      ) {
        clearHistory();
      }
      localStep = resolvedStep;
      if (!shouldRecordChecksum(resolvedStep)) {
        return;
      }
      const resolvedSnapshot = snapshot ?? captureSnapshot();
      recordChecksum(
        resolvedStep,
        computeStateChecksum(resolvedSnapshot),
      );
      lastRecordedStep = resolvedStep;
    },
    applyServerState(snapshot, confirmedStep) {
      const resolvedLocalStep =
        localStep >= 0 ? localStep : snapshot.runtime.step;
      if (confirmedStep < lastConfirmedStep) {
        return {
          status: 'ignored',
          confirmedStep,
          localStep: resolvedLocalStep,
          replayedSteps: 0,
          pendingCommands: pendingCommands.length,
          reason: 'stale-snapshot',
        };
      }

      if (pendingOverflowed) {
        pendingCommands = [];
        pendingOverflowed = false;
        const { result, replayDurationMs } = reconcileWithTelemetry(
          snapshot,
          confirmedStep,
          snapshot.runtime.step,
          'resynced',
          undefined,
          undefined,
          false,
        );
        recordTelemetryEvents(
          [{ kind: 'warning', event: TELEMETRY_BUFFER_OVERFLOW }],
          snapshot,
          result,
          replayDurationMs,
        );
        return result;
      }

      const localChecksum = findChecksum(confirmedStep);
      if (localChecksum === undefined) {
        dropPendingCommands(confirmedStep);
        const { result, replayDurationMs } = reconcileWithTelemetry(
          snapshot,
          confirmedStep,
          resolvedLocalStep,
          'resynced',
          'prediction-window-exceeded',
        );
        recordTelemetryEvents(
          [{ kind: 'warning', event: TELEMETRY_RESYNC }],
          snapshot,
          result,
          replayDurationMs,
        );
        return result;
      }

      const serverChecksum = computeStateChecksum(snapshot);
      const checksumMatch = serverChecksum === localChecksum;
      dropPendingCommands(confirmedStep);
      lastConfirmedStep = confirmedStep;

      if (checksumMatch) {
        const result: RollbackResult = {
          status: 'confirmed',
          confirmedStep,
          localStep: resolvedLocalStep,
          replayedSteps: 0,
          pendingCommands: pendingCommands.length,
          checksumMatch,
          reason: 'checksum-match',
        };
        recordTelemetryEvents(
          [{ kind: 'progress', event: TELEMETRY_CHECKSUM_MATCH }],
          snapshot,
          result,
          0,
        );
        return result;
      }

      const { result, replayDurationMs } = reconcileWithTelemetry(
        snapshot,
        confirmedStep,
        resolvedLocalStep,
        'rolled-back',
        'checksum-mismatch',
        checksumMatch,
      );
      recordTelemetryEvents(
        [
          { kind: 'warning', event: TELEMETRY_CHECKSUM_MISMATCH },
          { kind: 'progress', event: TELEMETRY_ROLLBACK },
        ],
        snapshot,
        result,
        replayDurationMs,
      );
      return result;
    },
    getPendingCommands() {
      return pendingCommands.slice();
    },
    getPredictionWindow() {
      return predictionWindow;
    },
  };
}
