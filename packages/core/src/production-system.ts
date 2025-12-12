import { isDevelopmentMode } from './env-utils.js';
import type { System } from './index.js';

/**
 * Minimal interface for resource state operations needed by the production system.
 * This abstraction allows for easier testing and reduces tight coupling to the
 * full ResourceState implementation.
 */
export interface ProductionResourceState {
  /** Get the internal index for a resource ID. Returns undefined if not found. */
  getIndex(resourceId: string): number | undefined;
  /** Get the current amount of a resource by index. */
  getAmount(index: number): number;
  /** Add an amount to a resource by index. */
  addAmount(index: number, amount: number): void;
  /** Spend an amount from a resource by index. Returns true if successful. */
  spendAmount(
    index: number,
    amount: number,
    context?: { systemId?: string },
  ): boolean;
}

interface ProductionResourceStateRateTracker {
  applyIncome(index: number, amountPerSecond: number): void;
  applyExpense(index: number, amountPerSecond: number): void;
}

type ProductionResourceStateWithRateTracking =
  ProductionResourceState & ProductionResourceStateRateTracker;

function supportsRateTracking(
  resourceState: ProductionResourceState,
): resourceState is ProductionResourceStateWithRateTracking {
  return (
    typeof (resourceState as ProductionResourceStateWithRateTracking).applyIncome === 'function' &&
    typeof (resourceState as ProductionResourceStateWithRateTracking).applyExpense === 'function'
  );
}

interface ProductionResourceStateFinalizer {
  finalizeTick(deltaMs: number): void;
}

type ProductionResourceStateWithFinalizeTick =
  ProductionResourceState & ProductionResourceStateFinalizer;

function supportsFinalizeTick(
  resourceState: ProductionResourceState,
): resourceState is ProductionResourceStateWithFinalizeTick {
  return (
    typeof (resourceState as ProductionResourceStateWithFinalizeTick).finalizeTick === 'function'
  );
}

interface ProductionResourceStateCapacityAccessor {
  getCapacity(index: number): number;
}

type ProductionResourceStateWithCapacity =
  ProductionResourceState & ProductionResourceStateCapacityAccessor;

function supportsCapacity(
  resourceState: ProductionResourceState,
): resourceState is ProductionResourceStateWithCapacity {
  return (
    typeof (resourceState as ProductionResourceStateWithCapacity).getCapacity === 'function'
  );
}

/**
 * Serialized accumulator state for save/load persistence.
 * Keys are in the format "generatorId:operation:resourceId" where operation is "produce" or "consume".
 */
export interface SerializedProductionAccumulators {
  /** Map of accumulator keys to their current fractional values */
  readonly accumulators: Record<string, number>;
}

/**
 * Represents a production or consumption rate for a specific resource.
 */
export interface GeneratorProductionRate {
  /** The ID of the resource being produced or consumed */
  readonly resourceId: string;
  /**
   * The rate per second at which the resource is produced/consumed per owned generator.
   * Must be a positive finite number. Invalid values (negative, zero, NaN, Infinity)
   * are silently ignored during production calculations.
   */
  readonly rate: number;
}

/**
 * Represents the production state of a generator.
 */
export interface GeneratorProductionState {
  /** Unique identifier for the generator */
  readonly id: string;
  /** Number of generators owned (acts as a multiplier) */
  readonly owned: number;
  /** Whether the generator is enabled (defaults to true when omitted). */
  readonly enabled?: boolean;
  /** Resources produced by this generator per tick */
  readonly produces: readonly GeneratorProductionRate[];
  /**
   * Resources consumed by this generator per tick.
   *
   * When a generator has consumption requirements, production is automatically
   * scaled based on available input resources. The system calculates a consumption
   * ratio (0-1) as the minimum of all ratios: available / required for each consumed
   * resource. Both production and consumption are then scaled by this ratio.
   *
   * @example
   * // Generator needs 5 energy/s but only 2.5 available
   * // consumptionRatio = 2.5 / 5 = 0.5 (50%)
   * // All production and consumption scaled to 50%
   * consumes: [{ resourceId: 'energy', rate: 5 }]
   *
   * @example
   * // Multiple requirements - uses minimum ratio
   * // If energy: 8/10 = 0.8, fuel: 3/5 = 0.6
   * // consumptionRatio = min(0.8, 0.6) = 0.6 (60%)
   * consumes: [
   *   { resourceId: 'energy', rate: 10 },
   *   { resourceId: 'fuel', rate: 5 }
   * ]
   *
   * @example
   * // Full consumption available - no scaling
   * // consumptionRatio = 1.0 (100%)
   * consumes: [{ resourceId: 'energy', rate: 10 }] // 10+ energy available
   */
  readonly consumes: readonly GeneratorProductionRate[];
}

