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
  if (options?.verifyDigest === true) {
    throw new Error('Digest verification is not implemented yet');
  }

  const clonedModules: Record<string, unknown> = Object.create(null);

  for (const [name, moduleValue] of Object.entries(serialized.modules)) {
    clonedModules[name] = Array.isArray(moduleValue)
      ? Object.freeze([...moduleValue])
      : moduleValue;
  }

  return {
    metadata: serialized.metadata,
    modules: Object.freeze(clonedModules),
  };
}

export function createModuleIndices(
  pack: NormalizedContentPack,
): ModuleIndexTables {
  return createModuleIndicesInternal(pack);
}
