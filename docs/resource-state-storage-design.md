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

  // Live, mutating views
  readonly amounts: Float64Array;
  readonly capacities: Float64Array;
  readonly incomePerSecond: Float64Array;
  readonly expensePerSecond: Float64Array;
  readonly netPerSecond: Float64Array;
  readonly tickDelta: Float64Array;
  readonly flags: Uint8Array;

  // Most recent published snapshot views (double-buffered)
  readonly publishAmounts: Float64Array;
  readonly publishCapacities: Float64Array;
  readonly publishIncomePerSecond: Float64Array;
  readonly publishExpensePerSecond: Float64Array;
  readonly publishNetPerSecond: Float64Array;
  readonly publishTickDelta: Float64Array;
  readonly publishFlags: Uint8Array;

  readonly dirtyIndexScratch: Uint32Array;
  readonly dirtyIndexPublish: Uint32Array;
}
```

- `ids`: canonical resource ordering derived from the active content pack.
- `indexById`: `ImmutableMapSnapshot` for O(1) lookup that throws on any attempt
  to mutate it post-initialization.
- `amounts`: current balances (double precision for cumulative accuracy).
- `capacities`: hard caps enforced on mutation; populated from definitions and
  upgrade modifiers.
- `incomePerSecond` / `expensePerSecond`: running totals populated by systems
  each tick to support production diagnostics and UI stat panels. These values
  are mirrored into the publish buffers before `resetPerTickAccumulators` clears
  the live arrays so rate changes survive the publish/reset cycle.
- `netPerSecond`: derived buffer updated at the end of each tick to avoid
  recomputing `income - expense` during reads.
- `tickDelta`: tracks the signed delta applied during the current tick, enabling
  compact state diffs for the presentation layer and recorder.
- `flags`: bit field storing boolean metadata. Bits are allocated as
  `VISIBLE = 1 << 0`, `UNLOCKED = 1 << 1`, and `DIRTY_THIS_TICK = 1 << 2`.
  Mutation helpers set the dirty bit only when they apply a substantive change
  (amount, capacity, visibility, or net rates). Follow-up operations that restore
  parity with the published state clear the bit via `unmarkIfClean`, keeping the
  dirty list minimal heading into publish.
- `publishAmounts` / `publishCapacities` / `publishIncomePerSecond` /
  `publishExpensePerSecond` / `publishNetPerSecond` / `publishTickDelta`:
  read-only copies of the live buffers used to serve the most
  recent snapshot. Only dirty indices are copied into these arrays during
  `snapshot({ mode: 'publish' })`, guaranteeing consumers never observe later
  mutations.
- `publishFlags`: bit field mirrored from `flags` at publish time so visibility /
  unlock changes stay stable for downstream readers. The publish path masks out
  the internal `DIRTY_THIS_TICK` bit so consumers never observe engine-only
  bookkeeping.
- `dirtyIndexScratch`: reusable scratch space sized to `resourceCount`. The data
  structure stores a compact list of mutated indices during the tick without
  allocating new arrays.
- `dirtyIndexPublish`: a second `Uint32Array` sized to `resourceCount`. Snapshot
  publication copies the scratch prefix into this buffer so the scratch array
  can be cleared immediately even if new mutations arrive before consumers
  finish reading the published view.

All live numeric buffers share a single `ArrayBuffer` per numeric width to
improve serialization locality while keeping independent views disjoint. The
Float64 views (`amounts`, `capacities`, `incomePerSecond`, `expensePerSecond`,
`netPerSecond`, `tickDelta`) are carved out of a backing buffer sized as
`Float64Array.BYTES_PER_ELEMENT * 6 * resourceCount`. The publish buffers reuse
a second Float64 `ArrayBuffer` sized for the copied views
(`publishAmounts`, `publishCapacities`, `publishIncomePerSecond`,
`publishExpensePerSecond`, `publishNetPerSecond`, `publishTickDelta`) so the
live buffers can reset without invalidating the latest snapshot. Each typed
array is constructed with an offset stride (`amounts` at offset `0`,
`capacities` at `1 * stride`, etc.). The `dirtyIndexScratch` array uses a
dedicated `ArrayBuffer`, as do the Uint8 flag bits (`flags` for live state,
`publishFlags` for the published mirror).

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
  snapshot(options?: { mode?: 'publish' | 'recorder' }): ResourceStateSnapshot;
  exportForSave(): SerializedResourceState;
}
```

- Mutation helpers return the actual delta applied to support downstream
  bookkeeping.
- `requireIndex(id)` wraps `getIndex` with an invariant check that throws and
  emits telemetry when presented with an unknown id. Index-based helpers call
  an internal `assertValidIndex(index)` guard so typed arrays never absorb
  silent out-of-bounds writes.
