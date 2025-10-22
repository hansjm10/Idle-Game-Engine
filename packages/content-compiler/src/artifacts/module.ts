import type { ModuleIndexTables, NormalizedContentPack } from '../types.js';

type ModuleWithId = Readonly<{ id: string }>;

function buildIndex<T extends ModuleWithId>(items: readonly T[]): ReadonlyMap<string, number> {
  const index = new Map<string, number>();

  items.forEach((item, position) => {
    index.set(item.id, position);
  });

  return index;
}

export function createModuleIndices(
  pack: NormalizedContentPack,
): ModuleIndexTables {
  return {
    resources: buildIndex(pack.resources),
    generators: buildIndex(pack.generators),
    upgrades: buildIndex(pack.upgrades),
    metrics: buildIndex(pack.metrics),
    achievements: buildIndex(pack.achievements),
    automations: buildIndex(pack.automations),
    transforms: buildIndex(pack.transforms),
    prestigeLayers: buildIndex(pack.prestigeLayers),
    guildPerks: buildIndex(pack.guildPerks),
    runtimeEvents: buildIndex(pack.runtimeEvents),
  };
}
