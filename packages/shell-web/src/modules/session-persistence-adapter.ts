import type {
  SerializedResourceState,
  ResourceDefinitionDigest,
} from '@idle-engine/core';
import { recordTelemetryError } from './telemetry-utils.js';

/**
 * Persistence schema version for stored session snapshots.
 * Increment when the payload structure changes in backwards-incompatible ways.
 */
export const PERSISTENCE_SCHEMA_VERSION = 1;

/**
 * Default offline progression cap: 24 hours in milliseconds.
 * Prevents runaway offline gains after extended absence.
 */
export const DEFAULT_OFFLINE_CAP_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * IndexedDB database name for session persistence.
 */
const DB_NAME = 'idle-engine.sessions';

/**
 * Current database schema version for IndexedDB migrations.
 */
const DB_SCHEMA_VERSION = 1;

/**
 * Object store name for session snapshots.
 */
const STORE_NAME = 'sessions';

/**
 * Maximum number of snapshots to retain per slot to prevent quota exhaustion.
 */
const MAX_SNAPSHOTS_PER_SLOT = 5;

/**
 * Content pack manifest embedded in save files for migration tracking.
 * Captures pack identity, version, and content digest at save time.
 */
export interface ContentPackManifest {
  /**
   * Content pack identifier (slug).
   */
  readonly id: string;

  /**
   * Semantic version of the content pack.
   */
  readonly version: string;

  /**
   * Content digest capturing resource definitions at save time.
   */
  readonly digest: ResourceDefinitionDigest;
}

/**
 * Stored session snapshot payload matching the schema from
 * docs/runtime-react-worker-bridge-design.md §14.1.
 *
 * Extended to include content pack manifests for migration support (Issue #155).
 */
export interface StoredSessionSnapshot {
  readonly schemaVersion: number;
  readonly slotId: string;
  readonly capturedAt: string; // ISO timestamp
  readonly workerStep: number;
  readonly monotonicMs: number;
  readonly state: SerializedResourceState;
  readonly runtimeVersion: string;
  readonly contentDigest: ResourceDefinitionDigest;
  /**
   * Content pack manifests for migration tracking.
   * Each entry captures the pack's identity, version, and digest at save time.
   * Used to detect content changes and trigger migrations on load.
   *
   * @remarks
   * Reserved for future use. The worker does not yet supply content pack metadata,
   * so this field will be undefined in current snapshots. Planned for implementation
   * when multi-pack support is added to the runtime.
   *
   * @since schemaVersion 1 (Issue #155)
   */
  readonly contentPacks?: readonly ContentPackManifest[];
  readonly flags?: {
    readonly pendingMigration?: boolean;
    readonly abortedRestore?: boolean;
  };
  readonly checksum?: string; // SHA-256 hex digest
}

/**
 * Key structure for IndexedDB entries.
 * Format: `{slotId}:{timestamp}` for natural ordering.
 */
interface SessionKey {
  readonly slotId: string;
  readonly timestamp: number;
}

function encodeKey(slotId: string, timestamp: number): string {
  return `${slotId}:${timestamp}`;
}

function decodeKey(key: string): SessionKey | null {
  // Split on last colon to handle slotIds that contain colons
  const lastColonIndex = key.lastIndexOf(':');
  if (lastColonIndex === -1) {
    return null;
  }
  const slotId = key.slice(0, lastColonIndex);
  const timestampStr = key.slice(lastColonIndex + 1);
  const timestamp = Number.parseInt(timestampStr, 10);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return { slotId, timestamp };
}

/**
 * Computes SHA-256 checksum of the serialized snapshot for corruption detection.
 */
async function computeChecksum(snapshot: StoredSessionSnapshot): Promise<string> {
  // Exclude checksum field from hash computation
  const { checksum: _checksum, ...payload } = snapshot;
  const json = JSON.stringify(payload);
  const encoder = new TextEncoder();
  const data = encoder.encode(json);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Verifies the checksum of a stored snapshot.
 * Returns true if valid or if no checksum is present (legacy snapshots).
 */
async function verifyChecksum(snapshot: StoredSessionSnapshot): Promise<boolean> {
  if (!snapshot.checksum) {
    // Legacy snapshots without checksums are considered valid
    return true;
  }
  const expectedChecksum = await computeChecksum(snapshot);
  return expectedChecksum === snapshot.checksum;
}

/**
 * Error thrown when persistence operations fail.
 */
export class SessionPersistenceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SessionPersistenceError';
  }
}

/**
 * Session persistence adapter managing IndexedDB storage for worker snapshots.
 *
 * Responsibilities:
 * - IndexedDB schema management and migrations
 * - Save/load/delete operations with checksum validation
 * - Quota management (trim old snapshots)
 * - Offline elapsed time computation
 *
 * See docs/runtime-react-worker-bridge-design.md §14.1 for architecture.
 */
