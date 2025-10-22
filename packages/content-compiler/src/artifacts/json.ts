import type {
  NormalizedContentPack,
  SerializedNormalizedContentPack,
} from '../types.js';

export function serializeNormalizedContentPack(
  pack: NormalizedContentPack,
): SerializedNormalizedContentPack {
  return {
    formatVersion: 1,
    metadata: pack.metadata,
    warnings: [],
  };
}