- A private `markDirty(index: number)` helper ensures each index is tracked only
  once per tick by checking the dirty bit before pushing into the scratch list.
  The helper is invoked only after confirming the live state diverges from the
  most recent publish snapshot (amount, capacity, income, expense, net, or
  flags). If a later mutation restores parity with the published state,
  `unmarkIfClean(index)` swaps the index out of the scratch list and clears the
  dirty bit so zero-delta work never leaks into the publish pipeline.
- `finalizeTick(deltaMs)` converts accumulated per-second rates into tick
  deltas, clamps amounts to capacities/zero, recomputes `netPerSecond`, and
  relies on `markDirty` + `unmarkIfClean` to ensure only indices with meaningful
  divergence remain dirty at the end of the tick (cancelling incomes/expenses do
  not surface spurious deltas).
- `resetPerTickAccumulators()` clears the live `incomePerSecond`,
  `expensePerSecond`, and `tickDelta` arrays after publish while leaving the
  mirrored publish buffers untouched thanks to the double-buffered publish
  arrays.
- `clearDirtyScratch()` clears residual dirty metadata and associated flag bits
  after authoritative calls to `snapshot({ mode: 'publish' })` complete (the
  snapshot path itself resets the scratch length to zero). This helper exists for
  test harnesses, migration tools, or debugging consoles that intentionally skip
  the publish path. Production code relies on `snapshot({ mode: 'publish' })`
  instead of calling `clearDirtyScratch()` directly.
- `snapshot(options)` defaults to `{ mode: 'publish' }`. Callers opt into
  recorder mode explicitly so accidental captures do not skip the publish reset.

 The façade tracks the active length in a `dirtyIndexCount` field; the valid
 portion of `dirtyIndexScratch` lives in `[0, dirtyIndexCount)`. Mutations append
 indices only when the dirty bit transitions from clear to set, guaranteeing that
 each index appears at most once per tick without extra allocations. When
 `unmarkIfClean` runs, it removes the index with a tail swap inside the same
 buffer and decrements `dirtyIndexCount`, preserving the compact prefix without
 secondary allocations.

### 5.3 Initialization & Lifecycle

Provide a factory `createResourceState(defs: readonly ResourceDefinition[])`
that:

1. Validates incoming definitions without reordering so designer-authored order
   is preserved and surfaces deterministically in presentation. The content pack
   compiler guarantees a stable array order; the factory verifies uniqueness by
   inserting ids into a `Set` and throws on duplicates.
2. Allocates typed arrays sized to the resource count, pre-filling `amounts`
   with `startAmount`, `capacities` with either `definition.capacity` (future) or
   `Number.POSITIVE_INFINITY` when absent, and mirroring those values into the
   publish buffers (`publishAmounts`, `publishCapacities`,
   `publishIncomePerSecond`, `publishExpensePerSecond`, `publishNetPerSecond`,
   `publishTickDelta`) so the initial snapshot requires no additional copying.
   The
   save serializer treats `Number.POSITIVE_INFINITY` as `null` to avoid lossy
   JSON round-trips.
3. Initializes `flags` with `VISIBLE | UNLOCKED` for starting resources and
   zero for locked ones.
4. Wraps `ids` in `Object.freeze` and converts the `indexById` lookup table into
   an `ImmutableMapSnapshot` via the existing `enforceImmutable(...)` helper so
   any attempt to mutate it throws at runtime.
5. Seeds the `dirtyIndexScratch` array with a sentinel length counter of `0`
   (tracked separately inside the façade) so the first mutation appends in-place.

On content reload or save restore, callers reuse the factory with definitions
and then hydrate numeric buffers from persisted data. Hydration writes restored
amount/capacity/net values into both the live and publish typed arrays, resets
income/expense/tick deltas to `0` in both views, and clears the dirty scratch
counter so the next `snapshot({ mode: 'publish' })` immediately reflects the
restored state without forcing a full-tick recomputation. The runtime stores the
`ResourceState` inside the broader game state object managed by
`setGameState(...)`.

### 5.4 Mutation Semantics

- **Additions:** `addAmount` increases `amounts[index]`, clamping to capacity by
  default unless the optional `clamp` argument is explicitly set to `false`.
  Negative input throws to catch misuse; callers use `spendAmount` for
  decrements. If the applied delta resolves to zero (e.g. already at cap or the
  caller adds `0`), the helper returns `0` and avoids calling `markDirty`. When
  the applied delta is non-zero, it accumulates into `tickDelta[index]` and
  `markDirty` tracks the index exactly once for the tick.
