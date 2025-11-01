import {
  reconcileSaveAgainstDefinitions,
  type ResourceDefinition,
  type SerializedResourceState,
} from '@idle-engine/core';

import type { WorkerBridge } from './worker-bridge.js';
import type {
  SessionPersistenceAdapter,
  StoredSessionSnapshot,
} from './session-persistence-adapter.js';
import { SessionPersistenceError } from './session-persistence-adapter.js';

/**
 * Telemetry facade interface for recording restore events.
 */
type TelemetryFacade = {
  recordError?: (event: string, data?: Record<string, unknown>) => void;
  recordEvent?: (event: string, data?: Record<string, unknown>) => void;
};

function getTelemetryFacade(): TelemetryFacade | undefined {
  return (globalThis as { __IDLE_ENGINE_TELEMETRY__?: TelemetryFacade })
    .__IDLE_ENGINE_TELEMETRY__;
}

function recordTelemetryError(
  event: string,
  data: Record<string, unknown>,
): void {
  getTelemetryFacade()?.recordError?.(event, data);
}

function recordTelemetryEvent(
  event: string,
  data: Record<string, unknown>,
): void {
  getTelemetryFacade()?.recordEvent?.(event, data);
}

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
    const reconciliation = reconcileSaveAgainstDefinitions(
      snapshot.state,
      definitions,
    );

    if (!reconciliation.isValid) {
      // eslint-disable-next-line no-console
      console.warn('[SessionRestore] Snapshot validation failed', {
        slotId,
        errors: reconciliation.errors,
      });

      recordTelemetryError('PersistenceRestoreFailed', {
        reason: 'validation_failed',
        slotId,
        capturedAt: snapshot.capturedAt,
        errors: reconciliation.errors,
      });

      // Check if migration flag is set
      if (allowMigration && snapshot.flags?.pendingMigration) {
        recordTelemetryEvent('PersistenceMigrationRequired', {
          slotId,
          capturedAt: snapshot.capturedAt,
        });

        // Migration would happen here, but for now we fail
        // Future: Apply migration transforms based on contentDigest
        return {
          success: false,
          snapshot,
          validationStatus: 'invalid',
          error: new SessionPersistenceError(
            'Snapshot requires migration (not yet implemented)',
            'MIGRATION_REQUIRED',
            { errors: reconciliation.errors },
          ),
        };
      }

      return {
        success: false,
        snapshot,
        validationStatus: 'invalid',
        error: new SessionPersistenceError(
          'Snapshot validation failed',
          'VALIDATION_FAILED',
          { errors: reconciliation.errors },
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
 * Validates a snapshot without actually restoring it.
 * Useful for pre-flight checks and migration planning.
 */
export function validateSnapshot(
  snapshot: StoredSessionSnapshot,
  definitions: readonly ResourceDefinition[],
): {
  readonly isValid: boolean;
  readonly errors: readonly string[];
  readonly reconciledState?: SerializedResourceState;
} {
  const reconciliation = reconcileSaveAgainstDefinitions(
    snapshot.state,
    definitions,
  );

  return {
    isValid: reconciliation.isValid,
    errors: reconciliation.errors,
    ...(reconciliation.isValid && {
      reconciledState: reconciliation.reconciledState,
    }),
  };
}
