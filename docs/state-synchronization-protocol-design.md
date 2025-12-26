# State Synchronization Protocol Design

## Document Control
- **Title**: Add State Synchronization Protocol for Client/Server Architecture
- **Authors**: Idle Engine Docs Agent
- **Reviewers**: Runtime Core maintainers
- **Status**: Implemented (Phase 1-2)
- **Last Updated**: 2025-12-22
- **Related Issues**: #544
- **Execution Mode**: AI-led

## 1. Summary

This design introduces infrastructure for synchronizing game state between an authoritative server and clients in the Idle Engine. The protocol enables periodic state snapshots, deterministic checksum verification for divergence detection, and efficient resync mechanisms when client-predicted state diverges from the server. By building on the existing deterministic simulation and serialization patterns, this protocol provides the foundation for multiplayer features, anti-cheat validation, and cloud save reconciliation without compromising the engine's offline-first design.

## 2. Context & Problem Statement

### Background

The Idle Engine runtime is fully deterministic and serializable. Existing infrastructure includes:
- `ResourceState.exportForSave()` for resource serialization
- `CommandQueue.exportForSave()` for command queue serialization
- `serializeProgressionCoordinatorState()` for progression state
- `createVerificationRuntime()` for replay-based verification
- `buildEconomyStateSummary()` for economy snapshots
- Seeded RNG via `getCurrentRNGSeed()` and `setRNGSeed()`

However, these primitives are scattered across subsystems and lack a unified protocol for:
- Capturing complete game state as a single atomic snapshot
- Computing fast checksums for divergence detection
- Restoring a runtime from a snapshot
- Identifying specific differences when divergence occurs

### Problem

Without a unified state synchronization protocol:
1. Server-authoritative validation requires ad-hoc state assembly
2. Desync detection between clients and server is manual and error-prone
3. Cloud save reconciliation lacks a structured comparison mechanism
4. Anti-cheat replay verification cannot efficiently compare endpoints
5. Future multiplayer features have no foundation for state transfer

### Forces

- **Performance**: Checksum computation must complete within microseconds for per-tick verification
- **Determinism**: Snapshot capture and restore must preserve bit-exact state
- **Bandwidth**: Full snapshots should support partial extraction for network efficiency
- **Debuggability**: Divergence detection must pinpoint specific differences for debugging
- **Compatibility**: Protocol must work across browser Workers, Node.js, and potential native shells

## 3. Goals & Non-Goals

### Goals

1. **Unified Snapshot API**: Single `captureGameStateSnapshot()` function that aggregates all runtime state components
2. **Fast Checksums**: `computeStateChecksum()` producing deterministic hashes in &lt;100μs for typical game states
3. **Complete Restore**: `restoreFromSnapshot()` that fully hydrates a runtime to an identical state
4. **Round-Trip Invariant**: `capture → serialize → deserialize → restore` produces bit-identical state
5. **Divergence Debugging**: `compareStates()` API that identifies specific field differences
6. **Partial Snapshots**: Support for extracting/restoring subsets (e.g., resources only) for bandwidth optimization

### Non-Goals

- Real-time multiplayer netcode (tick-by-tick synchronization)
- Network transport layer implementation
- Compression algorithms for wire format (deferred to transport layer)
- Client prediction with rollback (future work building on this foundation)
- Server-side continuous simulation (use replay verification instead)

## 4. Stakeholders, Agents & Impacted Surfaces

### Primary Stakeholders

- Runtime Core maintainers (implementation)
- Shell maintainers (Worker bridge updates)

### Agent Roles

| Agent | Responsibilities |
|-------|-----------------|
| Runtime Implementation Agent | Core snapshot/checksum/restore APIs in `packages/core` |
| Testing Agent | Unit tests, property-based tests, round-trip verification |
| Docs Agent | API documentation, usage examples |

### Affected Packages/Services

- `packages/core/src/` - New synchronization module
- `packages/core/src/index.ts` - Public API exports

### Compatibility Considerations

