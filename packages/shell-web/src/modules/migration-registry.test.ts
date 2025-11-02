import { describe, it, expect, beforeEach } from 'vitest';
import type { SerializedResourceState, ResourceDefinitionDigest } from '@idle-engine/core';
import {
  migrationRegistry,
  registerMigration,
  findMigrationPath,
  applyMigrations,
  type MigrationDescriptor,
} from './migration-registry.js';

describe('MigrationRegistry', () => {
  // Helper to create test digests
  const createDigest = (hash: string, ids: string[]): ResourceDefinitionDigest => ({
    hash,
    version: ids.length,
    ids,
  });

  // Helper to create test state
  const createState = (ids: string[], amounts?: number[]): SerializedResourceState => ({
    ids,
    amounts: amounts ?? ids.map(() => 0),
    capacities: ids.map(() => null),
    flags: ids.map(() => 0),
  });

  beforeEach(() => {
    // Clear registry before each test
    migrationRegistry.clear();
  });

  describe('register', () => {
    it('should register a migration successfully', () => {
      const migration: MigrationDescriptor = {
        id: 'test-migration',
        fromDigest: createDigest('fnv1a-00000001', ['old-id']),
        toDigest: createDigest('fnv1a-00000002', ['new-id']),
        transform: (state) => state,
      };

      registerMigration(migration);

      expect(migrationRegistry.size).toBe(1);
      expect(migrationRegistry.getMigration('test-migration')).toBe(migration);
    });

    it('should throw if migration ID is already registered', () => {
      const migration: MigrationDescriptor = {
        id: 'duplicate',
        fromDigest: createDigest('fnv1a-00000001', ['a']),
        toDigest: createDigest('fnv1a-00000002', ['b']),
        transform: (state) => state,
      };

      registerMigration(migration);

      expect(() => registerMigration(migration)).toThrow(
        'Migration "duplicate" is already registered',
      );
    });

    it('should throw if migration ID is empty', () => {
      expect(() =>
        registerMigration({
          id: '   ',
          fromDigest: createDigest('fnv1a-00000001', ['a']),
          toDigest: createDigest('fnv1a-00000002', ['b']),
          transform: (state) => state,
        }),
      ).toThrow('Migration ID cannot be empty');
    });

    it('should throw if fromDigest hash is missing', () => {
      expect(() =>
        registerMigration({
          id: 'bad-migration',
          fromDigest: { hash: '', version: 1, ids: ['a'] },
          toDigest: createDigest('fnv1a-00000002', ['b']),
          transform: (state) => state,
        }),
      ).toThrow('has invalid digest (missing hash)');
    });

    it('should throw if source and target digests are identical', () => {
      const digest = createDigest('fnv1a-00000001', ['a']);
      expect(() =>
        registerMigration({
          id: 'no-op',
          fromDigest: digest,
          toDigest: digest,
          transform: (state) => state,
        }),
      ).toThrow('has identical source and target digests');
    });

    it('should throw if version is zero or negative', () => {
      expect(() =>
        registerMigration({
          id: 'bad-version',
          fromDigest: { hash: 'fnv1a-00000001', version: 0, ids: [] },
          toDigest: createDigest('fnv1a-00000002', ['b']),
          transform: (state) => state,
        }),
      ).toThrow('invalid digest version (must be > 0)');

      expect(() =>
        registerMigration({
          id: 'negative-version',
          fromDigest: createDigest('fnv1a-00000001', ['a']),
          toDigest: { hash: 'fnv1a-00000002', version: -1, ids: ['b'] },
          transform: (state) => state,
        }),
      ).toThrow('invalid digest version (must be > 0)');
    });

    it('should throw if version does not match ids.length', () => {
      expect(() =>
        registerMigration({
          id: 'version-mismatch-from',
          fromDigest: { hash: 'fnv1a-00000001', version: 5, ids: ['a', 'b'] }, // version 5 != length 2
          toDigest: createDigest('fnv1a-00000002', ['c']),
          transform: (state) => state,
        }),
      ).toThrow('fromDigest version (5) must equal ids.length (2)');

      expect(() =>
        registerMigration({
          id: 'version-mismatch-to',
          fromDigest: createDigest('fnv1a-00000001', ['a']),
          toDigest: { hash: 'fnv1a-00000002', version: 3, ids: ['b'] }, // version 3 != length 1
          transform: (state) => state,
        }),
      ).toThrow('toDigest version (3) must equal ids.length (1)');
    });

    it('should throw if duplicate edge is registered', () => {
      const from = createDigest('fnv1a-00000001', ['a']);
      const to = createDigest('fnv1a-00000002', ['b']);

      registerMigration({
        id: 'first',
        fromDigest: from,
        toDigest: to,
        transform: (state) => state,
      });

      expect(() =>
        registerMigration({
          id: 'duplicate-edge',
          fromDigest: from,
          toDigest: to,
          transform: (state) => state,
        }),
      ).toThrow('creates duplicate edge');
    });
  });

  describe('findMigrationPath', () => {
    it('should return empty path when digests match', () => {
      const digest = createDigest('fnv1a-00000001', ['a']);
      const path = findMigrationPath(digest, digest);

      expect(path.found).toBe(true);
      expect(path.migrations).toHaveLength(0);
    });

    it('should find direct migration path', () => {
      const fromDigest = createDigest('fnv1a-00000001', ['a']);
      const toDigest = createDigest('fnv1a-00000002', ['b']);

      const migration: MigrationDescriptor = {
        id: 'a-to-b',
        fromDigest,
        toDigest,
        transform: (state) => state,
      };

      registerMigration(migration);

      const path = findMigrationPath(fromDigest, toDigest);

      expect(path.found).toBe(true);
      expect(path.migrations).toHaveLength(1);
      expect(path.migrations[0]).toBe(migration);
    });

    it('should find chained migration path (v1 -> v2 -> v3)', () => {
      const v1 = createDigest('fnv1a-00000001', ['a']);
      const v2 = createDigest('fnv1a-00000002', ['b']);
      const v3 = createDigest('fnv1a-00000003', ['c']);

      const migration1: MigrationDescriptor = {
        id: 'v1-to-v2',
        fromDigest: v1,
        toDigest: v2,
        transform: (state) => state,
      };

      const migration2: MigrationDescriptor = {
        id: 'v2-to-v3',
        fromDigest: v2,
        toDigest: v3,
        transform: (state) => state,
      };

      registerMigration(migration1);
      registerMigration(migration2);

      const path = findMigrationPath(v1, v3);

      expect(path.found).toBe(true);
      expect(path.migrations).toHaveLength(2);
      expect(path.migrations[0]).toBe(migration1);
      expect(path.migrations[1]).toBe(migration2);
    });

    it('should find shortest path when multiple routes exist', () => {
      const v1 = createDigest('fnv1a-00000001', ['a']);
      const v2 = createDigest('fnv1a-00000002', ['b']);
      const v3 = createDigest('fnv1a-00000003', ['c']);
      const v4 = createDigest('fnv1a-00000004', ['d']);

      // Register two paths: v1->v2->v4 (length 2) and v1->v3->v4 (length 2)
      // Also register longer path v1->v2->v3->v4 (length 3)
      registerMigration({
        id: 'v1-to-v2',
        fromDigest: v1,
        toDigest: v2,
        transform: (state) => state,
      });

      registerMigration({
        id: 'v2-to-v4',
        fromDigest: v2,
        toDigest: v4,
        transform: (state) => state,
      });

      registerMigration({
        id: 'v1-to-v3',
        fromDigest: v1,
        toDigest: v3,
        transform: (state) => state,
      });

      registerMigration({
        id: 'v3-to-v4',
        fromDigest: v3,
        toDigest: v4,
        transform: (state) => state,
      });

      registerMigration({
        id: 'v2-to-v3',
        fromDigest: v2,
        toDigest: v3,
        transform: (state) => state,
      });

      const path = findMigrationPath(v1, v4);

      expect(path.found).toBe(true);
      // Should find one of the 2-hop paths, not the 3-hop path
      expect(path.migrations).toHaveLength(2);
    });

    it('should return not found when no path exists', () => {
      const v1 = createDigest('fnv1a-00000001', ['a']);
      const v2 = createDigest('fnv1a-00000002', ['b']);
      const v3 = createDigest('fnv1a-00000003', ['c']);

      // Register v1->v2 but not v2->v3
      registerMigration({
        id: 'v1-to-v2',
        fromDigest: v1,
        toDigest: v2,
        transform: (state) => state,
      });

      const path = findMigrationPath(v1, v3);

      expect(path.found).toBe(false);
      expect(path.migrations).toHaveLength(0);
    });
  });

  describe('applyMigrations', () => {
    it('should apply single migration', () => {
      const migration: MigrationDescriptor = {
        id: 'rename',
        fromDigest: createDigest('fnv1a-00000001', ['old']),
        toDigest: createDigest('fnv1a-00000002', ['new']),
        transform: (state) => ({
          ...state,
          ids: state.ids.map((id) => (id === 'old' ? 'new' : id)),
        }),
      };

      const initialState = createState(['old'], [100]);
      const result = applyMigrations(initialState, [migration]);

      expect(result.ids).toEqual(['new']);
      expect(result.amounts).toEqual([100]);
    });

    it('should apply multiple migrations in sequence', () => {
      const migration1: MigrationDescriptor = {
        id: 'step1',
        fromDigest: createDigest('fnv1a-00000001', ['a']),
        toDigest: createDigest('fnv1a-00000002', ['b']),
        transform: (state) => ({
          ...state,
          ids: ['b'],
          amounts: [state.amounts[0] * 2],
        }),
      };

      const migration2: MigrationDescriptor = {
        id: 'step2',
        fromDigest: createDigest('fnv1a-00000002', ['b']),
        toDigest: createDigest('fnv1a-00000003', ['c']),
        transform: (state) => ({
          ...state,
          ids: ['c'],
          amounts: [state.amounts[0] + 10],
        }),
      };

      const initialState = createState(['a'], [5]);
      const result = applyMigrations(initialState, [migration1, migration2]);

      expect(result.ids).toEqual(['c']);
      // 5 * 2 = 10, then 10 + 10 = 20
      expect(result.amounts).toEqual([20]);
    });

    it('should handle empty migration list', () => {
      const initialState = createState(['a'], [100]);
      const result = applyMigrations(initialState, []);

      expect(result).toBe(initialState);
    });

    it('should throw if migration fails', () => {
      const failingMigration: MigrationDescriptor = {
        id: 'failing',
        fromDigest: createDigest('fnv1a-00000001', ['a']),
        toDigest: createDigest('fnv1a-00000002', ['b']),
        transform: () => {
          throw new Error('Migration failed');
        },
      };

      const initialState = createState(['a']);

      expect(() => applyMigrations(initialState, [failingMigration])).toThrow(
        'Migration "failing" failed: Migration failed',
      );
    });

    it('should preserve error cause when migration fails', () => {
      const originalError = new Error('Root cause');
      const failingMigration: MigrationDescriptor = {
        id: 'failing',
        fromDigest: createDigest('fnv1a-00000001', ['a']),
        toDigest: createDigest('fnv1a-00000002', ['b']),
        transform: () => {
          throw originalError;
        },
      };

      const initialState = createState(['a']);

      try {
        applyMigrations(initialState, [failingMigration]);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).cause).toBe(originalError);
      }
    });
  });

  describe('listMigrations', () => {
    it('should return empty array when no migrations registered', () => {
      expect(migrationRegistry.listMigrations()).toEqual([]);
    });

    it('should list all registered migrations', () => {
      const migration1: MigrationDescriptor = {
        id: 'm1',
        fromDigest: createDigest('fnv1a-00000001', ['a']),
        toDigest: createDigest('fnv1a-00000002', ['b']),
        transform: (state) => state,
      };

      const migration2: MigrationDescriptor = {
        id: 'm2',
        fromDigest: createDigest('fnv1a-00000002', ['b']),
        toDigest: createDigest('fnv1a-00000003', ['c']),
        transform: (state) => state,
      };

      registerMigration(migration1);
      registerMigration(migration2);

      const list = migrationRegistry.listMigrations();

      expect(list).toHaveLength(2);
      expect(list).toContain(migration1);
      expect(list).toContain(migration2);
    });
  });

  describe('clear', () => {
    it('should remove all migrations', () => {
      registerMigration({
        id: 'm1',
        fromDigest: createDigest('fnv1a-00000001', ['a']),
        toDigest: createDigest('fnv1a-00000002', ['b']),
        transform: (state) => state,
      });

      expect(migrationRegistry.size).toBe(1);

      migrationRegistry.clear();

      expect(migrationRegistry.size).toBe(0);
      expect(migrationRegistry.listMigrations()).toEqual([]);
    });
  });

  describe('real-world migration patterns', () => {
    it('should handle resource rename migration', () => {
      const oldDigest = createDigest('fnv1a-abc123', ['wood', 'stone']);
      const newDigest = createDigest('fnv1a-def456', ['lumber', 'stone']);

      registerMigration({
        id: 'rename-wood-to-lumber',
        fromDigest: oldDigest,
        toDigest: newDigest,
        transform: (state) => {
          const oldIndex = state.ids.indexOf('wood');
          if (oldIndex === -1) {
            throw new Error('Expected to find "wood" resource');
          }

          const newIds = [...state.ids];
          newIds[oldIndex] = 'lumber';

          return {
            ...state,
            ids: newIds,
          };
        },
      });

      const oldState = createState(['wood', 'stone'], [100, 50]);
      const path = findMigrationPath(oldDigest, newDigest);
      const newState = applyMigrations(oldState, path.migrations);

      expect(newState.ids).toEqual(['lumber', 'stone']);
      expect(newState.amounts).toEqual([100, 50]);
    });

    it('should handle resource merge migration', () => {
      const oldDigest = createDigest('fnv1a-abc123', ['wood', 'stone', 'iron']);
      const newDigest = createDigest('fnv1a-def456', ['resources', 'iron']);

      registerMigration({
        id: 'merge-wood-stone',
        fromDigest: oldDigest,
        toDigest: newDigest,
        transform: (state) => {
          const woodIdx = state.ids.indexOf('wood');
          const stoneIdx = state.ids.indexOf('stone');
          const ironIdx = state.ids.indexOf('iron');

          const mergedAmount = state.amounts[woodIdx] + state.amounts[stoneIdx];

          return {
            ids: ['resources', 'iron'],
            amounts: [mergedAmount, state.amounts[ironIdx]],
            capacities: [null, state.capacities[ironIdx]],
            flags: [0, state.flags[ironIdx]],
          };
        },
      });

      const oldState = createState(['wood', 'stone', 'iron'], [100, 50, 25]);
      const path = findMigrationPath(oldDigest, newDigest);
      const newState = applyMigrations(oldState, path.migrations);

      expect(newState.ids).toEqual(['resources', 'iron']);
      expect(newState.amounts).toEqual([150, 25]);
    });

    it('should handle unit conversion migration', () => {
      const oldDigest = createDigest('fnv1a-abc123', ['time-seconds']);
      const newDigest = createDigest('fnv1a-def456', ['time-ms']);

      registerMigration({
        id: 'seconds-to-ms',
        fromDigest: oldDigest,
        toDigest: newDigest,
        transform: (state) => ({
          ...state,
          ids: ['time-ms'],
          amounts: state.amounts.map((amount) => amount * 1000),
        }),
      });

      const oldState = createState(['time-seconds'], [60]);
      const path = findMigrationPath(oldDigest, newDigest);
      const newState = applyMigrations(oldState, path.migrations);

      expect(newState.ids).toEqual(['time-ms']);
      expect(newState.amounts).toEqual([60000]);
    });
  });

  describe('determinism and idempotence', () => {
    it('should produce identical results on repeated application', () => {
      const migration: MigrationDescriptor = {
        id: 'deterministic',
        fromDigest: createDigest('fnv1a-00000001', ['a']),
        toDigest: createDigest('fnv1a-00000002', ['b']),
        transform: (state) => ({
          ...state,
          ids: ['b'],
          amounts: [state.amounts[0] * 2],
        }),
      };

      const initialState = createState(['a'], [10]);

      const result1 = applyMigrations(initialState, [migration]);
      const result2 = applyMigrations(initialState, [migration]);

      expect(result1).toEqual(result2);
    });
  });

  describe('performance and scalability', () => {
    it('should handle 100+ migrations in long linear chain efficiently', () => {
      // Create a chain of 100 migrations: v0 -> v1 -> v2 -> ... -> v100
      const chainLength = 100;

      for (let i = 0; i < chainLength; i++) {
        const fromDigest = createDigest(`fnv1a-chain-${i}`, [`resource-v${i}`]);
        const toDigest = createDigest(`fnv1a-chain-${i + 1}`, [`resource-v${i + 1}`]);

        registerMigration({
          id: `chain-step-${i}`,
          fromDigest,
          toDigest,
          transform: (state) => ({
            ...state,
            ids: [`resource-v${i + 1}`],
            amounts: [state.amounts[0] + 1],
          }),
        });
      }

      const startDigest = createDigest('fnv1a-chain-0', ['resource-v0']);
      const endDigest = createDigest('fnv1a-chain-100', ['resource-v100']);

      // Measure pathfinding performance
      const startTime = performance.now();
      const path = findMigrationPath(startDigest, endDigest);
      const pathfindingTime = performance.now() - startTime;

      expect(path.found).toBe(true);
      expect(path.migrations).toHaveLength(chainLength);
      // Pathfinding should complete in under 100ms even for 100-step chain
      expect(pathfindingTime).toBeLessThan(100);

      // Measure migration application performance
      const initialState = createState(['resource-v0'], [0]);
      const applyStartTime = performance.now();
      const finalState = applyMigrations(initialState, path.migrations);
      const applyTime = performance.now() - applyStartTime;

      expect(finalState.ids).toEqual(['resource-v100']);
      expect(finalState.amounts).toEqual([chainLength]);
      // Application should complete in reasonable time
      expect(applyTime).toBeLessThan(200);
    });

    it('should handle complex migration graph with multiple paths', () => {
      // Create a graph with multiple paths from v1 to v10
      // Structure: diamond pattern with 10 source nodes, 10 intermediate nodes, 10 target nodes

      for (let i = 1; i <= 10; i++) {
        // Source to intermediate (10 paths)
        registerMigration({
          id: `stress-src-${i}-to-mid`,
          fromDigest: createDigest(`fnv1a-stress-src`, [`src-${i}`]),
          toDigest: createDigest(`fnv1a-stress-mid-${i}`, [`mid-${i}`]),
          transform: (state) => ({
            ...state,
            ids: [`mid-${i}`],
          }),
        });

        // Intermediate to target (10 paths)
        registerMigration({
          id: `stress-mid-${i}-to-tgt`,
          fromDigest: createDigest(`fnv1a-stress-mid-${i}`, [`mid-${i}`]),
          toDigest: createDigest(`fnv1a-stress-tgt`, [`target`]),
          transform: (state) => ({
            ...state,
            ids: ['target'],
          }),
        });
      }

      const startDigest = createDigest('fnv1a-stress-src', ['src-1']);
      const endDigest = createDigest('fnv1a-stress-tgt', ['target']);

      const startTime = performance.now();
      const path = findMigrationPath(startDigest, endDigest);
      const pathfindingTime = performance.now() - startTime;

      expect(path.found).toBe(true);
      expect(path.migrations).toHaveLength(2); // Should find shortest 2-hop path
      expect(pathfindingTime).toBeLessThan(50);
    });
  });

  describe('circular dependency handling', () => {
    it('should handle cycles in migration graph without infinite loop', () => {
      const v1 = createDigest('fnv1a-cycle-1', ['a']);
      const v2 = createDigest('fnv1a-cycle-2', ['b']);
      const v3 = createDigest('fnv1a-cycle-3', ['c']);

      // Create a cycle: v1 -> v2 -> v3 -> v1
      registerMigration({
        id: 'cycle-1-to-2',
        fromDigest: v1,
        toDigest: v2,
        transform: (state) => ({ ...state, ids: ['b'] }),
      });

      registerMigration({
        id: 'cycle-2-to-3',
        fromDigest: v2,
        toDigest: v3,
        transform: (state) => ({ ...state, ids: ['c'] }),
      });

      registerMigration({
        id: 'cycle-3-to-1',
        fromDigest: v3,
        toDigest: v1,
        transform: (state) => ({ ...state, ids: ['a'] }),
      });

      // Searching within the cycle should terminate
      const path = findMigrationPath(v1, v2);
      expect(path.found).toBe(true);
      expect(path.migrations).toHaveLength(1);

      // Searching for non-existent target should terminate
      const v4 = createDigest('fnv1a-cycle-4', ['d']);
      const noPath = findMigrationPath(v1, v4);
      expect(noPath.found).toBe(false);
    });

    it('should find shortest path through cycles', () => {
      const v1 = createDigest('fnv1a-shortcycle-1', ['a']);
      const v2 = createDigest('fnv1a-shortcycle-2', ['b']);
      const v3 = createDigest('fnv1a-shortcycle-3', ['c']);
      const v4 = createDigest('fnv1a-shortcycle-4', ['d']);

      // Create cycle with shortcut: v1 -> v2 -> v3 -> v2 (cycle), but also v1 -> v4
      registerMigration({
        id: 'shortcycle-1-to-2',
        fromDigest: v1,
        toDigest: v2,
        transform: (state) => ({ ...state, ids: ['b'] }),
      });

      registerMigration({
        id: 'shortcycle-2-to-3',
        fromDigest: v2,
        toDigest: v3,
        transform: (state) => ({ ...state, ids: ['c'] }),
      });

      registerMigration({
        id: 'shortcycle-3-to-2',
        fromDigest: v3,
        toDigest: v2,
        transform: (state) => ({ ...state, ids: ['b'] }),
      });

      registerMigration({
        id: 'shortcycle-1-to-4',
        fromDigest: v1,
        toDigest: v4,
        transform: (state) => ({ ...state, ids: ['d'] }),
      });

      // Should find the direct path v1 -> v4 (length 1), not v1 -> v2 -> v3 (length 2)
      const path = findMigrationPath(v1, v4);
      expect(path.found).toBe(true);
      expect(path.migrations).toHaveLength(1);
      expect(path.migrations[0].id).toBe('shortcycle-1-to-4');
    });
  });

  describe('registry memory management', () => {
    it('should clear all migrations without leaks', () => {
      // Register many migrations
      for (let i = 0; i < 1000; i++) {
        registerMigration({
          id: `leak-test-${i}`,
          fromDigest: createDigest(`fnv1a-leak-${i}`, [`v${i}`]),
          toDigest: createDigest(`fnv1a-leak-${i + 1}`, [`v${i + 1}`]),
          transform: (state) => state,
        });
      }

      expect(migrationRegistry.size).toBe(1000);

      // Clear registry
      migrationRegistry.clear();

      expect(migrationRegistry.size).toBe(0);
      expect(migrationRegistry.listMigrations()).toEqual([]);

      // Verify registry is usable after clear
      registerMigration({
        id: 'after-clear',
        fromDigest: createDigest('fnv1a-new-1', ['x']),
        toDigest: createDigest('fnv1a-new-2', ['y']),
        transform: (state) => ({ ...state, ids: ['y'] }),
      });

      expect(migrationRegistry.size).toBe(1);
    });

    it('should handle repeated register/clear cycles', () => {
      for (let cycle = 0; cycle < 10; cycle++) {
        // Register 100 migrations
        for (let i = 0; i < 100; i++) {
          registerMigration({
            id: `cycle-${cycle}-migration-${i}`,
            fromDigest: createDigest(`fnv1a-c${cycle}-${i}`, [`v${i}`]),
            toDigest: createDigest(`fnv1a-c${cycle}-${i + 1}`, [`v${i + 1}`]),
            transform: (state) => state,
          });
        }

        expect(migrationRegistry.size).toBe(100);

        // Clear
        migrationRegistry.clear();
        expect(migrationRegistry.size).toBe(0);
      }

      // Verify final state is clean
      expect(migrationRegistry.size).toBe(0);
      expect(migrationRegistry.listMigrations()).toEqual([]);
    });

    it('should not retain old migrations after clear', () => {
      // Register migration with specific ID
      registerMigration({
        id: 'retention-test',
        fromDigest: createDigest('fnv1a-ret-1', ['old']),
        toDigest: createDigest('fnv1a-ret-2', ['new']),
        transform: (state) => ({ ...state, ids: ['new'] }),
      });

      const oldMigration = migrationRegistry.getMigration('retention-test');
      expect(oldMigration).toBeDefined();

      // Clear registry
      migrationRegistry.clear();

      // Old migration should not be retrievable
      const afterClear = migrationRegistry.getMigration('retention-test');
      expect(afterClear).toBeUndefined();

      // Register new migration with same ID (should work)
      registerMigration({
        id: 'retention-test',
        fromDigest: createDigest('fnv1a-ret-3', ['newer']),
        toDigest: createDigest('fnv1a-ret-4', ['newest']),
        transform: (state) => ({ ...state, ids: ['newest'] }),
      });

      const newMigration = migrationRegistry.getMigration('retention-test');
      expect(newMigration).toBeDefined();
      expect(newMigration?.fromDigest.hash).toBe('fnv1a-ret-3');
    });
  });
});
