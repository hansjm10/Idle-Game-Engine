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
  /**
   * Applied once per call; omit on subsequent chunked calls to avoid reapplying.
   */
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

type OfflineProgressReporter = (processedMs: number, processedSteps: number) => void;

function createProgressReporter(
  onProgress: ApplyOfflineProgressOptions['onProgress'],
  totalMs: number,
  totalSteps: number,
): OfflineProgressReporter {
  if (!onProgress) {
    return () => {};
  }
  return (processedMs, processedSteps) => {
    onProgress(buildProgressUpdate(processedMs, totalMs, processedSteps, totalSteps));
  };
}

function tryApplyFastPathProgress(input: Readonly<{
  fastPath: OfflineProgressFastPathOptions;
  runtime: ApplyOfflineProgressOptions['runtime'];
  coordinator: ProgressionCoordinator;
  productionSystem: ProductionSystem | undefined;
  stepSizeMs: number;
  callElapsedMs: number;
  callSteps: number;
  totalMs: number;
  totalSteps: number;
  reportProgress: OfflineProgressReporter;
}>): OfflineProgressResult | null {
  const fastPathError = resolveFastPathError(input.fastPath, input.runtime);
  if (fastPathError) {
    if (input.fastPath.onInvalid === 'error') {
      throw new Error(fastPathError);
    }
    return null;
  }

  const stepsAdvanced = input.runtime.fastForward?.(input.callElapsedMs) ?? 0;
  const appliedMs = stepsAdvanced * input.stepSizeMs;
  if (appliedMs > 0) {
    if (input.productionSystem?.applyOfflineDelta) {
      input.productionSystem.applyOfflineDelta(appliedMs);
    } else {
      const fastPathDeltas = buildResourceDeltasFromNetRates(
        input.fastPath.resourceNetRates,
        appliedMs,
      );
      applyOfflineResourceDeltas(input.coordinator, fastPathDeltas);
    }
  }

  if (stepsAdvanced > 0) {
    input.coordinator.updateForStep(input.runtime.getCurrentStep());
  }

  const processedSteps = input.callSteps;
  const processedMs = input.callElapsedMs;
  if (processedMs > 0) {
    input.reportProgress(processedMs, processedSteps);
  }

  return buildProgressResult(processedMs, input.totalMs, processedSteps, input.totalSteps);
}

function resolveMaxBatchSteps(
  runtime: ApplyOfflineProgressOptions['runtime'],
): number {
  const maxStepsPerFrame =
    typeof runtime.getMaxStepsPerFrame === 'function'
      ? runtime.getMaxStepsPerFrame()
      : 1;

  return Number.isFinite(maxStepsPerFrame) && maxStepsPerFrame > 0
    ? Math.floor(maxStepsPerFrame)
    : 1;
}

type OfflineProgressLoopState = {
  processedSteps: number;
  processedMs: number;
};

function runFirstOfflineProgressTick(input: Readonly<{
  runtime: ApplyOfflineProgressOptions['runtime'];
  coordinator: ProgressionCoordinator;
  stepSizeMs: number;
  callSteps: number;
  loopState: OfflineProgressLoopState;
  reportProgress: OfflineProgressReporter;
}>): Readonly<{
  remainingFullSteps: number;
  coordinatorUpdatedByRuntime: boolean;
}> {
  let remainingFullSteps = input.callSteps;
  if (remainingFullSteps <= 0) {
    return { remainingFullSteps: 0, coordinatorUpdatedByRuntime: false };
  }

  const lastUpdatedBeforeTick = input.coordinator.getLastUpdatedStep();
  const stepsProcessed = input.runtime.tick(input.stepSizeMs);

  remainingFullSteps -= 1;
  input.loopState.processedSteps += 1;
  input.loopState.processedMs += input.stepSizeMs;
  input.reportProgress(input.loopState.processedMs, input.loopState.processedSteps);

  if (stepsProcessed <= 0) {
    return { remainingFullSteps, coordinatorUpdatedByRuntime: false };
  }

  const stepAfterTick = input.runtime.getCurrentStep();
  const lastUpdatedAfterTick = input.coordinator.getLastUpdatedStep();
  const coordinatorUpdatedByRuntime =
    lastUpdatedAfterTick !== lastUpdatedBeforeTick &&
    lastUpdatedAfterTick === stepAfterTick;

  if (!coordinatorUpdatedByRuntime) {
    input.coordinator.updateForStep(stepAfterTick);
  }

  return { remainingFullSteps, coordinatorUpdatedByRuntime };
}