- New APIs are additive; no breaking changes to existing serialization
- Snapshot format versioned for future schema evolution
- Existing `exportForSave()` methods remain unchanged

## 5. Current State

### Existing Serialization Architecture

The runtime currently has per-subsystem serialization:

**ResourceState** (`packages/core/src/resource-state.ts:1283-1341`):
```typescript
exportForSave(
  automationState?: ReadonlyMap<string, AutomationState>,
  transformState?: ReadonlyMap<string, TransformState>,
): SerializedResourceState
```
Returns `ids`, `amounts`, `capacities`, `unlocked`, `visible`, `flags`, `definitionDigest`, and optionally embedded automation/transform state.

**CommandQueue** (`packages/core/src/command-queue.ts:207-248`):
```typescript
exportForSave(): SerializedCommandQueueV1
```
Returns `schemaVersion`, `entries[]` with `type`, `priority`, `timestamp`, `step`, `payload`.

**ProgressionCoordinator** (`packages/core/src/progression-coordinator-save.ts:156-200`):
```typescript
serializeProgressionCoordinatorState(
  coordinator: ProgressionCoordinator,
  productionSystem?: { exportAccumulators: () => SerializedProductionAccumulators },
): SerializedProgressionCoordinatorStateV2
```
Returns `step`, `resources`, `generators`, `upgrades`, `achievements`, `productionAccumulators`.

**RNG State** (`packages/core/src/rng.ts`):
- `getCurrentRNGSeed(): number | undefined`
- `setRNGSeed(seed: number): void`
- `getRNGState(): number | undefined`
- `setRNGState(state: number): void`

**Verification Runtime** (`packages/core/src/index.ts:940-979`):
```typescript
createVerificationRuntime(options: CreateVerificationRuntimeOptions): VerificationRuntime
```
Hydrates a runtime from `EconomyStateSummary` for replay verification.

### Gaps

1. No single function to capture all state atomically
2. No checksum computation for fast divergence detection
3. No structured comparison for debugging desyncs
4. Restore requires manual assembly of multiple components

## 6. Proposed Solution

### 6.1 Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    State Sync Protocol                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  captureGameStateSnapshot()                                 │
│  ├── ResourceState.exportForSave()                          │
│  ├── ProgressionCoordinator state                           │
│  ├── AutomationSystem state                                 │
│  ├── TransformSystem state                                  │
│  ├── CommandQueue.exportForSave()                           │
│  └── Runtime metadata (step, stepSizeMs, rngSeed, rngState) │
│                    │                                        │
│                    ▼                                        │
│  ┌─────────────────────────────────────────┐               │
│  │         GameStateSnapshot               │               │
│  │  (unified, versioned, serializable)     │               │
│  └─────────────────────────────────────────┘               │
│           │                    │                           │
│           ▼                    ▼                           │
│  computeStateChecksum()    restoreFromSnapshot()           │
│  (FNV-1a / xxHash32)       (hydrate runtime)               │
│           │                                                │
│           ▼                                                │
│  compareStates(local, remote): StateDiff                   │
│  (field-by-field divergence report)                        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 6.2 Detailed Design

#### 6.2.1 GameStateSnapshot Type

```typescript
// packages/core/src/state-sync/types.ts

export interface GameStateSnapshot {
  /** Schema version for forward compatibility */
  readonly version: 1;

  /** Capture timestamp (wall clock, for diagnostics only) */
  readonly capturedAt: number;

  /** Runtime metadata */
  readonly runtime: {
    readonly step: number;
    readonly stepSizeMs: number;
    readonly rngSeed: number | undefined;
    readonly rngState?: number;
  };

  /** Serialized resource state */
  readonly resources: SerializedResourceState;

  /** Serialized progression coordinator state */
  readonly progression: SerializedProgressionCoordinatorStateV2;

  /** Serialized automation states */
  readonly automation: readonly SerializedAutomationState[];

  /** Serialized transform states */
  readonly transforms: readonly SerializedTransformState[];

  /** Serialized command queue */
  readonly commandQueue: SerializedCommandQueueV1;
}
```

