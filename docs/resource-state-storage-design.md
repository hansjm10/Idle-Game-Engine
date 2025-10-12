# Resource State Storage Design

**Issue:** #7  
**Workstream:** Runtime Core  
**Status:** Design  
**Last Updated:** 2025-10-12

> This document defines the struct-of-arrays resource storage that anchors the
> runtime state model described in `docs/idle-engine-design.md` §9.2. The design
> focuses on deterministic updates, cache-friendly iteration, and snapshot
> ergonomics so downstream systems (production, upgrades, offline catch-up, UI
> diffing) can evolve without revisiting the underlying layout.

## 1. Overview

Issue #7 tracks the initial `ResourceState` container responsible for storing
all mutable resource quantities at runtime. The storage must support
deterministic mutation through commands and systems, efficient aggregation for
per-frame calculations, and inexpensive snapshots for UI consumption and save
serialization. A data-oriented, struct-of-arrays layout keeps iteration costs
bounded as content packs scale and aligns with the performance strategy in
`docs/idle-engine-design.md` §12.

## 2. Goals

- **Deterministic mutations:** All adjustments flow through typed helpers that
  enforce caps, prevent negative balances, and emit telemetry on violations.
- **Struct-of-arrays layout:** Store resource attributes in typed arrays to
  minimize cache misses during systems iteration and to simplify snapshotting.
- **Stable indexing:** Provide a canonical resource index map shared by systems,
  command handlers, and serialization so lookups remain O(1).
- **Incremental deltas:** Track per-tick changes so the runtime can publish
  minimal deltas to the presentation shell and replay logs.
- **Persistence-ready:** Expose immutable snapshots compatible with the existing
  `CommandRecorder` structured clone workflow for deterministic save/restore.

## 3. Non-Goals

- Implementing generator logic, upgrade modifiers, or automation scheduling.
- Designing the content pipeline that emits resource/generator definitions.
- Persisting save data to disk (handled by the snapshot and migration workstream).
- Rendering UI views or formatting resource values for presentation.
- Optimizing for multi-threaded mutation; the runtime remains single-threaded.

## 4. Current State

- `packages/core` exposes `setGameState`/`getGameState` helpers
  (`packages/core/src/runtime-state.ts`) but lacks an opinionated resource
  container.
- Commands targeting resources (`COLLECT_RESOURCE`, `PURCHASE_GENERATOR`) are
  defined but have no backing storage APIs.
- No snapshot contract exists for resource quantities; UI and persistence cannot
  consume structured deltas.
- Prior design docs commit to struct-of-arrays (`docs/idle-engine-design.md`
  §9.2) yet no implementation details exist.

## 5. Proposed Solution

### 5.1 Data Layout

Introduce a `ResourceStateBuffers` struct encapsulating the underlying
ArrayBuffers and typed arrays:

```ts
interface ResourceStateBuffers {
  readonly ids: readonly string[];
  readonly indexById: ImmutableMapSnapshot<string, number>;
  readonly amounts: Float64Array;
  readonly capacities: Float64Array;
  readonly incomePerSecond: Float64Array;
  readonly expensePerSecond: Float64Array;
  readonly netPerSecond: Float64Array;
  readonly tickDelta: Float64Array;
  readonly flags: Uint8Array;
  readonly dirtyIndexScratch: Uint32Array;
}
```

- `ids`: canonical resource ordering derived from the active content pack.
- `indexById`: `ImmutableMapSnapshot` for O(1) lookup that throws on any attempt
  to mutate it post-initialization.
- `amounts`: current balances (double precision for cumulative accuracy).
- `capacities`: hard caps enforced on mutation; populated from definitions and
  upgrade modifiers.
- `incomePerSecond` / `expensePerSecond`: running totals populated by systems
  each tick to support production diagnostics and UI stat panels.
- `netPerSecond`: derived buffer updated at the end of each tick to avoid
  recomputing `income - expense` during reads.
- `tickDelta`: tracks the signed delta applied during the current tick, enabling
  compact state diffs for the presentation layer and recorder.
- `flags`: bit field storing boolean metadata. Bits are allocated as
  `VISIBLE = 1 << 0`, `UNLOCKED = 1 << 1`, and `DIRTY_THIS_TICK = 1 << 2`.
  Mutations always set (`|=`) the dirty bit; it never toggles or clears itself
  mid-tick.
