import type { ProgressionCoordinator } from './progression-coordinator.js';
import { applyOfflineResourceDeltas } from './offline-resource-deltas.js';

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
}>;

function applyResourceDeltas(
  coordinator: ProgressionCoordinator,
  resourceDeltas: Readonly<Record<string, number>>,
): void {
  applyOfflineResourceDeltas(coordinator, resourceDeltas);
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
