import type { WorkerBridge, SessionSnapshotPayload } from './worker-bridge.js';
import type {
  SessionPersistenceAdapter,
  StoredSessionSnapshot,
} from './session-persistence-adapter.js';
import { PERSISTENCE_SCHEMA_VERSION } from './session-persistence-adapter.js';
import { recordTelemetryError, recordTelemetryEvent } from './telemetry-utils.js';

/**
 * Default autosave interval: 60 seconds.
 */
const DEFAULT_AUTOSAVE_INTERVAL_MS = 60 * 1000;

/**
 * Minimum time between autosaves to prevent excessive I/O.
 */
const MIN_AUTOSAVE_INTERVAL_MS = 5 * 1000;

/**
 * Default slot ID for single-save-slot configuration.
 */
export const DEFAULT_SLOT_ID = 'default';

/**
 * Autosave status information.
 */
export interface AutosaveStatus {
  readonly isActive: boolean;
  readonly isSaving: boolean;
  readonly lastSaveTimestamp: number | null;
  readonly intervalMs: number;
}

/**
 * Autosave controller options.
 */
export interface AutosaveControllerOptions {
  readonly intervalMs?: number;
  readonly slotId?: string;
  readonly enableBeforeUnload?: boolean;
  readonly onStatusChange?: (status: AutosaveStatus) => void;
}

/**
 * Autosave controller managing periodic session snapshot persistence.
 *
 * Responsibilities:
 * - Schedule periodic autosaves at configured interval
 * - Throttle saves during high back-pressure or restore windows
 * - Trigger saves on beforeunload for clean shutdown
 * - Emit telemetry events for save success/failure
 *
 * See docs/runtime-react-worker-bridge-design.md §14.1 for architecture.
 */
export class AutosaveController {
  private readonly bridge: WorkerBridge;
  private readonly adapter: SessionPersistenceAdapter;
  private readonly intervalMs: number;
  private readonly slotId: string;
  private readonly enableBeforeUnload: boolean;
  private readonly onStatusChange?: (status: AutosaveStatus) => void;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private lastSaveTimestamp: number | null = null;
  private saveInProgress = false;
  private isActive = false;
  private isPaused = false;

  constructor(
    bridge: WorkerBridge,
    adapter: SessionPersistenceAdapter,
    options: AutosaveControllerOptions = {},
  ) {
    this.bridge = bridge;
    this.adapter = adapter;
    this.intervalMs = Math.max(
      options.intervalMs ?? DEFAULT_AUTOSAVE_INTERVAL_MS,
      MIN_AUTOSAVE_INTERVAL_MS,
    );
    this.slotId = options.slotId ?? DEFAULT_SLOT_ID;
    this.enableBeforeUnload = options.enableBeforeUnload ?? true;
    this.onStatusChange = options.onStatusChange;
  }

  /**
   * Starts the autosave loop and registers beforeunload handler.
   */
  start(): void {
    if (this.isActive) {
      return;
    }

    this.isActive = true;

    // Schedule periodic autosaves
    this.intervalHandle = setInterval(() => {
      void this.saveIfReady('periodic');
    }, this.intervalMs);

    // Register beforeunload handler for clean shutdown saves
    if (this.enableBeforeUnload && typeof window !== 'undefined') {
      window.addEventListener('beforeunload', this.handleBeforeUnload);
    }

    // Notify listeners of status change
    this.notifyStatusChange();
  }

  /**
   * Stops the autosave loop and unregisters beforeunload handler.
   */
  stop(): void {
    if (!this.isActive) {
      return;
    }

    this.isActive = false;

    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }

    if (this.enableBeforeUnload && typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', this.handleBeforeUnload);
    }

