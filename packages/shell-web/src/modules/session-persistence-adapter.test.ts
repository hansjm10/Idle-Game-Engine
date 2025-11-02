import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

import { createDefinitionDigest } from '@idle-engine/core';
import type { SerializedResourceState } from '@idle-engine/core';

import {
  SessionPersistenceAdapter,
  SessionPersistenceError,
  PERSISTENCE_SCHEMA_VERSION,
  DEFAULT_OFFLINE_CAP_MS,
  type StoredSessionSnapshot,
} from './session-persistence-adapter.js';

describe('SessionPersistenceAdapter', () => {
  let adapter: SessionPersistenceAdapter;

  beforeEach(() => {
    // Reset IndexedDB for each test
    globalThis.indexedDB = new IDBFactory();
    adapter = new SessionPersistenceAdapter();
  });

  afterEach(async () => {
    adapter.close();
  });

  const createMockState = (): SerializedResourceState => ({
    ids: ['resource1', 'resource2'],
    amounts: [100, 200],
    capacities: [1000, null],
    unlocked: [true, false],
    visible: [true, false],
    flags: [1, 0],
    definitionDigest: createDefinitionDigest(['resource1', 'resource2']),
  });

  const createMockSnapshot = (
    overrides?: Partial<StoredSessionSnapshot>,
  ): StoredSessionSnapshot => ({
    schemaVersion: PERSISTENCE_SCHEMA_VERSION,
    slotId: 'default',
    capturedAt: new Date().toISOString(),
    workerStep: 1000,
    monotonicMs: 5000,
    state: createMockState(),
    runtimeVersion: '0.1.0',
    contentDigest: createDefinitionDigest(['resource1', 'resource2']),
    ...overrides,
  });

  describe('open', () => {
    it('should open the database successfully', async () => {
      await expect(adapter.open()).resolves.toBeUndefined();
    });

    it('should not fail if called multiple times', async () => {
      await adapter.open();
      await expect(adapter.open()).resolves.toBeUndefined();
    });
  });

  describe('save', () => {
    it('should save a snapshot with checksum', async () => {
      const snapshot = createMockSnapshot();

      await expect(adapter.save(snapshot)).resolves.toBeUndefined();
    });

    it('should reject invalid capturedAt timestamp', async () => {
      const snapshot = createMockSnapshot({ capturedAt: 'invalid-date' });

      await expect(adapter.save(snapshot)).rejects.toThrow(
        SessionPersistenceError,
      );
      await expect(adapter.save(snapshot)).rejects.toMatchObject({
        code: 'INVALID_TIMESTAMP',
      });
    });

    it('should trim old snapshots when exceeding MAX_SNAPSHOTS_PER_SLOT', async () => {
      const slotId = 'test-slot';

      // Save 10 snapshots (limit is 5)
      for (let i = 0; i < 10; i++) {
        const snapshot = createMockSnapshot({
          slotId,
          capturedAt: new Date(Date.now() + i * 1000).toISOString(),
          workerStep: i,
        });
        await adapter.save(snapshot);
      }

      // Load should return the newest snapshot
      const loaded = await adapter.load(slotId);
      expect(loaded).not.toBeNull();
      expect(loaded?.workerStep).toBe(9);
    });
  });

  describe('load', () => {
    it('should return null for non-existent slot', async () => {
      const result = await adapter.load('non-existent-slot');
      expect(result).toBeNull();
    });

    it('should load the latest snapshot for a slot', async () => {
      const slotId = 'test-slot';
      const snapshot1 = createMockSnapshot({
        slotId,
        capturedAt: new Date(Date.now() - 10000).toISOString(),
        workerStep: 100,
      });
      const snapshot2 = createMockSnapshot({
        slotId,
        capturedAt: new Date(Date.now()).toISOString(),
        workerStep: 200,
      });

      await adapter.save(snapshot1);
      await adapter.save(snapshot2);

      const loaded = await adapter.load(slotId);
      expect(loaded).not.toBeNull();
      expect(loaded?.workerStep).toBe(200);
    });

    it('should validate checksum and fallback to older snapshot if corrupted', async () => {
      const slotId = 'test-slot';

      // Save a valid snapshot
      const validSnapshot = createMockSnapshot({
        slotId,
        capturedAt: new Date(Date.now() - 10000).toISOString(),
        workerStep: 100,
      });
      await adapter.save(validSnapshot);

      // Manually save a corrupted snapshot (invalid checksum)
      await adapter.open();
      const db = (adapter as any).db as IDBDatabase;
      const transaction = db.transaction(['sessions'], 'readwrite');
      const store = transaction.objectStore('sessions');

      const corruptedSnapshot: StoredSessionSnapshot = {
        ...createMockSnapshot({
          slotId,
          capturedAt: new Date(Date.now()).toISOString(),
          workerStep: 200,
        }),
        checksum: 'invalid-checksum',
      };

      const timestamp = Date.parse(corruptedSnapshot.capturedAt);
      const key = `${slotId}:${timestamp}`;
      store.put(corruptedSnapshot, key);

      await new Promise((resolve) => {
        transaction.oncomplete = resolve;
      });

      // Load should return the older valid snapshot
      const loaded = await adapter.load(slotId);
      expect(loaded).not.toBeNull();
      expect(loaded?.workerStep).toBe(100);
    });

    it('should throw if all snapshots fail checksum validation', async () => {
      const slotId = 'test-slot';

      // Manually save a corrupted snapshot
      await adapter.open();
      const db = (adapter as any).db as IDBDatabase;
      const transaction = db.transaction(['sessions'], 'readwrite');
      const store = transaction.objectStore('sessions');

      const corruptedSnapshot: StoredSessionSnapshot = {
        ...createMockSnapshot({
          slotId,
          capturedAt: new Date(Date.now()).toISOString(),
          workerStep: 100,
        }),
        checksum: 'invalid-checksum',
      };

      const timestamp = Date.parse(corruptedSnapshot.capturedAt);
      const key = `${slotId}:${timestamp}`;
      store.put(corruptedSnapshot, key);

      await new Promise((resolve) => {
        transaction.oncomplete = resolve;
      });

      // Load should throw checksum validation error
      await expect(adapter.load(slotId)).rejects.toThrow(
        SessionPersistenceError,
      );
      await expect(adapter.load(slotId)).rejects.toMatchObject({
        code: 'CHECKSUM_VALIDATION_FAILED',
      });
    });
  });

  describe('delete', () => {
    it('should delete a specific snapshot', async () => {
      const slotId = 'test-slot';
      const snapshot = createMockSnapshot({ slotId });

      await adapter.save(snapshot);

      const loadedBefore = await adapter.load(slotId);
      expect(loadedBefore).not.toBeNull();

      await adapter.delete(slotId, snapshot.capturedAt);

      const loadedAfter = await adapter.load(slotId);
      expect(loadedAfter).toBeNull();
    });

    it('should reject invalid capturedAt timestamp', async () => {
      await expect(
        adapter.delete('test-slot', 'invalid-date'),
      ).rejects.toThrow(SessionPersistenceError);
      await expect(
        adapter.delete('test-slot', 'invalid-date'),
      ).rejects.toMatchObject({
        code: 'INVALID_TIMESTAMP',
      });
    });
  });

  describe('deleteSlot', () => {
    it('should delete all snapshots for a slot', async () => {
      const slotId = 'test-slot';

      // Save multiple snapshots
      for (let i = 0; i < 3; i++) {
        const snapshot = createMockSnapshot({
          slotId,
          capturedAt: new Date(Date.now() + i * 1000).toISOString(),
          workerStep: i,
        });
        await adapter.save(snapshot);
      }

      const loadedBefore = await adapter.load(slotId);
      expect(loadedBefore).not.toBeNull();

      await adapter.deleteSlot(slotId);

      const loadedAfter = await adapter.load(slotId);
      expect(loadedAfter).toBeNull();
    });
  });

  describe('computeOfflineElapsedMs', () => {
    it('should compute elapsed time since capture', () => {
      const capturedTimestamp = Date.now() - 10000; // 10 seconds ago
      const snapshot = createMockSnapshot({
        capturedAt: new Date(capturedTimestamp).toISOString(),
      });

      const elapsed = adapter.computeOfflineElapsedMs(snapshot);

      // Should be approximately 10 seconds (allow some tolerance for test execution)
      expect(elapsed).toBeGreaterThan(9000);
      expect(elapsed).toBeLessThan(11000);
    });

    it('should clamp elapsed time to offline cap', () => {
      const customCapMs = 1000; // 1 second cap
      const customAdapter = new SessionPersistenceAdapter({
        offlineCapMs: customCapMs,
      });

      const capturedTimestamp = Date.now() - 10000; // 10 seconds ago
      const snapshot = createMockSnapshot({
        capturedAt: new Date(capturedTimestamp).toISOString(),
      });

      const elapsed = customAdapter.computeOfflineElapsedMs(snapshot);

      // Should be clamped to 1 second
      expect(elapsed).toBe(customCapMs);

      customAdapter.close();
    });

    it('should return 0 for invalid timestamps', () => {
      const snapshot = createMockSnapshot({
        capturedAt: 'invalid-date',
      });

      const elapsed = adapter.computeOfflineElapsedMs(snapshot);
      expect(elapsed).toBe(0);
    });

    it('should return 0 for future timestamps', () => {
      const futureTimestamp = Date.now() + 10000; // 10 seconds in future
      const snapshot = createMockSnapshot({
        capturedAt: new Date(futureTimestamp).toISOString(),
      });

      const elapsed = adapter.computeOfflineElapsedMs(snapshot);
      expect(elapsed).toBe(0);
    });

    it('should use DEFAULT_OFFLINE_CAP_MS when not specified', () => {
      const capturedTimestamp = Date.now() - (DEFAULT_OFFLINE_CAP_MS + 10000);
      const snapshot = createMockSnapshot({
        capturedAt: new Date(capturedTimestamp).toISOString(),
      });

      const elapsed = adapter.computeOfflineElapsedMs(snapshot);
      expect(elapsed).toBe(DEFAULT_OFFLINE_CAP_MS);
    });
  });

  describe('close', () => {
    it('should close the database connection', async () => {
      await adapter.open();
      adapter.close();

      // Attempting operations after close should fail
      await expect(adapter.load('test-slot')).rejects.toThrow(
        SessionPersistenceError,
      );
    });

    it('should be idempotent', async () => {
      await adapter.open();
      adapter.close();
      adapter.close(); // Should not throw
    });
  });

  describe('error handling', () => {
    it('should throw DB_NOT_INITIALIZED when operating on closed adapter', async () => {
      const closedAdapter = new SessionPersistenceAdapter();
      closedAdapter.close();

      await expect(closedAdapter.load('test')).rejects.toMatchObject({
        code: 'DB_NOT_INITIALIZED',
      });
    });
  });
});