export class SessionPersistenceAdapter {
  private db: IDBDatabase | null = null;
  private readonly offlineCapMs: number;
  private closed = false;

  constructor(options: { offlineCapMs?: number } = {}) {
    this.offlineCapMs = options.offlineCapMs ?? DEFAULT_OFFLINE_CAP_MS;
  }

  /**
   * Opens the IndexedDB database, creating it if necessary.
   * Handles schema migrations via the onupgradeneeded event.
   */
  async open(): Promise<void> {
    if (this.closed) {
      throw new SessionPersistenceError(
        'Adapter has been closed and cannot be reopened',
        'DB_CLOSED',
      );
    }

    if (this.db) {
      return;
    }

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_SCHEMA_VERSION);

      request.onerror = () => {
        reject(
          new SessionPersistenceError(
            'Failed to open IndexedDB',
            'DB_OPEN_FAILED',
            { error: request.error?.message },
          ),
        );
      };

      request.onblocked = () => {
        // onblocked fires when database upgrade is blocked by open connections
        // from other tabs/windows. Reject with specific error for diagnostics.
        reject(
          new SessionPersistenceError(
            'IndexedDB upgrade blocked by another connection. Close other tabs and retry.',
            'DB_UPGRADE_BLOCKED',
          ),
        );
      };

      request.onsuccess = () => {
        this.db = request.result;

        // Handle unexpected close/abort events on the database connection
        this.db.onabort = () => {
          recordTelemetryError('SessionPersistenceError', {
            code: 'DB_CONNECTION_ABORTED',
            message: 'IndexedDB connection aborted unexpectedly',
          });
        };

        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Schema v1: Create sessions object store with slotId:timestamp keys
        if (event.oldVersion < 1) {
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            // Keys are formatted as `{slotId}:{timestamp}` for natural ordering
            db.createObjectStore(STORE_NAME);
          }
        }

