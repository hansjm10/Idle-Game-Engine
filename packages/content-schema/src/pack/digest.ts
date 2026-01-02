/**
 * Early digest computation for content pack caching.
 *
 * This module provides digest computation that can be performed on a
 * ParsedContentPack (after Zod parsing) to enable cache lookups before
 * running expensive validation steps.
 */

import {
  createContentPackDigest,
  type ContentPackDigest,
  CONTENT_PACK_DIGEST_VERSION,
} from '../runtime-helpers.js';
import type { ParsedContentPack } from './schema.js';

export type { ContentPackDigest };
export { CONTENT_PACK_DIGEST_VERSION };

/**
 * Computes a digest for a parsed content pack.
 *
 * The digest is computed from the pack's metadata (id, version) and
 * entity IDs only, making it fast to compute before full validation.
 * This enables cache lookups early in the validation pipeline.
 *
 * @param pack - The parsed content pack (after Zod structural validation)
 * @returns A digest object containing version and hash
 */
export const computePackDigest = (pack: ParsedContentPack): ContentPackDigest =>
  createContentPackDigest(pack);

/**
 * Converts a ContentPackDigest to a cache key string.
 *
 * @param digest - The digest to convert
 * @returns A string suitable for use as a cache key
 */
export const digestToCacheKey = (digest: ContentPackDigest): string =>
  `v${digest.version}:${digest.hash}`;
