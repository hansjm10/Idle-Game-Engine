import type { ResourceStateAccessor } from './automation-system.js';

/**
 * Minimal ResourceState interface subset needed for adapter.
 * We only need getAmount and optionally getIndex.
 */
export interface ResourceStateSource {
  getAmount(index: number): number;
  getIndex?(id: string): number | undefined;
  addAmount?(index: number, amount: number): number;
  spendAmount?(
    index: number,
    amount: number,
    context?: { systemId?: string; commandId?: string },
  ): boolean;
}

/**
 * Creates a ResourceStateAccessor adapter that bridges the gap between
 * ResourceState's getIndex(id): number | undefined and
 * AutomationSystem's getResourceIndex(id): number contract.
 *
 * The adapter converts undefined returns from getIndex to -1,
 * which AutomationSystem interprets as "resource not found".
 *
 * @param resourceState - The underlying resource state (typically from ProgressionCoordinator)
 * @returns A ResourceStateAccessor compatible with AutomationSystem
 *
 * @example
 * ```typescript
 * const automationSystem = createAutomationSystem({
 *   automations: sampleContent.automations,
 *   commandQueue: runtime.getCommandQueue(),
 *   resourceState: createResourceStateAdapter(progressionCoordinator.resourceState),
 *   stepDurationMs,
 * });
 * ```
 */
export function createResourceStateAdapter(
  resourceState: ResourceStateSource,
): ResourceStateAccessor {
  const adapter: ResourceStateAccessor = {
    getAmount: (index: number) => resourceState.getAmount(index),
  };

  // Only add getResourceIndex if the underlying state has getIndex
  if (resourceState.getIndex) {
    adapter.getResourceIndex = (resourceId: string): number => {
      const index = resourceState.getIndex!(resourceId);
      return index === undefined ? -1 : index;
    };
  }

  // Pass through spendAmount if available on the underlying state
  if (resourceState.spendAmount) {
    adapter.spendAmount = (
      index: number,
      amount: number,
      context?: { systemId?: string; commandId?: string },
    ): boolean => {
      return !!resourceState.spendAmount?.(index, amount, context);
    };
  }

  // Pass through addAmount if available on the underlying state
  if (resourceState.addAmount) {
    adapter.addAmount = (index: number, amount: number): number => {
      return resourceState.addAmount!(index, amount);
    };
  }

  return adapter;
}