- `dirtyIndexScratch`: reusable scratch space sized to `resourceCount`. The data
  structure stores a compact list of mutated indices for the current tick
  without allocating new arrays.

All numeric buffers share a single `ArrayBuffer` per numeric width to improve
serialization locality while keeping independent views disjoint. The Float64
views (`amounts`, `capacities`, `incomePerSecond`, `expensePerSecond`,
`netPerSecond`, `tickDelta`) are carved out of a single backing buffer sized as
`Float64Array.BYTES_PER_ELEMENT * 6 * resourceCount`. Each typed array is
constructed with an offset stride (`amounts` at offset `0`, `capacities` at
`1 * stride`, etc.). The `dirtyIndexScratch` array uses a dedicated
`ArrayBuffer`, as do the Uint8 flag bits.

`ImmutableMapSnapshot` is already provided by `packages/core/src/immutable-snapshots.ts`
and proxies mutation methods so the lookup table cannot be altered after the
state is created.

### 5.2 Runtime API Surface

Expose a `ResourceState` façade owning the buffers and providing mutation and
query helpers:

```ts
interface ResourceState {
  readonly buffers: ResourceStateBuffers;
  getIndex(id: string): number | undefined;
  requireIndex(id: string): number;
  getAmount(index: number): number;
  getCapacity(index: number): number;
  getNetPerSecond(index: number): number;
  isUnlocked(index: number): boolean;
  isVisible(index: number): boolean;
  grantVisibility(index: number): void;
  unlock(index: number): void;
  setCapacity(index: number, capacity: number): number;
  addAmount(index: number, amount: number, clamp?: boolean): number;
  spendAmount(index: number, amount: number): boolean;
  applyIncome(index: number, amountPerSecond: number): void;
  applyExpense(index: number, amountPerSecond: number): void;
  finalizeTick(deltaMs: number): void;
  resetPerTickAccumulators(): void;
  clearDirtyScratch(): void;
  snapshot(): ResourceStateSnapshot;
  exportForSave(): SerializedResourceState;
}
```

- Mutation helpers return the actual delta applied to support downstream
  bookkeeping.
- `requireIndex(id)` wraps `getIndex` with an invariant check that throws and
  emits telemetry when presented with an unknown id. Index-based helpers call
  an internal `assertValidIndex(index)` guard so typed arrays never absorb
  silent out-of-bounds writes.
- `finalizeTick(deltaMs)` converts accumulated per-second rates into tick
  deltas, clamps amounts to capacities/zero, recomputes `netPerSecond`, and sets
  the dirty flag.
- `resetPerTickAccumulators()` clears `incomePerSecond`, `expensePerSecond`, and
  `tickDelta` after a snapshot publish.
- `clearDirtyScratch()` resets the `dirtyIndexScratch` length counter once a
  snapshot consumer has emitted the accumulated deltas.

The façade tracks the active length in a `dirtyIndexCount` field; the valid
portion of `dirtyIndexScratch` lives in `[0, dirtyIndexCount)`. Mutations append
indices only when the dirty bit transitions from clear to set, guaranteeing that
each index appears at most once per tick without extra allocations.

### 5.3 Initialization & Lifecycle

Provide a factory `createResourceState(defs: readonly ResourceDefinition[])`
that:

1. Sorts incoming definitions deterministically using a locale-independent
   comparator:
   ```ts
   defs.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
   ```
   Duplicate ids throw during this phase so content packs fail fast.
2. Allocates typed arrays sized to the resource count, pre-filling `amounts`
   with `startAmount`, `capacities` with either `definition.capacity` (future) or
   `Number.POSITIVE_INFINITY` when absent. The save serializer treats
   `Number.POSITIVE_INFINITY` as `null` to avoid lossy JSON round-trips.
3. Initializes `flags` with `VISIBLE | UNLOCKED` for starting resources and
   zero for locked ones.
4. Wraps `ids` in `Object.freeze` and converts the `indexById` lookup table into
   an `ImmutableMapSnapshot` via the existing `enforceImmutable(...)` helper so
   any attempt to mutate it throws at runtime.
5. Seeds the `dirtyIndexScratch` array with a sentinel length counter of `0`
   (tracked separately inside the façade) so the first mutation appends in-place.

