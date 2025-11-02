import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionSnapshotPayload } from './worker-bridge.js';
import type { WorkerBridge } from './worker-bridge.js';
import { SessionPersistenceError } from './session-persistence-adapter.js';
import { recordTelemetryEvent } from './telemetry-utils.js';
import type { AutosaveStatus } from './autosave-controller.js';

/**
 * Toast notification type for persistence operations.
 */
interface PersistenceToast {
  id: string;
  type: 'success' | 'error' | 'info';
  message: string;
  details?: string;
}

/**
 * Default toast timeout: 10 seconds (WCAG 2.1 compliant).
 */
const DEFAULT_TOAST_TIMEOUT_MS = 10000;

/**
 * Persistence panel props.
 */
export interface PersistencePanelProps {
  bridge: WorkerBridge;
  onSave?: (snapshot: SessionSnapshotPayload) => Promise<void>;
  onLoad?: () => Promise<void>;
  onClear?: () => Promise<void>;
  toastTimeoutMs?: number;
  autosaveStatus?: AutosaveStatus | null;
}

/**
 * PersistencePanel component providing manual save/load controls and status display.
 *
 * Features:
 * - Manual save button with last-saved timestamp
 * - Autosave activity indicator
 * - Restore failure messaging with retry/clear options
 * - Success/error toast notifications
 *
 * See docs/runtime-react-worker-bridge-design.md §14.1 and issue #272.
 */