#### 6.2.2 Snapshot Capture API

```typescript
// packages/core/src/state-sync/capture.ts

export interface CaptureSnapshotOptions {
  /** Runtime instance to capture */
  readonly runtime: IdleEngineRuntime;

  /** Progression coordinator to capture */
  readonly progressionCoordinator: ProgressionCoordinator;

  /** Optional timestamp override (wall clock, diagnostic only) */
  readonly capturedAt?: number;

  /** Automation system state extractor */
  readonly getAutomationState: () => ReadonlyMap<string, AutomationState>;

  /** Transform system state extractor */
  readonly getTransformState: () => ReadonlyMap<string, TransformState>;

  /** Command queue to capture */
  readonly commandQueue: CommandQueue;

  /** Optional production system for accumulators */
  readonly productionSystem?: { exportAccumulators: () => SerializedProductionAccumulators };
}

export function captureGameStateSnapshot(
  options: CaptureSnapshotOptions,
): GameStateSnapshot {
  const {
    runtime,
    progressionCoordinator,
    capturedAt,
    getAutomationState,
    getTransformState,
    commandQueue,
    productionSystem,
  } = options;

  const automationState = getAutomationState();
  const transformState = getTransformState();

  return {
    version: 1,
    capturedAt: capturedAt ?? Date.now(),
    runtime: {
      step: runtime.getCurrentStep(),
      stepSizeMs: runtime.getStepSizeMs(),
      rngSeed: getCurrentRNGSeed(),
      rngState: getRNGState(),
    },
    resources: progressionCoordinator.resourceState.exportForSave(),
    progression: serializeProgressionCoordinatorState(
      progressionCoordinator,
      productionSystem,
    ),
    automation: serializeAutomationState(automationState),
    transforms: serializeTransformState(transformState),
    commandQueue: commandQueue.exportForSave(),
  };
}
```

Note: automation/transforms are captured as top-level fields; `resources.exportForSave()` intentionally omits embedded automation/transform state to match the existing save format and avoid duplication. Resources are exported from the progression coordinator to keep the snapshot internally consistent.
Captured timestamps are diagnostic only; use `capturedAt` in `CaptureSnapshotOptions` when you need a deterministic value (e.g., tests or snapshot diffing).

#### 6.2.3 Checksum Computation

Based on research, FNV-1a is optimal for game state hashing due to:
- Excellent performance on small-to-medium data (&lt;1KB typical game state)
- Simple implementation (no dependencies)
- Good distribution properties
- Deterministic across platforms

For larger states (>10KB), xxHash32 provides better throughput.

```typescript
// packages/core/src/state-sync/checksum.ts

const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;
const utf8Encoder = new TextEncoder();

function normalizeForDeterministicJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForDeterministicJson(entry));
  }

  const result: Record<string, unknown> = {};
  const keys = Object.keys(value).sort();
  for (const key of keys) {
    result[key] = normalizeForDeterministicJson(
      (value as Record<string, unknown>)[key],
    );
  }
  return result;
}

function stringifyDeterministic(value: unknown): string {
  return JSON.stringify(normalizeForDeterministicJson(value));
}

/**
 * Compute FNV-1a hash of a Uint8Array.
 * Returns a 32-bit hash as an 8-character hex string.
 */
export function fnv1a32(data: Uint8Array): string {
  let hash = FNV_OFFSET_BASIS_32;
  for (let i = 0; i < data.length; i++) {
    hash ^= data[i];
    hash = Math.imul(hash, FNV_PRIME_32) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Compute a deterministic checksum for a game state snapshot.
 *
 * The checksum excludes capturedAt, since it is diagnostic only. The remaining
 * fields are recursively normalized with sorted keys, serialized to canonical
 * JSON, encoded to UTF-8, and hashed with FNV-1a.
 */
export function computeStateChecksum(snapshot: GameStateSnapshot): string {
  const checksumSnapshot = {
    version: snapshot.version,
    runtime: snapshot.runtime,
    resources: snapshot.resources,
    progression: snapshot.progression,
    automation: snapshot.automation,
    transforms: snapshot.transforms,
    commandQueue: snapshot.commandQueue,
  };

  const json = stringifyDeterministic(checksumSnapshot);
  return fnv1a32(utf8Encoder.encode(json));
}

/**
 * Compute checksum for a partial snapshot (e.g., resources only).
 */
export function computePartialChecksum<K extends keyof GameStateSnapshot>(
  snapshot: GameStateSnapshot,
  keys: readonly K[],
): string {
  const partial: Partial<GameStateSnapshot> = {};
  for (const key of keys) {
    partial[key] = snapshot[key];
  }
  const json = stringifyDeterministic(partial);
  return fnv1a32(utf8Encoder.encode(json));
}
```