function runOfflineProgressBatchTicks(input: Readonly<{
  runtime: ApplyOfflineProgressOptions['runtime'];
  coordinator: ProgressionCoordinator;
  stepSizeMs: number;
  remainingFullSteps: number;
  batchStepsLimit: number;
  coordinatorUpdatedByRuntime: boolean;
  loopState: OfflineProgressLoopState;
  reportProgress: OfflineProgressReporter;
}>): void {
  let remainingFullSteps = input.remainingFullSteps;

  while (remainingFullSteps > 0) {
    const batchSteps = Math.min(remainingFullSteps, input.batchStepsLimit);
    const stepsProcessed = input.runtime.tick(batchSteps * input.stepSizeMs);
    remainingFullSteps -= batchSteps;

    input.loopState.processedSteps += batchSteps;
    input.loopState.processedMs += batchSteps * input.stepSizeMs;
    input.reportProgress(input.loopState.processedMs, input.loopState.processedSteps);

    if (!input.coordinatorUpdatedByRuntime && stepsProcessed > 0) {
      input.coordinator.updateForStep(input.runtime.getCurrentStep());
    }
  }
}

function runOfflineProgressRemainderTick(input: Readonly<{
  runtime: ApplyOfflineProgressOptions['runtime'];
  coordinator: ProgressionCoordinator;
  callRemainderMs: number;
  loopState: OfflineProgressLoopState;
  reportProgress: OfflineProgressReporter;
}>): void {
  if (input.callRemainderMs <= 0) {
    return;
  }

  const stepsProcessed = input.runtime.tick(input.callRemainderMs);
  input.loopState.processedMs += input.callRemainderMs;
  input.reportProgress(input.loopState.processedMs, input.loopState.processedSteps);
  if (stepsProcessed > 0) {
    input.coordinator.updateForStep(input.runtime.getCurrentStep());
  }
}

export function applyOfflineProgress(
  options: ApplyOfflineProgressOptions,
): OfflineProgressResult {
  const { runtime, coordinator } = options;

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

  const reportProgress = createProgressReporter(options.onProgress, totalMs, totalSteps);

  const fastPath = options.fastPath;
  if (fastPath) {
    const fastPathResult = tryApplyFastPathProgress({
      fastPath,
      runtime,
      coordinator,
      productionSystem: options.productionSystem,
      stepSizeMs,
      callElapsedMs,
      callSteps,
      totalMs,
      totalSteps,
      reportProgress,
    });
    if (fastPathResult) {
      return fastPathResult;
    }
  }

  const loopState: OfflineProgressLoopState = {
    processedSteps: 0,
    processedMs: 0,
  };

  const maxBatchSteps = resolveMaxBatchSteps(runtime);
  const firstTickResult = runFirstOfflineProgressTick({
    runtime,
    coordinator,
    stepSizeMs,
    callSteps,
    loopState,
    reportProgress,
  });

  const batchStepsLimit =
    firstTickResult.coordinatorUpdatedByRuntime && maxBatchSteps > 1 ? maxBatchSteps : 1;

  runOfflineProgressBatchTicks({
    runtime,
    coordinator,
    stepSizeMs,
    remainingFullSteps: firstTickResult.remainingFullSteps,
    batchStepsLimit,
    coordinatorUpdatedByRuntime: firstTickResult.coordinatorUpdatedByRuntime,
    loopState,
    reportProgress,
  });

  runOfflineProgressRemainderTick({
    runtime,
    coordinator,
    callRemainderMs,
    loopState,
    reportProgress,
  });

  return buildProgressResult(loopState.processedMs, totalMs, loopState.processedSteps, totalSteps);
}
