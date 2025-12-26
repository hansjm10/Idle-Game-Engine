import { applyOfflineResourceDeltas } from './offline-resource-deltas.js';
import {
  resolveMaxTicksPerCall,
  resolveOfflineProgressTotals,
  type OfflineProgressLimits,
} from './offline-progress-limits.js';
import type { ProductionSystem } from './production-system.js';
import type { ProgressionCoordinator } from './progression-coordinator.js';

export type { OfflineProgressLimits } from './offline-progress-limits.js';

export type OfflineProgressFastPathMode = 'constant-rates';

export type OfflineProgressFastPathPreconditions = Readonly<{
  readonly constantRates: boolean;
  readonly noUnlocks: boolean;
  readonly noAchievements: boolean;
  readonly noAutomation: boolean;
  readonly modeledResourceBounds: boolean;
}>;

export type OfflineProgressFastPathOptions = Readonly<{
  readonly mode: OfflineProgressFastPathMode;
  readonly resourceNetRates: Readonly<Record<string, number>>;
  readonly preconditions: OfflineProgressFastPathPreconditions;
  readonly onInvalid?: 'fallback' | 'error';
}>;

export type ApplyOfflineProgressOptions = Readonly<{
  readonly elapsedMs: number;
  readonly coordinator: ProgressionCoordinator;
  readonly productionSystem?: ProductionSystem;
  readonly runtime: Readonly<{
    tick(deltaMs: number): number;
    getCurrentStep(): number;
    getStepSizeMs(): number;
    getMaxStepsPerFrame?: () => number;
    fastForward?: (deltaMs: number) => number;
  }>;
  readonly resourceDeltas?: Readonly<Record<string, number>>;
  readonly limits?: OfflineProgressLimits;
  readonly fastPath?: OfflineProgressFastPathOptions;
  readonly onProgress?: (progress: OfflineProgressUpdate) => void;
}>;

export type OfflineProgressUpdate = Readonly<{
  readonly processedMs: number;
  readonly totalMs: number;
  readonly processedSteps: number;
  readonly totalSteps: number;
  readonly remainingMs: number;
  readonly remainingSteps: number;
}>;

export type OfflineProgressResult = Readonly<{
  readonly processedMs: number;
  readonly totalMs: number;
  readonly processedSteps: number;
  readonly totalSteps: number;
  readonly remainingMs: number;
  readonly remainingSteps: number;
  readonly completed: boolean;
}>;

function applyResourceDeltas(
  coordinator: ProgressionCoordinator,
  resourceDeltas: Readonly<Record<string, number>>,
): void {
  applyOfflineResourceDeltas(coordinator, resourceDeltas);
}

function buildProgressUpdate(
  processedMs: number,
  totalMs: number,
  processedSteps: number,
  totalSteps: number,
): OfflineProgressUpdate {
  const remainingMs = Math.max(0, totalMs - processedMs);
  const remainingSteps = Math.max(0, totalSteps - processedSteps);
  return {
    processedMs,
    totalMs,
    processedSteps,
    totalSteps,
    remainingMs,
    remainingSteps,
  };
}

function buildProgressResult(
  processedMs: number,
  totalMs: number,
  processedSteps: number,
  totalSteps: number,
): OfflineProgressResult {
  const remainingMs = Math.max(0, totalMs - processedMs);
  const remainingSteps = Math.max(0, totalSteps - processedSteps);
  return {
    processedMs,
    totalMs,
    processedSteps,
    totalSteps,
    remainingMs,
    remainingSteps,
    completed: remainingMs === 0 && remainingSteps === 0,
  };
}

function buildResourceDeltasFromNetRates(
  resourceNetRates: Readonly<Record<string, number>>,
  elapsedMs: number,
): Record<string, number> {
  const deltas: Record<string, number> = {};
  const elapsedSeconds = elapsedMs / 1000;
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) {
    return deltas;
  }

  for (const [resourceId, netPerSecond] of Object.entries(resourceNetRates)) {
    if (!Number.isFinite(netPerSecond) || netPerSecond === 0) {
      continue;
    }
    const delta = netPerSecond * elapsedSeconds;
    if (!Number.isFinite(delta) || delta === 0) {
      continue;
    }
    deltas[resourceId] = delta;
  }

  return deltas;
}

function areFastPathPreconditionsMet(
  preconditions: OfflineProgressFastPathPreconditions | undefined,
): boolean {
  return Boolean(
    preconditions?.constantRates &&
      preconditions.noUnlocks &&
      preconditions.noAchievements &&
      preconditions.noAutomation &&
      preconditions.modeledResourceBounds,
  );
}

function resolveFastPathError(
  fastPath: OfflineProgressFastPathOptions,
  runtime: ApplyOfflineProgressOptions['runtime'],
): string | undefined {
  if (fastPath.mode !== 'constant-rates') {
    return 'Offline progress fast path mode is unsupported.';
  }

  if (!areFastPathPreconditionsMet(fastPath.preconditions)) {
    return 'Offline progress fast path preconditions are not satisfied.';
  }

  if (
    typeof fastPath.resourceNetRates !== 'object' ||
    fastPath.resourceNetRates === null ||
    Array.isArray(fastPath.resourceNetRates)
  ) {
    return 'Offline progress fast path requires resource net rates.';
  }

  if (typeof runtime.fastForward !== 'function') {
    return 'Offline progress fast path requires runtime fast-forward support.';
  }

  return undefined;
}

