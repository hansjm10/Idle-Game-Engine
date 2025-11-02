import {
  reconcileSaveAgainstDefinitions,
  type ResourceDefinition,
  type ResourceDefinitionDigest,
  type SerializedResourceState,
} from '@idle-engine/core';

import type { WorkerBridge } from './worker-bridge.js';
import type {
  SessionPersistenceAdapter,
  StoredSessionSnapshot,
} from './session-persistence-adapter.js';
import { SessionPersistenceError } from './session-persistence-adapter.js';
import { recordTelemetryError, recordTelemetryEvent } from './telemetry-utils.js';
import {
  findMigrationPath,
  applyMigrations,
  type MigrationDescriptor,
} from './migration-registry.js';

/**
 * Result of a session restore attempt.
 */
export interface SessionRestoreResult {
  readonly success: boolean;
  readonly snapshot?: StoredSessionSnapshot;
  readonly elapsedMs?: number;
  readonly validationStatus?: 'valid' | 'invalid' | 'migrated';
  readonly error?: Error;
}

/**
 * Options for session restore operation.
 */
export interface SessionRestoreOptions {
  readonly slotId: string;
  readonly definitions: readonly ResourceDefinition[];
  readonly allowMigration?: boolean;
}

/**
 * Restores a session from persisted storage with validation and offline progression.
 *
 * Process:
 * 1. Load latest snapshot from IndexedDB
 * 2. Validate against current resource definitions
 * 3. Compute offline elapsed time (clamped to cap)
 * 4. Call bridge.restoreSession() with validated state
 *
 * See docs/runtime-react-worker-bridge-design.md §14.1 for architecture.
 *
 * @param bridge Worker bridge for communicating with runtime
 * @param adapter Persistence adapter for loading snapshots
 * @param options Restore options including slot and definitions
 * @returns Promise resolving to restore result
 */
