import type { ResourceState } from './resource-state.js';
import type { System } from './index.js';

/**
 * Represents a production or consumption rate for a specific resource.
 */
export interface GeneratorProductionRate {
  /** The ID of the resource being produced or consumed */
  readonly resourceId: string;
  /** The rate per second at which the resource is produced/consumed per owned generator */
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
   * @example
   * ```typescript
   * // After a prestige reset
   * productionSystem.clearAccumulators();
   * ```
   */
  clearAccumulators(): void;
}

/**
 * Configuration options for creating a production system.
 */
export interface ProductionSystemOptions {
  /**
   * Function that returns the current generator states.
   * Called each tick to get fresh generator data.
   */
  readonly generators: () => readonly GeneratorProductionState[];
  /** The resource state to apply production/consumption to */
  readonly resourceState: ResourceState;
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
 * Internal type for pre-validated production/consumption rates.
 */
interface ValidatedRate {
  readonly resourceId: string;
  readonly index: number;
  readonly rate: number;
}

/**
 * Pre-processes rates, filtering invalid ones and resolving resource indices.
 */
function validateRates(
  rates: readonly GeneratorProductionRate[],
  resourceState: ResourceState,
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
 * @param options - Configuration options
 * @returns A ProductionSystem that can be added to the runtime
 */
export function createProductionSystem(
  options: ProductionSystemOptions,
): ProductionSystem {
  const { generators, resourceState, getMultiplier, onTick } = options;
  const applyThreshold = options.applyThreshold ?? 0.0001;

  if (applyThreshold <= 0 || !Number.isFinite(applyThreshold)) {
    throw new Error('applyThreshold must be a positive finite number');
  }

  // Track accumulated fractional amounts per generator/resource
  const accumulators = new Map<string, number>();

  function accumulate(
    generatorId: string,
    resourceId: string,
    delta: number,
  ): number {
    const key = `${generatorId}:${resourceId}`;
    const current = accumulators.get(key) ?? 0;
    const total = current + delta;

    // Apply in threshold-sized chunks
    const toApply = Math.floor(total / applyThreshold) * applyThreshold;
    accumulators.set(key, total - toApply);

    return toApply;
  }

  return {
    id: 'production',
    tick: ({ deltaMs }) => {
      const deltaSeconds = deltaMs / 1000;
      const generatorList = generators();

      // Track total produced and consumed amounts for this tick
      const produced = new Map<string, number>();
      const consumed = new Map<string, number>();

      for (const generator of generatorList) {
        if (generator.owned <= 0) {
          continue;
        }

        const multiplier = getMultiplier?.(generator.id) ?? 1;
        const effectiveOwned = generator.owned * multiplier;

        const validProductions = validateRates(generator.produces, resourceState);
        const validConsumptions = validateRates(generator.consumes, resourceState);

        // Calculate consumption ratio - production is throttled by available inputs
        let consumptionRatio = 1;
        for (const { index, rate } of validConsumptions) {
          const targetConsumption = rate * effectiveOwned * deltaSeconds;
          if (targetConsumption > 0) {
            const available = resourceState.getAmount(index);
            const ratio = available / targetConsumption;
            consumptionRatio = Math.min(consumptionRatio, ratio);
          }
        }

        // Apply production with accumulator
        for (const { resourceId, index, rate } of validProductions) {
          const delta = rate * effectiveOwned * deltaSeconds * consumptionRatio;
          const toApply = accumulate(generator.id, resourceId, delta);
          if (toApply > 0) {
            resourceState.addAmount(index, toApply);
            produced.set(resourceId, (produced.get(resourceId) ?? 0) + toApply);
          }
        }

        // Apply consumption with accumulator
        for (const { resourceId, index, rate } of validConsumptions) {
          const delta = rate * effectiveOwned * deltaSeconds * consumptionRatio;
          const toApply = accumulate(generator.id, resourceId, delta);
          if (toApply > 0) {
            resourceState.spendAmount(index, toApply, {
              systemId: 'production',
            });
            consumed.set(resourceId, (consumed.get(resourceId) ?? 0) + toApply);
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
  };
}