#### 6.2.4 Snapshot Restore API

```typescript
// packages/core/src/state-sync/restore.ts

export interface RestoreSnapshotOptions {
  /** Snapshot to restore from */
  readonly snapshot: GameStateSnapshot;

  /** Resource definitions for hydration */
  readonly resourceDefinitions: readonly ResourceDefinition[];

  /** Runtime options (overrides snapshot values if provided) */
  readonly runtimeOptions?: Partial<IdleEngineRuntimeOptions>;

  /** Whether to apply RNG seed from snapshot (default: true) */
  readonly applyRngSeed?: boolean;
}

export interface RestoredRuntime {
  /** Hydrated runtime instance */
  readonly runtime: IdleEngineRuntime;

  /** Hydrated resource state */
  readonly resources: ResourceState;

  /** Reconciliation metadata (added/removed resources) */
  readonly reconciliation: ResourceDefinitionReconciliation;

  /** Restored command queue */
  readonly commandQueue: CommandQueue;
}

export function restoreFromSnapshot(
  options: RestoreSnapshotOptions,
): RestoredRuntime {
  const {
    snapshot,
    resourceDefinitions,
    runtimeOptions,
    applyRngSeed = true,
  } = options;

  const { resources, reconciliation } = hydrateResourceStateFromSerialized(
    snapshot.resources,
    resourceDefinitions,
  );

  const commandQueue = runtimeOptions?.commandQueue ?? new CommandQueue();
  const runtime = resolveRuntimeFactory()({
    ...runtimeOptions,
    commandQueue,
    stepSizeMs: runtimeOptions?.stepSizeMs ?? snapshot.runtime.stepSizeMs,
    initialStep: runtimeOptions?.initialStep ?? snapshot.runtime.step,
  });

  if (applyRngSeed && snapshot.runtime.rngSeed !== undefined) {
    setRNGSeed(snapshot.runtime.rngSeed);
  }
  if (applyRngSeed && snapshot.runtime.rngState !== undefined) {
    setRNGState(snapshot.runtime.rngState);
  }

  const currentStep = runtime.getCurrentStep();
  const rebaseStep =
    currentStep !== snapshot.runtime.step
      ? { savedStep: snapshot.runtime.step, currentStep }
      : undefined;

  commandQueue.restoreFromSave(
    snapshot.commandQueue,
    rebaseStep ? { rebaseStep } : undefined,
  );

  return { runtime, resources, reconciliation, commandQueue };
}

/**
 * Restore only specific components for bandwidth optimization.
 */
export type RestoreMode = 'full' | 'resources' | 'commands';

export interface RestorePartialOptions {
  /** Optional command step rebasing for restores into a different timeline. */
  readonly rebaseCommands?: Readonly<{
    readonly savedStep: number;
    readonly currentStep: number;
  }>;
}

export function restorePartial(
  snapshot: GameStateSnapshot,
  mode: RestoreMode,
  target: {
    resources?: ResourceState;
    commandQueue?: CommandQueue;
  },
  options: RestorePartialOptions = {},
): void {
  const applyResources = () => {
    if (!target.resources) {
      return;
    }
    assertSerializedResourceState(snapshot.resources);
    const remap = buildRemapFromResources(
      target.resources,
      snapshot.resources,
    );
    applySerializedResourceState(
      target.resources,
      snapshot.resources,
      remap,
    );
  };

  const restoreCommands = () => {
    if (!target.commandQueue) {
      return;
    }
    const rebaseStep = options.rebaseCommands;
    target.commandQueue.restoreFromSave(
      snapshot.commandQueue,
      rebaseStep ? { rebaseStep } : undefined,
    );
  };

  switch (mode) {
    case 'full':
      applyResources();
      restoreCommands();
      break;
    case 'resources':
      applyResources();
      break;
    case 'commands':
      restoreCommands();
      break;
  }
}
```

