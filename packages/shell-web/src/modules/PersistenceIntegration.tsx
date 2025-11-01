import { useEffect, useRef, useCallback, useState } from 'react';
import type { ResourceDefinition } from '@idle-engine/core';

import type { WorkerBridge, SessionSnapshotPayload } from './worker-bridge.js';
import { SessionPersistenceAdapter } from './session-persistence-adapter.js';
import { AutosaveController, DEFAULT_SLOT_ID } from './autosave-controller.js';
import { restoreSession as performRestore } from './session-restore.js';
import { PersistencePanel } from './PersistencePanel.js';
import { isPersistenceUIEnabled } from './persistence-config.js';

/**
 * Telemetry facade interface for recording persistence events.
 */
type TelemetryFacade = {
  recordError?: (event: string, data?: Record<string, unknown>) => void;
  recordEvent?: (event: string, data?: Record<string, unknown>) => void;
};

function getTelemetryFacade(): TelemetryFacade | undefined {
  return (globalThis as { __IDLE_ENGINE_TELEMETRY__?: TelemetryFacade })
    .__IDLE_ENGINE_TELEMETRY__;
}

function recordTelemetryEvent(
  event: string,
  data: Record<string, unknown>,
): void {
  getTelemetryFacade()?.recordEvent?.(event, data);
}

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
 * See docs/runtime-react-worker-bridge-design.md §14.1 and issue #272.
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
      try {
        await adapter.open();

        recordTelemetryEvent('PersistenceUIRestoreAttempted', { slotId });

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
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        recordTelemetryEvent('PersistenceUIInitializationFailed', {
          slotId,
          error: errorMessage,
        });
        // eslint-disable-next-line no-console
        console.error('[PersistenceIntegration] Initialization failed', error);
      } finally {
        // Always start autosave after initialization attempt.
        // AutosaveController.start() is idempotent, so this is safe.
        // We start autosave even if restore failed to enable future saves.
        autosave.start();
        recordTelemetryEvent('PersistenceUIAutosaveStarted', {
          slotId,
          afterSuccessfulRestore: restoreSucceeded,
        });
      }
    })();

    return () => {
      recordTelemetryEvent('PersistenceUIUnmounted', { slotId });
      autosave.stop();
      adapter.close();
      adapterRef.current = null;
      autosaveRef.current = null;
    };
  }, [bridge, definitions, slotId, autosaveIntervalMs, isEnabled]);

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
    if (!adapter) {
      throw new Error('Persistence adapter not initialized');
    }

    recordTelemetryEvent('PersistenceUIManualLoadInitiated', { slotId });

    const result = await performRestore(bridge, adapter, {
      slotId,
      definitions,
    });

    if (!result.success) {
      throw result.error ?? new Error('Restore failed for unknown reason');
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
    />
  );
}
