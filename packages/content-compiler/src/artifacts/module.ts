import type { ModuleIndexTables, NormalizedContentPack } from '../types.js';

export function createModuleIndices(
  pack: NormalizedContentPack,
): ModuleIndexTables {
  void pack;
  return {
    resources: new Map(),
    generators: new Map(),
    upgrades: new Map(),
    metrics: new Map(),
    achievements: new Map(),
    automations: new Map(),
    transforms: new Map(),
    prestigeLayers: new Map(),
    guildPerks: new Map(),
    runtimeEvents: new Map(),
  };
}