Note: `restoreFromSnapshot()` depends on a runtime factory configured via
`setRestoreRuntimeFactory()`. The public `@idle-engine/core` entrypoints set
this to `IdleEngineRuntime` automatically.

#### 6.2.5 Divergence Detection API

```typescript
// packages/core/src/state-sync/compare.ts

export interface StateDiff {
  /** Whether states are identical */
  readonly identical: boolean;

  /** Runtime metadata differences */
  readonly runtime?: {
    step?: { local: number; remote: number };
    stepSizeMs?: { local: number; remote: number };
    rngSeed?: { local: number | undefined; remote: number | undefined };
    rngState?: { local: number | undefined; remote: number | undefined };
  };

  /** Resource differences (by resource ID) */
  readonly resources?: ReadonlyMap<string, ResourceDiff>;

  /** Progression differences */
  readonly progression?: ProgressionDiff;

  /** Command queue differences */
  readonly commandQueue?: CommandQueueDiff;
}

export interface ResourceDiff {
  readonly id: string;
  readonly amount?: { local: number; remote: number };
  readonly capacity?: { local: number | null; remote: number | null };
  readonly unlocked?: { local: boolean; remote: boolean };
  readonly visible?: { local: boolean; remote: boolean };
}

export interface ProgressionDiff {
  readonly generators?: ReadonlyMap<string, GeneratorDiff>;
  readonly upgrades?: ReadonlyMap<string, UpgradeDiff>;
  readonly achievements?: ReadonlyMap<string, AchievementDiff>;
}

export interface CommandQueueDiff {
  readonly entryCountDiff: { local: number; remote: number };
  readonly missingInLocal: readonly string[];  // command types
  readonly missingInRemote: readonly string[];
}

/**
 * Compare two snapshots and return detailed differences.
 * Useful for debugging desync issues.
 */
export function compareStates(
  local: GameStateSnapshot,
  remote: GameStateSnapshot,
): StateDiff {
  const diff: StateDiff = { identical: true };

  // Compare runtime metadata
  const runtimeDiff = compareRuntime(local.runtime, remote.runtime);
  if (runtimeDiff) {
    diff.runtime = runtimeDiff;
    (diff as { identical: boolean }).identical = false;
  }

  // Compare resources
  const resourceDiff = compareResources(local.resources, remote.resources);
  if (resourceDiff.size > 0) {
    diff.resources = resourceDiff;
    (diff as { identical: boolean }).identical = false;
  }

  // Compare progression
  const progressionDiff = compareProgression(local.progression, remote.progression);
  if (progressionDiff) {
    diff.progression = progressionDiff;
    (diff as { identical: boolean }).identical = false;
  }

  // Compare command queue
  const queueDiff = compareCommandQueues(local.commandQueue, remote.commandQueue);
  if (queueDiff) {
    diff.commandQueue = queueDiff;
    (diff as { identical: boolean }).identical = false;
  }

  return diff;
}

/**
 * Quick divergence check using checksums only.
 * Use this for periodic sync checks; fall back to compareStates() for debugging.
 */
export function hasStateDiverged(
  local: GameStateSnapshot,
  remote: GameStateSnapshot,
): boolean {
  return computeStateChecksum(local) !== computeStateChecksum(remote);
}
```

