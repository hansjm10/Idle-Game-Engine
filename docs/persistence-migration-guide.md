# Persistence Migration Guide

**Last Updated:** 2025-11-02
**Status:** ✅ Migration execution fully implemented (Issue #155)

This guide explains how to author migrations for persisted game state in the Idle Game Engine. It covers the migration system architecture, authoring workflow, testing practices, and current implementation status.

## Table of Contents

1. [Overview](#overview)
2. [Migration System Architecture](#migration-system-architecture)
3. [Content Digest System](#content-digest-system)
4. [Migration Authoring Workflow](#migration-authoring-workflow)
5. [Writing Deterministic Migrations](#writing-deterministic-migrations)
6. [Testing Migrations](#testing-migrations)
7. [When to Bump Schema Versions](#when-to-bump-schema-versions)
8. [Current Implementation Status & Tooling Gaps](#current-implementation-status--tooling-gaps)
9. [References](#references)

## Overview

The Idle Game Engine uses a **shell-managed persistence architecture** where the React shell handles all storage operations while the deterministic runtime worker remains isolated from I/O. This design ensures:

- **Determinism**: The worker never touches storage APIs directly
- **Testability**: Storage operations can be mocked independently
- **Portability**: Different shells can implement different storage strategies

Migrations are needed when:

- **Content pack definitions change** (resources added, removed, or reordered)
- **Persistence schema format changes** (structure of `StoredSessionSnapshot`)
- **State transformation required** (data model evolution, fixes to corrupted saves)

Migrations run **before** calling `bridge.restoreSession()`, allowing content packs to transform save data into a format compatible with current definitions.

## Migration System Architecture

### Storage Schema

Snapshots are stored in IndexedDB (`idle-engine.sessions` database) with the following structure:

```typescript
interface StoredSessionSnapshot {
  readonly schemaVersion: number;          // Persistence schema version
  readonly slotId: string;                 // Save slot identifier
  readonly capturedAt: string;             // ISO timestamp
  readonly workerStep: number;             // Runtime step counter
  readonly monotonicMs: number;            // Monotonic clock reference
  readonly state: SerializedResourceState; // Serialized game state
  readonly commandQueue?: SerializedCommandQueue; // Pending command queue snapshot
  readonly runtimeVersion: string;         // @idle-engine/core version
  readonly contentDigest: ResourceDefinitionDigest;  // Content pack hash
  readonly flags?: {
    readonly pendingMigration?: boolean;
    readonly abortedRestore?: boolean;
  };
  readonly checksum?: string;              // SHA-256 for corruption detection
}
```

### Key Version Fields

| Field | Purpose | Managed By |
|-------|---------|------------|
| `PERSISTENCE_SCHEMA_VERSION` | Format version of `StoredSessionSnapshot` | Engine maintainers |
| `schemaVersion` | Instance value stored in each snapshot | Automatically set on save |
| `runtimeVersion` | Semantic version from `@idle-engine/core` | Automatically set from package.json |
| `contentDigest` | Hash of resource IDs in content pack | Automatically computed on save/load |

### Execution Flow

```
1. SessionPersistenceAdapter.load(slotId)
   ↓
2. Validate snapshot integrity (checksum, schema version)
   ↓
3. reconcileSaveAgainstDefinitions(snapshot.state, liveDefinitions)
   ↓
4. Check if migration required (digest mismatch, removed resources)
   ↓
5. Apply content pack migrations (if registered)
   ↓
6. bridge.restoreSession({ state, elapsedMs, resourceDeltas })
```

## Content Digest System

### What is a ResourceDefinitionDigest?

A content digest is a stable hash of all resource IDs in a content pack, used to detect when definitions have changed between save and load:

```typescript
interface ResourceDefinitionDigest {
  readonly ids: readonly string[];  // Ordered resource IDs
  readonly version: number;          // Count of resource IDs
  readonly hash: string;            // FNV-1a hash of resource IDs
}
```

The digest is computed using **FNV-1a hash** for determinism across environments (see `createDefinitionDigest()` in `packages/core/src/resource-state.ts`).

### Validation Rules

When loading a save, the engine compares the saved digest against the current content pack definitions:

| Scenario | Detection | Handling | Migration Needed? |
|----------|-----------|----------|-------------------|
| **Resources added** | `addedIds.length > 0` | Gracefully handled (new resources initialize to defaults) | No |
| **Resources removed** | `removedIds.length > 0` | **FAILS** validation | Yes (must restore removed resources or migrate data) |
| **Resources reordered** | Hash mismatch, same IDs | Warning logged, gracefully handled via remapping | No |
| **Resources renamed** | Old ID removed, new ID added | **FAILS** validation | Yes (migration must transform state) |

Validation logic is implemented in `reconcileSaveAgainstDefinitions()` in `packages/core/src/resource-state.ts`.

### How Digest Changes Trigger Migrations

When `reconcileSaveAgainstDefinitions()` detects incompatibility, it returns reconciliation results containing:
- `addedIds`: Resources in current definitions but not in save
- `removedIds`: Resources in save but not in current definitions (triggers migration requirement)
- `digestsMatch`: Whether the saved and current digests match

The restore logic in `session-restore.ts` uses these results to determine if migration is needed:
- Migration is required when `removedIds.length > 0` (resources were removed/renamed)
- Migration can also be triggered by a pre-set `snapshot.flags.pendingMigration` flag

When migration is triggered:

1. Compare `snapshot.contentDigest` against known content pack versions
2. Find applicable migration transforms using the migration registry
3. Apply transforms to `snapshot.state` (amounts, capacities, flags arrays, etc.)
4. Re-validate after transformation

## Migration Authoring Workflow

### Where to Place Migrations

**Current Status:** ✅ Migration registration API is implemented and available.

**Note:** The `registerMigration()` and `findMigrationPath()` APIs are now available in `@idle-engine/shell-web`. Content packs can register migrations at initialization time.

Content pack migrations should be registered at pack initialization:

```typescript
// Example: In your content pack's initialization code
import { registerMigration } from '@idle-engine/shell-web';

registerMigration({
  // Unique identifier for this migration
  id: 'my-pack-v2-resource-rename',

  // Source content digest (before migration)
  fromDigest: {
    hash: 'fnv1a-abc123',
    version: 2,
    ids: ['old-resource-id', 'other-resource'],
  },

  // Target content digest (after migration)
  toDigest: {
    hash: 'fnv1a-def456',
    version: 2,
    ids: ['new-resource-id', 'other-resource'],
  },

  // Transform function
  transform: (state: SerializedResourceState): SerializedResourceState => {
    // Rename old-resource-id to new-resource-id in the state
    return {
      ...state,
      ids: state.ids.map(id => id === 'old-resource-id' ? 'new-resource-id' : id),
    };
  },
});
```

### Versioning Expectations

Migrations are **digest-driven**, not version-driven:

- A migration transforms state from one content digest to another
- Multiple migrations may form a chain (v1 → v2 → v3)
- The shell will automatically compute the shortest migration path

**Do NOT** tie migrations to `runtimeVersion` or `schemaVersion`:
- `runtimeVersion` changes with engine updates (not content changes)
- `schemaVersion` changes when `StoredSessionSnapshot` format changes (handled separately by IndexedDB migrations)

### Testing Hooks

Test migrations using the existing test infrastructure in `packages/shell-web/src/modules/`:

```typescript
// Example: In your content pack's test suite
import { describe, it, expect } from 'vitest';
import { registerMigration, findMigrationPath, applyMigrations } from '@idle-engine/shell-web';
import type { ResourceDefinitionDigest, SerializedResourceState } from '@idle-engine/core';

describe('resource rename migration', () => {
  it('should transform old resource ID to new ID', () => {
    const oldDigest: ResourceDefinitionDigest = {
      hash: 'abc123...',
      version: 2,
      ids: ['old-resource-id', 'other-resource'],
    };
    const newDigest: ResourceDefinitionDigest = {
      hash: 'def456...',
      version: 2,
      ids: ['new-resource-id', 'other-resource'],
    };

    registerMigration({
      id: 'my-pack-v2-resource-rename',
      fromDigest: oldDigest,
      toDigest: newDigest,
      transform: (state) => ({
        ...state,
        ids: state.ids.map((id) => (id === 'old-resource-id' ? 'new-resource-id' : id)),
      }),
    });

    const oldState: SerializedResourceState = {
      ids: ['old-resource-id', 'other-resource'],
      amounts: [100, 200],
      capacities: [1000, 2000],
      flags: [0, 0],
    };

    const path = findMigrationPath(oldDigest, newDigest);
    expect(path.found).toBe(true);

    const newState = applyMigrations(oldState, path.migrations);

    expect(newState.ids).toContain('new-resource-id');
    expect(newState.ids).not.toContain('old-resource-id');
    expect(newState.amounts[0]).toBe(100); // Value preserved
  });
});
```

## Writing Deterministic Migrations

### Principles for Safe Migrations

1. **Pure Transformations**: Migrations must be pure functions with no side effects
2. **Idempotence**: Applying a migration twice should produce the same result
3. **Lossless When Possible**: Preserve user data unless explicitly discarding
4. **Fail Loudly**: Throw errors for unexpected state rather than silently corrupting data

### Pattern: Resource Rename

Renaming a resource requires migrating its ID and preserving all state arrays at the same index:

```typescript
function migrateResourceRename(state: SerializedResourceState): SerializedResourceState {
  const oldId = 'wood-gatherer';
  const newId = 'lumber-gatherer';

  const oldIndex = state.ids.indexOf(oldId);
  if (oldIndex === -1) {
    throw new Error(`Migration expected to find resource "${oldId}" but it was missing`);
  }

  // Clone and update IDs
  const newIds = [...state.ids];
  newIds[oldIndex] = newId;

  // All other arrays (amounts, capacities, flags, etc.) remain unchanged
  // since we're only renaming the ID, not changing the index position
  return {
    ...state,
    ids: newIds,
  };
}
```

**IMPORTANT:** Do NOT manually set the `definitionDigest` field in migration transforms. The digest is automatically stripped and recomputed by the engine during validation to ensure it matches the migrated IDs. If you include a stale digest, re-validation will fail.

### Pattern: Resource Merge

Merging two resources into one requires combining state values from multiple arrays:

```typescript
function migrateResourceMerge(state: SerializedResourceState): SerializedResourceState {
  const sourceId1 = 'wood-gatherer';
  const sourceId2 = 'stone-gatherer';
  const targetId = 'resource-gatherer';

  const idx1 = state.ids.indexOf(sourceId1);
  const idx2 = state.ids.indexOf(sourceId2);

  if (idx1 === -1 || idx2 === -1) {
    throw new Error('Migration expected to find both source resources');
  }

  // Helper to remove elements at two indices and append a new value
  const mergeArrays = <T>(arr: readonly T[], newValue: T): T[] => {
    return arr.filter((_, i) => i !== idx1 && i !== idx2).concat([newValue]);
  };

  // Remove both old IDs, add new one
  const newIds = mergeArrays(state.ids, targetId);

  // Combine amounts (example: sum them)
  const newAmounts = mergeArrays(
    state.amounts,
    state.amounts[idx1] + state.amounts[idx2]
  );

  // Combine capacities (example: take the maximum)
  const capacity1 = state.capacities[idx1];
  const capacity2 = state.capacities[idx2];
  const mergedCapacity =
    capacity1 == null || capacity2 == null
      ? null
      : Math.max(capacity1, capacity2);
  const newCapacities = mergeArrays(state.capacities, mergedCapacity);

  // Combine flags (example: bitwise OR)
  const newFlags = mergeArrays(
    state.flags,
    state.flags[idx1] | state.flags[idx2]
  );

  // Handle optional arrays
  const newUnlocked = state.unlocked
    ? mergeArrays(state.unlocked, state.unlocked[idx1] || state.unlocked[idx2])
    : undefined;

  const newVisible = state.visible
    ? mergeArrays(state.visible, state.visible[idx1] || state.visible[idx2])
    : undefined;

  return {
    ids: newIds,
    amounts: newAmounts,
    capacities: newCapacities,
    flags: newFlags,
    ...(newUnlocked !== undefined && { unlocked: newUnlocked }),
    ...(newVisible !== undefined && { visible: newVisible }),
  };
}
```

**Note:** When merging resources, carefully consider how to combine each field (sum amounts, max capacities, OR flags, etc.) based on your game's semantics.

### Pattern: State Value Transformation

Transforming specific resource values (e.g., changing units, applying fixes):

```typescript
function migrateStateStructure(state: SerializedResourceState): SerializedResourceState {
  // Example: Converting elapsed-time resource from seconds to milliseconds
  const timeResourceIndex = state.ids.indexOf('elapsed-time');

  if (timeResourceIndex === -1) {
    throw new Error('Migration expected to find "elapsed-time" resource');
  }

  // Transform the amount for the time resource
  const newAmounts = state.amounts.map((amount, i) => {
    if (i === timeResourceIndex) {
      return amount * 1000; // Convert seconds to ms
    }
    return amount;
  });

  // If capacities also need scaling, transform them too
  const newCapacities = state.capacities.map((capacity, i) => {
    if (i === timeResourceIndex && capacity != null) {
      return capacity * 1000;
    }
    return capacity;
  });

  return {
    ...state,
    amounts: newAmounts,
    capacities: newCapacities,
  };
}
```

**Example: Bulk transformation across all resources**

```typescript
function migrateClampNegativeAmounts(state: SerializedResourceState): SerializedResourceState {
  // Fix corrupted saves where amounts became negative
  const newAmounts = state.amounts.map(amount => Math.max(0, amount));

  return {
    ...state,
    amounts: newAmounts,
  };
}
```

### Testing Determinism

Ensure migrations are deterministic by running them multiple times and verifying identical output:

```typescript
it('should produce identical results on repeated application', () => {
  const originalState = createTestState();

  // Get the registered migration
  const path = findMigrationPath(oldDigest, newDigest);
  expect(path.found).toBe(true);

  const result1 = applyMigrations(originalState, path.migrations);
  const result2 = applyMigrations(originalState, path.migrations);

  expect(result1).toEqual(result2);
});
```

## Testing Migrations

### Using Existing Test Infrastructure

The engine provides comprehensive test utilities in `packages/shell-web/src/modules/`:

#### 1. Unit Tests for Migration Logic

Test individual migration transforms in isolation:

```typescript
// my-pack-migrations.test.ts
import { describe, it, expect } from 'vitest';

describe('resource rename migration', () => {
  it('should rename resource ID while preserving values', () => {
    const input: SerializedResourceState = {
      ids: ['old-id', 'other-resource'],
      amounts: [42, 100],
      capacities: [1000, 2000],
      flags: [0, 0],
      definitionDigest: { hash: 'old-hash', version: 2, ids: ['old-id', 'other-resource'] },
    };

    const output = migrateResourceRename(input);

    expect(output.ids).toEqual(['new-id', 'other-resource']);
    expect(output.amounts).toEqual([42, 100]); // Values preserved
    expect(output.capacities).toEqual([1000, 2000]);
    expect(output.flags).toEqual([0, 0]);
  });

  it('should fail when expected resource is missing', () => {
    const input: SerializedResourceState = {
      ids: ['wrong-id'],
      amounts: [0],
      capacities: [100],
      flags: [0],
      definitionDigest: { hash: 'hash', version: 1, ids: ['wrong-id'] },
    };

    expect(() => migrateResourceRename(input)).toThrow('expected to find resource');
  });
});
```

#### 2. Integration Tests with SessionPersistenceAdapter

Test full save/migrate/restore flow (when migration execution is implemented):

```typescript
// migration-integration.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto'; // Mock IndexedDB
import { SessionPersistenceAdapter } from '../modules/session-persistence-adapter';
import { registerMigration } from '../modules/migration-registry'; // Placeholder - not yet implemented

describe('migration integration', () => {
  let adapter: SessionPersistenceAdapter;

  beforeEach(() => {
    adapter = new SessionPersistenceAdapter();
  });

  it('should apply migration when loading incompatible save', async () => {
    // Helper to create old-format state
    const createOldState = (): SerializedResourceState => ({
      ids: ['old-resource-id'],
      amounts: [999],
      capacities: [1000],
      flags: [0],
      definitionDigest: {
        hash: 'old-hash',
        version: 1,
        ids: ['old-resource-id']
      },
    });

    // 1. Save state with old content digest
    const oldSnapshot = {
      schemaVersion: 1,
      slotId: 'test-slot',
      capturedAt: new Date().toISOString(),
      workerStep: 100,
      monotonicMs: 1000,
      state: createOldState(),
      runtimeVersion: '1.0.0',
      contentDigest: {
        hash: 'old-hash',
        version: 1,
        ids: ['old-resource-id']
      },
    };
    await adapter.save(oldSnapshot);

    // 2. Register migration (placeholder API)
    const newDigest = { hash: 'new-hash', version: 1, ids: ['new-resource-id'] };
    registerMigration({
      id: 'test-migration',
      fromDigest: oldSnapshot.contentDigest,
      toDigest: newDigest,
      transform: migrateResourceRename,
    });

    // 3. Load with new definitions (migration should auto-apply)
    const newDefinitions = [/* new resource definitions */];
    const loaded = await adapter.load('test-slot', newDefinitions);

    // 4. Verify migration was applied
    expect(loaded.state.ids).toContain('new-resource-id');
    expect(loaded.state.ids).not.toContain('old-resource-id');
    expect(loaded.state.amounts[0]).toBe(999); // Value preserved
  });
});
```

**Note:** Integration tests will work once the migration registry (Issue #155) is implemented.

#### 3. Fixture-Based Testing

Create fixture snapshots for regression testing:

```json
// fixtures/saves/v1-to-v2-migration.json
{
  "schemaVersion": 1,
  "slotId": "fixture-v1",
  "state": {
    "ids": ["old-resource-id"],
    "amounts": [999],
    "capacities": [1000],
    "flags": [0],
    "definitionDigest": {
      "hash": "old-hash",
      "version": 1,
      "ids": ["old-resource-id"]
    }
  },
  "runtimeVersion": "1.0.0",
  "contentDigest": {
    "hash": "old-hash",
    "version": 1,
    "ids": ["old-resource-id"]
  },
  "capturedAt": "2024-01-15T10:30:00.000Z",
  "workerStep": 1000,
  "monotonicMs": 60000
}
```

Test against fixtures:

```typescript
import fixtureV1 from './fixtures/saves/v1-to-v2-migration.json';
import { findMigrationPath, applyMigrations } from '@idle-engine/shell-web';

it('should migrate v1 fixture to v2', () => {
  const oldDigest = fixtureV1.contentDigest;
  const newDigest = { hash: 'new-hash', version: 1, ids: ['new-resource-id'] };

  const path = findMigrationPath(oldDigest, newDigest);
  expect(path.found).toBe(true);

  const migrated = applyMigrations(fixtureV1.state, path.migrations);

  expect(migrated.ids).toEqual(['new-resource-id']);
  expect(migrated.amounts).toEqual([999]); // Value preserved
  expect(migrated.capacities).toEqual([1000]);
  expect(migrated.flags).toEqual([0]);
});
```

### CLI Commands for Running Tests

Run migration tests using Vitest:

```bash
# Run all migration tests
pnpm test migration

# Run tests in watch mode during development
pnpm test --watch migration

# Run specific test file
pnpm --filter @idle-engine/shell-web test my-pack-migrations

# Generate coverage report
pnpm test --coverage migration
```

### Example Test Cases

Comprehensive test cases should cover:

```typescript
describe('migration test suite', () => {
  describe('correctness', () => {
    it('should preserve all user data');
    it('should update resource IDs correctly');
    it('should recompute content digest');
  });

  describe('error handling', () => {
    it('should throw when required resource is missing');
    it('should throw on invalid state structure');
    it('should provide clear error messages');
  });

  describe('determinism', () => {
    it('should produce identical results on repeated runs');
    it('should produce same hash across different environments');
  });

  describe('edge cases', () => {
    it('should handle empty state arrays');
    it('should handle maximum array sizes');
    it('should handle special numeric values (NaN, Infinity)');
  });
});
```

See `packages/shell-web/src/modules/session-restore.test.ts` for real-world examples.

## When to Bump Schema Versions

### PERSISTENCE_SCHEMA_VERSION

Bump `PERSISTENCE_SCHEMA_VERSION` (defined in `packages/shell-web/src/modules/session-persistence-adapter.ts:10`) when:

- The structure of `StoredSessionSnapshot` changes
- New required fields are added to the snapshot
- Field types change in a breaking way
- IndexedDB schema migration is needed

**Do NOT bump** for:
- Content pack resource changes (use content migrations instead)
- Runtime version updates
- Non-breaking additions (new optional fields)

When bumping, you must also implement an IndexedDB schema migration to handle existing snapshots.

### contentDigest

The `contentDigest` is **automatically computed** on every save and load. You don't manually bump it. Instead:

1. Change your resource definitions (add, remove, rename resources)
2. The digest will automatically update to reflect the new IDs
3. Write a content migration to handle saves with the old digest

### runtimeVersion

The `runtimeVersion` is **automatically set** from `@idle-engine/core`'s `package.json`. You don't manually control it. The engine records it for diagnostic purposes but doesn't use it for validation.

## Current Implementation Status & Tooling Gaps

### What Works Today

✅ **Session save/load to IndexedDB** - Full implementation in `SessionPersistenceAdapter`
✅ **Content digest computation and validation** - Detects when definitions change
✅ **Graceful handling of added resources** - New resources initialize to defaults
✅ **Checksum validation** - Detects corrupted snapshots using SHA-256
✅ **Telemetry for migration events** - `PersistenceMigrationRequired`, `PersistenceMigrationApplied`, `PersistenceMigrationFailed` emitted
✅ **Comprehensive test infrastructure** - Unit, integration, and fixture tests
✅ **Migration registry** - `packages/shell-web/src/modules/migration-registry.ts` with BFS pathfinding
✅ **Migration execution** - `session-restore.ts:attemptMigration()` applies transforms and re-validates
✅ **Public API** - `registerMigration()`, `findMigrationPath()`, `applyMigrations()` exported
✅ **Content pack manifests** - `StoredSessionSnapshot.contentPacks` field for tracking pack versions

### Known Limitations

⚠️ **No CLI tooling** - No commands to generate migration scaffolds or validate determinism
⚠️ **No migration templates** - No example migrations in real content packs yet (coming soon)
⚠️ **No resourceDeltas support** - `RESTORE_SESSION` message accepts deltas but they're never populated
⚠️ **Content pack manifest population** - `StoredSessionSnapshot.contentPacks` field is defined but worker does not yet supply content pack metadata. Reserved for future multi-pack support in runtime.

### Follow-Up Tooling (Future Work)

Track these in future issues:

- **CLI scaffold generator** - `npx idle-engine generate migration` command
- **Checksum helpers** - Utilities for computing and verifying migration determinism
- **Diagnostic tools** - CLI to inspect save files and test migrations offline
- **Content pack manifest population** - Auto-populate `contentPacks` during save operations
- **Example migrations** - Add real migration examples to sample content pack

## References

### Design Documents

- [Runtime-React-Worker-Bridge Design](./runtime-react-worker-bridge-design.md) - Section 14.1 covers persistence handoff
- [Resource State Storage Design](./resource-state-storage-design.md) - Serialization format and digest computation

### Implementation Files

- `packages/shell-web/src/modules/session-persistence-adapter.ts` - IndexedDB adapter API
- `packages/shell-web/src/modules/session-restore.ts` - Validation and migration flow
- `packages/shell-web/src/modules/migration-registry.ts` - Migration registration and pathfinding
- `packages/core/src/resource-state.ts` - Digest computation (`createDefinitionDigest`) and reconciliation (`reconcileSaveAgainstDefinitions`)

### Test Files

- `packages/shell-web/src/modules/session-persistence-adapter.test.ts` - Adapter unit tests
- `packages/shell-web/src/modules/session-restore.test.ts` - Validation logic tests
- `packages/shell-web/src/modules/session-persistence-integration.test.ts` - Full round-trip tests

### Related Issues

- Issue #273 - This documentation (migration authoring guide)
- Issue #155 - Save file format with content pack manifests and migrations
- Issue #271 - Session persistence adapter (completed)
- Issue #16 - Original persistence tracking issue

---

**Note:** The migration system is fully implemented as of Issue #155. The core registry, pathfinding, and execution logic are complete and tested. Content pack authors can register migrations using the `registerMigration()` API. Remember that migration transforms should NOT manually set the `definitionDigest` field - it is automatically stripped and recomputed during validation to ensure correctness.
