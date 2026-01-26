/**
 * Browser-safe harness entry point for `@idle-engine/core`.
 *
 * This entry point exposes a small set of integration helpers intended for
 * host shells and test runners (save parsing and deterministic snapshot
 * building) without requiring `@idle-engine/core/internals`.
 *
 * @public
 * @stability experimental
 */

export { loadGameStateSaveFormat } from './game-state-save.js';
export type { GameStateSaveFormat, SchemaMigration } from './game-state-save.js';

export { buildProgressionSnapshot } from './progression.js';
export type {
  ProgressionAuthoritativeState,
  ProgressionSnapshot,
  ProgressionSnapshotOptions,
} from './progression.js';