- **Spending:** `spendAmount` verifies `amounts[index] >= amount` before
  subtracting. It returns `true/false` to signal insufficient resources and
  never allows negative balances. Successful spends subtract from both
  `amounts[index]` and `tickDelta[index]`, then call `markDirty`. If the spend
  later gets cancelled by a compensating `addAmount` before publish, the helper
  calls `unmarkIfClean` to drop the index from the scratch list. When spending
  fails, telemetry records a `ResourceSpendFailed` event with the offending
  command/system id and the guard throws if the caller attempts to subtract a
  negative amount.
- **Per-second accumulation:** Systems call `applyIncome` / `applyExpense`
  during their tick. Each helper adds to (`+=`) `incomePerSecond[index]` and
  `expensePerSecond[index]`, allowing multiple systems to compose within a
  single frame. Helpers ignore zero-valued inputs and mark the resource dirty
  only when the accumulator changes from its previous value compared to the
  publish buffers. If opposing calls cancel each other within the same tick,
  `unmarkIfClean` clears the dirty flag and the publish arrays retain the prior
  rates.
- **Capacity updates:** `setCapacity` validates the requested capacity (must be
  `>= 0`, not `NaN`; `Infinity` is permitted to represent uncapped resources)
  before writing into the buffer. Invalid values log telemetry and throw. On
  success the helper clamps the current amount if it now exceeds the cap
  (recording that clamp as a delta in `tickDelta`), calls `markDirty`, mirrors the
  cap into the publish buffer, and returns the applied cap so command handlers
  can publish diffs.
- **Visibility/unlock:** `grantVisibility` and `unlock` set bits inside the
  flag buffer and mark the resource dirty so the UI is notified.

Dirty tracking (flag bit `0b100`) is cleared inside `snapshot({ mode: 'publish' })`
only after the live values and flag bits have been copied into the publish
buffers. Clearing the bit at this point keeps the underlying live buffers
mutable while guaranteeing the published snapshot remains immutable.

Every index-based helper calls `assertValidIndex(index)`, which verifies
`index >= 0 && index < resourceCount`, logs a `ResourceIndexViolation` telemetry
event, and throws when the guard fails. Command handlers invoke `requireIndex`
so the guard fires at lookup time rather than after a mutation attempt.

### 5.5 Snapshot & Persistence

- `snapshot({ mode: 'publish' })` returns an immutable view
  (`ResourceStateSnapshot`) containing:
  - `ids` (frozen array)
  - Read-only typed-array proxies that expose the double-buffered publish views
    (`publishAmounts`, `publishCapacities`, `publishIncomePerSecond`,
    `publishExpensePerSecond`, `publishNetPerSecond`, `publishTickDelta`,
    `publishFlags`). A dedicated helper
    (`createReadOnlyTypedArrayView`) wraps each publish array so mutator traps
    throw, ensuring consumers see a stable frame even while the live buffers are
    reset for the next tick.
  - A compact list of dirty indices for the current tick derived from the
    populated prefix of `dirtyIndexScratch`. During publish the runtime walks the
    prefix, revalidates each index against the publish buffers (amount, capacity,
    income, expense, net, flags), and skips any entries that have reverted to
    their prior values.
    Skipped indices have their `publishTickDelta` zeroed and their dirty bit
    cleared immediately. Surviving indices copy into `dirtyIndexPublish`, receive
    the filtered `publishAmounts`/`publishCapacities`/
    `publishIncomePerSecond`/`publishExpensePerSecond`/`publishNetPerSecond`/
    `publishTickDelta`/flag updates, and keep the dirty bit set until the copy
    completes. The publish path then clears the bit, exposes
    `dirtyIndexPublish.subarray(0, filteredCount)` via the read-only wrapper, and
    resets the scratch counter so subsequent mutations do not trample the
    published delta.
  - Flag bits encoded as a read-only `Uint8Array` snapshot sourced from
    `publishFlags`.
- `snapshot({ mode: 'recorder' })` returns the same shape but clones its data
  into ephemeral typed arrays owned by the recorder call site (amount, capacity,
  income, expense, net, tick delta, flags). This mode does not touch dirty
  bookkeeping, publish mirrors, or per-tick accumulators, allowing
  pre/post-command captures without interfering with the presentation pipeline.
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

Offline catch-up consumes `SerializedResourceState`, rehydrates the live typed
arrays, and continues deterministic execution. The save payload intentionally
omits per-second income/expense data because they are tick-scoped diagnostics;
the runtime zeros those buffers (both live and publish views) on restore and
regenerates fresh rates during the next tick.

