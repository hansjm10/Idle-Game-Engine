# Persistence Migration Guide

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
5. Apply content pack migrations (if registered) ⚠️ NOT YET IMPLEMENTED
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

The digest is computed using **FNV-1a hash** for determinism across environments (see `packages/core/src/resource-state.ts:1818-1826`).

### Validation Rules

When loading a save, the engine compares the saved digest against the current content pack definitions:

| Scenario | Detection | Handling | Migration Needed? |
|----------|-----------|----------|-------------------|
| **Resources added** | `addedIds.length > 0` | Gracefully handled (new resources initialize to defaults) | No |
| **Resources removed** | `removedIds.length > 0` | **FAILS** validation | Yes (must restore removed resources or migrate data) |
| **Resources reordered** | Hash mismatch, same IDs | Warning logged, gracefully handled via remapping | No |
| **Resources renamed** | Old ID removed, new ID added | **FAILS** validation | Yes (migration must transform state) |

Validation logic is implemented in `reconcileSaveAgainstDefinitions()` at `packages/core/src/resource-state.ts:1194-1300`.

### How Digest Changes Trigger Migrations

When `reconcileSaveAgainstDefinitions()` detects incompatibility (removed resources), it sets `snapshot.flags.pendingMigration = true`. Future migration execution will:

1. Compare `snapshot.contentDigest` against known content pack versions
2. Find applicable migration transforms
3. Apply transforms to `snapshot.state.values` arrays
4. Re-validate after transformation

## Migration Authoring Workflow

### Where to Place Migrations

**Current Status:** ⚠️ Migration execution infrastructure not yet implemented. This section describes the intended design.

Content pack migrations should be registered at pack initialization:

```typescript
// Example: In your content pack's initialization code
import { registerMigration } from '@idle-engine/shell-web';

registerMigration({
  // Unique identifier for this migration
  id: 'my-pack-v2-resource-rename',

  // Source content digest (before migration)
  fromDigest: {
    hash: 'abc123...',
    version: 42,
  },

  // Target content digest (after migration)
  toDigest: {
    hash: 'def456...',
    version: 43,
  },

  // Transform function
  transform: (state: SerializedResourceState): SerializedResourceState => {
    // Migration logic here
    return transformedState;
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
import { applyMigration } from '@idle-engine/shell-web';

describe('resource rename migration', () => {
  it('should transform old resource ID to new ID', () => {
    const oldState: SerializedResourceState = {
      ids: ['old-resource-id', 'other-resource'],
      values: [[100], [200]],
      definitionDigest: { hash: 'abc123...', version: 2, ids: [...] },
    };

    const newState = applyMigration('my-pack-v2-resource-rename', oldState);

    expect(newState.ids).toContain('new-resource-id');
    expect(newState.ids).not.toContain('old-resource-id');
    expect(newState.values[0][0]).toBe(100); // Value preserved
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

Renaming a resource requires migrating its ID and preserving all state values:

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

  // Values array remains unchanged (same index)
  return {
    ids: newIds,
    values: state.values,
    definitionDigest: createDefinitionDigest(newIds),
  };
}
```

### Pattern: Resource Merge

Merging two resources into one requires combining state values:

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

  // Remove both old IDs, add new one
  const newIds = state.ids.filter((id) => id !== sourceId1 && id !== sourceId2);
  newIds.push(targetId);

  // Combine values (example: sum the counts)
  const newValues = state.values
    .filter((_, i) => i !== idx1 && i !== idx2)
    .concat([[
      (state.values[idx1][0] ?? 0) + (state.values[idx2][0] ?? 0)
    ]]);

  return {
    ids: newIds,
    values: newValues,
    definitionDigest: createDefinitionDigest(newIds),
  };
}
```

### Pattern: State Value Transformation

Changing the structure of state values (e.g., adding fields, changing units):

```typescript
function migrateStateStructure(state: SerializedResourceState): SerializedResourceState {
  // Example: Converting from seconds to milliseconds
  const timeResourceIndex = state.ids.indexOf('elapsed-time');

  if (timeResourceIndex === -1) {
    throw new Error('Migration expected to find "elapsed-time" resource');
  }

  const newValues = state.values.map((vals, i) => {
    if (i === timeResourceIndex) {
      return vals.map((v) => v * 1000); // Convert seconds to ms
    }
    return vals;
  });

  return {
    ...state,
    values: newValues,
  };
}
```

### Testing Determinism

Ensure migrations are deterministic by running them multiple times and verifying identical output:

```typescript
it('should produce identical results on repeated application', () => {
  const originalState = createTestState();

  const result1 = applyMigration('my-migration', originalState);
  const result2 = applyMigration('my-migration', originalState);

  expect(result1).toEqual(result2);
  expect(result1.definitionDigest.hash).toBe(result2.definitionDigest.hash);
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
      values: [[42], [100]],
      definitionDigest: { hash: 'old-hash', version: 2, ids: ['old-id', 'other-resource'] },
    };

    const output = migrateResourceRename(input);

    expect(output.ids).toEqual(['new-id', 'other-resource']);
    expect(output.values).toEqual([[42], [100]]);
  });

  it('should fail when expected resource is missing', () => {
    const input: SerializedResourceState = {
      ids: ['wrong-id'],
      values: [[0]],
      definitionDigest: { hash: 'hash', version: 1, ids: ['wrong-id'] },
    };

    expect(() => migrateResourceRename(input)).toThrow('expected to find resource');
  });
});
```

#### 2. Integration Tests with SessionPersistenceAdapter

Test full save/migrate/restore flow:

```typescript
// migration-integration.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto'; // Mock IndexedDB
import { SessionPersistenceAdapter } from '../modules/session-persistence-adapter';
import { StubWorkerContext } from '../test-utils';