#### 6.2.6 Usage Patterns

**Snapshots vs checksums**
- Use `computeStateChecksum()` or `hasStateDiverged()` for frequent sync checks.
- Use full snapshots for state transfer, resync, or audit workflows.
- `capturedAt` is excluded from checksums; set it explicitly for deterministic testing.

**Round-trip verification**
```typescript
const snapshot = captureGameStateSnapshot({
  runtime,
  progressionCoordinator,
  commandQueue: runtime.getCommandQueue(),
  getAutomationState: () => getAutomationState(automationSystem),
  getTransformState: () => getTransformState(transformSystem),
  capturedAt: 0,
});

const restored = restoreFromSnapshot({
  snapshot,
  resourceDefinitions,
});

const restoredCoordinator = createProgressionCoordinator({
  content,
  stepDurationMs: snapshot.runtime.stepSizeMs,
  initialState: {
    stepDurationMs: snapshot.runtime.stepSizeMs,
    resources: { state: restored.resources },
  },
});

hydrateProgressionCoordinatorState(
  snapshot.progression,
  restoredCoordinator,
  undefined,
  { skipResources: true },
);

const roundTrip = captureGameStateSnapshot({
  runtime: restored.runtime as IdleEngineRuntime,
  progressionCoordinator: restoredCoordinator,
  commandQueue: restored.commandQueue,
  getAutomationState: () => getAutomationState(automationSystem),
  getTransformState: () => getTransformState(transformSystem),
  capturedAt: 0,
});

const diff = compareStates(snapshot, roundTrip);
console.log('Round-trip identical:', diff.identical);
```

**Debugging desyncs**
```typescript
if (hasStateDiverged(localSnapshot, remoteSnapshot)) {
  const diff = compareStates(localSnapshot, remoteSnapshot);
  console.warn('Desync details:', diff);
}
```

**Partial snapshot/restore for bandwidth**
```typescript
const resourcesChecksum = computePartialChecksum(snapshot, ['resources']);
if (resourcesChecksum !== computePartialChecksum(remoteSnapshot, ['resources'])) {
  restorePartial(snapshot, 'resources', { resources });
}

restorePartial(
  snapshot,
  'commands',
  { commandQueue },
  { rebaseCommands: { savedStep: snapshot.runtime.step, currentStep: runtime.getCurrentStep() } },
);
```

### 6.3 Operational Considerations

#### Deployment

- New module added to `packages/core`; no infrastructure changes required
- Public API exported from `packages/core/src/index.ts`

#### Telemetry & Observability

- Checksum computation time tracked via diagnostics timeline
- Divergence events logged with diff summaries for debugging
- Snapshot size metrics for bandwidth planning

#### Security & Compliance

- Snapshots may contain gameplay progress; no PII by design
- Checksums are non-cryptographic (FNV-1a); use proper signatures for authentication
- Snapshot validation rejects malformed/tampered data

## 7. Work Breakdown & Delivery Plan

### 7.1 Issue Map

| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| feat(core): define GameStateSnapshot type | Type definitions for unified snapshot | Runtime Implementation Agent | None | Types exported; JSDoc complete |
| feat(core): implement captureGameStateSnapshot | Aggregate all state into snapshot | Runtime Implementation Agent | Type definitions | Unit tests; captures all components |
| feat(core): implement computeStateChecksum | FNV-1a checksum for snapshots | Runtime Implementation Agent | Capture API | Determinism test; &lt;100μs benchmark |
| feat(core): implement restoreFromSnapshot | Hydrate runtime from snapshot | Runtime Implementation Agent | Capture API | Round-trip test passes |
| feat(core): implement compareStates | Field-by-field diff for debugging | Runtime Implementation Agent | Type definitions | Diff reports all differences |
| test(core): property-based sync tests | Generate random states; verify invariants | Testing Agent | All APIs | 1000+ cases pass |
| docs(core): state sync API documentation | Usage examples and API reference | Docs Agent | All APIs | Docs reviewed and merged |

