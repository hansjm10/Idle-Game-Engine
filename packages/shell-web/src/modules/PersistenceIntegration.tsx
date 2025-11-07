import { useEffect, useRef, useCallback, useState, type JSX } from 'react';
import type { ResourceDefinition } from '@idle-engine/core';

import type { WorkerBridge, SessionSnapshotPayload } from './worker-bridge.js';
import { SessionPersistenceAdapter } from './session-persistence-adapter.js';
import { AutosaveController, DEFAULT_SLOT_ID, type AutosaveStatus } from './autosave-controller.js';
import { restoreSession as performRestore } from './session-restore.js';
import { PersistencePanel } from './PersistencePanel.js';
import { isPersistenceUIEnabled } from './persistence-config.js';
import { recordTelemetryEvent } from './telemetry-utils.js';

/**
 * Props for PersistenceIntegration component.
 */
export interface PersistenceIntegrationProps {
  bridge: WorkerBridge;
  definitions: readonly ResourceDefinition[];
  slotId?: string;
  autosaveIntervalMs?: number;
}

/**
 * PersistenceIntegration component managing autosave and manual save/load operations.
 *
 * Responsibilities:
 * - Initialize SessionPersistenceAdapter and AutosaveController
 * - Restore session on mount if snapshot exists
 * - Provide manual save/load handlers to PersistencePanel
 * - Clean up resources on unmount
 *
 * See docs/runtime-react-worker-bridge-design.md §14.1 and issue #155.
 */
export function PersistenceIntegration({
  bridge,
  definitions,
  slotId = DEFAULT_SLOT_ID,
  autosaveIntervalMs,
}: PersistenceIntegrationProps): JSX.Element | null {
  const [isEnabled] = useState(() => isPersistenceUIEnabled());
  const adapterRef = useRef<SessionPersistenceAdapter | null>(null);
  const autosaveRef = useRef<AutosaveController | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [autosaveStatus, setAutosaveStatus] = useState<AutosaveStatus | null>(null);

  // Callback to update autosave status
  const handleAutosaveStatusChange = useCallback((status: AutosaveStatus) => {
    setAutosaveStatus(status);
  }, []);

  // Initialize adapter and autosave controller
  useEffect(() => {
    if (!isEnabled) {
      return;
    }

    const adapter = new SessionPersistenceAdapter();
    adapterRef.current = adapter;

    const autosave = new AutosaveController(bridge, adapter, {
      slotId,
      intervalMs: autosaveIntervalMs,
      onStatusChange: handleAutosaveStatusChange,
    });
    autosaveRef.current = autosave;

    // Mark as initialized immediately to not block rendering
    setIsInitialized(true);

    recordTelemetryEvent('PersistenceUIInitialized', {
      slotId,
      autosaveIntervalMs: autosaveIntervalMs ?? 'default',
    });

    // Restore session on mount (non-blocking)
    void (async () => {
      let restoreSucceeded = false;
      let adapterInitialized = false;
      try {
        await adapter.open();
        adapterInitialized = true;

        recordTelemetryEvent('PersistenceUIRestoreAttempted', { slotId });

        // Pause autosave during restore to prevent race conditions
        // (autosave hasn't started yet, but this ensures consistency with manual restore)
        autosave.pause();

        try {
          const result = await performRestore(bridge, adapter, {
            slotId,
            definitions,
          });

          if (result.success) {
            restoreSucceeded = true;
            recordTelemetryEvent('PersistenceUIRestoreSucceeded', { slotId });
          } else if (result.error) {
            recordTelemetryEvent('PersistenceUIRestoreFailed', {
              slotId,
              error: result.error.message,
              errorCode: result.error instanceof Error ? result.error.name : 'Unknown',
            });
            // eslint-disable-next-line no-console
            console.error('[PersistenceIntegration] Restore failed on mount', result.error);
          }
        } finally {
          // Resume autosave after restore completes (success or failure)
          autosave.resume();
        }

        // Start autosave only after successful adapter initialization.
        // We start autosave regardless of restore success/failure, as long as
        // the adapter is ready to accept save operations.
        autosave.start();
        recordTelemetryEvent('PersistenceUIAutosaveStarted', {
          slotId,
          afterSuccessfulRestore: restoreSucceeded,
          adapterInitialized: true,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        recordTelemetryEvent('PersistenceUIInitializationFailed', {
          slotId,
          error: errorMessage,
          adapterInitialized,
        });
        // eslint-disable-next-line no-console
        console.error('[PersistenceIntegration] Initialization failed', error);

        // Do not start autosave if adapter failed to initialize.
        // This prevents continuous failed save attempts.
        if (!adapterInitialized) {
          recordTelemetryEvent('PersistenceUIAutosaveSkipped', {
            slotId,
            reason: 'adapter_initialization_failed',
          });
        }
      }
    })();

    return () => {
      recordTelemetryEvent('PersistenceUIUnmounted', { slotId });
      autosave.stop();
      adapter.close();
      adapterRef.current = null;
      autosaveRef.current = null;
    };
  }, [bridge, definitions, slotId, autosaveIntervalMs, isEnabled, handleAutosaveStatusChange]);

  const handleSave = useCallback(async (snapshot: SessionSnapshotPayload) => {
    const adapter = adapterRef.current;
    if (!adapter) {
      throw new Error('Persistence adapter not initialized');
    }

    recordTelemetryEvent('PersistenceUIManualSaveInitiated', {
      slotId: snapshot.slotId,
      workerStep: snapshot.workerStep,
    });

    await adapter.save({
      schemaVersion: snapshot.persistenceSchemaVersion,
      slotId: snapshot.slotId,
      capturedAt: snapshot.capturedAt,
      workerStep: snapshot.workerStep,
      monotonicMs: snapshot.monotonicMs,
      state: snapshot.state,
      runtimeVersion: snapshot.runtimeVersion,
      contentDigest: snapshot.contentDigest,
      flags: snapshot.flags,
    });
  }, []);

  const handleLoad = useCallback(async () => {
    const adapter = adapterRef.current;
    const autosave = autosaveRef.current;
    if (!adapter) {
      throw new Error('Persistence adapter not initialized');
    }

    recordTelemetryEvent('PersistenceUIManualLoadInitiated', { slotId });

    // Pause autosave during manual restore to prevent race conditions
    autosave?.pause();

    try {
      const result = await performRestore(bridge, adapter, {
        slotId,
        definitions,
      });

      if (!result.success) {
        throw result.error ?? new Error('Restore failed for unknown reason');
      }
    } finally {
      // Resume autosave after restore completes
      autosave?.resume();
    }
  }, [bridge, definitions, slotId]);

  const handleClear = useCallback(async () => {
    const adapter = adapterRef.current;
    if (!adapter) {
      throw new Error('Persistence adapter not initialized');
    }

    recordTelemetryEvent('PersistenceUIClearInitiated', { slotId });

    await adapter.deleteSlot(slotId);
  }, [slotId]);

  if (!isEnabled || !isInitialized) {
    return null;
  }

  return (
    <PersistencePanel
      bridge={bridge}
      onSave={handleSave}
      onLoad={handleLoad}
      onClear={handleClear}
      autosaveStatus={autosaveStatus}
    />
  );
}