    // Notify listeners of status change
    this.notifyStatusChange();
  }

  /**
   * Pauses autosaves temporarily without stopping the timer.
   * Used during restore operations to prevent race conditions.
   */
  pause(): void {
    this.isPaused = true;
    this.notifyStatusChange();
  }

  /**
   * Resumes autosaves after being paused.
   */
  resume(): void {
    this.isPaused = false;
    this.notifyStatusChange();
  }

  /**
   * Manually triggers a save with an optional reason.
   * Respects throttling and back-pressure constraints.
   */
  async save(reason: string = 'manual'): Promise<void> {
    return this.saveIfReady(reason, true);
  }

  /**
   * Saves a snapshot if conditions are met (not in progress, not paused, throttle elapsed).
   */
  private async saveIfReady(
    reason: string,
    force: boolean = false,
  ): Promise<void> {
    // Skip if save already in progress
    if (this.saveInProgress) {
      return;
    }

    // Skip if paused (e.g., during restore operations)
    if (this.isPaused) {
      return;
    }

    // Throttle saves unless forced
    if (!force) {
      const elapsed = this.lastSaveTimestamp !== null ? Date.now() - this.lastSaveTimestamp : Infinity;
      if (elapsed < MIN_AUTOSAVE_INTERVAL_MS) {
        return;
      }
    }

    this.saveInProgress = true;
    this.notifyStatusChange();

    try {
      // Request snapshot from worker
      const snapshot = await this.bridge.requestSessionSnapshot(reason);

      // Convert to stored format
      const stored = this.convertToStoredSnapshot(snapshot);

      // Persist to IndexedDB
      await this.adapter.save(stored);

      this.lastSaveTimestamp = Date.now();

      recordTelemetryEvent('PersistenceSaveSucceeded', {
        reason,
        slotId: this.slotId,
        workerStep: snapshot.workerStep,
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[AutosaveController] Save failed', { reason, error });

      recordTelemetryError('PersistenceSaveFailed', {
        reason,
        slotId: this.slotId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.saveInProgress = false;
      this.notifyStatusChange();
    }
  }

  /**
   * Converts worker snapshot payload to stored format.
   */
  private convertToStoredSnapshot(
    snapshot: SessionSnapshotPayload,
  ): StoredSessionSnapshot {
    return {
      schemaVersion: PERSISTENCE_SCHEMA_VERSION,
      slotId: this.slotId,
      capturedAt: snapshot.capturedAt,
      workerStep: snapshot.workerStep,
      monotonicMs: snapshot.monotonicMs,
      state: snapshot.state,
      commandQueue: snapshot.commandQueue,
      runtimeVersion: snapshot.runtimeVersion,
      contentDigest: snapshot.contentDigest,
      // TODO: Populate contentPacks field when worker supplies content pack metadata
      // This will enable multi-pack migration tracking (planned for future runtime enhancement)
      flags: snapshot.flags,
    };
  }

  /**
   * Handles beforeunload event for clean shutdown saves.
   * Note: This is best-effort; async operations may not complete before unload.
   */
  private readonly handleBeforeUnload = (_event: BeforeUnloadEvent): void => {
    // Trigger save attempt (async, may not complete before unload)
    void this.saveIfReady('beforeunload', true);

    // Note: We intentionally do NOT call preventDefault() or set returnValue,
    // as we want silent saves without blocking/prompting the user
  };

  /**
   * Returns whether autosave is currently active.
   */
  isRunning(): boolean {
    return this.isActive;
  }

  /**
   * Returns the configured autosave interval in milliseconds.
   */
  getIntervalMs(): number {
    return this.intervalMs;
  }

  /**
   * Returns whether a save operation is currently in progress.
   */
  isSaving(): boolean {
    return this.saveInProgress;
  }

  /**
   * Returns the timestamp of the last successful save, or null if no save has occurred.
   */
  getLastSaveTimestamp(): number | null {
    return this.lastSaveTimestamp;
  }

  /**
   * Returns the current autosave status.
   */
  getStatus(): AutosaveStatus {
    return {
      isActive: this.isActive,
      isSaving: this.saveInProgress,
      lastSaveTimestamp: this.lastSaveTimestamp,
      intervalMs: this.intervalMs,
    };
  }

  /**
   * Notifies listeners of status changes.
   */
  private notifyStatusChange(): void {
    this.onStatusChange?.(this.getStatus());
  }
}