/**
 * Extended System interface that includes production-specific methods.
 */
export interface ProductionSystem extends System {
  /**
   * Clears all accumulated fractional amounts.
   *
   * This is useful when you need to reset the internal accumulator state:
   * - After prestige resets, to prevent stale fractional amounts from being applied
   * - When generators change significantly (e.g., upgrades that drastically alter rates)
   * - When you want to ensure fresh accumulation starts from zero
   *
   * @remarks
   * Accumulators are not automatically cleaned up when generators are removed.
   * For games with many dynamic/temporary generators, call clearAccumulators() periodically
   * or after removing generators to free memory. For typical idle games with static generators, this is not a concern.
   *
   * @example
   * ```typescript
   * // After a prestige reset
   * productionSystem.clearAccumulators();
   * ```
   */
  clearAccumulators(): void;

  /**
   * Removes accumulator entries that have effectively zero value.
   *
   * Unlike `clearAccumulators()` which removes ALL entries, this method only
   * removes entries with negligible values (below the threshold). This is useful
   * for freeing memory from removed generators while preserving valid in-progress
   * accumulations.
   *
   * @remarks
   * Call this after removing generators to free memory without disrupting
   * active production. Entries are considered "effectively zero" if their
   * absolute value is less than threshold * 1e-6.
   *
   * @example
   * ```typescript
   * // After removing some generators
   * productionSystem.cleanupAccumulators();
   * ```
   */
  cleanupAccumulators(): void;

  /**
   * Removes all accumulator entries for a specific generator.
   *
   * Call this when a generator is removed from the game to free memory
   * associated with that generator's accumulated fractional amounts.
   *
   * @param generatorId - The ID of the generator whose accumulators should be removed
   *
   * @example
   * ```typescript
   * // When removing a generator
   * gameState.removeGenerator('gold-mine');
   * productionSystem.clearGeneratorAccumulators('gold-mine');
   * ```
   */
  clearGeneratorAccumulators(generatorId: string): void;

  /**
   * Exports accumulator state for persistence.
   *
   * Call this when saving game state to preserve fractional amounts that
   * haven't yet reached the apply threshold. Without this, small accumulated
   * amounts would be lost on save/load.
   *
   * @returns Serialized accumulator state suitable for JSON storage
   *
   * @example
   * ```typescript
   * // When saving game state
   * const saveData = {
   *   resources: resourceState.exportForSave(),
   *   productionAccumulators: productionSystem.exportAccumulators(),
   * };
   * ```
   */
  exportAccumulators(): SerializedProductionAccumulators;

  /**
   * Restores accumulator state from a previous save.
   *
   * Call this after loading game state to restore fractional amounts.
   * Invalid or unknown accumulator keys are silently ignored for
   * forward compatibility.
   *
   * @param state - Previously exported accumulator state
   *
   * @example
   * ```typescript
   * // When loading game state
   * if (saveData.productionAccumulators) {
   *   productionSystem.restoreAccumulators(saveData.productionAccumulators);
   * }
   * ```
   */
  restoreAccumulators(state: SerializedProductionAccumulators): void;
}

/**
 * Default system ID used for telemetry and resource spend tracking.
 */
const DEFAULT_PRODUCTION_SYSTEM_ID = 'production';

/**
 * Configuration options for creating a production system.
 */
