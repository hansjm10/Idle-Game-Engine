import type { ProgressionCoordinator } from './progression-coordinator.js';
import { applyOfflineResourceDeltas } from './offline-resource-deltas.js';
import {
  resolveMaxTicksPerCall,
  resolveOfflineProgressTotals,
  type OfflineProgressLimits,
} from './offline-progress-limits.js';

export type { OfflineProgressLimits } from './offline-progress-limits.js';

export type ApplyOfflineProgressOptions = Readonly<{
  readonly elapsedMs: number;
  readonly coordinator: ProgressionCoordinator;
  readonly runtime: Readonly<{
    tick(deltaMs: number): number;
    getCurrentStep(): number;
    getStepSizeMs(): number;
    getMaxStepsPerFrame?: () => number;
  }>;
  readonly resourceDeltas?: Readonly<Record<string, number>>;
  readonly limits?: OfflineProgressLimits;
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

  const maxStepsPerFrame =
    typeof runtime.getMaxStepsPerFrame === 'function'
      ? runtime.getMaxStepsPerFrame()
      : 1;
  const maxBatchSteps =
    Number.isFinite(maxStepsPerFrame) && maxStepsPerFrame > 0
      ? Math.floor(maxStepsPerFrame)
      : 1;

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
