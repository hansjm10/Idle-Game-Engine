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
      startAmount: 0,
      capacity: null,
      unlocked: true,
      visible: true,
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

    it('should NOT require migration when definitions only add resources', async () => {
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

      // Addition-only changes are compatible and don't require migration
      // (new resources initialize to defaults gracefully)
      expect(result.compatible).toBe(true);
      expect(result.requiresMigration).toBe(false);
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

    it('should report migrationAvailable=true for zero-step path with pendingMigration flag', async () => {
      const digest = createDigest(['wood']);
      const definitions = createDefinitions(['wood']);

      // Zero-step scenario: snapshot digest matches current definitions,
      // but pendingMigration flag forces migration check.
      // findMigrationPath returns found=true with empty migrations array.
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
      // Zero-step path is always "available" (trivial path where from==to)
      expect(result.migrationAvailable).toBe(true);
      expect(result.digestsMatch).toBe(true);
    });
  });

  describe('restoreSession with migration', () => {
    it('should not treat zero-step migration as success when validation fails', async () => {
      // Snapshot content digest already matches current definitions, but the
      // serialized state is corrupted (length mismatch). Validation initially
      // throws, and since no migration steps are available, we must revalidate
      // and propagate the failure instead of restoring.

      const digest = createDigest(['wood']);

      const corruptedSnapshot: StoredSessionSnapshot = {
        schemaVersion: 1,
        slotId: 'test-slot',
        capturedAt: new Date().toISOString(),
        workerStep: 100,
        monotonicMs: 10000,
        state: {
          ids: ['wood'],
          // amounts length does not match ids length -> validation error
          amounts: [],
          capacities: [null],
          flags: [0],
        },
        runtimeVersion: '1.0.0',
        // Digest matches the current content definitions (zero-step path)
        contentDigest: digest,
      };

      await adapter.save(corruptedSnapshot);

      const definitions = createDefinitions(['wood']);
      const result = await restoreSession(mockBridge, adapter, {
        slotId: 'test-slot',
        definitions,
        allowMigration: true,
      });

      expect(result.success).toBe(false);
      expect(result.validationStatus).toBe('invalid');
      expect(result.error).toBeDefined();
      expect(mockBridge.restoreSession).not.toHaveBeenCalled();
    });
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

    it('should verify final digest hash matches after multi-step migration', async () => {
      // This test ensures the defensive telemetry check doesn't fire
      // when migrations are correctly implemented
      const v1 = createDigest(['a', 'b']);
      const v2 = createDigest(['a', 'c']);
      const v3 = createDigest(['d', 'c']);

      registerMigration({
        id: 'v1-to-v2',
        fromDigest: v1,
        toDigest: v2,
        transform: (state) => ({
          ...state,
          ids: ['a', 'c'],
          amounts: [state.amounts[0], state.amounts[1]],
        }),
      });

      registerMigration({
        id: 'v2-to-v3',
        fromDigest: v2,
        toDigest: v3,
        transform: (state) => ({
          ...state,
          ids: ['d', 'c'],
          amounts: [state.amounts[0], state.amounts[1]],
        }),
      });

      const v1Snapshot: StoredSessionSnapshot = {
        schemaVersion: 1,
        slotId: 'test-slot',
        capturedAt: new Date().toISOString(),
        workerStep: 100,
        monotonicMs: 10000,
        state: {
          ids: ['a', 'b'],
          amounts: [10, 20],
          capacities: [null, null],
          flags: [0, 0],
        },
        runtimeVersion: '1.0.0',
        contentDigest: v1,
      };

      await adapter.save(v1Snapshot);

      const v3Definitions = createDefinitions(['d', 'c']);

      const result = await restoreSession(mockBridge, adapter, {
        slotId: 'test-slot',
        definitions: v3Definitions,
        allowMigration: true,
      });

      expect(result.success).toBe(true);
      expect(result.validationStatus).toBe('migrated');

      // Verify the final state passed to bridge has correct ids
      expect(mockBridge.restoreSession).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.objectContaining({
            ids: ['d', 'c'],
            amounts: [10, 20],
          }),
        }),
      );

      // Verify final hash matches expected v3 digest
      const restoredCall = vi.mocked(mockBridge.restoreSession).mock.calls[0][0];
      const finalHash = computeDigest(restoredCall.state.ids);
      expect(finalHash).toBe(v3.hash);
    });

    it('should fail when migration transform breaks array structure', async () => {
      const oldDigest = createDigest(['wood']);
      const newDigest = createDigest(['lumber']);

      // Register a migration that produces structurally invalid state
      registerMigration({
        id: 'broken-migration',
        fromDigest: oldDigest,
        toDigest: newDigest,
        transform: (state) => ({
          ...state,
          ids: ['lumber'],
          // Intentionally break structure: amounts length doesn't match ids
          amounts: [],
          capacities: [null],
          flags: [0],
        }),
      });

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

      const newDefinitions = createDefinitions(['lumber']);

      const result = await restoreSession(mockBridge, adapter, {
        slotId: 'test-slot',
        definitions: newDefinitions,
        allowMigration: true,
      });

      // Should fail due to revalidation catching the structural error
      expect(result.success).toBe(false);
      expect(result.validationStatus).toBe('invalid');
      expect(result.error).toBeDefined();
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

  describe('Transformation array alignment edge cases', () => {
    it('should detect misaligned unlocked array after migration', async () => {
      const oldDigest = createDigest(['wood', 'stone']);
      const newDigest = createDigest(['lumber', 'gravel']);

      // Migration that incorrectly transforms only some arrays
      registerMigration({
        id: 'broken-unlocked-alignment',
        fromDigest: oldDigest,
        toDigest: newDigest,
        transform: (state) => ({
          ...state,
          ids: ['lumber', 'gravel'],
          amounts: [state.amounts[0], state.amounts[1]],
          capacities: [state.capacities[0], state.capacities[1]],
          flags: [state.flags[0], state.flags[1]],
          // Missing unlocked array! This breaks alignment
          unlocked: [], // Empty instead of matching length
        }),
      });

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
          unlocked: [true, false],
        },
        runtimeVersion: '1.0.0',
        contentDigest: oldDigest,
      };

      await adapter.save(snapshot);

      const result = await restoreSession(mockBridge, adapter, {
        slotId: 'test',
        definitions: createDefinitions(['lumber', 'gravel']),
        allowMigration: true,
      });

      // Migration should fail validation due to array length mismatch
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/invalid|length/i);
    });

    it('should detect misaligned visible array after migration', async () => {
      const oldDigest = createDigest(['a']);
      const newDigest = createDigest(['b', 'c']);

      // Migration that adds a resource but forgets to extend visible array
      registerMigration({
        id: 'broken-visible-alignment',
        fromDigest: oldDigest,
        toDigest: newDigest,
        transform: (state) => ({
          ...state,
          ids: ['b', 'c'],
          amounts: [state.amounts[0], 0],
          capacities: [state.capacities[0], null],
          flags: [state.flags[0], 0],
          visible: [true], // Only 1 element instead of 2!
        }),
      });

      const snapshot: StoredSessionSnapshot = {
        schemaVersion: 1,
        slotId: 'test',
        capturedAt: new Date().toISOString(),
        workerStep: 100,
        monotonicMs: 1000,
        state: {
          ids: ['a'],
          amounts: [50],
          capacities: [null],
          flags: [0],
          visible: [true],
        },
        runtimeVersion: '1.0.0',
        contentDigest: oldDigest,
      };

      await adapter.save(snapshot);

      const result = await restoreSession(mockBridge, adapter, {
        slotId: 'test',
        definitions: createDefinitions(['b', 'c']),
        allowMigration: true,
      });

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/invalid|length/i);
    });

    it('should detect when migration produces inconsistent optional field lengths', async () => {
      const oldDigest = createDigest(['x', 'y', 'z']);
      const newDigest = createDigest(['x', 'y']);

      // Migration that removes a resource but inconsistently updates optional arrays
      registerMigration({
        id: 'broken-optional-alignment',
        fromDigest: oldDigest,
        toDigest: newDigest,
        transform: (state) => ({
          ids: ['x', 'y'],
          amounts: [state.amounts[0], state.amounts[1]],
          capacities: [state.capacities[0], state.capacities[1]],
          flags: [state.flags[0], state.flags[1]],
          // unlocked is correctly sized
          unlocked: [true, false],
          // visible has wrong length (3 instead of 2)
          visible: [true, false, true],
        }),
      });

      const snapshot: StoredSessionSnapshot = {
        schemaVersion: 1,
        slotId: 'test',
        capturedAt: new Date().toISOString(),
        workerStep: 100,
        monotonicMs: 1000,
        state: {
          ids: ['x', 'y', 'z'],
          amounts: [1, 2, 3],
          capacities: [null, null, null],
          flags: [0, 0, 0],
          unlocked: [true, true, true],
          visible: [true, false, true],
        },
        runtimeVersion: '1.0.0',
        contentDigest: oldDigest,
      };

      await adapter.save(snapshot);

      const result = await restoreSession(mockBridge, adapter, {
        slotId: 'test',
        definitions: createDefinitions(['x', 'y']),
        allowMigration: true,
      });

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/invalid|length/i);
    });
  });
});
