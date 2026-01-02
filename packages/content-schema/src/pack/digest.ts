/**
 * Early digest computation for content pack caching.
 *
 * This module provides digest computation that can be performed on a
 * ParsedContentPack (after Zod parsing) to enable cache lookups before
 * running expensive validation steps.
 */

import {
  CONTENT_PACK_DIGEST_VERSION,
  type ContentPackDigest,
} from '../runtime-helpers.js';
import type { ParsedContentPack } from './schema.js';

export type { ContentPackDigest } from '../runtime-helpers.js';
export { CONTENT_PACK_DIGEST_VERSION } from '../runtime-helpers.js';

const FNV1A_OFFSET_BASIS = 0x811c9dc5;
const FNV1A_PRIME = 0x01000193;

const fnv1a = (input: string): number => {
  let hash = FNV1A_OFFSET_BASIS;
  for (const char of input) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    hash ^= codePoint;
    hash = Math.imul(hash, FNV1A_PRIME);
    hash >>>= 0;
  }
  return hash >>> 0;
};

const compareKeys = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const serialized = value.map((entry) => {
      if (
        entry === undefined ||
        typeof entry === 'function' ||
        typeof entry === 'symbol'
      ) {
        return 'null';
      }
      return stableStringify(entry);
    });
    return `[${serialized.join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(
      ([, entry]) =>
        entry !== undefined &&
        typeof entry !== 'function' &&
        typeof entry !== 'symbol',
    )
    .sort(([left], [right]) => compareKeys(left, right));

  const serializedEntries = entries.map(
    ([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`,
  );
  return `{${serializedEntries.join(',')}}`;
};

/**
 * Computes a digest for a parsed content pack.
 *
 * The digest is computed from a stable serialization of the parsed pack,
 * ensuring that any content edits invalidate cached validation results.
 * This enables cache lookups early in the validation pipeline without
 * returning stale results.
 *
 * @param pack - The parsed content pack (after Zod structural validation)
 * @returns A digest object containing version and hash
 */
export const computePackDigest = (pack: ParsedContentPack): ContentPackDigest => {
  const serialized = stableStringify(pack);
  const hash = fnv1a(serialized);
  return {
    version: CONTENT_PACK_DIGEST_VERSION,
    hash: `fnv1a-${hash.toString(16).padStart(8, '0')}`,
  };
};

/**
 * Converts a ContentPackDigest to a cache key string.
 *
 * @param digest - The digest to convert
 * @returns A string suitable for use as a cache key
 */
export const digestToCacheKey = (digest: ContentPackDigest): string =>
  `v${digest.version}:${digest.hash}`;