### 7.2 Milestones

- **Phase 1**: Core APIs (`captureGameStateSnapshot`, `computeStateChecksum`, `restoreFromSnapshot`)
- **Phase 2**: Debugging tools (`compareStates`, partial checksums)
- **Phase 3**: Integration with future services (cloud sync)

### 7.3 Coordination Notes

- **Hand-off Package**: This design doc, existing serialization code paths, `docs/idle-engine-design.md`
- **Communication Cadence**: One PR per issue-map row; maintain backward compatibility

## 8. Agent Guidance & Guardrails

### Context Packets

Files agents must load before execution:
- `packages/core/src/resource-state.ts` - Existing resource serialization
- `packages/core/src/command-queue.ts` - Command queue serialization
- `packages/core/src/progression-coordinator-save.ts` - Progression serialization
- `packages/core/src/rng.ts` - RNG seed handling
- `packages/core/src/index.ts` - Public API patterns

### Prompting & Constraints

- Use imperative commit messages: `feat(core): add captureGameStateSnapshot`
- Follow existing naming patterns (e.g., `exportForSave` convention)
- Maintain 100% test coverage for new public APIs
- Use type-only imports for TypeScript types
- Keep checksum computation pure and side-effect free

### Safety Rails

- NEVER reset git history or force push to main
- DO NOT introduce non-deterministic behavior (e.g., `Date.now()` in checksums)
- ALWAYS use deterministic JSON serialization (recursive key sorting)
- NEVER modify existing `exportForSave()` signatures

### Validation Hooks

Commands agents must run:
- `pnpm lint` - Code style
- `pnpm typecheck` - Type safety
- `pnpm test --filter @idle-engine/core` - Unit tests
- `pnpm build` - Build verification

## 9. Alternatives Considered

### Delta Synchronization Instead of Snapshots

**Approach**: Send only changed fields between sync points.

**Trade-offs**:
- Pro: Lower bandwidth for incremental updates
- Con: Significantly more complex; requires change tracking infrastructure
- Con: Error accumulation risk if delta is lost

**Decision**: Start with full snapshots; delta compression can layer on top as bandwidth optimization in transport layer.

### Cryptographic Hashing (SHA-256)

**Approach**: Use SHA-256 for tamper detection.

**Trade-offs**:
- Pro: Cryptographic security for integrity
- Con: 10-100x slower than FNV-1a
- Con: Overkill for desync detection (not a security boundary)

**Decision**: Use FNV-1a for performance; rely on transport-layer signatures for authentication.

### xxHash Instead of FNV-1a

**Approach**: Use xxHash32 for all checksums.

**Trade-offs**:
- Pro: Faster for large data (>1KB)
- Con: Requires WASM/native dependency or pure JS implementation
- Con: FNV-1a is faster for typical game state sizes (&lt;1KB)

**Decision**: Start with FNV-1a (zero dependencies); add xxHash option if profiling shows need.

### Per-Component Checksums

**Approach**: Compute separate checksums for resources, progression, commands.

**Trade-offs**:
- Pro: Identifies which subsystem diverged
- Con: Multiple hash computations per sync
- Con: Cross-component consistency still requires full comparison

**Decision**: Implement `computePartialChecksum()` for debugging; primary API uses full checksum.

## 10. Testing & Validation Plan

### Unit / Integration

- **Capture tests**: Verify all state components included in snapshot
- **Checksum determinism**: Same state produces identical checksum across runs
- **Round-trip tests**: `capture → serialize → deserialize → restore → capture` produces identical snapshot
- **Checksum uniqueness**: Different states produce different checksums (collision resistance)
- **Comparison tests**: `compareStates()` identifies all field differences

### Performance

- **Checksum benchmark**: &lt;100μs for typical game state (~100 resources, 50 generators)
- **Capture benchmark**: &lt;1ms for full snapshot
- **Restore benchmark**: &lt;5ms for full hydration

### Property-Based Tests

