import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionSnapshotPayload } from './worker-bridge.js';
import type { WorkerBridge } from './worker-bridge.js';
import { SessionPersistenceError } from './session-persistence-adapter.js';
import { recordTelemetryEvent } from './telemetry-utils.js';
import type { AutosaveStatus } from './autosave-controller.js';
import styles from './PersistencePanel.module.css';

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

  // Determine if any error toasts are present for accessibility
  const hasErrorToast = toasts.some((toast) => toast.type === 'error');

  return (
    <section
      aria-labelledby="persistence-panel-heading"
      className={styles.panel}
    >
      <h2 id="persistence-panel-heading" className={styles.heading}>
        Save / Load
      </h2>

      {restoreError && (
        <div
          role="alert"
          aria-live="assertive"
          className={styles.restoreError}
        >
          <strong>Restore Error:</strong> {restoreError}
          <div className={styles.restoreErrorActions}>
            <button
              onClick={handleRetryRestore}
              type="button"
              className={styles.retryButton}
            >
              Retry
            </button>
            <button onClick={handleClear} type="button">
              Clear Data
            </button>
          </div>
        </div>
      )}

      <div className={styles.actions}>
        <button
          onClick={handleManualSave}
          disabled={isSaving}
          type="button"
          aria-label="Save game manually"
          className={styles.actionButton}
        >
          {isSaving ? 'Saving...' : 'Save Now'}
        </button>

        <button
          onClick={handleLoad}
          disabled={isLoading}
          type="button"
          aria-label="Load saved game"
          className={styles.actionButton}
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
        <p className={styles.lastSaved}>
          <strong>Last manual save:</strong>{' '}
          <time dateTime={lastSaved.toISOString()}>
            {lastSaved.toLocaleString()}
          </time>
        </p>
      )}

      {autosaveStatus && (
        <div className={styles.autosaveStatus}>
          <p className={styles.autosaveStatusText}>
            <strong>Autosave:</strong>{' '}
            {autosaveStatus.isActive ? (
              <span>
                {autosaveStatus.isSaving ? (
                  <span className={styles.autosaveSaving}>
                    Saving...{' '}
                    <span
                      aria-label="Autosave in progress"
                      className={styles.autosaveIndicator}
                    >
                      ●
                    </span>
                  </span>
                ) : (
                  <span className={styles.autosaveActive}>Active</span>
                )}
                {' '}(every {Math.round(autosaveStatus.intervalMs / 1000)}s)
              </span>
            ) : (
              <span className={styles.autosaveIdle}>Idle</span>
            )}
          </p>
          {autosaveStatus.lastSaveTimestamp && (
            <p className={styles.autosaveLastSave}>
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
          className={styles.savingProgress}
        >
          Manual save in progress...
        </div>
      )}

      {toasts.length > 0 && (
        <div
          aria-live={hasErrorToast ? 'assertive' : 'polite'}
          aria-atomic="true"
          className={styles.toastContainer}
        >
          {toasts.map((toast) => {
            const toastClass =
              toast.type === 'error' ? styles.toastError :
              toast.type === 'success' ? styles.toastSuccess :
              styles.toastInfo;

            return (
              <div
                key={toast.id}
                role="alert"
                className={`${styles.toast} ${toastClass}`}
              >
                <div className={styles.toastContent}>
                  <div>
                    <strong>{toast.message}</strong>
                    {toast.details && (
                      <div className={styles.toastDetails}>
                        {toast.details}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => dismissToast(toast.id)}
                    type="button"
                    aria-label="Dismiss notification"
                    className={styles.toastDismissButton}
                  >
                    ×
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