export function PersistencePanel({
  bridge,
  onSave,
  onLoad,
  onClear,
  toastTimeoutMs = DEFAULT_TOAST_TIMEOUT_MS,
  autosaveStatus,
}: PersistencePanelProps): JSX.Element {
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [toasts, setToasts] = useState<PersistenceToast[]>([]);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  // Track timeout IDs to clean them up on unmount or manual dismissal
  const timeoutIdsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const addToast = useCallback((toast: Omit<PersistenceToast, 'id'>) => {
    const id = `toast-${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { ...toast, id }]);

    // Auto-dismiss success and info toasts after timeout.
    // Error toasts persist until manually dismissed for accessibility.
    if (toast.type !== 'error') {
      const timeoutId = setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
        timeoutIdsRef.current.delete(id);
      }, toastTimeoutMs);

      timeoutIdsRef.current.set(id, timeoutId);
    }
  }, [toastTimeoutMs]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));

    // Clear timeout if exists
    const timeoutId = timeoutIdsRef.current.get(id);
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
      timeoutIdsRef.current.delete(id);
    }
  }, []);

  const handleManualSave = useCallback(async () => {
    if (isSaving) {
      return;
    }

    recordTelemetryEvent('PersistenceUIManualSaveClicked', {});

    setIsSaving(true);
    try {
      await bridge.awaitReady();
      const snapshot = await bridge.requestSessionSnapshot('manual_save');

      if (onSave) {
        await onSave(snapshot);
      }

      setLastSaved(new Date());
      addToast({
        type: 'success',
        message: 'Game saved successfully',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const details = error instanceof SessionPersistenceError ? error.code : undefined;

      addToast({
        type: 'error',
        message: 'Failed to save game',
        details: details || message,
      });

      // eslint-disable-next-line no-console
      console.error('[PersistencePanel] Save failed', error);
    } finally {
      setIsSaving(false);
    }
  }, [bridge, isSaving, onSave, addToast]);

  const handleLoad = useCallback(async () => {
    if (isLoading) {
      return;
    }

    recordTelemetryEvent('PersistenceUIManualLoadClicked', {});

    setIsLoading(true);
    setRestoreError(null);

    try {
      if (onLoad) {
        await onLoad();
      }

      addToast({
        type: 'success',
        message: 'Game loaded successfully',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      setRestoreError(message);

      addToast({
        type: 'error',
        message: 'Failed to load game',
        details: message,
      });

      // eslint-disable-next-line no-console
      console.error('[PersistencePanel] Load failed', error);
    } finally {
      setIsLoading(false);
    }
  }, [isLoading, onLoad, addToast]);

  const handleClear = useCallback(async () => {
    recordTelemetryEvent('PersistenceUIClearDataClicked', {});

    if (!window.confirm('Are you sure you want to clear all saved data? This cannot be undone.')) {
      recordTelemetryEvent('PersistenceUIClearDataCancelled', {});
      return;
    }

    recordTelemetryEvent('PersistenceUIClearDataConfirmed', {});

    try {
      if (onClear) {
        await onClear();
      }

      setLastSaved(null);
      setRestoreError(null);

      addToast({
        type: 'info',
        message: 'Saved data cleared',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';

      addToast({
        type: 'error',
        message: 'Failed to clear saved data',
        details: message,
      });

      // eslint-disable-next-line no-console
      console.error('[PersistencePanel] Clear failed', error);
    }
  }, [onClear, addToast]);

  const handleRetryRestore = useCallback(() => {
    recordTelemetryEvent('PersistenceUIRestoreRetried', {});
    setRestoreError(null);
    void handleLoad();
  }, [handleLoad]);

  // Listen for worker bridge errors
  useEffect(() => {
    const handleError = (error: { code: string; message: string }) => {
      if (error.code === 'RESTORE_FAILED') {
        setRestoreError(error.message);
        addToast({
          type: 'error',
          message: 'Session restore failed',
          details: error.message,
        });
      }
    };

    bridge.onError(handleError);
    return () => {
      bridge.offError(handleError);
    };
  }, [bridge, addToast]);

  // Clean up all pending toast timeouts on unmount
  useEffect(() => {
    return () => {
      timeoutIdsRef.current.forEach((timeoutId) => {
        clearTimeout(timeoutId);
      });
      timeoutIdsRef.current.clear();
    };
  }, []);

  return (
    <section
      aria-labelledby="persistence-panel-heading"
      style={{
        border: '1px solid #ccc',
        borderRadius: 4,
        padding: 16,
        marginTop: 24,
      }}
    >
      <h2 id="persistence-panel-heading" style={{ marginTop: 0 }}>
        Save / Load
      </h2>

      {restoreError && (
        <div
          role="alert"
          aria-live="assertive"
          style={{
            backgroundColor: '#fee',
            border: '1px solid #c33',
            borderRadius: 4,
            padding: 12,
            marginBottom: 16,
          }}
        >
          <strong>Restore Error:</strong> {restoreError}
          <div style={{ marginTop: 8 }}>
            <button
              onClick={handleRetryRestore}
              type="button"
              style={{ marginRight: 8 }}
            >
              Retry
            </button>
            <button onClick={handleClear} type="button">
              Clear Data
            </button>
          </div>
        </div>
      )}

      <div style={{ marginBottom: 16 }}>
        <button
          onClick={handleManualSave}
          disabled={isSaving}
          type="button"
          aria-label="Save game manually"
          style={{ marginRight: 8 }}
        >
          {isSaving ? 'Saving...' : 'Save Now'}
        </button>

        <button
          onClick={handleLoad}
          disabled={isLoading}
          type="button"
          aria-label="Load saved game"
          style={{ marginRight: 8 }}
        >
          {isLoading ? 'Loading...' : 'Load Game'}
        </button>

        <button
          onClick={handleClear}
          type="button"
          aria-label="Clear all saved data"
        >
          Clear Data
        </button>
      </div>

      {lastSaved && (
        <p style={{ fontSize: 14, color: '#666', margin: '8px 0 0 0' }}>
          <strong>Last manual save:</strong>{' '}
          <time dateTime={lastSaved.toISOString()}>
            {lastSaved.toLocaleString()}
          </time>
        </p>
      )}

      {autosaveStatus && (
        <div style={{ fontSize: 14, color: '#666', marginTop: 8 }}>
          <p style={{ margin: 0 }}>
            <strong>Autosave:</strong>{' '}
            {autosaveStatus.isActive ? (
              <span>
                {autosaveStatus.isSaving ? (
                  <span style={{ color: '#2563eb' }}>
                    Saving...{' '}
                    <span
                      aria-label="Autosave in progress"
                      style={{ display: 'inline-block', animation: 'pulse 1.5s ease-in-out infinite' }}
                    >
                      ●
                    </span>
                  </span>
                ) : (
                  <span style={{ color: '#059669' }}>Active</span>
                )}
                {' '}(every {Math.round(autosaveStatus.intervalMs / 1000)}s)
              </span>
            ) : (
              <span style={{ color: '#6b7280' }}>Idle</span>
            )}
          </p>
          {autosaveStatus.lastSaveTimestamp && (
            <p style={{ margin: '4px 0 0 0', fontSize: 13 }}>
              Last autosave:{' '}
              <time dateTime={new Date(autosaveStatus.lastSaveTimestamp).toISOString()}>
                {new Date(autosaveStatus.lastSaveTimestamp).toLocaleString()}
              </time>
            </p>
          )}
        </div>
      )}

      {isSaving && (
        <div
          role="status"
          aria-live="polite"
          style={{ fontSize: 14, color: '#666', marginTop: 8 }}
        >
          Manual save in progress...
        </div>
      )}

      {toasts.length > 0 && (
        <div
          aria-live="polite"
          aria-atomic="true"
          style={{
            position: 'fixed',
            bottom: 16,
            right: 16,
            zIndex: 1000,
          }}
        >
          {toasts.map((toast) => (
            <div
              key={toast.id}
              role="alert"
              style={{
                backgroundColor:
                  toast.type === 'error'
                    ? '#fee'
                    : toast.type === 'success'
                      ? '#efe'
                      : '#eef',
                border: `1px solid ${
                  toast.type === 'error'
                    ? '#c33'
                    : toast.type === 'success'
                      ? '#3c3'
                      : '#33c'
                }`,
                borderRadius: 4,
                padding: 12,
                marginBottom: 8,
                minWidth: 250,
                boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                <div>
                  <strong>{toast.message}</strong>
                  {toast.details && (
                    <div style={{ fontSize: 12, marginTop: 4 }}>
                      {toast.details}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => dismissToast(toast.id)}
                  type="button"
                  aria-label="Dismiss notification"
                  style={{
                    background: 'none',
                    border: 'none',
                    fontSize: 16,
                    cursor: 'pointer',
                    padding: 0,
                    marginLeft: 8,
                  }}
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
