import type { ProgressionCoordinator } from './progression-coordinator.js';

export type ApplyOfflineProgressOptions = Readonly<{
  readonly elapsedMs: number;
  readonly coordinator: ProgressionCoordinator;
  readonly runtime: Readonly<{
    tick(deltaMs: number): void;
    getCurrentStep(): number;
    getStepSizeMs(): number;
  }>;
  readonly resourceDeltas?: Readonly<Record<string, number>>;
}>;

function applyResourceDeltas(
  coordinator: ProgressionCoordinator,
  resourceDeltas: Readonly<Record<string, number>>,
): void {
  const resourceState = coordinator.resourceState;
  const resourceIds = Object.keys(resourceDeltas).sort((a, b) =>
    a.localeCompare(b),
  );

  for (const resourceId of resourceIds) {
    const delta = resourceDeltas[resourceId];
    if (typeof delta !== 'number' || !Number.isFinite(delta) || delta === 0) {
      continue;
    }

    const index = resourceState.getIndex(resourceId);
    if (index === undefined) {
      continue;
    }

    if (delta > 0) {
      resourceState.addAmount(index, delta);
      continue;
    }

    const current = resourceState.getAmount(index);
    const toSpend = Math.min(current, -delta);
    if (toSpend === 0) {
      continue;
    }
    resourceState.spendAmount(index, toSpend, {
      systemId: 'offline-catchup',
    });
  }
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
    const before = runtime.getCurrentStep();
    runtime.tick(stepSizeMs);
    const after = runtime.getCurrentStep();
    if (after !== before) {
      coordinator.updateForStep(after);
    }
  }

  if (remainderMs > 0) {
    const before = runtime.getCurrentStep();
    runtime.tick(remainderMs);
    const after = runtime.getCurrentStep();
    if (after !== before) {
      coordinator.updateForStep(after);
    }
  }
}