        // Future migrations go here
        // if (event.oldVersion < 2) { ... }
      };
    });
  }

  /**
   * Closes the database connection.
   *
   * @remarks
   * This is a one-shot operation. Once closed, the adapter cannot be reopened.
   * Subsequent calls to `open()` will throw a `DB_CLOSED` error.
   * Create a new adapter instance if you need to reconnect to the database.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.closed = true;
  }

  /**
   * Saves a session snapshot to IndexedDB with checksum protection.
   * Trims old snapshots if MAX_SNAPSHOTS_PER_SLOT is exceeded.
   */
  async save(snapshot: StoredSessionSnapshot): Promise<void> {
    await this.open();
    if (!this.db) {
      throw new SessionPersistenceError(
        'Database not initialized',
        'DB_NOT_INITIALIZED',
      );
    }

    // Compute checksum for corruption detection
    const checksum = await computeChecksum(snapshot);
    const snapshotWithChecksum: StoredSessionSnapshot = {
      ...snapshot,
      checksum,
    };

    const timestamp = Date.parse(snapshot.capturedAt);
    if (!Number.isFinite(timestamp)) {
      throw new SessionPersistenceError(
        'Invalid capturedAt timestamp',
        'INVALID_TIMESTAMP',
        { capturedAt: snapshot.capturedAt },
      );
    }

    const key = encodeKey(snapshot.slotId, timestamp);

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);

      const putRequest = store.put(snapshotWithChecksum, key);

      putRequest.onerror = () => {
        reject(
          new SessionPersistenceError(
            'Failed to save snapshot',
            'SAVE_FAILED',
            { error: putRequest.error?.message, slotId: snapshot.slotId },
          ),
        );
      };

      transaction.oncomplete = async () => {
        // Trim old snapshots to prevent quota exhaustion
        try {
          await this.trimOldSnapshots(snapshot.slotId);
        } catch (error) {
          // Log but don't fail the save operation
          recordTelemetryError('PersistenceTrimSnapshotsFailed', {
            slotId: snapshot.slotId,
            error: error instanceof Error ? error.message : String(error),
          });
          // eslint-disable-next-line no-console
          console.warn('[SessionPersistence] Failed to trim old snapshots', error);
        }
        resolve();
      };

      transaction.onerror = () => {
        reject(
          new SessionPersistenceError(
            'Transaction failed during save',
            'TRANSACTION_FAILED',
            { error: transaction.error?.message },
          ),
        );
      };
    });
  }

  /**
   * Loads the latest session snapshot for the given slot.
   * Returns null if no snapshot exists.
   * Validates checksum and falls back to previous snapshot if corrupted.
   */
  async load(slotId: string): Promise<StoredSessionSnapshot | null> {
    await this.open();
    if (!this.db) {
      throw new SessionPersistenceError(
        'Database not initialized',
        'DB_NOT_INITIALIZED',
      );
    }

    const snapshots = await this.listSnapshots(slotId);
    if (snapshots.length === 0) {
      return null;
    }

    // Try snapshots from newest to oldest until we find a valid one
    for (const snapshot of snapshots) {
      const isValid = await verifyChecksum(snapshot);
      if (isValid) {
        return snapshot;
      }

      // eslint-disable-next-line no-console
      console.warn('[SessionPersistence] Checksum validation failed, trying older snapshot', {
        slotId: snapshot.slotId,
        capturedAt: snapshot.capturedAt,
      });
    }

    // All snapshots failed checksum validation
    throw new SessionPersistenceError(
      'All snapshots failed checksum validation',
      'CHECKSUM_VALIDATION_FAILED',
      { slotId, snapshotCount: snapshots.length },
    );
  }

  /**
   * Deletes a specific snapshot by slot and timestamp.
   */
  async delete(slotId: string, capturedAt: string): Promise<void> {
    await this.open();
    if (!this.db) {
      throw new SessionPersistenceError(
        'Database not initialized',
        'DB_NOT_INITIALIZED',
      );
    }

    const timestamp = Date.parse(capturedAt);
    if (!Number.isFinite(timestamp)) {
      throw new SessionPersistenceError(
        'Invalid capturedAt timestamp',
        'INVALID_TIMESTAMP',
        { capturedAt },
      );
    }

    const key = encodeKey(slotId, timestamp);

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);

      const deleteRequest = store.delete(key);

      deleteRequest.onerror = () => {
        reject(
          new SessionPersistenceError(
            'Failed to delete snapshot',
            'DELETE_FAILED',
            { error: deleteRequest.error?.message, slotId, capturedAt },
          ),
        );
      };

      transaction.oncomplete = () => {
        resolve();
      };

      transaction.onerror = () => {
        reject(
          new SessionPersistenceError(
            'Transaction failed during delete',
            'TRANSACTION_FAILED',
            { error: transaction.error?.message },
          ),
        );
      };
    });
  }

  /**
   * Deletes all snapshots for a given slot.
   */
  async deleteSlot(slotId: string): Promise<void> {
    await this.open();
    if (!this.db) {
      throw new SessionPersistenceError(
        'Database not initialized',
        'DB_NOT_INITIALIZED',
      );
    }

    const snapshots = await this.listSnapshots(slotId);
    for (const snapshot of snapshots) {
      await this.delete(slotId, snapshot.capturedAt);
    }
  }

  /**
   * Lists all snapshots for a given slot, ordered newest to oldest.
   */
  private async listSnapshots(slotId: string): Promise<StoredSessionSnapshot[]> {
    if (!this.db) {
      throw new SessionPersistenceError(
        'Database not initialized',
        'DB_NOT_INITIALIZED',
      );
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.openCursor();

      const snapshots: StoredSessionSnapshot[] = [];

      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          const key = cursor.key as string;
          const decoded = decodeKey(key);
          if (decoded && decoded.slotId === slotId) {
            snapshots.push(cursor.value as StoredSessionSnapshot);
          }
          cursor.continue();
        } else {
          // Sort newest to oldest
          snapshots.sort((a, b) => {
            const timestampA = Date.parse(a.capturedAt);
            const timestampB = Date.parse(b.capturedAt);
            return timestampB - timestampA;
          });
          resolve(snapshots);
        }
      };

      request.onerror = () => {
        reject(
          new SessionPersistenceError(
            'Failed to list snapshots',
            'LIST_FAILED',
            { error: request.error?.message, slotId },
          ),
        );
      };
    });
  }

  /**
   * Trims old snapshots for a slot to stay within MAX_SNAPSHOTS_PER_SLOT.
   */
  private async trimOldSnapshots(slotId: string): Promise<void> {
    const snapshots = await this.listSnapshots(slotId);
    if (snapshots.length <= MAX_SNAPSHOTS_PER_SLOT) {
      return;
    }

    // Delete oldest snapshots beyond the limit
    const snapshotsToDelete = snapshots.slice(MAX_SNAPSHOTS_PER_SLOT);
    for (const snapshot of snapshotsToDelete) {
      await this.delete(slotId, snapshot.capturedAt);
    }
  }

  /**
   * Computes offline elapsed time for restore, clamped to the configured cap.
   * Returns elapsed milliseconds since the snapshot was captured.
   */
  computeOfflineElapsedMs(snapshot: StoredSessionSnapshot): number {
    const capturedTimestamp = Date.parse(snapshot.capturedAt);
    if (!Number.isFinite(capturedTimestamp)) {
      return 0;
    }

    const now = Date.now();
    const elapsed = now - capturedTimestamp;

    // Clamp to offline cap to prevent runaway gains
    return Math.min(Math.max(0, elapsed), this.offlineCapMs);
  }
}
