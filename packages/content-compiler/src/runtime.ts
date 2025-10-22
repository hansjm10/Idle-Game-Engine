import type {
  ModuleIndexTables,
  NormalizedContentPack,
  RehydrateOptions,
  SerializedNormalizedContentPack,
} from './types.js';
import { createModuleIndices as createModuleIndicesInternal } from './artifacts/module.js';

export function rehydrateNormalizedPack(
  serialized: SerializedNormalizedContentPack,
  options?: RehydrateOptions,
): NormalizedContentPack {
  void options;
  return {
    metadata: serialized.metadata,
    modules: {},
  };
}

export function createModuleIndices(
  pack: NormalizedContentPack,
): ModuleIndexTables {
  return createModuleIndicesInternal(pack);
}
