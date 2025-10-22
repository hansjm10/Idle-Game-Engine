import type {
  NormalizedContentPack,
  SerializedContentSchemaWarning,
  SerializedNormalizedContentPack,
} from '../types.js';

export interface SerializeNormalizedContentPackOptions {
  readonly warnings?: readonly SerializedContentSchemaWarning[];
  readonly digest?: string;
  readonly artifactHash?: string;
}

export function serializeNormalizedContentPack(
  pack: NormalizedContentPack,
  options: SerializeNormalizedContentPackOptions = {},
): SerializedNormalizedContentPack {
  const warnings = options.warnings ?? [];
  const modules: Record<string, unknown> = Object.create(null);

  for (const [name, moduleValue] of Object.entries(pack.modules)) {
    modules[name] = moduleValue;
  }

  return {
    formatVersion: 1,
    metadata: pack.metadata,
    modules,
    warnings,
    digest: options.digest,
    artifactHash: options.artifactHash,
  };
}