export interface ProductionSystemOptions {
  /**
   * Function that returns the current generator states.
   * Called each tick to get fresh generator data.
   */
  readonly generators: () => readonly GeneratorProductionState[];
  /**
   * The resource state to apply production/consumption to.
   * Accepts any object implementing ProductionResourceState, including the full ResourceState.
   */
  readonly resourceState: ProductionResourceState;
  /**
   * Unique identifier for this production system.
   * Used for the system's `id` property and recorded in telemetry when
   * resources are consumed. Defaults to "production" when omitted.
   *
   * Specify a unique ID when creating multiple production systems to
   * distinguish their resource operations in telemetry and debugging.
   *
   * @default "production"
   */
  readonly systemId?: string;
  /**
   * Optional function to get a production multiplier for a generator.
   * Can be used to apply upgrade bonuses.
   * @returns Multiplier value (defaults to 1 if not provided)
   */
  readonly getMultiplier?: (generatorId: string) => number;
  /**
   * Minimum amount to apply to resources per tick.
   *
   * Fractional amounts below this threshold are accumulated internally
   * and applied once they reach the threshold. This prevents floating-point
   * drift while allowing smooth resource updates.
   *
   * @example
   * // Apply changes in increments of 0.01 (good for displayed values)
   * applyThreshold: 0.01
   *
   * @example
   * // Apply changes in increments of 1 (whole units only)
   * applyThreshold: 1
   *
   * @default 0.0001
   */
  readonly applyThreshold?: number;
  /**
   * When enabled, the system also populates per-second income/expense buffers
   * by calling `resourceState.applyIncome/applyExpense` (when available).
   *
   * When the provided `resourceState` also supports `finalizeTick`, the production
   * system will only queue per-second rates and expects the caller to apply them
   * via `resourceState.finalizeTick(deltaMs)` after systems run.
   *
   * When `finalizeTick` is not available, enabling this option only affects
   * per-second buffers and does not change balance mutations.
   *
   * @default false
   */
  readonly trackRates?: boolean;
  /**
   * Optional callback invoked after each tick with production statistics.
   *
   * Useful for debugging, metrics collection, or UI updates. The callback
   * receives the total amounts actually applied (after accumulator thresholding)
   * for each resource during the tick.
   *
   * @param stats - Production statistics for the tick
   * @param stats.produced - Map of resource IDs to total amounts produced
   * @param stats.consumed - Map of resource IDs to total amounts consumed
   *
   * @example
   * ```typescript
   * createProductionSystem({
   *   generators: () => generators,
   *   resourceState,
   *   onTick: ({ produced, consumed }) => {
   *     console.log('Produced:', Object.fromEntries(produced));
   *     console.log('Consumed:', Object.fromEntries(consumed));
   *   }
   * });
   * ```
   */
  readonly onTick?: (stats: {
    produced: Map<string, number>;
    consumed: Map<string, number>;
  }) => void;
}

/**
 * A validated production/consumption rate with resolved resource index.
 * Returned by `validateRates` after filtering invalid rates.
 */
export interface ValidatedRate {
  /** The ID of the resource */
  readonly resourceId: string;
  /** The resolved index in the resource state */
  readonly index: number;
  /** The validated rate (guaranteed positive and finite) */
  readonly rate: number;
}

/**
 * Pre-processes production/consumption rates, filtering invalid ones and resolving resource indices.
 *
 * This function is exported primarily for testing purposes, allowing consumers to
 * pre-validate their generator configurations before runtime.
 *
 * @param rates - Array of production rates to validate
 * @param resourceState - Resource state to resolve indices against
 * @returns Array of validated rates with resolved indices
 *
 * @example
 * ```typescript
 * const validated = validateRates(generator.produces, resourceState);
 * // validated contains only rates that are positive, finite, and have valid resource indices
 * ```
 */
export function validateRates(
  rates: readonly GeneratorProductionRate[],
  resourceState: ProductionResourceState,
): ValidatedRate[] {
  const validated: ValidatedRate[] = [];

  for (const { resourceId, rate } of rates) {
    if (!Number.isFinite(rate) || rate <= 0) {
      continue;
    }

    const index = resourceState.getIndex(resourceId);
    if (index === undefined) {
      continue;
    }

    validated.push({ resourceId, index, rate });
  }

  return validated;
}

