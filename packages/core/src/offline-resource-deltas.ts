import type { ProgressionCoordinator } from './progression-coordinator.js';

export function applyOfflineResourceDeltas(
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
