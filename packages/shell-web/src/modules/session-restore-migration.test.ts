import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import type {
  ResourceDefinition,
  ResourceDefinitionDigest,
} from '@idle-engine/core';
import { SessionPersistenceAdapter } from './session-persistence-adapter.js';
import type { StoredSessionSnapshot } from './session-persistence-adapter.js';
import { restoreSession, validateSaveCompatibility } from './session-restore.js';
import { registerMigration, migrationRegistry } from './migration-registry.js';
import type { WorkerBridge } from './worker-bridge.js';

describe('Session Restore with Migration', () => {
  let adapter: SessionPersistenceAdapter;
  let mockBridge: WorkerBridge;

  // Helper to compute real FNV-1a digest matching core implementation
  const computeDigest = (ids: string[]): string => {
    let hash = 0x811c9dc5;
    for (const id of ids) {
      for (let i = 0; i < id.length; i += 1) {
        hash ^= id.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
        hash >>>= 0;
      }
      hash ^= 0xff;
      hash = Math.imul(hash, 0x01000193);
      hash >>>= 0;
    }
    return `fnv1a-${hash.toString(16).padStart(8, '0')}`;
  };

  const createDigest = (ids: string[]): ResourceDefinitionDigest => ({
    hash: computeDigest(ids),
    version: ids.length,
    ids,
  });

  const createDefinitions = (ids: string[]): ResourceDefinition[] =>
    ids.map((id) => ({
      id,
      displayName: id,
      description: '',
      icon: '',
      category: 'currency' as const,
      initialAmount: 0,
      maxAmount: null,
      isPrimary: false,
      precision: 2,
      formatting: { type: 'decimal' as const },
    }));

  beforeEach(() => {
    adapter = new SessionPersistenceAdapter();
    migrationRegistry.clear();

    // Mock worker bridge
    mockBridge = {
      restoreSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as WorkerBridge;
  });

  describe('validateSaveCompatibility', () => {
    it('should report compatible when snapshot matches definitions', async () => {
      const definitions = createDefinitions(['wood', 'stone']);
      const digest = createDigest(['wood', 'stone']);

      const snapshot: StoredSessionSnapshot = {
        schemaVersion: 1,
        slotId: 'test',
        capturedAt: new Date().toISOString(),
        workerStep: 100,
        monotonicMs: 1000,
        state: {
          ids: ['wood', 'stone'],
          amounts: [10, 20],
          capacities: [null, null],
          flags: [0, 0],
        },
        runtimeVersion: '1.0.0',
        contentDigest: digest,
      };

      const result = validateSaveCompatibility(snapshot, definitions);

      expect(result.compatible).toBe(true);
      expect(result.requiresMigration).toBe(false);
      expect(result.migrationAvailable).toBe(false);
      expect(result.removedIds).toEqual([]);
      expect(result.digestsMatch).toBe(true);
    });

    it('should detect incompatibility when resources removed', async () => {
      // Snapshot has 3 resources, but current definitions only have 2
      const snapshot: StoredSessionSnapshot = {
        schemaVersion: 1,
        slotId: 'test',
        capturedAt: new Date().toISOString(),
        workerStep: 100,
        monotonicMs: 1000,
        state: {
          ids: ['wood', 'stone', 'iron'],
          amounts: [10, 20, 30],
          capacities: [null, null, null],
          flags: [0, 0, 0],
        },
        runtimeVersion: '1.0.0',
        contentDigest: createDigest(['wood', 'stone', 'iron']),
      };

      const definitions = createDefinitions(['wood', 'stone']);

      const result = validateSaveCompatibility(snapshot, definitions);

      expect(result.compatible).toBe(false);
      expect(result.requiresMigration).toBe(true);
      expect(result.removedIds.length).toBeGreaterThan(0);
    });

    it('should detect available migration', async () => {
      const oldDigest = createDigest(['wood']);
      const newDigest = createDigest(['lumber']);

      // Register migration
      registerMigration({
        id: 'wood-to-lumber',
        fromDigest: oldDigest,
        toDigest: newDigest,
        transform: (state) => ({
          ...state,
          ids: ['lumber'],
        }),
      });

      const snapshot: StoredSessionSnapshot = {
        schemaVersion: 1,
        slotId: 'test',
        capturedAt: new Date().toISOString(),
        workerStep: 100,
        monotonicMs: 1000,
        state: {
          ids: ['wood'],
          amounts: [100],
          capacities: [null],
          flags: [0],
        },
        runtimeVersion: '1.0.0',
        contentDigest: oldDigest,
      };

      const definitions = createDefinitions(['lumber']);

      const result = validateSaveCompatibility(snapshot, definitions);

      expect(result.compatible).toBe(false);
      expect(result.requiresMigration).toBe(true);
      expect(result.migrationAvailable).toBe(true);
    });

    it('should require migration when definitions add resources (digest mismatch)', async () => {
      // Snapshot with 1 resource; definitions add a new resource but remove none
      const snapshot: StoredSessionSnapshot = {
        schemaVersion: 1,
        slotId: 'test',
        capturedAt: new Date().toISOString(),
        workerStep: 100,
        monotonicMs: 1000,
        state: {
          ids: ['wood'],
          amounts: [10],
          capacities: [null],
          flags: [0],
        },
        runtimeVersion: '1.0.0',
        contentDigest: createDigest(['wood']),
      };

      // Current definitions include the original id plus a new one
      const definitions = createDefinitions(['wood', 'stone']);

      const result = validateSaveCompatibility(snapshot, definitions);

      expect(result.compatible).toBe(false);
      expect(result.requiresMigration).toBe(true);
      // No migration registered for this addition-only change
      expect(result.migrationAvailable).toBe(false);
      expect(result.removedIds).toEqual([]);
      expect(result.addedIds).toEqual(['stone']);
      expect(result.digestsMatch).toBe(false);
    });

    it('should require migration when pendingMigration flag is set', async () => {
      const definitions = createDefinitions(['wood']);
      const digest = createDigest(['wood']);

      const snapshot: StoredSessionSnapshot = {
        schemaVersion: 1,
        slotId: 'test',
        capturedAt: new Date().toISOString(),
        workerStep: 100,
        monotonicMs: 1000,
        state: {
          ids: ['wood'],
          amounts: [50],
          capacities: [null],
          flags: [0],
        },
        runtimeVersion: '1.0.0',
        contentDigest: digest,
        flags: { pendingMigration: true },
      };

      const result = validateSaveCompatibility(snapshot, definitions);

      expect(result.compatible).toBe(false);
      expect(result.requiresMigration).toBe(true);
    });
  });

  describe('restoreSession with migration', () => {
    it('should successfully migrate and restore when migration is registered', async () => {
      const oldDigest = createDigest(['wood']);
      const newDigest = createDigest(['lumber']);

      // Register migration
      registerMigration({
        id: 'wood-to-lumber',
        fromDigest: oldDigest,
        toDigest: newDigest,
        transform: (state) => ({
          ...state,
          ids: state.ids.map((id) => (id === 'wood' ? 'lumber' : id)),
        }),
      });

      // Save old snapshot
      const oldSnapshot: StoredSessionSnapshot = {
        schemaVersion: 1,
        slotId: 'test-slot',
        capturedAt: new Date().toISOString(),
        workerStep: 100,
        monotonicMs: 10000,
        state: {
          ids: ['wood'],
          amounts: [999],
          capacities: [null],
          flags: [0],
        },
        runtimeVersion: '1.0.0',
        contentDigest: oldDigest,
      };

      await adapter.save(oldSnapshot);

      // Restore with new definitions
      const newDefinitions = createDefinitions(['lumber']);

      const result = await restoreSession(mockBridge, adapter, {
        slotId: 'test-slot',
        definitions: newDefinitions,
        allowMigration: true,
      });

      expect(result.success).toBe(true);
      expect(result.validationStatus).toBe('migrated');
      expect(mockBridge.restoreSession).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.objectContaining({
            ids: ['lumber'],
            amounts: [999],
          }),
        }),
      );
    });

    it('should fail when migration is not available', async () => {
      const oldDigest = createDigest(['wood']);

      // Save old snapshot
      const oldSnapshot: StoredSessionSnapshot = {
        schemaVersion: 1,
        slotId: 'test-slot',
        capturedAt: new Date().toISOString(),
        workerStep: 100,
        monotonicMs: 10000,
        state: {
          ids: ['wood'],
          amounts: [999],
          capacities: [null],
          flags: [0],
        },
        runtimeVersion: '1.0.0',
        contentDigest: oldDigest,
      };

      await adapter.save(oldSnapshot);

      // Try to restore with incompatible definitions, no migration registered
      const newDefinitions = createDefinitions(['lumber']);

      const result = await restoreSession(mockBridge, adapter, {
        slotId: 'test-slot',
        definitions: newDefinitions,
        allowMigration: true,
      });

      expect(result.success).toBe(false);
      expect(result.validationStatus).toBe('invalid');
      expect(result.error).toBeDefined();
      expect(mockBridge.restoreSession).not.toHaveBeenCalled();
    });

    it('should apply chained migrations', async () => {
      const v1 = createDigest(['a']);
      const v2 = createDigest(['b']);
      const v3 = createDigest(['c']);

      // Register migration chain
      registerMigration({
        id: 'v1-to-v2',
        fromDigest: v1,
        toDigest: v2,
        transform: (state) => ({
          ...state,
          ids: ['b'],
          amounts: [state.amounts[0] * 2],
        }),
      });

      registerMigration({
        id: 'v2-to-v3',
        fromDigest: v2,
        toDigest: v3,
        transform: (state) => ({
          ...state,
          ids: ['c'],
          amounts: [state.amounts[0] + 10],
        }),
      });

      // Save v1 snapshot
      const v1Snapshot: StoredSessionSnapshot = {
        schemaVersion: 1,
        slotId: 'test-slot',
        capturedAt: new Date().toISOString(),
        workerStep: 100,
        monotonicMs: 10000,
        state: {
          ids: ['a'],
          amounts: [5],
          capacities: [null],
          flags: [0],
        },
        runtimeVersion: '1.0.0',
        contentDigest: v1,
      };

      await adapter.save(v1Snapshot);

      // Restore with v3 definitions
      const v3Definitions = createDefinitions(['c']);

      const result = await restoreSession(mockBridge, adapter, {
        slotId: 'test-slot',
        definitions: v3Definitions,
        allowMigration: true,
      });

      expect(result.success).toBe(true);
      expect(result.validationStatus).toBe('migrated');
      expect(mockBridge.restoreSession).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.objectContaining({
            ids: ['c'],
            // 5 * 2 = 10, then 10 + 10 = 20
            amounts: [20],
          }),
        }),
      );
    });

    it('should fail if no migration path exists to current definitions', async () => {
      const oldDigest = createDigest(['wood']);

      // Save old snapshot (no migration registered)
      const oldSnapshot: StoredSessionSnapshot = {
        schemaVersion: 1,
        slotId: 'test-slot',
        capturedAt: new Date().toISOString(),
        workerStep: 100,
        monotonicMs: 10000,
        state: {
          ids: ['wood'],
          amounts: [100],
          capacities: [null],
          flags: [0],
        },
        runtimeVersion: '1.0.0',
        contentDigest: oldDigest,
      };

      await adapter.save(oldSnapshot);

      // Try to restore with incompatible definitions and no migration
      const newDefinitions = createDefinitions(['lumber', 'stone']);

      const result = await restoreSession(mockBridge, adapter, {
        slotId: 'test-slot',
        definitions: newDefinitions,
        allowMigration: true,
      });

      // Should fail - no migration path available
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('No migration path found');
      expect(mockBridge.restoreSession).not.toHaveBeenCalled();
    });

    it('should respect allowMigration flag', async () => {
      const oldDigest = createDigest(['wood']);
      const newDigest = createDigest(['lumber']);

      registerMigration({
        id: 'wood-to-lumber',
        fromDigest: oldDigest,
        toDigest: newDigest,
        transform: (state) => ({
          ...state,
          ids: ['lumber'],
        }),
      });

      // Save old snapshot
      const oldSnapshot: StoredSessionSnapshot = {
        schemaVersion: 1,
        slotId: 'test-slot',
        capturedAt: new Date().toISOString(),
        workerStep: 100,
        monotonicMs: 10000,
        state: {
          ids: ['wood'],
          amounts: [100],
          capacities: [null],
          flags: [0],
        },
        runtimeVersion: '1.0.0',
        contentDigest: oldDigest,
      };

      await adapter.save(oldSnapshot);

      // Try to restore with migration disabled
      const newDefinitions = createDefinitions(['lumber']);

      const result = await restoreSession(mockBridge, adapter, {
        slotId: 'test-slot',
        definitions: newDefinitions,
        allowMigration: false,
      });

      // Should fail without attempting migration
      expect(result.success).toBe(false);
      expect(result.validationStatus).toBe('invalid');
      expect(mockBridge.restoreSession).not.toHaveBeenCalled();
    });

    it('should handle migration that throws error', async () => {
      const oldDigest = createDigest(['wood']);
      const newDigest = createDigest(['lumber']);

      registerMigration({
        id: 'failing-migration',
        fromDigest: oldDigest,
        toDigest: newDigest,
        transform: () => {
          throw new Error('Migration logic error');
        },
      });

      // Save old snapshot
      const oldSnapshot: StoredSessionSnapshot = {
        schemaVersion: 1,
        slotId: 'test-slot',
        capturedAt: new Date().toISOString(),
        workerStep: 100,
        monotonicMs: 10000,
        state: {
          ids: ['wood'],
          amounts: [100],
          capacities: [null],
          flags: [0],
        },
        runtimeVersion: '1.0.0',
        contentDigest: oldDigest,
      };

      await adapter.save(oldSnapshot);

      // Try to restore
      const newDefinitions = createDefinitions(['lumber']);

      const result = await restoreSession(mockBridge, adapter, {
        slotId: 'test-slot',
        definitions: newDefinitions,
        allowMigration: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('Migration failed');
      expect(mockBridge.restoreSession).not.toHaveBeenCalled();
    });
  });

  describe('real-world migration scenarios', () => {
    it('should handle resource rename preserving all data', async () => {
      const oldDigest = createDigest(['wood-gatherer', 'stone-quarry']);
      const newDigest = createDigest(['lumber-mill', 'stone-quarry']);

      registerMigration({
        id: 'rename-gatherer',
        fromDigest: oldDigest,
        toDigest: newDigest,
        transform: (state) => {
          const oldIndex = state.ids.indexOf('wood-gatherer');
          if (oldIndex === -1) {
            throw new Error('Expected to find wood-gatherer');
          }

          const newIds = [...state.ids];
          newIds[oldIndex] = 'lumber-mill';

          return {
            ...state,
            ids: newIds,
          };
        },
      });

      const oldSnapshot: StoredSessionSnapshot = {
        schemaVersion: 1,
        slotId: 'test',
        capturedAt: new Date().toISOString(),
        workerStep: 100,
        monotonicMs: 10000,
        state: {
          ids: ['wood-gatherer', 'stone-quarry'],
          amounts: [999, 500],
          capacities: [1000, null],
          flags: [1, 0],
        },
        runtimeVersion: '1.0.0',
        contentDigest: oldDigest,
      };

      await adapter.save(oldSnapshot);

      const newDefinitions = createDefinitions(['lumber-mill', 'stone-quarry']);

      const result = await restoreSession(mockBridge, adapter, {
        slotId: 'test',
        definitions: newDefinitions,
      });

      expect(result.success).toBe(true);
      expect(mockBridge.restoreSession).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.objectContaining({
            ids: ['lumber-mill', 'stone-quarry'],
            amounts: [999, 500],
            capacities: [1000, null],
            flags: [1, 0],
          }),
        }),
      );
    });

    it('should handle resource merge combining values', async () => {
      const oldDigest = createDigest(['wood', 'stone', 'iron']);
      const newDigest = createDigest(['basic-resources', 'iron']);

      registerMigration({
        id: 'merge-basic',
        fromDigest: oldDigest,
        toDigest: newDigest,
        transform: (state) => {
          const woodIdx = state.ids.indexOf('wood');
          const stoneIdx = state.ids.indexOf('stone');
          const ironIdx = state.ids.indexOf('iron');

          return {
            ids: ['basic-resources', 'iron'],
            amounts: [
              state.amounts[woodIdx] + state.amounts[stoneIdx],
              state.amounts[ironIdx],
            ],
            capacities: [null, state.capacities[ironIdx]],
            flags: [
              state.flags[woodIdx] | state.flags[stoneIdx],
              state.flags[ironIdx],
            ],
          };
        },
      });

      const oldSnapshot: StoredSessionSnapshot = {
        schemaVersion: 1,
        slotId: 'test',
        capturedAt: new Date().toISOString(),
        workerStep: 100,
        monotonicMs: 10000,
        state: {
          ids: ['wood', 'stone', 'iron'],
          amounts: [100, 50, 25],
          capacities: [null, null, 100],
          flags: [1, 2, 0],
        },
        runtimeVersion: '1.0.0',
        contentDigest: oldDigest,
      };

      await adapter.save(oldSnapshot);

      const newDefinitions = createDefinitions(['basic-resources', 'iron']);

      const result = await restoreSession(mockBridge, adapter, {
        slotId: 'test',
        definitions: newDefinitions,
      });

      expect(result.success).toBe(true);
      expect(mockBridge.restoreSession).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.objectContaining({
            ids: ['basic-resources', 'iron'],
            amounts: [150, 25], // 100 + 50, 25
            capacities: [null, 100],
            flags: [3, 0], // 1 | 2, 0
          }),
        }),
      );
    });
  });
});