export async function restoreSession(
  bridge: WorkerBridge,
  adapter: SessionPersistenceAdapter,
  options: SessionRestoreOptions,
): Promise<SessionRestoreResult> {
  const { slotId, definitions, allowMigration = true } = options;

  try {
    // Load latest snapshot from persistence
    const snapshot = await adapter.load(slotId);

    if (!snapshot) {
      // No snapshot found - this is a fresh start, not an error
      recordTelemetryEvent('PersistenceRestoreSkipped', {
        reason: 'no_snapshot',
        slotId,
      });

      return {
        success: true,
      };
    }

    // Validate snapshot against current resource definitions
    let reconciliation;
    let validationError: Error | undefined;
    try {
      reconciliation = reconcileSaveAgainstDefinitions(
        snapshot.state,
        definitions,
      );
    } catch (error) {
      // reconcileSaveAgainstDefinitions throws for severe incompatibilities (removed resources)
      validationError = error instanceof Error ? error : new Error(String(error));

      // eslint-disable-next-line no-console
      console.warn('[SessionRestore] Snapshot validation threw error', {
        slotId,
        error: validationError.message,
      });

      recordTelemetryError('PersistenceRestoreFailed', {
        reason: 'validation_error',
        slotId,
        capturedAt: snapshot.capturedAt,
        error: validationError.message,
      });

      // Attempt migration if allowed
      if (allowMigration) {
        recordTelemetryEvent('PersistenceMigrationRequired', {
          slotId,
          capturedAt: snapshot.capturedAt,
        });

        // Attempt to find and apply migration
        const migrationResult = await attemptMigration(
          snapshot,
          definitions,
          slotId,
        );

        if (migrationResult.success && migrationResult.migratedState) {
          // Migration succeeded - continue with migrated state
          const elapsedMs = adapter.computeOfflineElapsedMs(snapshot);

          await bridge.restoreSession({
            state: migrationResult.migratedState,
            elapsedMs,
          });

          recordTelemetryEvent('PersistenceRestoreSucceeded', {
            slotId,
            capturedAt: snapshot.capturedAt,
            workerStep: snapshot.workerStep,
            elapsedMs,
          });

          return {
            success: true,
            snapshot,
            elapsedMs,
            validationStatus: 'migrated',
          };
        }

        // Migration failed or not found
        return {
          success: false,
          snapshot,
          validationStatus: 'invalid',
          error: migrationResult.error ?? new SessionPersistenceError(
            'Snapshot requires migration but no migration path found',
            'MIGRATION_NOT_FOUND',
            { error: validationError.message },
          ),
        };
      }

      // Migration not allowed, fail
      return {
        success: false,
        snapshot,
        validationStatus: 'invalid',
        error: new SessionPersistenceError(
          'Snapshot validation failed',
          'VALIDATION_FAILED',
          { error: validationError.message },
        ),
      };
    }

    // Validation succeeded (no exception), check reconciliation results
    const needsMigration =
      reconciliation.removedIds.length > 0 ||
      !reconciliation.digestsMatch ||
      snapshot.flags?.pendingMigration;

    if (needsMigration) {
      // eslint-disable-next-line no-console
      console.warn('[SessionRestore] Snapshot needs migration', {
        slotId,
        removedIds: reconciliation.removedIds,
        addedIds: reconciliation.addedIds,
        digestsMatch: reconciliation.digestsMatch,
      });

      recordTelemetryError('PersistenceRestoreFailed', {
        reason: 'migration_needed',
        slotId,
        capturedAt: snapshot.capturedAt,
        removedIds: reconciliation.removedIds,
        addedIds: reconciliation.addedIds,
      });

      if (allowMigration) {
        recordTelemetryEvent('PersistenceMigrationRequired', {
          slotId,
          capturedAt: snapshot.capturedAt,
        });

        // Attempt to find and apply migration
        const migrationResult = await attemptMigration(
          snapshot,
          definitions,
          slotId,
        );

        if (migrationResult.success && migrationResult.migratedState) {
          // Migration succeeded - continue with migrated state
          const elapsedMs = adapter.computeOfflineElapsedMs(snapshot);

          await bridge.restoreSession({
            state: migrationResult.migratedState,
            elapsedMs,
          });

          recordTelemetryEvent('PersistenceRestoreSucceeded', {
            slotId,
            capturedAt: snapshot.capturedAt,
            workerStep: snapshot.workerStep,
            elapsedMs,
          });

          return {
            success: true,
            snapshot,
            elapsedMs,
            validationStatus: 'migrated',
          };
        }

        // Migration failed or not found
        return {
          success: false,
          snapshot,
          validationStatus: 'invalid',
          error: migrationResult.error ?? new SessionPersistenceError(
            'Snapshot requires migration but no migration path found',
            'MIGRATION_NOT_FOUND',
            {
              removedIds: reconciliation.removedIds,
              digestsMatch: reconciliation.digestsMatch,
            },
          ),
        };
      }

      // Migration not allowed
      return {
        success: false,
        snapshot,
        validationStatus: 'invalid',
        error: new SessionPersistenceError(
          'Snapshot needs migration but migration is not allowed',
          'MIGRATION_REQUIRED',
          {
            removedIds: reconciliation.removedIds,
            digestsMatch: reconciliation.digestsMatch,
          },
        ),
      };
    }

    // Compute offline elapsed time
    const elapsedMs = adapter.computeOfflineElapsedMs(snapshot);

    // Restore session via worker bridge
    await bridge.restoreSession({
      state: snapshot.state,
      elapsedMs,
      // resourceDeltas would come from migration transforms
    });

    recordTelemetryEvent('PersistenceRestoreSucceeded', {
      slotId,
      capturedAt: snapshot.capturedAt,
      workerStep: snapshot.workerStep,
      elapsedMs,
    });

    return {
      success: true,
      snapshot,
      elapsedMs,
      validationStatus: 'valid',
    };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[SessionRestore] Restore failed', { slotId, error });

    recordTelemetryError('PersistenceRestoreFailed', {
      reason: 'restore_error',
      slotId,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      success: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Result of attempting a migration.
 */
interface MigrationAttemptResult {
  readonly success: boolean;
  readonly migratedState?: SerializedResourceState;
  readonly appliedMigrations?: readonly MigrationDescriptor[];
  readonly error?: Error;
}

/**
 * Attempts to migrate a snapshot to be compatible with current definitions.
 *
 * Process:
 * 1. Extract current content digest from definitions
 * 2. Find migration path from snapshot digest to current digest
 * 3. Apply migrations sequentially
 * 4. Re-validate after migration
 *
 * @param snapshot - Snapshot to migrate
 * @param definitions - Current resource definitions
 * @param slotId - Slot ID for telemetry
 * @returns Migration result with migrated state if successful
 */
async function attemptMigration(
  snapshot: StoredSessionSnapshot,
  definitions: readonly ResourceDefinition[],
  slotId: string,
): Promise<MigrationAttemptResult> {
  try {
    // Compute current digest from definitions
    const currentDigest = computeDigestFromDefinitions(definitions);

    // Find migration path from snapshot digest to current digest
    const migrationPath = findMigrationPath(
      snapshot.contentDigest,
      currentDigest,
    );

    if (!migrationPath.found) {
      // eslint-disable-next-line no-console
      console.warn('[SessionRestore] No migration path found', {
        slotId,
        fromDigest: snapshot.contentDigest.hash,
        toDigest: currentDigest.hash,
      });

      recordTelemetryError('PersistenceMigrationFailed', {
        reason: 'no_path_found',
        slotId,
        fromDigest: snapshot.contentDigest.hash,
        toDigest: currentDigest.hash,
      });

      return {
        success: false,
        error: new SessionPersistenceError(
          'No migration path found from saved content to current content',
          'MIGRATION_PATH_NOT_FOUND',
          {
            fromDigest: snapshot.contentDigest.hash,
            toDigest: currentDigest.hash,
          },
        ),
      };
    }

    if (migrationPath.migrations.length === 0) {
      // Digests match, no migration needed
      // This shouldn't happen in practice since we only attempt migration when invalid
      return {
        success: true,
        migratedState: snapshot.state,
        appliedMigrations: [],
      };
    }

    // eslint-disable-next-line no-console
    console.log('[SessionRestore] Applying migrations', {
      slotId,
      count: migrationPath.migrations.length,
      path: migrationPath.migrations.map((m) => m.id),
    });

    recordTelemetryEvent('PersistenceMigrationStarted', {
      slotId,
      migrationCount: migrationPath.migrations.length,
      migrationIds: migrationPath.migrations.map((m) => m.id),
    });

    // Apply migrations
    let migratedState = applyMigrations(snapshot.state, migrationPath.migrations);

    // Strip the old definitionDigest so reconcileSaveAgainstDefinitions can reconstruct it
    // from the new IDs. This ensures the digest matches the migrated state.
    const { definitionDigest: _unusedDigest, ...stateWithoutDigest } = migratedState;
    migratedState = stateWithoutDigest as SerializedResourceState;

    // Re-validate after migration
    let revalidation;
    try {
      revalidation = reconcileSaveAgainstDefinitions(
        migratedState,
        definitions,
      );
    } catch (error) {
      // Migration produced state that throws during validation
      const validationError = error instanceof Error ? error : new Error(String(error));

      // eslint-disable-next-line no-console
      console.error('[SessionRestore] Migration produced invalid state', {
        slotId,
        error: validationError.message,
      });

      recordTelemetryError('PersistenceMigrationFailed', {
        reason: 'validation_failed_after_migration',
        slotId,
        error: validationError.message,
      });

      return {
        success: false,
        error: new SessionPersistenceError(
          'Migration completed but state is still invalid',
          'MIGRATION_VALIDATION_FAILED',
          { error: validationError.message },
        ),
      };
    }

    // Check if migration result is compatible
    const stillIncompatible = revalidation.removedIds.length > 0;
    if (stillIncompatible) {
      // eslint-disable-next-line no-console
      console.error('[SessionRestore] Migration did not resolve incompatibilities', {
        slotId,
        removedIds: revalidation.removedIds,
        addedIds: revalidation.addedIds,
        digestsMatch: revalidation.digestsMatch,
      });

      recordTelemetryError('PersistenceMigrationFailed', {
        reason: 'still_incompatible_after_migration',
        slotId,
        removedIds: revalidation.removedIds,
      });

      return {
        success: false,
        error: new SessionPersistenceError(
          'Migration completed but state still has incompatibilities',
          'MIGRATION_INCOMPLETE',
          {
            removedIds: revalidation.removedIds,
            digestsMatch: revalidation.digestsMatch,
          },
        ),
      };
    }

    // Success!
    recordTelemetryEvent('PersistenceMigrationApplied', {
      slotId,
      migrationCount: migrationPath.migrations.length,
      migrationIds: migrationPath.migrations.map((m) => m.id),
    });

    return {
      success: true,
      migratedState,
      appliedMigrations: migrationPath.migrations,
    };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[SessionRestore] Migration error', { slotId, error });

    recordTelemetryError('PersistenceMigrationFailed', {
      reason: 'migration_error',
      slotId,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      success: false,
      error: error instanceof Error
        ? new SessionPersistenceError(
            `Migration failed: ${error.message}`,
            'MIGRATION_ERROR',
            { cause: error },
          )
        : new Error(String(error)),
    };
  }
}

/**
 * Computes a content digest from resource definitions.
 * Mirrors the digest computation in the core runtime.
 *
 * @param definitions - Resource definitions
 * @returns Content digest
 */
function computeDigestFromDefinitions(
  definitions: readonly ResourceDefinition[],
): ResourceDefinitionDigest {
  const ids = definitions.map((def) => def.id);
  return {
    ids,
    version: ids.length,
    hash: computeStableDigest(ids),
  };
}

/**
 * Computes FNV-1a hash of resource IDs.
 * Must match the implementation in packages/core/src/resource-state.ts:1828-1841.
 *
 * @param ids - Ordered resource IDs
 * @returns Hash string in format "fnv1a-{hex}"
 */
function computeStableDigest(ids: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const id of ids) {
    for (let i = 0; i < id.length; i += 1) {
      hash ^= id.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
      hash >>>= 0;
    }
    hash ^= 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash >>>= 0;
  }
  return `fnv1a-${hash.toString(16).padStart(8, '0')}`;
}

/**
 * Validates a snapshot without actually restoring it.
 * Useful for pre-flight checks and migration planning.
 */
export function validateSnapshot(
  snapshot: StoredSessionSnapshot,
  definitions: readonly ResourceDefinition[],
): {
  readonly compatible: boolean;
  readonly removedIds: readonly string[];
  readonly addedIds: readonly string[];
  readonly digestsMatch: boolean;
} {
  try {
    const reconciliation = reconcileSaveAgainstDefinitions(
      snapshot.state,
      definitions,
    );

    return {
      compatible: reconciliation.removedIds.length === 0,
      removedIds: reconciliation.removedIds,
      addedIds: reconciliation.addedIds,
      digestsMatch: reconciliation.digestsMatch,
    };
  } catch {
    // reconcileSaveAgainstDefinitions throws for severe incompatibilities
    return {
      compatible: false,
      removedIds: ['<validation error>'],
      addedIds: [],
      digestsMatch: false,
    };
  }
}

/**
 * Validates save compatibility before attempting restore.
 * Checks runtime version and content pack compatibility.
 *
 * @param snapshot - Snapshot to validate
 * @param definitions - Current resource definitions
 * @returns Validation result with compatibility details
 */
export function validateSaveCompatibility(
  snapshot: StoredSessionSnapshot,
  definitions: readonly ResourceDefinition[],
): {
  readonly compatible: boolean;
  readonly requiresMigration: boolean;
  readonly migrationAvailable: boolean;
  readonly removedIds: readonly string[];
  readonly addedIds: readonly string[];
  readonly digestsMatch: boolean;
} {
  // Validate against current definitions
  const validation = validateSnapshot(snapshot, definitions);

  if (validation.compatible) {
    return {
      compatible: true,
      requiresMigration: false,
      migrationAvailable: false,
      removedIds: [],
      addedIds: validation.addedIds,
      digestsMatch: validation.digestsMatch,
    };
  }

  // Check if migration is available
  const currentDigest = computeDigestFromDefinitions(definitions);
  const migrationPath = findMigrationPath(
    snapshot.contentDigest,
    currentDigest,
  );

  return {
    compatible: false,
    requiresMigration: true,
    migrationAvailable: migrationPath.found,
    removedIds: validation.removedIds,
    addedIds: validation.addedIds,
    digestsMatch: validation.digestsMatch,
  };
}
