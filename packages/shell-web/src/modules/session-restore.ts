import {
  reconcileSaveAgainstDefinitions,
  createDefinitionDigest,
  computeStableDigest,
  type ResourceDefinition,
  type ResourceDefinitionReconciliation,
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
    let reconciliation: ResourceDefinitionReconciliation | undefined;
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

          // Persist migrated state immediately to avoid repeat migrations
          // if app closes before next autosave
          try {
            const currentDigest = createDefinitionDigest(definitions.map((d) => d.id));
            const migratedSnapshot: StoredSessionSnapshot = {
              ...snapshot,
              state: migrationResult.migratedState,
              contentDigest: currentDigest,
              capturedAt: new Date().toISOString(),
            };
            await adapter.save(migratedSnapshot);
            recordTelemetryEvent('PersistenceMigratedStateSaved', { slotId });
          } catch (saveError) {
            // Log but don't fail restore - autosave will retry
            // eslint-disable-next-line no-console
            console.warn('[SessionRestore] Failed to persist migrated state', { slotId, saveError });
            recordTelemetryError('PersistenceMigratedStateSaveFailed', {
              slotId,
              error: saveError instanceof Error ? saveError.message : String(saveError),
            });
          }

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
    // Only require migration if resources were removed OR pendingMigration flag is set
    //
    // Note: Digest mismatches are acceptable when caused by additions only (no removals).
    // When new resources are added to definitions but none are removed, reconciliation
    // gracefully initializes the new resources to defaults without requiring migration.
    // This additions-only case is treated as valid restore, not incompatibility.
    const needsMigration =
      reconciliation.removedIds.length > 0 ||
      snapshot.flags?.pendingMigration === true;

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

          // Persist migrated state immediately to avoid repeat migrations
          // if app closes before next autosave
          try {
            const currentDigest = createDefinitionDigest(definitions.map((d) => d.id));
            const migratedSnapshot: StoredSessionSnapshot = {
              ...snapshot,
              state: migrationResult.migratedState,
              contentDigest: currentDigest,
              capturedAt: new Date().toISOString(),
            };
            await adapter.save(migratedSnapshot);
            recordTelemetryEvent('PersistenceMigratedStateSaved', { slotId });
          } catch (saveError) {
            // Log but don't fail restore - autosave will retry
            // eslint-disable-next-line no-console
            console.warn('[SessionRestore] Failed to persist migrated state', { slotId, saveError });
            recordTelemetryError('PersistenceMigratedStateSaveFailed', {
              slotId,
              error: saveError instanceof Error ? saveError.message : String(saveError),
            });
          }

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
 * Result of revalidating migrated state.
 */
interface RevalidationResult {
  readonly success: boolean;
  readonly reconciliation?: ResourceDefinitionReconciliation;
  readonly error?: SessionPersistenceError;
}

/**
 * Revalidates migrated state against current definitions.
 *
 * This helper encapsulates the complex validation and compatibility checking
 * logic that occurs after migration transforms are applied.
 *
 * @param migratedState - State after migration transforms
 * @param definitions - Current resource definitions
 * @param slotId - Slot ID for telemetry and logging
 * @returns Validation result with reconciliation data or error
 */
function revalidateMigratedState(
  migratedState: SerializedResourceState,
  definitions: readonly ResourceDefinition[],
  slotId: string,
): RevalidationResult {
  // Attempt reconciliation against current definitions
  let reconciliation: ResourceDefinitionReconciliation;
  try {
    reconciliation = reconcileSaveAgainstDefinitions(
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
  const stillIncompatible = reconciliation.removedIds.length > 0;
  if (stillIncompatible) {
    // eslint-disable-next-line no-console
    console.error('[SessionRestore] Migration did not resolve incompatibilities', {
      slotId,
      removedIds: reconciliation.removedIds,
      addedIds: reconciliation.addedIds,
      digestsMatch: reconciliation.digestsMatch,
    });

    recordTelemetryError('PersistenceMigrationFailed', {
      reason: 'still_incompatible_after_migration',
      slotId,
      removedIds: reconciliation.removedIds,
    });

    return {
      success: false,
      error: new SessionPersistenceError(
        'Migration completed but state still has incompatibilities',
        'MIGRATION_INCOMPLETE',
        {
          removedIds: reconciliation.removedIds,
          digestsMatch: reconciliation.digestsMatch,
        },
      ),
    };
  }

  // Validation succeeded
  return {
    success: true,
    reconciliation,
  };
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
    const currentDigest = createDefinitionDigest(
      definitions.map((def) => def.id),
    );

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
      // Digests match, no migration steps to apply. However, we reached
      // attemptMigration() because validation previously failed or flagged
      // pending migration. Re-run the same validation path to ensure we do
      // not treat corrupted snapshots as successfully migrated.
      const revalidation = revalidateMigratedState(
        snapshot.state,
        definitions,
        slotId,
      );

      if (!revalidation.success) {
        return {
          success: false,
          error: revalidation.error,
        };
      }

      // Revalidation passed: treat as a no-op migration and continue.
      return {
        success: true,
        migratedState: snapshot.state,
        appliedMigrations: [],
      };
    }

    recordTelemetryEvent('PersistenceMigrationStarted', {
      slotId,
      migrationCount: migrationPath.migrations.length,
      migrationIds: migrationPath.migrations.map((m) => m.id),
    });

    // Apply migrations
    let migratedState = applyMigrations(snapshot.state, migrationPath.migrations);

    // Validate that migrated state IDs match the target digest (defensive check)
    const targetDigest = migrationPath.migrations[migrationPath.migrations.length - 1].toDigest;
    const migratedHash = computeStableDigest(migratedState.ids);
    if (migratedHash !== targetDigest.hash) {
      // Emit telemetry warning but don't fail - revalidation will catch real issues
      recordTelemetryEvent('PersistenceMigrationDigestMismatch', {
        slotId,
        expectedHash: targetDigest.hash,
        actualHash: migratedHash,
        migrationCount: migrationPath.migrations.length,
      });
    }

    // Strip the old definitionDigest so reconcileSaveAgainstDefinitions can reconstruct it
    // from the new IDs. This ensures the digest matches the migrated state.
    // Type cast is safe here because:
    // 1. revalidateMigratedState immediately rebuilds the digest via reconcileSaveAgainstDefinitions
    // 2. Any missing/invalid fields will be caught by the validation below
    // 3. The cast allows the validation function to work with the standard interface
    const { definitionDigest: _oldDigest, ...stateWithoutDigest } = migratedState;
    migratedState = stateWithoutDigest as SerializedResourceState;

    // Re-validate after migration - this will catch any shape issues from bad migrations
    const revalidationResult = revalidateMigratedState(
      migratedState,
      definitions,
      slotId,
    );

    if (!revalidationResult.success) {
      return {
        success: false,
        error: revalidationResult.error,
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
      // Compatible only when nothing was removed.
      // This aligns with restoreSession and docs: additions/reordering are
      // handled gracefully by reconciliation and don't require migration.
      // Only resource removals require migration.
      compatible: reconciliation.removedIds.length === 0,
      removedIds: reconciliation.removedIds,
      addedIds: reconciliation.addedIds,
      digestsMatch: reconciliation.digestsMatch,
    };
  } catch (error) {
    // reconcileSaveAgainstDefinitions throws for severe incompatibilities.
    // When it throws due to removed resources, the removedIds are computed but
    // not included in the error. Try to compute them ourselves for diagnostics.
    // eslint-disable-next-line no-console
    console.warn('[SessionRestore] Snapshot validation failed during reconciliation', {
      error: error instanceof Error ? error.message : String(error),
      snapshotIds: snapshot.state.ids,
    });

    // Try to compute removedIds by comparing snapshot IDs with definition IDs
    const definitionIds = new Set(definitions.map((def) => def.id));
    const removedIds = snapshot.state.ids.filter((id) => !definitionIds.has(id));
    const addedIds = definitions
      .map((def) => def.id)
      .filter((id) => !snapshot.state.ids.includes(id));

    recordTelemetryError('PersistenceValidationFailed', {
      reason: 'reconciliation_error',
      error: error instanceof Error ? error.message : String(error),
      idsCount: snapshot.state.ids.length,
      removedIds,
      addedIds,
    });

    return {
      compatible: false,
      removedIds,
      addedIds,
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

  const hasPendingMigrationFlag = Boolean(snapshot.flags?.pendingMigration);
  const needsMigration = !validation.compatible || hasPendingMigrationFlag;

  if (!needsMigration) {
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
  const currentDigest = createDefinitionDigest(
    definitions.map((def) => def.id),
  );
  const migrationPath = findMigrationPath(
    snapshot.contentDigest,
    currentDigest,
  );

  return {
    compatible: false,
    requiresMigration: true,
    // Report migration as available if:
    // 1. A path was found AND has actual steps to apply, OR
    // 2. Zero-step path (digests match) but pendingMigration flag is set
    //    (attemptMigration will revalidate and clear the flag)
    migrationAvailable: migrationPath.found && (
      migrationPath.migrations.length > 0 ||
      hasPendingMigrationFlag
    ),
    removedIds: validation.removedIds,
    addedIds: validation.addedIds,
    digestsMatch: validation.digestsMatch,
  };
}
