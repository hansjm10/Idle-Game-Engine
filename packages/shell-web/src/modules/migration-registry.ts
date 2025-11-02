import type {
  SerializedResourceState,
  ResourceDefinitionDigest,
} from '@idle-engine/core';
import { computeStableDigest } from '@idle-engine/core';

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

    // Validate version is non-negative
    if (descriptor.fromDigest.version < 0 || descriptor.toDigest.version < 0) {
      throw new Error(
        `Migration "${descriptor.id}" has invalid digest version (must be >= 0)`,
      );
    }

    // Validate version matches ids.length
    if (descriptor.fromDigest.version !== descriptor.fromDigest.ids.length) {
      throw new Error(
        `Migration "${descriptor.id}" fromDigest version (${descriptor.fromDigest.version}) must equal ids.length (${descriptor.fromDigest.ids.length})`,
      );
    }

    if (descriptor.toDigest.version !== descriptor.toDigest.ids.length) {
      throw new Error(
        `Migration "${descriptor.id}" toDigest version (${descriptor.toDigest.version}) must equal ids.length (${descriptor.toDigest.ids.length})`,
      );
    }

    // Validate hash matches computed digest from ids
    const expectedFromHash = computeStableDigest(descriptor.fromDigest.ids);
    if (descriptor.fromDigest.hash !== expectedFromHash) {
      throw new Error(
        `Migration "${descriptor.id}" fromDigest hash mismatch: expected "${expectedFromHash}" but got "${descriptor.fromDigest.hash}"`,
      );
    }

    const expectedToHash = computeStableDigest(descriptor.toDigest.ids);
    if (descriptor.toDigest.hash !== expectedToHash) {
      throw new Error(
        `Migration "${descriptor.id}" toDigest hash mismatch: expected "${expectedToHash}" but got "${descriptor.toDigest.hash}"`,
      );
    }

    if (
      descriptor.fromDigest.hash === descriptor.toDigest.hash &&
      descriptor.fromDigest.version === descriptor.toDigest.version
    ) {
      throw new Error(
        `Migration "${descriptor.id}" has identical source and target digests. No migration needed.`,
      );
    }

    // Prevent duplicate edges (same fromDigest->toDigest path)
    // Compare full digest including ids to prevent collisions
    // Use JSON.stringify for safe comparison even if ids contain special chars
    for (const existing of this.migrations.values()) {
      if (
        existing.fromDigest.hash === descriptor.fromDigest.hash &&
        existing.fromDigest.version === descriptor.fromDigest.version &&
        JSON.stringify(existing.fromDigest.ids) === JSON.stringify(descriptor.fromDigest.ids) &&
        existing.toDigest.hash === descriptor.toDigest.hash &&
        existing.toDigest.version === descriptor.toDigest.version &&
        JSON.stringify(existing.toDigest.ids) === JSON.stringify(descriptor.toDigest.ids)
      ) {
        const fromKey = `${descriptor.fromDigest.hash}:${descriptor.fromDigest.version}:${JSON.stringify(descriptor.fromDigest.ids)}`;
        const toKey = `${descriptor.toDigest.hash}:${descriptor.toDigest.version}:${JSON.stringify(descriptor.toDigest.ids)}`;
        throw new Error(
          `Migration "${descriptor.id}" creates duplicate edge from ${fromKey} to ${toKey}. Existing migration "${existing.id}" already covers this path.`,
        );
      }
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
    // Helper to create composite key from digest (prevents hash collisions)
    // Include ids to fully disambiguate digests with same hash+version
    // Use JSON.stringify to avoid delimiter ambiguity if ids contain special chars
    const digestKey = (digest: ResourceDefinitionDigest): string =>
      `${digest.hash}:${digest.version}:${JSON.stringify(digest.ids)}`;

    // If digests match (full composite key), no migration needed
    if (digestKey(fromDigest) === digestKey(toDigest)) {
      return {
        migrations: [],
        fromDigest,
        toDigest,
        found: true,
      };
    }

    // Build adjacency graph: composite key -> list of migrations starting from that digest
    const graph = new Map<string, MigrationDescriptor[]>();
    for (const migration of this.migrations.values()) {
      const sourceKey = digestKey(migration.fromDigest);
      if (!graph.has(sourceKey)) {
        graph.set(sourceKey, []);
      }
      graph.get(sourceKey)!.push(migration);
    }

    // BFS to find shortest path
    const queue: Array<{ key: string; path: MigrationDescriptor[] }> = [
      { key: digestKey(fromDigest), path: [] },
    ];
    const visited = new Set<string>([digestKey(fromDigest)]);

    while (queue.length > 0) {
      const current = queue.shift()!;

      // Check if we reached target
      if (current.key === digestKey(toDigest)) {
        return {
          migrations: current.path,
          fromDigest,
          toDigest,
          found: true,
        };
      }

      // Explore neighbors
      const neighbors = graph.get(current.key) ?? [];
      for (const migration of neighbors) {
        const nextKey = digestKey(migration.toDigest);
        if (!visited.has(nextKey)) {
          visited.add(nextKey);
          queue.push({
            key: nextKey,
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
