import type { ProgressionCoordinator } from './progression-coordinator.js';
import { applyOfflineResourceDeltas } from './offline-resource-deltas.js';

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
  readonly runtime: Readonly<{
    tick(deltaMs: number): number;
    getCurrentStep(): number;
    getStepSizeMs(): number;
    getMaxStepsPerFrame?: () => number;
    fastForward?: (deltaMs: number) => number;
  }>;
  readonly resourceDeltas?: Readonly<Record<string, number>>;
  readonly fastPath?: OfflineProgressFastPathOptions;
}>;

function applyResourceDeltas(
  coordinator: ProgressionCoordinator,
  resourceDeltas: Readonly<Record<string, number>>,
): void {
  applyOfflineResourceDeltas(coordinator, resourceDeltas);
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

export function applyOfflineProgress(options: ApplyOfflineProgressOptions): void {
  const { runtime, coordinator } = options;

  if (options.resourceDeltas) {
    applyResourceDeltas(coordinator, options.resourceDeltas);
  }

  const stepSizeMs = runtime.getStepSizeMs();
  if (!Number.isFinite(stepSizeMs) || stepSizeMs <= 0) {
    return;
  }

  const startingStep = runtime.getCurrentStep();
  coordinator.updateForStep(startingStep);

  const elapsedMs = options.elapsedMs;
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return;
  }

  const clampedElapsedMs = Math.max(0, elapsedMs);

  const fastPath = options.fastPath;
  if (fastPath) {
    const fastPathError = resolveFastPathError(fastPath, runtime);
    if (!fastPathError) {
      const stepsAdvanced = runtime.fastForward?.(clampedElapsedMs) ?? 0;
      const appliedMs = stepsAdvanced * stepSizeMs;
      if (appliedMs > 0) {
        const fastPathDeltas = buildResourceDeltasFromNetRates(
          fastPath.resourceNetRates,
          appliedMs,
        );
        applyOfflineResourceDeltas(coordinator, fastPathDeltas);
      }
      if (stepsAdvanced > 0) {
        coordinator.updateForStep(runtime.getCurrentStep());
      }
      return;
    }

    if (fastPath.onInvalid === 'error') {
      throw new Error(fastPathError);
    }
  }

  const fullSteps = Math.floor(clampedElapsedMs / stepSizeMs);
  const remainderMs = clampedElapsedMs - fullSteps * stepSizeMs;

  const maxStepsPerFrame =
    typeof runtime.getMaxStepsPerFrame === 'function'
      ? runtime.getMaxStepsPerFrame()
      : 1;
  const maxBatchSteps =
    Number.isFinite(maxStepsPerFrame) && maxStepsPerFrame > 0
      ? Math.floor(maxStepsPerFrame)
      : 1;

  let coordinatorUpdatedByRuntime = false;
  let remainingFullSteps = fullSteps;

  if (remainingFullSteps > 0) {
    const lastUpdatedBeforeTick = coordinator.getLastUpdatedStep();
    const stepsProcessed = runtime.tick(stepSizeMs);
    remainingFullSteps -= 1;

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

    if (!coordinatorUpdatedByRuntime && stepsProcessed > 0) {
      coordinator.updateForStep(runtime.getCurrentStep());
    }
  }

  if (remainderMs > 0) {
    const stepsProcessed = runtime.tick(remainderMs);
    if (stepsProcessed > 0) {
      coordinator.updateForStep(runtime.getCurrentStep());
    }
  }
}