/**
 * Creates a production system that applies generator produces/consumes rates
 * to resources each tick.
 *
 * The system calculates production as: rate * owned * multiplier * deltaSeconds * consumptionRatio
 *
 * ## Consumption Ratio Behavior
 *
 * When a generator has consumption requirements (consumes array), production is
 * automatically throttled based on available input resources. The system:
 *
 * 1. Calculates the ratio of available/required for each consumed resource
 * 2. Takes the minimum ratio across all consumed resources (consumptionRatio)
 * 3. Scales both production AND consumption by this ratio
 *
 * This ensures generators operate at reduced efficiency when inputs are limited,
 * rather than stopping completely or consuming more than available.
 *
 * @remarks
 * **Consumption Ratio Formula:**
 * ```
 * consumptionRatio = min(available[i] / (rate[i] * owned * multiplier * deltaSeconds))
 * ```
 * where i iterates over all consumed resources.
 *
 * **Scaling Formula:**
 * ```
 * actualProduction = baseProduction * consumptionRatio
 * actualConsumption = baseConsumption * consumptionRatio
 * ```
 *
 * @example
 * **Example 1: Single consumption requirement with limited input**
 * ```typescript
 * // Generator produces 10 metal/s, consumes 5 energy/s
 * // Only 2.5 energy available this tick (0.5s * 5 = 2.5 needed)
 * const generator = {
 *   id: 'smelter',
 *   owned: 1,
 *   produces: [{ resourceId: 'metal', rate: 10 }],
 *   consumes: [{ resourceId: 'energy', rate: 5 }]
 * };
 * // With only 1.25 energy available for a 0.5s tick:
 * // consumptionRatio = 1.25 / 2.5 = 0.5
 * // Produces: 10 * 1 * 1 * 0.5 * 0.5 = 2.5 metal (instead of 5)
 * // Consumes: 5 * 1 * 1 * 0.5 * 0.5 = 1.25 energy (instead of 2.5)
 * ```
 *
 * @example
 * **Example 2: Multiple consumption requirements**
 * ```typescript
 * // Generator needs both energy and fuel
 * const generator = {
 *   id: 'refinery',
 *   owned: 1,
 *   produces: [{ resourceId: 'output', rate: 20 }],
 *   consumes: [
 *     { resourceId: 'energy', rate: 10 },  // Need 10/s
 *     { resourceId: 'fuel', rate: 5 }      // Need 5/s
 *   ]
 * };
 * // For a 1s tick with energy: 8 available, fuel: 3 available
 * // energyRatio = 8 / 10 = 0.8
 * // fuelRatio = 3 / 5 = 0.6
 * // consumptionRatio = min(0.8, 0.6) = 0.6
 * // Produces: 20 * 1 * 1 * 1 * 0.6 = 12 output (instead of 20)
 * // Consumes: 10 * 0.6 = 6 energy, 5 * 0.6 = 3 fuel
 * ```
 *
 * @example
 * **Example 3: Full consumption available**
 * ```typescript
 * // Generator with abundant inputs
 * const generator = {
 *   id: 'generator',
 *   owned: 1,
 *   produces: [{ resourceId: 'power', rate: 100 }],
 *   consumes: [{ resourceId: 'fuel', rate: 10 }]
 * };
 * // For a 1s tick with fuel: 50 available (need only 10)
 * // fuelRatio = 50 / 10 = 5.0, but consumptionRatio clamped at 1.0
 * // consumptionRatio = 1.0 (no throttling)
 * // Produces: 100 * 1 * 1 * 1 * 1.0 = 100 power (full rate)
 * // Consumes: 10 * 1 * 1 * 1 * 1.0 = 10 fuel (full rate)
 * ```
 *
 * @example
 * **Basic usage:**
 * ```typescript
 * import { createProductionSystem } from '@idle-engine/core';
 *
 * const productionSystem = createProductionSystem({
 *   generators: () => progressionCoordinator.state.generators,
 *   resourceState: progressionCoordinator.resourceState,
 *   getMultiplier: (generatorId) => upgradeMultipliers.get(generatorId) ?? 1,
 * });
 *
 * runtime.addSystem(productionSystem);
 * ```
 *
 * ## Accumulator Memory Management
 *
 * The production system maintains internal accumulators to track fractional amounts
 * below the `applyThreshold`. These accumulators are keyed by generator ID and resource ID,
 * meaning **memory grows with the number of unique generator/resource combinations**.
 *
 * **Important:** Accumulators are NOT automatically cleaned up when generators are removed.
 * For games with dynamic generators (created/destroyed at runtime), you should manage
 * accumulator memory using these methods:
 *
 * - `clearGeneratorAccumulators(generatorId)` - Call when removing a specific generator
 * - `cleanupAccumulators()` - Removes entries with near-zero values (safe to call periodically)
 * - `clearAccumulators()` - Removes ALL entries (use after prestige resets)
 *
 * For typical idle games with a fixed set of generators, this is not a concern.
 *
 * @example
 * **Memory management for dynamic generators:**
 * ```typescript
 * // When removing a generator
 * gameState.removeGenerator('temporary-boost');
 * productionSystem.clearGeneratorAccumulators('temporary-boost');
 *
 * // After prestige reset
 * productionSystem.clearAccumulators();
 * ```
 *
 * @param options - Configuration options
 * @returns A ProductionSystem that can be added to the runtime
 */
