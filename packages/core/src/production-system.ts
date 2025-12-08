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
  /** Resources consumed by this generator per tick */
  readonly consumes: readonly GeneratorProductionRate[];
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
 * The system calculates production as: rate * owned * multiplier * deltaSeconds
 *
 * @example
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
 * @returns A System that can be added to the runtime
 */
export function createProductionSystem(
  options: ProductionSystemOptions,
): System {
  const { generators, resourceState, getMultiplier } = options;
  const applyThreshold = options.applyThreshold ?? 0.0001;

  if (applyThreshold <= 0 || !Number.isFinite(applyThreshold)) {
    throw new Error('applyThreshold must be a positive finite number');
  }

  return {
    id: 'production',
    tick: ({ deltaMs }) => {
      const deltaSeconds = deltaMs / 1000;
      const generatorList = generators();

      for (const generator of generatorList) {
        if (generator.owned <= 0) {
          continue;
        }

        const multiplier = getMultiplier?.(generator.id) ?? 1;
        const effectiveOwned = generator.owned * multiplier;

        // Calculate consumption ratio first - production is throttled by available inputs
        let consumptionRatio = 1;
        for (const consumption of generator.consumes) {
          const index = resourceState.getIndex(consumption.resourceId);
          if (index === undefined) {
            continue;
          }

          if (!Number.isFinite(consumption.rate) || consumption.rate <= 0) {
            continue;
          }

          const targetConsumption = consumption.rate * effectiveOwned * deltaSeconds;
          if (targetConsumption > 0) {
            const available = resourceState.getAmount(index);
            const ratio = available / targetConsumption;
            consumptionRatio = Math.min(consumptionRatio, ratio);
          }
        }

        // Apply production scaled by consumption ratio
        for (const production of generator.produces) {
          const index = resourceState.getIndex(production.resourceId);
          if (index === undefined) {
            continue;
          }

          if (!Number.isFinite(production.rate) || production.rate <= 0) {
            continue;
          }

          const delta = production.rate * effectiveOwned * deltaSeconds * consumptionRatio;
          if (delta > 0) {
            resourceState.addAmount(index, delta);
          }
        }

        // Apply consumption scaled by the same ratio
        for (const consumption of generator.consumes) {
          const index = resourceState.getIndex(consumption.resourceId);
          if (index === undefined) {
            continue;
          }

          if (!Number.isFinite(consumption.rate) || consumption.rate <= 0) {
            continue;
          }

          const targetConsumption = consumption.rate * effectiveOwned * deltaSeconds * consumptionRatio;
          if (targetConsumption > 0) {
            resourceState.spendAmount(index, targetConsumption, {
              systemId: 'production',
            });
          }
        }
      }
    },
  };
}
