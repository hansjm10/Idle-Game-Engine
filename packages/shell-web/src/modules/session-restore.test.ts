import { describe, it, expect, beforeEach, vi } from 'vitest';

import type { ResourceDefinition } from '@idle-engine/core';

import type { WorkerBridge } from './worker-bridge.js';
import type {
  SessionPersistenceAdapter,
  StoredSessionSnapshot,
} from './session-persistence-adapter.js';
import { restoreSession, validateSnapshot } from './session-restore.js';
import { createDefinitionDigest } from '@idle-engine/core';

describe('session-restore', () => {
  let mockBridge: WorkerBridge;
  let mockAdapter: SessionPersistenceAdapter;

  const createMockDefinitions = (): ResourceDefinition[] => [
    {
      id: 'resource1',
      name: 'Resource 1',
      initialAmount: 0,
      capacity: 1000,
      unlocked: true,
      visible: true,
    },
    {
      id: 'resource2',
      name: 'Resource 2',
      initialAmount: 0,
      capacity: 2000,
      unlocked: false,
      visible: false,
    },
  ];

  const createMockSnapshot = (
    overrides?: Partial<StoredSessionSnapshot>,
  ): StoredSessionSnapshot => {
    const baseIds = overrides?.state && 'ids' in overrides.state
      ? (overrides.state as any).ids as string[]
      : ['resource1', 'resource2'];
    const digest = createDefinitionDigest(baseIds);

    const snapshot: StoredSessionSnapshot = {
      schemaVersion: 1,
      slotId: 'default',
      capturedAt: new Date(Date.now() - 10000).toISOString(), // 10 seconds ago
      workerStep: 1000,
      monotonicMs: 5000,
      state: {
        ids: baseIds,
        amounts: baseIds.map((_, i) => (i + 1) * 100),
        capacities: baseIds.map((_, i) => (i + 1) * 1000),
        unlocked: baseIds.map((_, i) => i % 2 === 0),
        visible: baseIds.map((_, i) => i % 2 === 0),
        flags: baseIds.map((_, i) => (i % 2 === 0 ? 1 : 0)),
        definitionDigest: digest,
      },
      runtimeVersion: '0.1.0',
      contentDigest: digest,
      ...overrides,
    };

    return snapshot;
  };

  beforeEach(() => {
    // Mock WorkerBridge
    mockBridge = {
      restoreSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as WorkerBridge;

    // Mock SessionPersistenceAdapter
    mockAdapter = {
      load: vi.fn().mockResolvedValue(createMockSnapshot()),
      computeOfflineElapsedMs: vi.fn().mockReturnValue(10000),
    } as unknown as SessionPersistenceAdapter;
  });

  describe('restoreSession', () => {
    it('should successfully restore a valid snapshot', async () => {
      const definitions = createMockDefinitions();
      const result = await restoreSession(mockBridge, mockAdapter, {
        slotId: 'default',
        definitions,
      });

      expect(result.success).toBe(true);
      expect(result.validationStatus).toBe('valid');
      expect(result.snapshot).toBeDefined();
      expect(result.elapsedMs).toBe(10000);
      expect(mockBridge.restoreSession).toHaveBeenCalledWith({
        state: expect.any(Object),
        elapsedMs: 10000,
      });
    });

    it('should return success with no snapshot for fresh start', async () => {
      mockAdapter.load = vi.fn().mockResolvedValue(null);

      const definitions = createMockDefinitions();
      const result = await restoreSession(mockBridge, mockAdapter, {
        slotId: 'default',
        definitions,
      });

      expect(result.success).toBe(true);
      expect(result.snapshot).toBeUndefined();
      expect(mockBridge.restoreSession).not.toHaveBeenCalled();
    });

    it('should fail when snapshot validation fails', async () => {
      // Create snapshot with mismatched resource IDs
      const invalidSnapshot = createMockSnapshot({
        state: {
          ids: ['resource1', 'resource_invalid'],
          amounts: [100, 200],
          capacities: [1000, 2000],
          unlocked: [true, false],
          visible: [true, false],
          flags: [1, 0],
          definitionDigest: {
            version: 1,
            contentHash: 'test-hash',
            definitionCount: 2,
          },
        },
      });

      mockAdapter.load = vi.fn().mockResolvedValue(invalidSnapshot);

      const definitions = createMockDefinitions();
      const result = await restoreSession(mockBridge, mockAdapter, {
        slotId: 'default',
        definitions,
      });

      expect(result.success).toBe(false);
      expect(result.validationStatus).toBe('invalid');
      expect(result.error).toBeDefined();
      expect(mockBridge.restoreSession).not.toHaveBeenCalled();
    });

    it('should handle migration-required scenarios', async () => {
      const snapshotWithMigrationFlag = createMockSnapshot({
        flags: {
          pendingMigration: true,
        },
        state: {
          ids: ['resource1', 'resource_invalid'],
          amounts: [100, 200],
          capacities: [1000, 2000],
          unlocked: [true, false],
          visible: [true, false],
          flags: [1, 0],
          definitionDigest: {
            version: 1,
            contentHash: 'old-hash',
            definitionCount: 2,
          },
        },
      });

      mockAdapter.load = vi.fn().mockResolvedValue(snapshotWithMigrationFlag);

      const definitions = createMockDefinitions();
      const result = await restoreSession(mockBridge, mockAdapter, {
        slotId: 'default',
        definitions,
        allowMigration: true,
      });

      expect(result.success).toBe(false);
      expect(result.validationStatus).toBe('invalid');
      expect(result.error?.message).toContain('migration');
    });

    it('should respect allowMigration flag', async () => {
      const snapshotWithMigrationFlag = createMockSnapshot({
        flags: {
          pendingMigration: true,
        },
        state: {
          ids: ['resource1', 'resource_invalid'],
          amounts: [100, 200],
          capacities: [1000, 2000],
          unlocked: [true, false],
          visible: [true, false],
          flags: [1, 0],
          definitionDigest: {
            version: 1,
            contentHash: 'old-hash',
            definitionCount: 2,
          },
        },
      });

      mockAdapter.load = vi.fn().mockResolvedValue(snapshotWithMigrationFlag);

      const definitions = createMockDefinitions();
      const result = await restoreSession(mockBridge, mockAdapter, {
        slotId: 'default',
        definitions,
        allowMigration: false,
      });

      expect(result.success).toBe(false);
      expect(result.validationStatus).toBe('invalid');
      // Should not mention migration since it's disabled
      expect(result.error?.message).not.toContain('migration');
    });

    it('should handle adapter load errors', async () => {
      mockAdapter.load = vi
        .fn()
        .mockRejectedValue(new Error('Storage error'));

      const definitions = createMockDefinitions();
      const result = await restoreSession(mockBridge, mockAdapter, {
        slotId: 'default',
        definitions,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('Storage error');
    });

    it('should handle bridge restore errors', async () => {
      mockBridge.restoreSession = vi
        .fn()
        .mockRejectedValue(new Error('Restore failed'));

      const definitions = createMockDefinitions();
      const result = await restoreSession(mockBridge, mockAdapter, {
        slotId: 'default',
        definitions,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('validateSnapshot', () => {
    it('should validate a correct snapshot', () => {
      const snapshot = createMockSnapshot();
      const definitions = createMockDefinitions();

      const result = validateSnapshot(snapshot, definitions);

      expect(result.compatible).toBe(true);
      expect(result.digestsMatch).toBe(true);
      expect(result.removedIds).toHaveLength(0);
    });

    it('should detect mismatched resource IDs', () => {
      const snapshot = createMockSnapshot({
        state: {
          ids: ['resource1', 'resource_invalid'],
          amounts: [100, 200],
          capacities: [1000, 2000],
          unlocked: [true, false],
          visible: [true, false],
          flags: [1, 0],
          definitionDigest: {
            version: 1,
            contentHash: 'test-hash',
            definitionCount: 2,
          },
        },
      });

      const definitions = createMockDefinitions();

      const result = validateSnapshot(snapshot, definitions);

      expect(result.compatible).toBe(false);
    });

    it('should detect length mismatches', () => {
      const snapshot = createMockSnapshot({
        state: {
          ids: ['resource1'], // Only 1 resource instead of 2
          amounts: [100],
          capacities: [1000],
          unlocked: [true],
          visible: [true],
          flags: [1],
          definitionDigest: {
            version: 1,
            contentHash: 'test-hash',
            definitionCount: 1,
          },
        },
      });

      const definitions = createMockDefinitions(); // Expects 2 resources

      const result = validateSnapshot(snapshot, definitions);

      expect(result.compatible).toBe(false);
    });

    it('should accept extra resources gracefully', () => {
      const snapshot = createMockSnapshot({
        state: {
          ids: ['resource1', 'resource2', 'resource3'], // Extra resource
          amounts: [100, 200, 300],
          capacities: [1000, 2000, 3000],
          unlocked: [true, false, true],
          visible: [true, false, true],
          flags: [1, 0, 1],
          definitionDigest: {
            version: 1,
            contentHash: 'test-hash',
            definitionCount: 3,
          },
        },
      });

      const definitions = createMockDefinitions(); // Only defines 2 resources

      const result = validateSnapshot(snapshot, definitions);

      // Should be incompatible because definition count doesn't match
      expect(result.compatible).toBe(false);
    });
  });
});