```typescript
// Generate random game states
// Verify: capture(restore(capture(state))) === capture(state)
// Verify: checksum(state1) !== checksum(state2) when state1 !== state2
```

## 11. Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Checksum collisions causing missed divergence | High | Low | Use 32-bit hash; upgrade to 64-bit if collisions observed |
| JSON serialization non-determinism | High | Medium | Explicitly sort keys; add determinism tests |
| Performance regression on large states | Medium | Low | Benchmark during development; optimize hot paths |
| Schema evolution breaking compatibility | High | Medium | Version field in snapshot; migration utilities |
| Floating-point serialization drift | High | Medium | Use JSON.stringify (IEEE 754); document precision limits |

## 12. Rollout Plan

### Milestones

1. **Core APIs**: Implement and test snapshot/checksum/restore
2. **Integration**: Wire into Worker bridge for UI sync diagnostics
3. **Server Validation**: Integrate with future backend verification (TBD)

### Migration Strategy

- New APIs are additive; existing code unaffected
- Snapshot format versioned from v1; future migrations use version field

### Communication

- API documentation published with release
- Migration guide if breaking changes in future versions

## 13. Open Questions

1. **Checksum algorithm upgrade path**: Should we support pluggable hash algorithms, or is FNV-1a sufficient long-term?
2. **Partial restore granularity**: Which subsets of state are useful for bandwidth optimization (resources only, commands only, etc.)?
3. **Snapshot compression**: Should the protocol define optional compression, or leave that to transport?
4. **Floating-point precision**: Should we quantize floats before hashing to avoid IEEE 754 edge cases?

Decision: capture `runtime.rngState` in snapshots and restore it when present to
support restore-and-continue determinism without changing the v1 schema.

## 14. Follow-Up Work

- **Delta synchronization**: Layer delta compression on snapshots for bandwidth optimization
- **Client prediction**: Build on restore/compare APIs for prediction with rollback
- **Server continuous validation**: Optional mode where server runs shadow simulation
- **Snapshot versioning/migration**: Utilities for upgrading old snapshot formats
- **Binary serialization**: Replace JSON with MessagePack for size reduction

## 15. References

- `packages/core/src/resource-state.ts:1283-1341` - Resource serialization
- `packages/core/src/command-queue.ts:207-248` - Command queue serialization
- `packages/core/src/progression-coordinator-save.ts:156-200` - Progression serialization
- `packages/core/src/rng.ts` - RNG seed handling
- `packages/core/src/index.ts:940-979` - Verification runtime pattern
- `packages/core/src/index.ts:499-591` - EconomyStateSummary pattern
- `docs/idle-engine-design.md` - Engine architecture
- [Gaffer On Games: State Synchronization](https://gafferongames.com/post/state_synchronization/)
- [Gaffer On Games: Deterministic Lockstep](https://gafferongames.com/post/deterministic_lockstep/)
- [Gaffer On Games: Snapshot Compression](https://gafferongames.com/post/snapshot_compression/)
- [Gabriel Gambetta: Client-Side Prediction and Server Reconciliation](https://www.gabrielgambetta.com/client-side-prediction-server-reconciliation.html)
- [Aras Pranckevičius: Hash Function Tests](https://aras-p.info/blog/2016/08/09/More-Hash-Function-Tests/)

## Appendix A - Glossary

- **Snapshot**: Complete serialized state of the game at a specific simulation step
- **Checksum**: Fast hash of snapshot for divergence detection (not cryptographic)
- **Divergence/Desync**: When client and server states differ unexpectedly
- **Round-trip invariant**: Property that capture → restore produces identical state
- **FNV-1a**: Fowler-Noll-Vo hash function variant; fast, simple, good distribution
- **Hydration**: Process of reconstructing runtime objects from serialized data

## Appendix B - Change Log

| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2025-12-19 | Idle Engine Docs Agent | Initial draft for #544 |
| 2025-12-22 | Codex | Mark Phase 1-2 implementation status for #544 |
