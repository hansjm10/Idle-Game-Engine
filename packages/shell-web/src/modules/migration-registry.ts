import type {
  SerializedResourceState,
  ResourceDefinitionDigest,
} from '@idle-engine/core';

/**
 * Pure transformation function that migrates resource state from one content
 * pack digest to another.
 *
 * Migrations must be:
 * - Pure (no side effects)
 * - Deterministic (same input always produces same output)
 * - Idempotent (applying twice produces same result as applying once)
 * - Lossless when possible (preserve user data)
 *
 * @param state - Serialized resource state to transform
 * @returns Transformed state compatible with target digest
 * @throws Error if migration cannot be safely applied
 */
export type MigrationTransform = (
  state: SerializedResourceState,
) => SerializedResourceState;

/**
 * Metadata describing a registered migration transform.
 */
export interface MigrationDescriptor {
  /**
   * Unique identifier for this migration.
   * Convention: `{pack-id}-{from-digest}-to-{to-digest}`
   */
  readonly id: string;

  /**
   * Source content digest before migration.
   * Migration applies when save has this digest.
   */
  readonly fromDigest: ResourceDefinitionDigest;

  /**
   * Target content digest after migration.
   * State will be compatible with this digest after transform.
   */
  readonly toDigest: ResourceDefinitionDigest;

  /**
   * Pure transformation function.
   */
  readonly transform: MigrationTransform;

  /**
   * Optional description for debugging and logging.
   */
  readonly description?: string;
}

/**
 * Result of attempting to find a migration path.
 */
export interface MigrationPath {
  /**
   * Ordered sequence of migrations to apply.
   * Empty if source and target digests match.
   */
  readonly migrations: readonly MigrationDescriptor[];

  /**
   * Source digest (starting point).
   */
  readonly fromDigest: ResourceDefinitionDigest;

  /**
   * Target digest (ending point).
   */
  readonly toDigest: ResourceDefinitionDigest;

  /**
   * Whether a valid path was found.
   */
  readonly found: boolean;
}

/**
 * Global registry for content pack migrations.
 * Manages registration and lookup of migration transforms.
 */
class MigrationRegistry {
  private migrations = new Map<string, MigrationDescriptor>();

  /**
   * Registers a migration transform.
   *
   * @param descriptor - Migration metadata and transform function
   * @throws Error if migration with same ID is already registered
   *
   * @example
   * ```typescript
   * registerMigration({
   *   id: 'my-pack-v1-to-v2',
   *   fromDigest: { hash: 'fnv1a-abc123', version: 10, ids: ['old-id'] },
   *   toDigest: { hash: 'fnv1a-def456', version: 10, ids: ['new-id'] },
   *   transform: (state) => {
   *     // Migration logic
   *     return transformedState;
   *   },
   *   description: 'Rename resource from old-id to new-id',
   * });
   * ```
   */
  register(descriptor: MigrationDescriptor): void {
    if (this.migrations.has(descriptor.id)) {
      throw new Error(
        `Migration "${descriptor.id}" is already registered. Each migration must have a unique ID.`,
      );
    }

    // Validate descriptor
    if (!descriptor.id.trim()) {
      throw new Error('Migration ID cannot be empty');
    }

    if (!descriptor.fromDigest.hash || !descriptor.toDigest.hash) {
      throw new Error(
        `Migration "${descriptor.id}" has invalid digest (missing hash)`,
      );
    }

    if (descriptor.fromDigest.hash === descriptor.toDigest.hash) {
      throw new Error(
        `Migration "${descriptor.id}" has identical source and target digests. No migration needed.`,
      );
    }

    this.migrations.set(descriptor.id, descriptor);
  }

