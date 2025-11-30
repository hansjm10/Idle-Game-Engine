import type { ResourceState } from './resource-state.js';
import { __unsafeWriteAmountDirect } from './resource-state.js';
import { telemetry } from './telemetry.js';

/**
 * Specifies a resource to reset to a specific amount during prestige.
 */
export interface PrestigeResetTarget {
  readonly resourceId: string;
  readonly resetToAmount: number;
}

/**
 * Specifies a resource with a calculated retention amount.
 * The retained amount is computed by the caller using pre-reset values.
 */
export interface PrestigeRetentionTarget {
  readonly resourceId: string;
  readonly retainedAmount: number;
}

/**
 * Context for applying a prestige reset.
 * All values should be pre-calculated by the caller before invoking applyPrestigeReset.
 */
export interface PrestigeResetContext {
  /** The prestige layer ID being applied */
  readonly layerId: string;

  /** The resource state to mutate */
  readonly resourceState: ResourceState;

  /** The reward to grant (added before any resets) */
  readonly reward: {
    readonly resourceId: string;
    readonly amount: number;
  };

  /**
   * Resources to reset to specific amounts.
   * These are resources NOT in the retention list.
   */
  readonly resetTargets: readonly PrestigeResetTarget[];

  /**
   * Resources with retention formulas.
   * The retainedAmount should be calculated using pre-reset resource values.
   */
  readonly retentionTargets: readonly PrestigeRetentionTarget[];
}

/**
 * Applies a prestige reset by executing all mutations in the correct order:
 * 1. Grant reward (using safe addAmount)
 * 2. Reset targets to their specified amounts (using privileged write)
 * 3. Apply retention amounts (using privileged write)
 *
 * This function encapsulates all privileged write operations for prestige resets.
 * The caller is responsible for:
 * - Validating the layer exists and is available
 * - Capturing pre-reset resource values for formula evaluation
 * - Computing all resetToAmount and retainedAmount values
 *
 * @param context - The prestige reset context with pre-calculated values
 */
export function applyPrestigeReset(context: PrestigeResetContext): void {
  const { layerId, resourceState, reward, resetTargets, retentionTargets } = context;

  // 1. Grant reward (safe operation using addAmount)
  const rewardIndex = resourceState.getIndex(reward.resourceId);
  if (rewardIndex !== undefined && reward.amount > 0) {
    resourceState.addAmount(rewardIndex, reward.amount);
  }

  // 2. Reset targets to their specified amounts
  for (const target of resetTargets) {
    const index = resourceState.getIndex(target.resourceId);
    if (index !== undefined) {
      const amount = normalizeAmount(target.resetToAmount);
      __unsafeWriteAmountDirect(resourceState, index, amount);
    }
  }

  // 3. Apply retention amounts
  for (const target of retentionTargets) {
    const index = resourceState.getIndex(target.resourceId);
    if (index !== undefined) {
      const amount = normalizeAmount(target.retainedAmount);
      __unsafeWriteAmountDirect(resourceState, index, amount);
    }
  }

  telemetry.recordProgress('prestige.reset_applied', {
    layerId,
    rewardResourceId: reward.resourceId,
    rewardAmount: reward.amount,
    resetCount: resetTargets.length,
    retentionCount: retentionTargets.length,
  });
}

/**
 * Normalizes an amount to be non-negative and finite.
 * Returns 0 for non-finite values.
 */
function normalizeAmount(amount: number): number {
  if (!Number.isFinite(amount)) {
    return 0;
  }
  return Math.max(0, Math.floor(amount));
}