export function applyOfflineProgress(
  options: ApplyOfflineProgressOptions,
): OfflineProgressResult {
  const { runtime, coordinator, onProgress } = options;

  if (options.resourceDeltas) {
    applyResourceDeltas(coordinator, options.resourceDeltas);
  }

  const stepSizeMs = runtime.getStepSizeMs();
  if (!Number.isFinite(stepSizeMs) || stepSizeMs <= 0) {
    return buildProgressResult(0, 0, 0, 0);
  }

  const startingStep = runtime.getCurrentStep();
  coordinator.updateForStep(startingStep);

  const elapsedMs = options.elapsedMs;
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return buildProgressResult(0, 0, 0, 0);
  }

  const { totalMs, totalSteps, totalRemainderMs } = resolveOfflineProgressTotals(
    elapsedMs,
    stepSizeMs,
    options.limits,
  );
  if (totalMs <= 0) {
    return buildProgressResult(0, totalMs, 0, totalSteps);
  }

  const maxTicksPerCall = resolveMaxTicksPerCall(options.limits);
  const callSteps = maxTicksPerCall !== undefined
    ? Math.min(totalSteps, maxTicksPerCall)
    : totalSteps;
  const callRemainderMs = callSteps === totalSteps ? totalRemainderMs : 0;
  const callElapsedMs = callSteps * stepSizeMs + callRemainderMs;

  let processedSteps = 0;
  let processedMs = 0;

  const reportProgress = () => {
    if (!onProgress) {
      return;
    }
    onProgress(
      buildProgressUpdate(processedMs, totalMs, processedSteps, totalSteps),
    );
  };

  const fastPath = options.fastPath;
  if (fastPath) {
    const fastPathError = resolveFastPathError(fastPath, runtime);
    if (!fastPathError) {
      const stepsAdvanced = runtime.fastForward?.(callElapsedMs) ?? 0;
      const appliedMs = stepsAdvanced * stepSizeMs;
      if (appliedMs > 0) {
        if (options.productionSystem?.applyOfflineDelta) {
          options.productionSystem.applyOfflineDelta(appliedMs);
        } else {
          const fastPathDeltas = buildResourceDeltasFromNetRates(
            fastPath.resourceNetRates,
            appliedMs,
          );
          applyOfflineResourceDeltas(coordinator, fastPathDeltas);
        }
      }
      if (stepsAdvanced > 0) {
        coordinator.updateForStep(runtime.getCurrentStep());
      }
      processedSteps = callSteps;
      processedMs = callElapsedMs;
      if (callElapsedMs > 0) {
        reportProgress();
      }
      return buildProgressResult(processedMs, totalMs, processedSteps, totalSteps);
    }

    if (fastPath.onInvalid === 'error') {
      throw new Error(fastPathError);
    }
  }

  const maxStepsPerFrame =
    typeof runtime.getMaxStepsPerFrame === 'function'
      ? runtime.getMaxStepsPerFrame()
      : 1;
  const maxBatchSteps =
    Number.isFinite(maxStepsPerFrame) && maxStepsPerFrame > 0
      ? Math.floor(maxStepsPerFrame)
      : 1;

  let coordinatorUpdatedByRuntime = false;
  let remainingFullSteps = callSteps;

  if (remainingFullSteps > 0) {
    const lastUpdatedBeforeTick = coordinator.getLastUpdatedStep();
    const stepsProcessed = runtime.tick(stepSizeMs);
    remainingFullSteps -= 1;
    processedSteps += 1;
    processedMs += stepSizeMs;
    reportProgress();

    if (stepsProcessed > 0) {
      const stepAfterTick = runtime.getCurrentStep();
      const lastUpdatedAfterTick = coordinator.getLastUpdatedStep();
      coordinatorUpdatedByRuntime =
        lastUpdatedAfterTick !== lastUpdatedBeforeTick &&
        lastUpdatedAfterTick === stepAfterTick;

      if (!coordinatorUpdatedByRuntime) {
        coordinator.updateForStep(stepAfterTick);
      }
    }
  }

  const batchStepsLimit =
    coordinatorUpdatedByRuntime && maxBatchSteps > 1 ? maxBatchSteps : 1;

  while (remainingFullSteps > 0) {
    const batchSteps = Math.min(remainingFullSteps, batchStepsLimit);
    const stepsProcessed = runtime.tick(batchSteps * stepSizeMs);
    remainingFullSteps -= batchSteps;
    processedSteps += batchSteps;
    processedMs += batchSteps * stepSizeMs;
    reportProgress();

    if (!coordinatorUpdatedByRuntime && stepsProcessed > 0) {
      coordinator.updateForStep(runtime.getCurrentStep());
    }
  }

  if (callRemainderMs > 0) {
    const stepsProcessed = runtime.tick(callRemainderMs);
    processedMs += callRemainderMs;
    reportProgress();
    if (stepsProcessed > 0) {
      coordinator.updateForStep(runtime.getCurrentStep());
    }
  }

  return buildProgressResult(processedMs, totalMs, processedSteps, totalSteps);
}