On content reload or save restore, callers reuse the factory with definitions
and then hydrate numeric buffers from persisted data. The runtime stores the
`ResourceState` inside the broader game state object managed by
`setGameState(...)`.

### 5.4 Mutation Semantics

- **Additions:** `addAmount` increases `amounts[index]`, clamping to capacity by
  default unless the optional `clamp` argument is explicitly set to `false`.
  Negative input throws to catch misuse; callers use `spendAmount` for
  decrements. The applied delta is accumulated into `tickDelta[index]`,
  the dirty bit is set, and the index is appended to `dirtyIndexScratch` the
  first time it is mutated within the current tick.
- **Spending:** `spendAmount` verifies `amounts[index] >= amount` before
  subtracting. It returns `true/false` to signal insufficient resources and
  never allows negative balances. Successful spends subtract from both
  `amounts[index]` and `tickDelta[index]`. When spending fails, telemetry records
  a `ResourceSpendFailed` event with the offending command/system id and the
  guard throws if the caller attempts to subtract a negative amount.
- **Per-second accumulation:** Systems call `applyIncome` / `applyExpense`
  during their tick. Each helper adds to (`+=`) `incomePerSecond[index]` and
  `expensePerSecond[index]`, allowing multiple systems to compose within a
  single frame. Both helpers set the dirty bit and record the index in the
  scratch list if it was not already marked dirty.
- **Capacity updates:** `setCapacity` updates the `capacities` buffer, clamps
  the current amount if it now exceeds the cap (recording that clamp as a delta
  in `tickDelta`) and returns the applied cap so command handlers can publish
  diffs.
- **Visibility/unlock:** `grantVisibility` and `unlock` set bits inside the
  flag buffer and mark the resource dirty so the UI is notified.

Dirty tracking (flag bit `0b100`) is cleared inside `snapshot()` prior to
wrapping the arrays in immutable proxies. Clearing the bit at this point keeps
the underlying buffers mutable while guaranteeing the published snapshot remains
immutable.

Every index-based helper calls `assertValidIndex(index)`, which verifies
`index >= 0 && index < resourceCount`, logs a `ResourceIndexViolation` telemetry
event, and throws when the guard fails. Command handlers invoke `requireIndex`
so the guard fires at lookup time rather than after a mutation attempt.

### 5.5 Snapshot & Persistence

- `snapshot()` returns an immutable view (`ResourceStateSnapshot`) containing:
  - `ids` (frozen array)
  - Immutable typed-array wrappers (leveraging `ImmutableTypedArraySnapshot`
    from `immutable-snapshots.ts`)
  - A compact list of dirty indices for the current tick derived from the
    populated prefix of `dirtyIndexScratch`
  - Flag bits encoded as a read-only `Uint8Array` snapshot
- `exportForSave()` returns a POJO suitable for persistence:

```ts
interface SerializedResourceState {
  readonly ids: readonly string[];
  readonly amounts: readonly number[];
  readonly capacities: readonly (number | null)[];
  readonly unlocked: readonly boolean[];
  readonly visible: readonly boolean[];
}
```

Offline catch-up consumes `SerializedResourceState`, rehydrates the typed arrays,
and continues deterministic execution. The save payload intentionally omits
per-second income/expense data because they are tick-scoped diagnostics; the
runtime zeros those buffers on restore and regenerates fresh rates during the
next tick.

The snapshot builder iterates the `dirtyIndexScratch` prefix, emitting deltas
and clearing the `DIRTY_THIS_TICK` bit for each index before the immutable
wrappers are created. After publication, `clearDirtyScratch()` resets the prefix
length to zero so the next tick starts with an empty slate.

### 5.6 Integration Points

- **Command handlers:** `COLLECT_RESOURCE` routes through `addAmount`,
  `PURCHASE_GENERATOR` and future `APPLY_MODIFIER` commands use `spendAmount`
  and `setCapacity`. All handlers include resource ids to translate into indices
  via `requireIndex`, ensuring invalid content references surface as telemetry.
- **Systems:** Production, automation, and prestige systems receive the shared
  `ResourceState` instance on registration. Each system operates on indices
  rather than ids for tight loops; helper utilities resolve ids only during
  initialization.
- **Telemetry:** The resource module records events via the existing
  `telemetry` facade (`TelemetryEventData`) for invalid operations, capacity
  clamping, and overflow detection. Metrics aggregate per-second income/expense
  totals for diagnostics dashboards.