describe('migration integration', () => {
  let adapter: SessionPersistenceAdapter;

  beforeEach(() => {
    adapter = new SessionPersistenceAdapter();
  });

  it('should apply migration when loading incompatible save', async () => {
    // 1. Save state with old content digest
    const oldSnapshot = {
      schemaVersion: 1,
      slotId: 'test-slot',
      capturedAt: new Date().toISOString(),
      workerStep: 100,
      monotonicMs: 1000,
      state: createOldState(), // Old resource IDs
      runtimeVersion: '1.0.0',
      contentDigest: oldDigest,
    };
    await adapter.save(oldSnapshot);

    // 2. Register migration
    registerMigration({
      id: 'test-migration',
      fromDigest: oldDigest,
      toDigest: newDigest,
      transform: migrateResourceRename,
    });

    // 3. Load with new definitions
    const loaded = await adapter.load('test-slot', newDefinitions);

    // 4. Verify migration was applied
    expect(loaded.state.ids).toContain('new-id');
    expect(loaded.state.ids).not.toContain('old-id');
  });
});
```

#### 3. Fixture-Based Testing

Create fixture snapshots for regression testing:

```typescript
// fixtures/saves/v1-to-v2-migration.json
{
  "schemaVersion": 1,
  "slotId": "fixture-v1",
  "state": {
    "ids": ["old-resource-id"],
    "values": [[999]],
    "definitionDigest": { "hash": "old-hash", "version": 1, "ids": ["old-resource-id"] }
  },
  "runtimeVersion": "1.0.0",
  "contentDigest": { "hash": "old-hash", "version": 1, "ids": ["old-resource-id"] }
}
```

Test against fixtures:

```typescript
import fixtureV1 from './fixtures/saves/v1-to-v2-migration.json';

it('should migrate v1 fixture to v2', () => {
  const migrated = applyMigration('v1-to-v2', fixtureV1.state);
  expect(migrated.ids).toEqual(['new-resource-id']);
  expect(migrated.values).toEqual([[999]]);
});
```

### CLI Commands for Running Tests

Run migration tests using Vitest:

```bash
# Run all migration tests
npm test -- migration

# Run tests in watch mode during development
npm test -- --watch migration

# Run specific test file
npm test -- packages/shell-web/src/migrations/my-pack-migrations.test.ts

# Generate coverage report
npm test -- --coverage migration
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
✅ **Telemetry for migration events** - `PersistenceMigrationRequired` emitted when needed
✅ **Comprehensive test infrastructure** - Unit, integration, and fixture tests

### Critical Gaps ⚠️

❌ **No migration execution** - `session-restore.ts:101-113` contains only a stub that throws "migration not yet implemented"
❌ **No migration registry** - No API to register or discover content pack migrations
❌ **No CLI tooling** - No commands to generate migration scaffolds or validate determinism
❌ **No migration templates** - No example migrations to use as reference
❌ **No resourceDeltas support** - `RESTORE_SESSION` message accepts deltas but they're never populated

### Partially Implemented

⚠️ **Migration flag detection** - System correctly identifies when migration is needed, but can't execute it
⚠️ **Validation infrastructure** - `reconcileSaveAgainstDefinitions()` works for simple cases but can't apply transforms
⚠️ **Telemetry events** - `PersistenceMigrationApplied` defined but never emitted

### Follow-Up Tooling (Future Work)

Track these in issues:

- **Migration registry** (Issue #271) - API for registering and chaining migrations
- **CLI scaffold generator** - `npx idle-engine generate migration` command
- **Checksum helpers** - Utilities for computing and verifying migration determinism
- **Migration path solver** - Automatically compute shortest migration chain
- **Diagnostic tools** - CLI to inspect save files and test migrations offline

## References

### Design Documents

- [Runtime-React-Worker-Bridge Design](./runtime-react-worker-bridge-design.md) - Section 14.1 covers persistence handoff
- [Resource State Storage Design](./resource-state-storage-design.md) - Serialization format and digest computation

### Implementation Files

- `packages/shell-web/src/modules/session-persistence-adapter.ts` - IndexedDB adapter API
- `packages/shell-web/src/modules/session-restore.ts` - Validation and migration flow (stub at line 108)
- `packages/core/src/resource-state.ts` - Digest computation (line 1818) and reconciliation (line 1194)

### Test Files

- `packages/shell-web/src/modules/session-persistence-adapter.test.ts` - Adapter unit tests
- `packages/shell-web/src/modules/session-restore.test.ts` - Validation logic tests
- `packages/shell-web/src/modules/session-persistence-integration.test.ts` - Full round-trip tests

### Related Issues

- Issue #273 - This documentation (migration authoring guide)
- Issue #271 - Migration registry implementation
- Issue #16 - Original persistence tracking issue

---

**Note:** This guide documents the intended migration system design. Several critical components are not yet implemented (see [Current Implementation Status](#current-implementation-status--tooling-gaps)). Content pack authors should be aware that migration execution is planned but not available until Issue #271 is resolved.