Consumers always read deltas through the dirty index list. The publish step
zeros `publishTickDelta` for cleared indices and leaves untouched entries with
their prior values, so downstream readers must honor the filtered dirty list
instead of re-scanning the entire buffer each frame.

During `snapshot({ mode: 'publish' })` the builder iterates the
`dirtyIndexScratch` prefix, copies dirty indices into the publish arrays,
clears the `DIRTY_THIS_TICK` bit inside the live flag buffer, and then resets
`dirtyIndexCount` to zero. Because publish buffers store the copied values,
subsequent calls to `finalizeTick`, `resetPerTickAccumulators`, or additional
mutations cannot invalidate the frame released to consumers. `clearDirtyScratch()`
exists as an escape hatch for test harnesses that need to force-reset the live
buffers and flag bits without emitting a snapshot.

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
  with updated `amount`, `capacity`, per-second rates, `netPerSecond`, and
  `visibility` flags.
- **Command recorder:** The recorder uses `snapshot({ mode: 'recorder' })`
  before/after command execution to capture deterministic replays; this mode
  deep-clones the live view so structured cloning succeeds without disturbing
  the dirty tracking that the presentation layer relies on.

### 5.7 Implementation Plan

1. Scaffold `packages/core/src/resource-state.ts` with the buffer structs,
   factory, and façade.
2. Wire the module into existing exports (`packages/core/src/index.ts`).
3. Add Vitest coverage for initialization, mutation semantics, dirty tracking,
   duplicate-id guarding, snapshot generation (including `null` persistence for
   uncapped capacities), income/expense publish mirroring, and rehydration from
   persisted saves.
4. Update command handlers (future issue) to depend on `ResourceState`.
5. Extend documentation (`docs/runtime-command-queue-design.md`) with references
   to the new storage contract after implementation lands.

## 6. Testing Strategy

- Unit tests verifying:
  - Deterministic index ordering from unordered definitions.
  - Duplicate ids throw during initialization.
  - Capacity enforcement (including accepting `Infinity`) and telemetry emission
    on attempted overflows.
  - Spending failure paths leave balances untouched.
  - `requireIndex` and `assertValidIndex` telemetry + throw on unknown ids or
    out-of-range indices.
  - `finalizeTick` converts rates into clamped deltas given various `deltaMs`.
  - Zero-value income/expense submissions do not mark resources dirty and rate
    changes propagate into the publish buffers.
  - `snapshot({ mode: 'publish' })` resets the dirty scratch counter while leaving
    the published delta accessible and read-only through the double-buffered
    proxies.
  - `snapshot({ mode: 'recorder' })` leaves dirty tracking and live buffers
    untouched while returning a deep-clone suitable for structured cloning.
  - Dirty index tracking only flags mutated resources per tick.
  - `exportForSave()` serializes uncapped capacities as `null` and rehydrates to
    `Number.POSITIVE_INFINITY`.
  - Rehydration from saves updates both live and publish buffers so the first
    publish after restore reflects the persisted values.
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
- **Proxy guard complexity:** Zero-copy typed-array proxies must replicate the
  existing immutability guarantees. The implementation will live alongside the
  existing snapshot utilities and include exhaustive tests for mutator trapping.

## 8. Decisions & Clarifications

- **Prestige currencies:** Prestige and primary currencies share the same
  `ResourceState`. Content packs tag prestige entries in their definitions, and
  the runtime stores that metadata alongside the immutable `ids` array so
  systems can branch without duplicating buffers.
- **Ordering:** Resource definitions keep the order supplied by the content pack.
  The pack compiler owns determinism of that ordering, and the factory validates
  duplicates without re-sorting so design-authored presentation remains intact.
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
- `setCapacity` accepts `Infinity` to re-establish uncapped resources while
  continuing to reject `NaN` and negatives.
- Save rehydration writes values into both live and publish buffers and clears
  dirty scratch state before the next tick processes.

## 9. Acceptance Criteria

- Struct-of-arrays `ResourceState` module checked into `packages/core`.
- Deterministic initialization from sample content definitions.
- Mutation helpers enforce caps, permit `Infinity` for uncapped resources, and
  prevent negative balances.
- `requireIndex`/`assertValidIndex` guard invalid lookups with telemetry and
  exceptions.
- Snapshot API returns immutable data compatible with `CommandRecorder`.
- Snapshots expose zero-copy, read-only typed array views through the new proxy
  helper, including income/expense rates.
- Dirty index scratch list powers delta publications without heap churn.
- Save rehydration updates both live and publish buffers so the next publish
  reflects persisted state without a warm-up tick.
- Unit tests cover initialization, mutation, and snapshot behaviors.
