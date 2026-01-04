import type { GameStateSnapshot } from './types.js';

const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;
const utf8Encoder = new TextEncoder();

function normalizeForDeterministicJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForDeterministicJson(entry));
  }

  const result: Record<string, unknown> = {};
  const keys = Object.keys(value).sort();
  for (const key of keys) {
    result[key] = normalizeForDeterministicJson(
      (value as Record<string, unknown>)[key],
    );
  }
  return result;
}

function stringifyDeterministic(value: unknown): string {
  return JSON.stringify(normalizeForDeterministicJson(value));
}

/**
 * Compute FNV-1a hash of a Uint8Array.
 * Returns a 32-bit hash as an 8-character hex string.
 */
export function fnv1a32(data: Uint8Array): string {
  let hash = FNV_OFFSET_BASIS_32;
  for (let i = 0; i < data.length; i += 1) {
    hash ^= data[i];
    hash = Math.imul(hash, FNV_PRIME_32) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Compute a deterministic checksum for a game state snapshot.
 *
 * The checksum excludes `capturedAt` because it is diagnostic only.
 *
 * @example
 * ```typescript
 * const checksum = computeStateChecksum(snapshot);
 * if (checksum !== expected) {
 *   console.warn('Snapshot mismatch detected.');
 * }
 * ```
 */
export function computeStateChecksum(snapshot: GameStateSnapshot): string {
  const checksumSnapshot = {
    version: snapshot.version,
    runtime: snapshot.runtime,
    resources: snapshot.resources,
    progression: snapshot.progression,
    automation: snapshot.automation,
    transforms: snapshot.transforms,
    entities: snapshot.entities,
    commandQueue: snapshot.commandQueue,
  };
  const json = stringifyDeterministic(checksumSnapshot);
  return fnv1a32(utf8Encoder.encode(json));
}

/**
 * Compute checksum for a partial snapshot (e.g., resources only).
 *
 * @example
 * ```typescript
 * const resourcesChecksum = computePartialChecksum(snapshot, ['resources']);
 * const commandsChecksum = computePartialChecksum(snapshot, ['commandQueue']);
 * ```
 */
export function computePartialChecksum<K extends keyof GameStateSnapshot>(
  snapshot: GameStateSnapshot,
  keys: readonly K[],
): string {
  const partial: Partial<GameStateSnapshot> = {};
  for (const key of keys) {
    partial[key] = snapshot[key];
  }
  const json = stringifyDeterministic(partial);
  return fnv1a32(utf8Encoder.encode(json));
}
