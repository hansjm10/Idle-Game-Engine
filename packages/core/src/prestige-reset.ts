import type { ResourceState } from './resource-state.js';
import {
  __unsafeWriteAmountDirect,
  __unsafeWriteUnlockedDirect,
  __unsafeWriteVisibleDirect,
} from './resource-state.js';
import { telemetry } from './telemetry.js';

/**
 * Specifies a resource to reset to a specific amount during prestige.
 * The amount will be normalized (floored, clamped to 0) by applyPrestigeReset.
 */
export interface PrestigeResetTarget {
  readonly resourceId: string;
  /** Raw amount from formula - will be normalized to non-negative integer */
  readonly resetToAmount: number;
}

/**
 * Specifies a resource with a calculated retention amount.
 * The retained amount is computed by the caller using pre-reset values.
 * The amount will be normalized (floored, clamped to 0) by applyPrestigeReset.
 */
export interface PrestigeRetentionTarget {
  readonly resourceId: string;
  /** Raw amount from formula - will be normalized to non-negative integer */
  readonly retainedAmount: number;
}

/**
 * Specifies a resource flag reset during prestige.
 * Used to re-lock/re-hide resources back to their content defaults.
 */
export interface PrestigeResourceFlagTarget {
  readonly resourceId: string;
  readonly unlocked: boolean;
  readonly visible: boolean;
}

/**
 * Context for applying a prestige reset.
 * All values should be pre-calculated by the caller before invoking applyPrestigeReset.
 *
 * Note: Callers can pass raw formula outputs. The applyPrestigeReset function
 * normalizes all amounts (floors to integer, clamps to non-negative).
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

  /**
   * Optional resource flag resets (unlocked/visible).
   * This supports "full wipe" prestige semantics for resources that were unlocked earlier.
   */
  readonly resetResourceFlags?: readonly PrestigeResourceFlagTarget[];
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
  const {
    layerId,
    resourceState,
    reward,
    resetTargets,
    retentionTargets,
    resetResourceFlags,
  } = context;

  // 1. Grant reward (safe operation using addAmount)
  const rewardIndex = resourceState.getIndex(reward.resourceId);
  if (rewardIndex !== undefined && reward.amount > 0) {
    resourceState.addAmount(rewardIndex, reward.amount);
  } else if (rewardIndex === undefined && reward.amount > 0) {
    telemetry.recordWarning('PrestigeResetRewardSkipped', {
      layerId,
      resourceId: reward.resourceId,
    });
  }

  // 2. Reset targets to their specified amounts
  for (const target of resetTargets) {
    const index = resourceState.getIndex(target.resourceId);
    if (index !== undefined) {
      const amount = normalizeAmount(target.resetToAmount);
      __unsafeWriteAmountDirect(resourceState, index, amount);
    } else {
      telemetry.recordWarning('PrestigeResetTargetSkipped', {
        layerId,
        resourceId: target.resourceId,
        targetType: 'reset',
      });
    }
  }

  // 3. Apply retention amounts
  for (const target of retentionTargets) {
    const index = resourceState.getIndex(target.resourceId);
    if (index !== undefined) {
      const amount = normalizeAmount(target.retainedAmount);
      __unsafeWriteAmountDirect(resourceState, index, amount);
    } else {
      telemetry.recordWarning('PrestigeResetTargetSkipped', {
        layerId,
        resourceId: target.resourceId,
        targetType: 'retention',
      });
    }
  }

  // 4. Reset resource flags (unlock/visibility) when requested
  if (resetResourceFlags && resetResourceFlags.length > 0) {
    for (const target of resetResourceFlags) {
      const index = resourceState.getIndex(target.resourceId);
      if (index !== undefined) {
        __unsafeWriteUnlockedDirect(resourceState, index, target.unlocked);
        __unsafeWriteVisibleDirect(resourceState, index, target.visible);
      } else {
        telemetry.recordWarning('PrestigeResetTargetSkipped', {
          layerId,
          resourceId: target.resourceId,
          targetType: 'flags',
        });
      }
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
