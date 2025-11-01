import { useEffect, useRef, useCallback, useState } from 'react';
import type { ResourceDefinition } from '@idle-engine/core';

import type { WorkerBridge, SessionSnapshotPayload } from './worker-bridge.js';
import { SessionPersistenceAdapter } from './session-persistence-adapter.js';
import { AutosaveController, DEFAULT_SLOT_ID } from './autosave-controller.js';
import { restoreSession as performRestore } from './session-restore.js';
import { PersistencePanel } from './PersistencePanel.js';
import { isPersistenceUIEnabled } from './persistence-config.js';

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

    // Restore session on mount (non-blocking)
    void (async () => {
      try {
        await adapter.open();

        const result = await performRestore(bridge, adapter, {
          slotId,
          definitions,
        });

        if (result.success) {
          // Start autosave after successful restore
          autosave.start();
        } else if (result.error) {
          // eslint-disable-next-line no-console
          console.error('[PersistenceIntegration] Restore failed on mount', result.error);
          // Still start autosave even if restore failed
          autosave.start();
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('[PersistenceIntegration] Initialization failed', error);
        // Still start autosave even if initialization failed
        autosave.start();
      }
    })();

    return () => {
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