export function createProductionSystem(
  options: ProductionSystemOptions,
): ProductionSystem {
  const { generators, resourceState, getMultiplier, onTick } = options;
  const systemId = options.systemId ?? DEFAULT_PRODUCTION_SYSTEM_ID;
  const applyThreshold = options.applyThreshold ?? 0.0001;
  const rateTrackingState = supportsRateTracking(resourceState)
    ? resourceState
    : undefined;
  const trackRates = options.trackRates === true;
  const useFinalizeTickRates =
    trackRates && rateTrackingState !== undefined && supportsFinalizeTick(resourceState);

  if (applyThreshold <= 0 || !Number.isFinite(applyThreshold)) {
    throw new Error('applyThreshold must be a positive finite number');
  }

  // Track accumulated fractional amounts per generator/resource
  const accumulators = new Map<string, number>();

  function getAccumulatorKey(
    generatorId: string,
    operation: 'produce' | 'consume',
    resourceId: string,
  ): string {
    return `${generatorId}:${operation}:${resourceId}`;
  }

  /**
   * Calculates what would be applied without modifying accumulator state.
   * Returns both the amount that would be applied and the new accumulator total.
   */
  interface AccumulatorResult {
    /** Amount that would be applied this tick (threshold-aligned) */
    toApply: number;
    /** Total accumulated value (for ratio calculations) */
    newTotal: number;
    /** Commits the accumulator state, optionally scaling the applied amount */
    commit: (scale?: number) => void;
  }

  /**
   * Accumulates a delta and returns the threshold-aligned amount to apply.
   * Call commit() to finalize the accumulator state after deciding the scale.
   */
  function accumulate(key: string, delta: number): AccumulatorResult {
    const current = accumulators.get(key) ?? 0;
    const total = current + delta;
    // Use a small epsilon to handle floating-point precision issues
    // (e.g., 0.09 + 0.01 = 0.09999999999999999 should count as 0.10)
    // 1e-9 is orders of magnitude larger than float64 machine epsilon (~2.2e-16)
    // but still negligible relative to any practical threshold value.
    const epsilon = applyThreshold * 1e-9;
    const toApply = Math.floor((total + epsilon) / applyThreshold) * applyThreshold;

    return {
      toApply,
      newTotal: total,
      commit: (scale = 1) => {
        // Store the difference between total accumulated and what was actually applied.
        // This preserves both the sub-threshold remainder and any portion not applied due to scaling.
        accumulators.set(key, total - toApply * scale);
      },
    };
  }

  return {
    id: systemId,
    tick: ({ deltaMs }) => {
      const deltaSeconds = deltaMs / 1000;
      const generatorList = generators();

      // Track total produced and consumed amounts for this tick
      const produced = new Map<string, number>();
      const consumed = new Map<string, number>();

      if (useFinalizeTickRates && rateTrackingState) {
        if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) {
          if (onTick) {
            onTick({ produced, consumed });
          }
          return;
        }

        const capacityState = supportsCapacity(resourceState)
          ? resourceState
          : undefined;
        const shadowAmounts = new Map<number, number>();
        const tickIncome = new Map<number, number>();
        const tickExpense = new Map<number, number>();

        const getShadowAmount = (index: number): number =>
          shadowAmounts.get(index) ?? resourceState.getAmount(index);

        const getShadowCapacity = (index: number): number => {
          if (!capacityState) {
            return Number.POSITIVE_INFINITY;
          }

          const capacity = capacityState.getCapacity(index);
          if (capacity === Number.POSITIVE_INFINITY) {
            return Number.POSITIVE_INFINITY;
          }
          if (!Number.isFinite(capacity) || capacity < 0) {
            return Number.POSITIVE_INFINITY;
          }
          return capacity;
        };

        const clampShadowAmount = (amount: number, capacity: number): number => {
          if (amount < 0) {
            return 0;
          }
          if (amount > capacity) {
            return capacity;
          }
          return amount;
        };

        const addShadowAmount = (index: number, amount: number): number => {
          const current = getShadowAmount(index);
          const capacity = getShadowCapacity(index);
          const next = clampShadowAmount(current + amount, capacity);
          shadowAmounts.set(index, next);
          return next - current;
        };

        const spendShadowAmount = (index: number, amount: number): boolean => {
          const current = getShadowAmount(index);
          if (current < amount) {
            return false;
          }
          shadowAmounts.set(index, current - amount);
          return true;
        };

        const recordTickAmount = (map: Map<number, number>, index: number, amount: number): void => {
          if (!Number.isFinite(amount) || amount <= 0) {
            return;
          }
          map.set(index, (map.get(index) ?? 0) + amount);
        };

        for (const generator of generatorList) {
          if (isDevelopmentMode() && generator.id.includes(':')) {
            // eslint-disable-next-line no-console
            console.warn(
              `Generator ID "${generator.id}" contains ':' which may cause accumulator key collisions`,
            );
          }

          if (generator.owned <= 0) {
            continue;
          }
          if (generator.enabled === false) {
            continue;
          }

          const multiplier = getMultiplier?.(generator.id) ?? 1;
          const effectiveOwned = generator.owned * multiplier;

          const validProductions = validateRates(generator.produces, resourceState);
          const validConsumptions = validateRates(generator.consumes, resourceState);

          // Phase 1: Peek at what each consumption accumulator would apply
          // and calculate ratio based on ACTUAL consumable amounts (post-threshold)
          const consumptionAccumulators: Array<{
            resourceId: string;
            index: number;
            result: AccumulatorResult;
          }> = [];

          let consumptionRatio = 1;
          // Generators without consumption requirements always produce at full rate.
          // For generators WITH consumption, we only apply production when at least
          // one consumption crosses the threshold (keeps production/consumption in sync).
          let willApplyProduction = validConsumptions.length === 0;
          for (const { resourceId, index, rate } of validConsumptions) {
            const delta = rate * effectiveOwned * deltaSeconds;
            const key = getAccumulatorKey(generator.id, 'consume', resourceId);
            const result = accumulate(key, delta);

            consumptionAccumulators.push({ resourceId, index, result });

            // Calculate ratio based on total accumulated consumption vs available
            if (result.toApply > 0) {
              willApplyProduction = true;
              const available = getShadowAmount(index);
              // Use newTotal (full accumulated amount) for ratio calculation
              // to ensure production scales correctly with actual consumption.
              // Guard against division by zero (theoretically possible with extremely
              // small delta times that round to zero after floating-point operations).
              const ratio = result.newTotal > 0 ? available / result.newTotal : 1;
              consumptionRatio = Math.min(consumptionRatio, ratio);
            }
          }

          // Phase 2: Accumulate production at full rate, apply scaled by consumption ratio
          for (const { resourceId, index, rate } of validProductions) {
            const delta = rate * effectiveOwned * deltaSeconds;
            const key = getAccumulatorKey(generator.id, 'produce', resourceId);
            const result = accumulate(key, delta);

            // Scale the applied amount by consumption ratio
            const scale = willApplyProduction ? consumptionRatio : 0;
            result.commit(scale);

            const actualToApply = result.toApply * scale;
            if (actualToApply > 0) {
              const applied = addShadowAmount(index, actualToApply);
              recordTickAmount(tickIncome, index, applied);
              if (onTick && applied > 0) {
                produced.set(resourceId, (produced.get(resourceId) ?? 0) + applied);
              }
            }
          }

          // Phase 3: Apply consumption, scaling by ratio if resources were limited
          for (const { resourceId, index, result } of consumptionAccumulators) {
            result.commit(consumptionRatio);

            const actualToApply = result.toApply * consumptionRatio;
            if (actualToApply > 0 && spendShadowAmount(index, actualToApply)) {
              recordTickAmount(tickExpense, index, actualToApply);
              if (onTick) {
                consumed.set(
                  resourceId,
                  (consumed.get(resourceId) ?? 0) + actualToApply,
                );
              }
            }
          }
        }

        for (const [index, amount] of tickIncome) {
          const amountPerSecond = amount / deltaSeconds;
          if (Number.isFinite(amountPerSecond) && amountPerSecond > 0) {
            rateTrackingState.applyIncome(index, amountPerSecond);
          }
        }

        for (const [index, amount] of tickExpense) {
          const amountPerSecond = amount / deltaSeconds;
          if (Number.isFinite(amountPerSecond) && amountPerSecond > 0) {
            rateTrackingState.applyExpense(index, amountPerSecond);
          }
        }

        if (onTick) {
          onTick({ produced, consumed });
        }
        return;
      }

      for (const generator of generatorList) {
        if (isDevelopmentMode() && generator.id.includes(':')) {
          // eslint-disable-next-line no-console
          console.warn(
            `Generator ID "${generator.id}" contains ':' which may cause accumulator key collisions`,
          );
        }

        if (generator.owned <= 0) {
          continue;
        }
        if (generator.enabled === false) {
          continue;
        }

        const multiplier = getMultiplier?.(generator.id) ?? 1;
        const effectiveOwned = generator.owned * multiplier;

        const validProductions = validateRates(generator.produces, resourceState);
        const validConsumptions = validateRates(generator.consumes, resourceState);

        if (trackRates && rateTrackingState) {
          let rateConsumptionRatio = 1;

          if (validConsumptions.length > 0) {
            for (const { index, rate } of validConsumptions) {
              const required = rate * effectiveOwned * deltaSeconds;
              if (!Number.isFinite(required) || required <= 0) {
                continue;
              }

              const available = resourceState.getAmount(index);
              if (!Number.isFinite(available) || available <= 0) {
                rateConsumptionRatio = 0;
                break;
              }

              const ratio = available / required;
              if (Number.isFinite(ratio)) {
                rateConsumptionRatio = Math.min(rateConsumptionRatio, ratio);
              }
            }

            if (rateConsumptionRatio < 0) {
              rateConsumptionRatio = 0;
            } else if (rateConsumptionRatio > 1) {
              rateConsumptionRatio = 1;
            }
          }

          if (rateConsumptionRatio > 0) {
            for (const { index, rate } of validProductions) {
              const amountPerSecond = rate * effectiveOwned * rateConsumptionRatio;
              if (Number.isFinite(amountPerSecond) && amountPerSecond > 0) {
                rateTrackingState.applyIncome(index, amountPerSecond);
              }
            }

            for (const { index, rate } of validConsumptions) {
              const amountPerSecond = rate * effectiveOwned * rateConsumptionRatio;
              if (Number.isFinite(amountPerSecond) && amountPerSecond > 0) {
                rateTrackingState.applyExpense(index, amountPerSecond);
              }
            }
          }
        }

        // Phase 1: Peek at what each consumption accumulator would apply
        // and calculate ratio based on ACTUAL consumable amounts (post-threshold)
        const consumptionAccumulators: Array<{
          resourceId: string;
          index: number;
          result: AccumulatorResult;
        }> = [];

        let consumptionRatio = 1;
        // Generators without consumption requirements always produce at full rate.
        // For generators WITH consumption, we only apply production when at least
        // one consumption crosses the threshold (keeps production/consumption in sync).
        let willApplyProduction = validConsumptions.length === 0;
        for (const { resourceId, index, rate } of validConsumptions) {
          const delta = rate * effectiveOwned * deltaSeconds;
          const key = getAccumulatorKey(generator.id, 'consume', resourceId);
          const result = accumulate(key, delta);

          consumptionAccumulators.push({ resourceId, index, result });

          // Calculate ratio based on total accumulated consumption vs available
          if (result.toApply > 0) {
            willApplyProduction = true;
            const available = resourceState.getAmount(index);
            // Use newTotal (full accumulated amount) for ratio calculation
            // to ensure production scales correctly with actual consumption.
            // Guard against division by zero (theoretically possible with extremely
            // small delta times that round to zero after floating-point operations).
            const ratio = result.newTotal > 0 ? available / result.newTotal : 1;
            consumptionRatio = Math.min(consumptionRatio, ratio);
          }
        }

        // Phase 2: Accumulate production at full rate, apply scaled by consumption ratio
        for (const { resourceId, index, rate } of validProductions) {
          const delta = rate * effectiveOwned * deltaSeconds;
          const key = getAccumulatorKey(generator.id, 'produce', resourceId);
          const result = accumulate(key, delta);

          // Scale the applied amount by consumption ratio
          const scale = willApplyProduction ? consumptionRatio : 0;
          result.commit(scale);

          const actualToApply = result.toApply * scale;
          if (actualToApply > 0) {
            resourceState.addAmount(index, actualToApply);
            if (onTick) {
              produced.set(resourceId, (produced.get(resourceId) ?? 0) + actualToApply);
            }
          }
        }

        // Phase 3: Apply consumption, scaling by ratio if resources were limited
        for (const { resourceId, index, result } of consumptionAccumulators) {
          result.commit(consumptionRatio);

          const actualToApply = result.toApply * consumptionRatio;
          if (actualToApply > 0) {
            resourceState.spendAmount(index, actualToApply, { systemId });
            if (onTick) {
              consumed.set(resourceId, (consumed.get(resourceId) ?? 0) + actualToApply);
            }
          }
        }
      }

      // Call onTick callback if provided
      if (onTick) {
        onTick({ produced, consumed });
      }
    },
    clearAccumulators: () => {
      accumulators.clear();
    },
    cleanupAccumulators: () => {
      const zeroThreshold = applyThreshold * 1e-6;
      for (const [key, value] of accumulators) {
        if (Math.abs(value) < zeroThreshold) {
          accumulators.delete(key);
        }
      }
    },
    clearGeneratorAccumulators: (generatorId: string) => {
      const prefix = `${generatorId}:`;
      for (const key of accumulators.keys()) {
        if (key.startsWith(prefix)) {
          accumulators.delete(key);
        }
      }
    },
    exportAccumulators: (): SerializedProductionAccumulators => {
      const result: Record<string, number> = {};
      for (const [key, value] of accumulators) {
        // Only export non-zero values to minimize save size
        if (value !== 0) {
          result[key] = value;
        }
      }
      return { accumulators: result };
    },
    restoreAccumulators: (state: SerializedProductionAccumulators) => {
      // Clear existing accumulators before restoring
      accumulators.clear();

      if (!state || !state.accumulators) {
        return;
      }

      // Restore each accumulator, filtering out invalid values
      for (const [key, value] of Object.entries(state.accumulators)) {
        if (typeof value === 'number' && Number.isFinite(value)) {
          accumulators.set(key, value);
        }
      }
    },
  };
}
