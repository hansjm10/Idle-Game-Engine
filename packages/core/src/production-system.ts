import type { ResourceState } from './resource-state.js';
import type { System } from './index.js';

export interface GeneratorProductionRate {
  readonly resourceId: string;
  readonly rate: number;
}

export interface GeneratorProductionState {
  readonly id: string;
  readonly owned: number;
  readonly produces: readonly GeneratorProductionRate[];
  readonly consumes: readonly GeneratorProductionRate[];
}

export interface ProductionSystemOptions {
  readonly generators: () => readonly GeneratorProductionState[];
  readonly resourceState: ResourceState;
  readonly getMultiplier?: (generatorId: string) => number;
}

export function createProductionSystem(
  options: ProductionSystemOptions,
): System {
  const { generators, resourceState, getMultiplier } = options;

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

        for (const production of generator.produces) {
          const index = resourceState.getIndex(production.resourceId);
          if (index === undefined) {
            continue;
          }

          if (!Number.isFinite(production.rate) || production.rate <= 0) {
            continue;
          }

          const delta = production.rate * effectiveOwned * deltaSeconds;
          if (delta > 0) {
            resourceState.addAmount(index, delta);
          }
        }

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
            const actualConsumption = Math.min(available, targetConsumption);
            if (actualConsumption > 0) {
              resourceState.spendAmount(index, actualConsumption, {
                systemId: 'production',
              });
            }
          }
        }
      }
    },
  };
}
