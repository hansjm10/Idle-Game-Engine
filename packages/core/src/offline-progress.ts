import type { ProgressionCoordinator } from './progression-coordinator.js';
import { applyOfflineResourceDeltas } from './offline-resource-deltas.js';

export type ApplyOfflineProgressOptions = Readonly<{
  readonly elapsedMs: number;
  readonly coordinator: ProgressionCoordinator;
  readonly runtime: Readonly<{
    tick(deltaMs: number): number;
    getCurrentStep(): number;
    getStepSizeMs(): number;
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

  for (let i = 0; i < fullSteps; i += 1) {
    const stepsProcessed = runtime.tick(stepSizeMs);
    if (stepsProcessed > 0) {
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