  /**
   * Finds the shortest migration path from source to target digest.
   * Uses breadth-first search to find shortest chain.
   *
   * @param fromDigest - Source content digest (current save state)
   * @param toDigest - Target content digest (current definitions)
   * @returns Migration path if found, or result with found=false
   *
   * @example
   * ```typescript
   * const path = findMigrationPath(saveDigest, currentDigest);
   * if (path.found) {
   *   console.log(`Found migration path with ${path.migrations.length} steps`);
   *   for (const migration of path.migrations) {
   *     state = migration.transform(state);
   *   }
   * }
   * ```
   */
  findMigrationPath(
    fromDigest: ResourceDefinitionDigest,
    toDigest: ResourceDefinitionDigest,
  ): MigrationPath {
    // If digests match, no migration needed
    if (fromDigest.hash === toDigest.hash) {
      return {
        migrations: [],
        fromDigest,
        toDigest,
        found: true,
      };
    }

    // Build adjacency graph: hash -> list of migrations starting from that hash
    const graph = new Map<string, MigrationDescriptor[]>();
    for (const migration of this.migrations.values()) {
      const sourceHash = migration.fromDigest.hash;
      if (!graph.has(sourceHash)) {
        graph.set(sourceHash, []);
      }
      graph.get(sourceHash)!.push(migration);
    }

    // BFS to find shortest path
    const queue: Array<{ hash: string; path: MigrationDescriptor[] }> = [
      { hash: fromDigest.hash, path: [] },
    ];
    const visited = new Set<string>([fromDigest.hash]);

    while (queue.length > 0) {
      const current = queue.shift()!;

      // Check if we reached target
      if (current.hash === toDigest.hash) {
        return {
          migrations: current.path,
          fromDigest,
          toDigest,
          found: true,
        };
      }

      // Explore neighbors
      const neighbors = graph.get(current.hash) ?? [];
      for (const migration of neighbors) {
        const nextHash = migration.toDigest.hash;
        if (!visited.has(nextHash)) {
          visited.add(nextHash);
          queue.push({
            hash: nextHash,
            path: [...current.path, migration],
          });
        }
      }
    }

    // No path found
    return {
      migrations: [],
      fromDigest,
      toDigest,
      found: false,
    };
  }

  /**
   * Retrieves a migration by ID.
   *
   * @param id - Migration identifier
   * @returns Migration descriptor if found, undefined otherwise
   */
  getMigration(id: string): MigrationDescriptor | undefined {
    return this.migrations.get(id);
  }

  /**
   * Lists all registered migrations.
   *
   * @returns Array of all migration descriptors
   */
  listMigrations(): MigrationDescriptor[] {
    return Array.from(this.migrations.values());
  }

  /**
   * Clears all registered migrations.
   * Primarily used for testing.
   */
  clear(): void {
    this.migrations.clear();
  }

  /**
   * Returns the number of registered migrations.
   */
  get size(): number {
    return this.migrations.size;
  }
}

/**
 * Global migration registry instance.
 * Content packs register migrations against this singleton.
 */
export const migrationRegistry = new MigrationRegistry();

/**
 * Convenience function to register a migration.
 * Delegates to the global registry.
 *
 * @param descriptor - Migration metadata and transform function
 *
 * @example
 * ```typescript
 * import { registerMigration } from '@idle-engine/shell-web';
 *
 * registerMigration({
 *   id: 'sample-pack-v1-to-v2',
 *   fromDigest: oldDigest,
 *   toDigest: newDigest,
 *   transform: (state) => ({
 *     ...state,
 *     ids: state.ids.map(id => id === 'old-name' ? 'new-name' : id),
 *   }),
 * });
 * ```
 */
export function registerMigration(descriptor: MigrationDescriptor): void {
  migrationRegistry.register(descriptor);
}

/**
 * Convenience function to find a migration path.
 * Delegates to the global registry.
 *
 * @param fromDigest - Source content digest
 * @param toDigest - Target content digest
 * @returns Migration path result
 */
export function findMigrationPath(
  fromDigest: ResourceDefinitionDigest,
  toDigest: ResourceDefinitionDigest,
): MigrationPath {
  return migrationRegistry.findMigrationPath(fromDigest, toDigest);
}

/**
 * Applies a sequence of migrations to resource state.
 *
 * @param state - Initial resource state
 * @param migrations - Ordered migrations to apply
 * @returns Transformed state after all migrations
 * @throws Error if any migration fails
 *
 * @example
 * ```typescript
 * const path = findMigrationPath(saveDigest, currentDigest);
 * if (path.found) {
 *   const migratedState = applyMigrations(state, path.migrations);
 * }
 * ```
 */
export function applyMigrations(
  state: SerializedResourceState,
  migrations: readonly MigrationDescriptor[],
): SerializedResourceState {
  let currentState = state;

  for (const migration of migrations) {
    try {
      currentState = migration.transform(currentState);
    } catch (error) {
      throw new Error(
        `Migration "${migration.id}" failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  return currentState;
}