- **Presentation bridge:** When publishing state to the UI, the runtime emits
  either the full snapshot (initial load) or a delta referencing dirty indices
  with updated `amount`, `capacity`, `netPerSecond`, and `visibility` flags.
- **Command recorder:** The recorder uses `snapshot()` before/after command
  execution to capture deterministic replays; typed array wrappers ensure
  structural cloning without manual serialization.

### 5.7 Implementation Plan

1. Scaffold `packages/core/src/resource-state.ts` with the buffer structs,
   factory, and façade.
2. Wire the module into existing exports (`packages/core/src/index.ts`).
3. Add Vitest coverage for initialization, mutation semantics, dirty tracking,
   duplicate-id guarding, and snapshot generation (including `null` persistence
   for uncapped capacities).
4. Update command handlers (future issue) to depend on `ResourceState`.
5. Extend documentation (`docs/runtime-command-queue-design.md`) with references
   to the new storage contract after implementation lands.

## 6. Testing Strategy

- Unit tests verifying:
  - Deterministic index ordering from unordered definitions.
  - Duplicate ids throw during initialization.
  - Capacity enforcement and telemetry emission on attempted overflows.
  - Spending failure paths leave balances untouched.
  - `requireIndex` and `assertValidIndex` telemetry + throw on unknown ids or
    out-of-range indices.
  - `finalizeTick` converts rates into clamped deltas given various `deltaMs`.
  - Dirty index tracking only flags mutated resources per tick.
  - `exportForSave()` serializes uncapped capacities as `null` and rehydrates to
    `Number.POSITIVE_INFINITY`.
- Snapshot tests ensuring immutable wrappers block mutation attempts.
- Property-based tests (future follow-up) around additive/subtractive symmetry.

## 7. Risks & Mitigations

- **Precision drift & magnitude ceiling:** Using `Float64Array` mitigates
  cumulative rounding error common in idle economies, but values above `2^53`
  lose integer precision. Balance tuning will monitor growth curves and, when
  definitions demand it, graduate to a fixed-point or logarithmic representation
  captured in a follow-up design doc.
- **Serialization cost:** Large typed arrays can inflate save size. Mitigate by
  delta-encoding saves or compressing offline, tracked in a follow-up issue.
- **Content churn:** New resources require reinitialization. Mitigate by
  defining migration utilities that map old saves onto new resource ordering.
- **Future threading needs:** If a separate worker manipulates resources, shared
  buffers would require atomics. Out of scope now; document invariants so future
  work can extend safely.

## 8. Decisions & Clarifications

- **Prestige currencies:** Prestige and primary currencies share the same
  `ResourceState`. Content packs tag prestige entries in their definitions, and
  the runtime stores that metadata alongside the immutable `ids` array so
  systems can branch without duplicating buffers.
- **Income/expense accumulation:** `applyIncome` / `applyExpense` reset to zero
  each tick via `resetPerTickAccumulators`. Rolling averages are calculated by
  analytics code that consumes successive snapshots instead of mutating the core
  buffers.
- **Telemetry format:** Mutations emit structured telemetry events with
  `{resourceId, operation, amountBefore, amountAfter}` payloads. An optional
  diagnostics system aggregates these into per-second summaries for dashboards
  without coupling the storage layer to presentation concerns.
- **Localized labels:** Snapshots expose resource ids only; UI and localization
  layers resolve display names via the content pack metadata. This avoids sharing
  mutable strings or translation maps across module boundaries.

Additional resolved clarifications:

- The factory rejects duplicate resource ids up front, ensuring deterministic
  indexing.
- The tick loop calls `finalizeTick` after systems finish mutating rates and
  balances, emits a snapshot, and then invokes `resetPerTickAccumulators`
  immediately after the publish so subsequent reads observe cleared per-tick
  state.

## 9. Acceptance Criteria

- Struct-of-arrays `ResourceState` module checked into `packages/core`.
- Deterministic initialization from sample content definitions.
- Mutation helpers enforce caps and prevent negative balances.
- `requireIndex`/`assertValidIndex` guard invalid lookups with telemetry and
  exceptions.
- Snapshot API returns immutable data compatible with `CommandRecorder`.
- Dirty index scratch list powers delta publications without heap churn.
- Unit tests cover initialization, mutation, and snapshot behaviors.
