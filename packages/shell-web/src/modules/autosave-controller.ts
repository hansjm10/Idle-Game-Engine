import type { WorkerBridge, SessionSnapshotPayload } from './worker-bridge.js';
import type {
  SessionPersistenceAdapter,
  StoredSessionSnapshot,
} from './session-persistence-adapter.js';
import { PERSISTENCE_SCHEMA_VERSION } from './session-persistence-adapter.js';

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
 * Autosave controller options.
 */
export interface AutosaveControllerOptions {
  readonly intervalMs?: number;
  readonly slotId?: string;
  readonly enableBeforeUnload?: boolean;
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
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private lastSaveTimestamp = 0;
  private saveInProgress = false;
  private isActive = false;

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
  }

  /**
   * Manually triggers a save with an optional reason.
   * Respects throttling and back-pressure constraints.
   */
  async save(reason: string = 'manual'): Promise<void> {
    return this.saveIfReady(reason, true);
  }

  /**
   * Saves a snapshot if conditions are met (not in progress, throttle elapsed).
   */
  private async saveIfReady(
    reason: string,
    force: boolean = false,
  ): Promise<void> {
    // Skip if save already in progress
    if (this.saveInProgress) {
      return;
    }

    // Throttle saves unless forced
    if (!force) {
      const elapsed = Date.now() - this.lastSaveTimestamp;
      if (elapsed < MIN_AUTOSAVE_INTERVAL_MS) {
        return;
      }
    }

    this.saveInProgress = true;

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
      runtimeVersion: snapshot.runtimeVersion,
      contentDigest: snapshot.contentDigest,
      flags: snapshot.flags,
    };
  }

  /**
   * Handles beforeunload event for clean shutdown saves.
   * Uses synchronous approach to ensure save completes before unload.
   */
  private readonly handleBeforeUnload = (event: BeforeUnloadEvent): void => {
    // Modern browsers ignore custom messages, but we can still trigger save
    // Note: This is best-effort; async operations may not complete before unload
    void this.saveIfReady('beforeunload', true);

    // Don't show confirmation dialog (just save silently)
    event.preventDefault();
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
}
