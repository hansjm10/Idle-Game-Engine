---
title: Resource State Storage Design
sidebar_position: N/A
---

# Resource State Storage Design

Use this template when authoring new design proposals or retrofitting existing notes. Fill out every section or state explicitly why it is not applicable. Replace bracketed guidance with project-specific detail before submitting for review. The structure is optimised for an AI-first delivery model where work is decomposed into issues and executed by autonomous agents under human orchestration.

## Document Control
- **Title**: Introduce struct-of-arrays resource storage for deterministic runtime state
- **Authors**: Original design team
- **Reviewers**: N/A
- **Status**: Design
- **Last Updated**: 2025-10-12
- **Related Issues**: #7
- **Execution Mode**: AI-led

## 1. Summary
This document defines the struct-of-arrays resource storage that anchors the runtime state model described in `docs/idle-engine-design.md` §6.2. Issue #7 tracks the initial `ResourceState` container responsible for storing all mutable resource quantities at runtime. The design focuses on deterministic updates, cache-friendly iteration, and snapshot ergonomics so downstream systems (production, upgrades, offline catch-up, UI diffing) can evolve without revisiting the underlying layout. A data-oriented, struct-of-arrays layout keeps iteration costs bounded as content packs scale and aligns with the performance strategy in `docs/idle-engine-design.md` §6.2.

## 2. Context & Problem Statement
- **Background**: The `packages/core` exposes `setGameState`/`getGameState` helpers (`packages/core/src/runtime-state.ts`) but lacks an opinionated resource container. Commands targeting resources (`COLLECT_RESOURCE`, `PURCHASE_GENERATOR`) are defined but have no backing storage APIs. No snapshot contract exists for resource quantities; UI and persistence cannot consume structured deltas. Prior design docs commit to struct-of-arrays (`docs/idle-engine-design.md` §6.2) yet no implementation details exist.
- **Problem**: The runtime needs a deterministic, cache-friendly storage solution for resource quantities that supports efficient mutation, aggregation, snapshotting, and serialization. Without this foundation, downstream systems cannot evolve independently.
- **Forces**: Performance targets require cache-friendly iteration. Deterministic replay and save/restore require snapshot-friendly data structures. Content pack scaling requires O(1) lookups and bounded iteration costs.

## 3. Goals & Non-Goals
### Goals
- **Deterministic mutations:** All adjustments flow through typed helpers that enforce caps, prevent negative balances, and emit telemetry on violations.
- **Struct-of-arrays layout:** Store resource attributes in typed arrays to minimize cache misses during systems iteration and to simplify snapshotting.
- **Stable indexing:** Provide a canonical resource index map shared by systems, command handlers, and serialization so lookups remain O(1).
- **Incremental deltas:** Track per-tick changes so the runtime can publish minimal deltas to the presentation shell and replay logs.
- **Persistence-ready:** Expose immutable snapshots compatible with the existing `CommandRecorder` structured clone workflow for deterministic save/restore.

### Non-Goals
- Implementing generator logic, upgrade modifiers, or automation scheduling.
- Designing the content pipeline that emits resource/generator definitions.
- Persisting save data to disk (handled by the snapshot and migration workstream).
- Rendering UI views or formatting resource values for presentation.
- Optimizing for multi-threaded mutation; the runtime remains single-threaded.

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**: Runtime Core workstream
- **Agent Roles**: Runtime Implementation Agent (responsible for implementing the storage layer), Docs Agent (for documentation updates)
- **Affected Packages/Services**: `packages/core`
- **Compatibility Considerations**: Backward compatibility required for save file formats; API stability promises for public `ResourceState` interface.

## 5. Current State
- `packages/core` exposes `setGameState`/`getGameState` helpers (`packages/core/src/runtime-state.ts`) but lacks an opinionated resource container.
- Commands targeting resources (`COLLECT_RESOURCE`, `PURCHASE_GENERATOR`) are defined but have no backing storage APIs.
- No snapshot contract exists for resource quantities; UI and persistence cannot consume structured deltas.
- Prior design docs commit to struct-of-arrays (`docs/idle-engine-design.md` §6.2) yet no implementation details exist.

## 6. Proposed Solution
### 6.1 Architecture Overview
The solution introduces a `ResourceState` façade that owns struct-of-arrays typed buffers internally while providing mutation and query helpers. The storage uses a double-buffered publish pattern to enable zero-copy snapshots while maintaining cache-friendly iteration performance. All mutations flow through the façade, ensuring capacity enforcement, dirty tracking, and telemetry emission.

### 6.2 Detailed Design

#### Data Layout

Introduce a `ResourceStateBuffers` struct encapsulating the underlying ArrayBuffers and typed arrays:

```ts
interface ResourcePublishBuffers {
  readonly amounts: Float64Array;
  readonly capacities: Float64Array;
  readonly incomePerSecond: Float64Array;
  readonly expensePerSecond: Float64Array;
  readonly netPerSecond: Float64Array;
  readonly tickDelta: Float64Array;
  readonly flags: Uint8Array;
  readonly dirtyTolerance: Float64Array;
  readonly dirtyIndices: Uint32Array;
  dirtyCount: number;
}

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
  readonly dirtyTolerance: Float64Array;

  // Double-buffered publish views (ping-pong)
  readonly publish: readonly [ResourcePublishBuffers, ResourcePublishBuffers];

  readonly dirtyIndexScratch: Uint32Array;
  readonly dirtyIndexPositions: Int32Array;
}
```

- `ids`: canonical resource ordering derived from the active content pack.
- `indexById`: `ImmutableMapSnapshot` for O(1) lookup that throws on any attempt to mutate it post-initialization.
- `amounts`: current balances (double precision for cumulative accuracy).
- `capacities`: hard caps enforced on mutation; populated from definitions and upgrade modifiers.
- `incomePerSecond` / `expensePerSecond`: running totals populated by systems each tick to support production diagnostics and UI stat panels. These values are mirrored into the publish buffers before `resetPerTickAccumulators` clears the live arrays so rate changes survive the publish/reset cycle.
- `netPerSecond`: derived buffer updated whenever rate accumulators change (and recomputed during `finalizeTick`) to avoid recomputing `income - expense` during reads.
- `tickDelta`: tracks the signed delta applied during the current tick, enabling compact state diffs for the presentation layer and recorder.
- `flags`: bit field storing boolean metadata. Bits are allocated as `VISIBLE = 1 << 0`, `UNLOCKED = 1 << 1`, and `DIRTY_THIS_TICK = 1 << 2`. Mutation helpers set the dirty bit only when they apply a substantive change (amount, capacity, visibility, or net rates). Follow-up operations that restore parity with the published state clear the bit via `unmarkIfClean`, keeping the dirty list minimal heading into publish.
- `dirtyTolerance`: per-resource tolerance ceiling (defaults to `DIRTY_EPSILON_CEILING`). When a resource definition supplies `dirtyTolerance`, the factory writes the normalized value (clamped to `>= DIRTY_EPSILON_ABSOLUTE` and `<= DIRTY_EPSILON_OVERRIDE_MAX`) into this buffer and `epsilonEquals` reads it instead of the default ceiling so prestige-scale resources can relax their tolerance without mutating global constants. The runtime treats these tolerances as immutable metadata outside initialization, hydration, or content reload flows, so dirty tracking deliberately ignores the field during per-tick mutation.
- `publish`: pair of `ResourcePublishBuffers` used in a ping-pong pattern. Each buffer owns read-only copies of amounts, caps, per-second diagnostics, deltas, flags, tolerance ceilings, and the filtered list of dirty indices that back the most recent snapshot. `snapshot({ mode: 'publish' })` writes into the inactive publish buffer and then flips the active pointer. Because only two publish buffers exist, the previous snapshot (the one created immediately before the current publish) remains isolated, but snapshots retained for more than one publish must deep-clone their data if they need to remain immutable. To keep clean resources aligned when buffers swap without replaying the entire buffer, the publish path replays the prior frame's dirty indices into the inactive buffer before applying the new tick's updates. The steps are:
  1. Zero `targetPublish.tickDelta` only for indices recorded in either the previous publish's dirty list or the current tick's scratch union to avoid `O(resourceCount)` work when the dirty set is small.
  2. Iterate the prefix of `sourcePublish.dirtyIndices` up to `sourcePublish.dirtyCount` and copy the corresponding slots (amounts, caps, rates, flags, tolerance) from `sourcePublish` into the inactive buffer so everything that moved last tick is already correct while leaving `tickDelta` at zero.
  3. Apply the current tick's dirty updates.
  Resources that stay clean for two consecutive ticks never move, keeping the copy cost proportional to the union of the previous and current dirty sets instead of `O(resourceCount)`. Each publish buffer maintains a mutable `dirtyCount` that records how much of its `dirtyIndices` array is populated; the snapshot path zeroes this value before repopulating the list for the current tick.
- `dirtyIndexScratch`: reusable scratch space sized to `resourceCount`. The data structure stores a compact list of mutated indices during the tick without allocating new arrays.
- `dirtyIndexPositions`: `Int32Array` mapping resource index → position inside the scratch prefix (or `-1` when absent). `markDirty` and `unmarkIfClean` consult this map to append and remove indices in O(1) while keeping the prefix densely packed. During publish passes the map may temporarily hold the sentinel value `-2` (`SCRATCH_VISITED`) while unioned loops are running; the loop restores the entry to `-1` before exiting so steady-state semantics remain unchanged.
- `definitionDigest`: frozen record `{ ids, version, hash }` cached alongside the immutable id array so save systems can quickly confirm compatibility prior to hydration.

```ts
interface ResourceDefinitionDigest {
  readonly ids: readonly string[];
  readonly version: number;
  readonly hash: string;
}
```

All live numeric buffers share a single `ArrayBuffer` per numeric width to improve serialization locality while keeping independent views disjoint. The Float64 views (`amounts`, `capacities`, `incomePerSecond`, `expensePerSecond`, `netPerSecond`, `tickDelta`, `dirtyTolerance`) are carved out of a backing buffer sized as `Float64Array.BYTES_PER_ELEMENT * 7 * resourceCount`. Each publish buffer owns its own Float64 `ArrayBuffer` sized for the copied views (covering all seven slices) so the runtime can flip between `publish[0]` and `publish[1]` without invalidating previously issued snapshots. Typed arrays are constructed with an offset stride where `stride = resourceCount * Float64Array.BYTES_PER_ELEMENT` (`amounts` at offset `0`, `capacities` at `1 * stride`, etc.). The scratch and position maps use dedicated `ArrayBuffer`s, as do the Uint8 flag bits for both live and publish views.

Comparisons between live and publish buffers run through `epsilonEquals(a, b)`, which treats two values as equivalent when

```
const magnitude = Math.max(Math.abs(a), Math.abs(b));
const tolerance = Math.max(
  DIRTY_EPSILON_ABSOLUTE,
  Math.min(toleranceCeiling, DIRTY_EPSILON_RELATIVE * magnitude),
);
return Math.abs(a - b) <= tolerance;
```

Comparisons short-circuit when operands are already identical (including matching `Infinity` sentinels) so resources that return to their prior state do not remain marked dirty after reconciliation.

`toleranceCeiling` resolves per resource from the mutable `dirtyTolerance` buffer (defaulting to `DIRTY_EPSILON_CEILING` but allowed to grow up to `DIRTY_EPSILON_OVERRIDE_MAX`), ensuring the epsilon never exceeds the ceiling stored for that index.

Default constants:

- `DIRTY_EPSILON_ABSOLUTE = 1e-9` collapses near-zero jitter.
- `DIRTY_EPSILON_RELATIVE = 1e-9` scales tolerance in proportion to value size.
- `DIRTY_EPSILON_CEILING = 1e-3` serves as the default per-resource ceiling.
- `DIRTY_EPSILON_OVERRIDE_MAX = 5e-1` bounds definition-supplied overrides so they can relax tolerance for prestige-scale resources without letting massive deltas slip through unchecked while still covering magnitude ranges up to approximately `1e15` without keeping resources perpetually dirty.

If specific resources require looser tolerances (e.g., prestige currencies with huge exponential growth), the content definition may optionally supply a `dirtyTolerance` override that the factory stores alongside the resource index; `epsilonEquals` then reads the per-resource ceiling (capped only by `DIRTY_EPSILON_OVERRIDE_MAX`). Telemetry records the raw comparisons whenever the override saturates so balancing can adjust the configuration before release. When this occurs the runtime emits `ResourceDirtyToleranceSaturated` with `{ resourceId, field, difference, toleranceCeiling, relativeTolerance, magnitude }` so analytics and balancing pipelines have the full context.

`ImmutableMapSnapshot` is already provided by `packages/core/src/immutable-snapshots.ts` and proxies mutation methods so the lookup table cannot be altered after the state is created.

#### Runtime API Surface

Expose a `ResourceState` façade that owns the buffers internally while providing mutation and query helpers:

```ts
interface ResourceState {
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
  addAmount(index: number, amount: number): number;
  spendAmount(
    index: number,
    amount: number,
    context?: ResourceSpendAttemptContext,
  ): boolean;
  applyIncome(index: number, amountPerSecond: number): void;
  applyExpense(index: number, amountPerSecond: number): void;
  finalizeTick(deltaMs: number): void;
  resetPerTickAccumulators(): void;
  forceClearDirtyState(): void;
  clearDirtyScratch(): void;
  snapshot(options?: { mode?: 'publish' | 'recorder' }): ResourceStateSnapshot;
  exportForSave(): SerializedResourceState;
  getDefinitionDigest(): ResourceDefinitionDigest;
}
```

- The module retains the `ResourceStateBuffers` reference inside a closure so external callers can only mutate state through the façade. Instrumentation or diagnostics that need raw access live in the same module and never receive a public reference to the mutable typed arrays.
- Mutation helpers return the actual delta applied to support downstream bookkeeping.
- `requireIndex(id)` wraps `getIndex` with an invariant check that throws and emits telemetry when presented with an unknown id. Index-based helpers call an internal `assertValidIndex(index)` guard so typed arrays never absorb silent out-of-bounds writes.
- A private `markDirty(index: number)` helper ensures each index is tracked only once per tick. It consults the `DIRTY_THIS_TICK` bit and `dirtyIndexPositions` map before pushing into the scratch prefix, then records the assigned slot so future checks stay O(1). Every entry in `dirtyIndexPositions` is initialized to `-1`; the first call to `markDirty` writes the index into `dirtyIndexScratch` at position `dirtyIndexCount`, persists that position inside the map, and increments the count. The helper is invoked only after confirming the live state and the active publish buffer fail `epsilonEquals` for any tracked field (amount, capacity, income, expense, net, or flags). If a later mutation restores parity and `epsilonEquals` returns true again, `unmarkIfClean(index)` reads the stored slot, swaps the tail entry into place, updates both impacted `dirtyIndexPositions` entries (the restored index and the swapped tail), clears the dirty bit, and writes `-1` back into the map. The publish pass introduces a second sentinel (`SCRATCH_VISITED = -2`) while it performs unioned work over previous/current dirty sets, then restores the map to `-1` afterward. Zero-delta work therefore never leaks into the publish pipeline and the scratch prefix always remains densely packed without allocations.
- To prevent callers from skipping the epsilon/dirty bookkeeping, every façade helper routes writes through `updateFloatField(index, field, nextValue)` and `updateFlagField(index, mask, shouldSet)` utilities defined inside the module. These helpers centralize the `epsilonEquals` comparison, dirty bit toggling, and `dirtyIndexPositions` maintenance so individual mutators cannot drift out of sync.
- Internal maintenance code uses `writeAmountDirect(index, amount)` to bypass capacity clamping during save restore or migrations. The helper is not part of the public façade and is only callable from privileged modules in the same file so gameplay code must go through `addAmount`. For tooling, the module exposes an opt-in escape hatch `__unsafeWriteAmountDirect(state, index, amount)` that routes through the same helper; callers are expected to guard their inputs and remain confined to hydration/migration flows.
- `finalizeTick(deltaMs)` converts accumulated per-second rates into a proposed delta, clamps amounts to capacities/zero, recomputes `netPerSecond`, and relies on `markDirty` + `unmarkIfClean` to ensure only indices with meaningful divergence remain dirty at the end of the tick (cancelling incomes/expenses do not surface spurious deltas). The conversion uses `deltaSeconds = deltaMs / 1_000`, computes `incomeDelta = incomePerSecond * deltaSeconds`, `expenseDelta = expensePerSecond * deltaSeconds`, and derives a tentative `appliedDelta = incomeDelta - expenseDelta`. After clamping the live amount into `[0, capacity]`, we recompute the `actualDelta = clampedAmount - previousAmount` and calculate `nextTickDelta = tickDelta[index] + actualDelta`. When `epsilonEquals(nextTickDelta, 0)` succeeds we reset `tickDelta[index] = 0`; otherwise we assign the computed `nextTickDelta`. We never clear an existing non-zero `tickDelta` unless the combined value reconciles to ~0 so earlier frame work (e.g., capacity adjustments or direct grants) survives the finalize pass. Dirty bookkeeping and telemetry always use `actualDelta` so resources that hit their cap/zero do not remain in the dirty set indefinitely. Callers must pass a finite, non-negative `deltaMs`; otherwise telemetry emits `ResourceFinalizeInvalidDelta` and the helper throws before mutating any buffers, preventing clock drift or `NaN` propagation from corrupting state.
- `resetPerTickAccumulators()` clears the live `incomePerSecond`, `expensePerSecond`, and `tickDelta` arrays after publish while leaving the publish buffers untouched thanks to the ping-pong double buffering. It does **not** zero `netPerSecond`; that value remains valid until the next `finalizeTick` so systems sampling immediately after publish observe the most recent rates. The helper asserts that `snapshot({ mode: 'publish' })` has already executed during the current tick (tracked via an internal boolean toggled by the snapshot path); calling it out of order throws and logs telemetry because clearing the accumulators before publish would erase the tick delta that the UI expects to consume.
- `clearDirtyScratch()` clears residual dirty metadata and associated flag bits after authoritative calls to `snapshot({ mode: 'publish' })` complete (the snapshot path itself resets the scratch length to zero). For rare flows that intentionally skip publish (e.g. deterministic test harnesses comparing recorder snapshots) the module exposes `forceClearDirtyState()` which performs the same scratch reset and clears `incomePerSecond`, `expensePerSecond`, and `tickDelta` under an internal "publish skipped" guard. Callers must invoke `forceClearDirtyState()` instead of `resetPerTickAccumulators()` in that scenario so rate accumulators do not desynchronise. Production code relies on `snapshot({ mode: 'publish' })` instead of calling either helper directly.
- `getDefinitionDigest()` returns the frozen `{ ids, version, hash }` payload recorded during initialization so save serializers can embed it and hydration routines can check compatibility before replaying data.
- `snapshot(options)` defaults to `{ mode: 'publish' }`. Callers opt into recorder mode explicitly so accidental captures do not skip the publish reset.

The façade tracks the active length in a `dirtyIndexCount` field; the valid portion of `dirtyIndexScratch` lives in `[0, dirtyIndexCount)`. Mutations append indices only when the dirty bit transitions from clear to set, guaranteeing that each index appears at most once per tick without extra allocations. Whenever the list changes, `dirtyIndexPositions` keeps the index ↔ position mapping in sync so removals and parity-driven unmarks stay constant time even in the hot path.

#### Initialization & Lifecycle

Provide a factory `createResourceState(defs: readonly ResourceDefinition[])` that:

1. Validates incoming definitions without reordering so designer-authored order is preserved and surfaces deterministically in presentation. The content pack compiler guarantees a stable array order; the factory verifies uniqueness by inserting ids into a `Set` and throws on duplicates.
2. Allocates typed arrays sized to the resource count. Initialization passes each definition through `sanitizeInitialResourceValues`, which clamps `startAmount` into `[0, capacity]`, rejects `NaN`/non-finite input with a telemetry event and thrown error, and logs + clamps negative values to `0` or overshoot values down to the capacity. The sanitized amounts populate both the live `amounts` array and the mirrored publish buffers. Capacities default to `Number.POSITIVE_INFINITY` when unspecified (and populate both publish views) so the initial snapshot requires no additional copying. The retainers track the active publish buffer index (`0` at bootstrap) and mark the standby buffer ready for the next tick, clearing each publish buffer's `dirtyCount` to `0`. The save serializer treats `Number.POSITIVE_INFINITY` as `null` to avoid lossy JSON round-trips.
3. Initializes `flags` with `VISIBLE | UNLOCKED` for starting resources and zero for locked ones.
4. Populates `dirtyTolerance[index]` with the sanitized tolerance from the definition (if provided) or `DIRTY_EPSILON_CEILING`. Sanitization clamps the tolerance between `DIRTY_EPSILON_ABSOLUTE` and `DIRTY_EPSILON_OVERRIDE_MAX`, and each publish buffer stores the same scalar so comparison logic receives a per-resource ceiling regardless of which buffer is active. Overrides that land above the default ceiling but within the max let prestige-scale resources relax their noise floor deterministically.
5. Wraps `ids` in `Object.freeze` and converts the `indexById` lookup table into an `ImmutableMapSnapshot` via the existing `enforceImmutable(...)` helper so any attempt to mutate it throws at runtime.
6. Seeds the `dirtyIndexScratch` array with a sentinel length counter of `0` (tracked separately inside the façade) and fills `dirtyIndexPositions` with `-1` so the first mutation appends in-place without additional setup.
7. Emits a `ResourceDefinitionDigest` record `{ ids, version, hash }` so save restores can verify content compatibility before hydrating. When hydrating a save the runtime invokes `reconcileSaveAgainstDefinitions(savedIds, defs)` which produces a mapping from save index → live index, reports removed/added ids, and throws if a referenced id no longer exists. Mismatches surface telemetry (`ResourceHydrationMismatch`) and fail fast instead of silently dropping data; future migrations can hook into this reconciliation step to map old ids onto new ones.

On content reload or save restore, callers reuse the factory with definitions and then hydrate numeric buffers from persisted data. `reconcileSaveAgainstDefinitions` drives the process: it verifies payload array lengths, produces a remapping from save indices to live indices, and rejects any out-of-band data. Hydration iterates the remapping, writes restored amount/capacity values and flag bits into both the live and publish typed arrays, zeros `incomePerSecond`, `expensePerSecond`, `netPerSecond`, and `tickDelta` in both views, and clears the dirty scratch counter so the next `snapshot({ mode: 'publish' })` immediately reflects the restored state without forcing a full-tick recomputation. Until the first post-restore tick runs the UI should expect rate diagnostics to read as zero; the follow-up finalize recomputes rates deterministically. The runtime stores the `ResourceState` inside the broader game state object managed by `setGameState(...)`; systems recompute per-second rates on the very next tick using the hydrated amounts. Save restore and migration utilities invoke the internal `writeAmountDirect` helper during this process so they can place values that temporarily exceed caps before the relevant upgrades reapply. Immediately after hydration the engine reapplies content-defined capacities/upgrades and only then schedules the next `finalizeTick`. This ordering ensures overshoot values survive long enough for upgrade modifiers to recreate the higher caps; if no modifier reinstates a wider cap before finalize executes, the clamp (and corresponding telemetry) makes the data loss explicit to designers.

#### Mutation Semantics

- **Additions:** `addAmount` increases `amounts[index]` while always clamping to capacity. Negative input throws to catch misuse; callers use `spendAmount` for decrements. If the applied delta resolves to zero (e.g. already at cap or the caller adds `0`), the helper returns `0` and avoids calling `markDirty`. When the applied delta is non-zero, it accumulates into `tickDelta[index]` and `markDirty` tracks the index exactly once for the tick. Internal maintenance utilities (migrations, save restore) use a private `writeAmountDirect` helper that bypasses the clamp, never the public façade, so gameplay code cannot accidentally overshoot capacities.
- **Spending:** `spendAmount` verifies `amounts[index] >= amount` before subtracting. It returns `true/false` to signal insufficient resources and never allows negative balances. Successful spends subtract from both `amounts[index]` and `tickDelta[index]`, then call `markDirty`. If the spend later gets cancelled by a compensating `addAmount` before publish, the helper calls `unmarkIfClean` once the live values satisfy `epsilonEquals` with the publish buffer, dropping the index from the scratch list. When spending fails, telemetry records a `ResourceSpendFailed` event with the offending command/system id (when supplied via `ResourceSpendAttemptContext`) and the guard throws if the caller attempts to subtract a negative amount.
- **Per-second accumulation:** Systems call `applyIncome` / `applyExpense` during their tick. Inputs must be finite (`Number.isFinite`) and non-negative; attempts to submit negative, `NaN`, or infinite rates log telemetry and throw. Each helper adds to (`+=`) `incomePerSecond[index]` and `expensePerSecond[index]`, allowing multiple systems to compose within a single frame. The helpers also keep `netPerSecond[index]` in sync immediately so shells can read `getNetPerSecond` without requiring `finalizeTick` in integrations that want to display live rates. Systems that queue rates (for example, `createProductionSystem({ applyViaFinalizeTick: true })`) rely on `finalizeTick` to roll accumulated income/expense into balances. Helpers ignore zero-valued inputs and mark the resource dirty only when the accumulator fails `epsilonEquals` against the most recent publish buffer. If opposing calls cancel each other within the same tick, `unmarkIfClean` clears the dirty flag once the accumulators drift back inside the epsilon band and the previously published buffer retains the prior rates. Because the per-second fields are additive, publish flows must call `resetPerTickAccumulators()` once per tick after `snapshot({ mode: 'publish' })` to avoid rates accumulating across ticks.
- **Capacity updates:** `setCapacity` validates the requested capacity (must be `>= 0`, not `NaN`; `Infinity` is permitted to represent uncapped resources) before writing into the buffer. Invalid values log telemetry and throw. On success the helper clamps the current amount if it now exceeds the cap (recording that clamp as a delta in `tickDelta`), calls `markDirty`, and returns the applied cap so command handlers can publish diffs. The subsequent publish copies the new cap into the active publish buffer.
- **Visibility/unlock:** `grantVisibility` and `unlock` set bits inside the flag buffer and mark the resource dirty so the UI is notified.

Dirty tracking (flag bit `0b100`) is cleared inside `snapshot({ mode: 'publish' })` only after the live values and flag bits have been copied into the publish buffers. The same loop clears the bit in both the live flag array (so subsequent mutations have to re-mark the resource) and the publish copy (by masking the bit before exposure). Clearing the bit at this point keeps the underlying live buffers mutable while guaranteeing the published snapshot remains immutable.

Every index-based helper calls `assertValidIndex(index)`, which verifies `index >= 0 && index < resourceCount`, logs a `ResourceIndexViolation` telemetry event, and throws when the guard fails. Command handlers invoke `requireIndex` so the guard fires at lookup time rather than after a mutation attempt.

#### Snapshot & Persistence

- `snapshot({ mode: 'publish' })` returns a read-only-by-contract view (`ResourceStateSnapshot`) containing:
  - `ids` (frozen array).
  - Direct references to the publish buffer's typed arrays. To keep cache-friendly hot reads intact we still hand out the live views, but the runtime installs a lightweight `createImmutableTypedArrayView(...)` wrapper over each view in non-production builds. The wrapper traps mutators, forwards safe reads, and throws when a consumer attempts to write. Production builds may disable the guard by clearing `SNAPSHOT_GUARDS`, but tests and development builds force it on by default so accidental mutations cannot corrupt determinism. The flag now supports three modes: `'auto'` (default; enabled for `NODE_ENV !== 'production'`), `'force-on'`, and `'force-off'`, giving automation harnesses explicit control. Guarded views share their backing buffer with the publish arrays so the check costs a single proxy allocation per field rather than deep cloning; structured cloning paths use recorder mode instead.
  - The typed arrays surface only to same-thread consumers. Cross-thread transport happens through the `ResourcePublishTransport` (see below); attempting to `postMessage` a `ResourceStateSnapshot` is unsupported and intentionally undocumented in the runtime API.
  - A compact list of dirty indices for the current tick. Consumers read the shared `Uint32Array` prefix `[0, dirtyCount)` and must ignore unused capacity beyond that point; the array remains read-only by contract just like the other typed views.
  - Flag bits encoded as a read-only `Uint8Array` snapshot sourced from `targetPublish.flags`.

The publish snapshot type is therefore:

```ts
interface ResourceStateSnapshot {
  readonly ids: readonly string[];
  readonly amounts: Float64Array;
  readonly capacities: Float64Array;
  readonly incomePerSecond: Float64Array;
  readonly expensePerSecond: Float64Array;
  readonly netPerSecond: Float64Array;
  readonly tickDelta: Float64Array;
  readonly flags: Uint8Array;
  readonly dirtyTolerance: Float64Array;
  readonly dirtyIndices: Uint32Array;
  readonly dirtyCount: number;
}
```

The TypeScript surface marks these arrays as `readonly` to call out the contract. In `'auto'`/`'force-on'` guard modes the runtime swaps each typed array reference for the immutable proxy returned by `createImmutableTypedArrayView(...)`, keeping the same underlying buffer while disallowing writes in development and test environments. Recorder mode returns the same interface, but the arrays are deep-cloned and own their backing buffers regardless of guard configuration so structured cloning cannot observe shared state.

- `snapshot({ mode: 'recorder' })` returns the same shape but clones its data into ephemeral typed arrays owned by the recorder call site (amount, capacity, income, expense, net, tick delta, flags, tolerance). This mode does not touch dirty bookkeeping, publish mirrors, or per-tick accumulators, allowing pre/post-command captures without interfering with the presentation pipeline. The full-clone approach is `O(resourceCount)` per capture; for now we accept the overhead because command executions are infrequent in deterministic tests. If the workload proves heavier, future work can explore reusing the inactive publish buffer with reference counting or capturing only the dirty indices plus a shared frozen baseline. Recorder-mode clones remain structured-clone friendly, so tooling can persist them or ship them across worker boundaries without additional conversion.

- `exportForSave()` returns a POJO suitable for persistence:

```ts
interface SerializedResourceState {
  readonly ids: readonly string[];
  readonly amounts: readonly number[];
  readonly capacities: readonly (number | null)[];
  readonly unlocked?: readonly boolean[];
  readonly visible?: readonly boolean[];
  readonly flags: readonly number[];
  readonly definitionDigest?: ResourceDefinitionDigest;
  readonly automationState?: readonly SerializedAutomationState[];
}

interface ResourceSpendAttemptContext {
  readonly commandId?: string;
  readonly systemId?: string;
}
```

Offline catch-up consumes `SerializedResourceState`, rehydrates the live typed arrays, and continues deterministic execution. The save payload intentionally omits per-second income/expense data because they are tick-scoped diagnostics; the runtime zeros those buffers (both live and publish views) on restore and regenerates fresh rates during the next tick.

`flags` mirrors the raw bit mask so future toggle bits survive round-trips even when older clients do not understand them. The optional `unlocked` and `visible` arrays remain for ergonomic access in content tooling; when provided they must stay in sync with the bit mask. `reconcileSaveAgainstDefinitions` validates that every array matches the `ids.length` (`flags.length` must also match) and throws `ResourceSaveLengthMismatch` when they do not; telemetry captures the offending metadata. During rehydration the module trusts `flags` as the single source of truth, rebuilding the convenience arrays from the mask so the emitted snapshot always reflects the authoritative bits.

**Automation State Serialization:**

The `automationState` field contains serialized automation state entries. Each entry uses `SerializedAutomationState` format where `lastFiredStep` is `number | null` (null represents `-Infinity` for JSON compatibility). During `exportForSave()`, the runtime converts `AutomationState.lastFiredStep` values of `-Infinity` to `null`. During restoration via `restoreState()`, `null` values are converted back to `-Infinity`.

See `docs/automation-system-api.md` for details on `SerializedAutomationState` and `restoreState()`.

#### Dual-Mode Progression Snapshot Support (Existing Implementation)

> **Note**: This subsection documents **existing progression snapshot behavior** as shipped in PR #303 (`packages/core/src/progression.ts:138-214`). This is retroactive documentation of production code.

The `buildProgressionSnapshot()` function supports **dual-mode snapshot generation**, consuming either live `ResourceState` or serialized `SerializedResourceState` to build UI-ready `ProgressionSnapshot` data. This enables both runtime snapshot publishing and save file preview.

**Live State Mode**:

When `ProgressionAuthoritativeState.resources.state` contains a live `ResourceState` instance:

```typescript
const snapshot = state.snapshot({ mode: 'publish' });

const resourceView = {
  id: resourceId,
  displayName: metadata.get(resourceId)?.displayName ?? resourceId,
  amount: snapshot.amounts[index],
  capacity: snapshot.capacities[index],
  isUnlocked: (snapshot.flags[index] & UNLOCKED_BIT) !== 0,
  isVisible: (snapshot.flags[index] & VISIBLE_BIT) !== 0,
  perTick: state.getNetPerSecond(index) * (stepDurationMs / 1000), // Live rate data
};
```

**Serialized State Mode**:

When `ProgressionAuthoritativeState.resources.serialized` contains `SerializedResourceState` (during save preview or session restore):

```typescript
const serialized = state.resources.serialized;

const resourceView = {
  id: serialized.ids[index],
  displayName: metadata.get(serialized.ids[index])?.displayName ?? serialized.ids[index],
  amount: serialized.amounts[index],
  capacity: serialized.capacities[index] ?? Infinity,
  isUnlocked: serialized.unlocked?.[index] ?? false,
  isVisible: serialized.visible?.[index] ?? false,
  perTick: 0, // No rate data in serialized state
};
```

**Key Differences**:

| Aspect | Live State Mode | Serialized State Mode |
|--------|----------------|----------------------|
| **Data Source** | `ResourceState.snapshot({ mode: 'publish' })` | `SerializedResourceState` from save file |
| **Rate Data** | `perTick` calculated from `getNetPerSecond()` | `perTick = 0` (rates not persisted) |
| **Flag Access** | Bit masks from `snapshot.flags` typed array | Boolean arrays `unlocked`/`visible` |
| **Capacity** | Live typed array value | POJO number array with `null` → `Infinity` |
| **Use Case** | Runtime worker snapshot publishing | Save file preview, session hydration |

**Implementation**:

The snapshot builder detects which mode to use by checking for live state first:

```typescript
// packages/core/src/progression.ts:146-211
const liveState = state.resources?.state;
const serializedState = state.resources?.serialized;

if (liveState) {
  // Live mode: use ResourceState snapshot
  const snapshot = liveState.snapshot({ mode: 'publish' });
  // Build resource views from typed arrays...
} else if (serializedState) {
  // Serialized mode: use save file data
  // Build resource views from POJO arrays...
}
```

**Rationale**:

Dual-mode support enables:
- **Runtime publishing**: Worker emits progression snapshots every tick using live state
- **Save preview**: UI can display save file contents without loading into live runtime
- **Session restoration**: Initial snapshot after hydration uses serialized state before first tick
- **Consistent UI contract**: Both modes produce identical `ProgressionSnapshot` structure

**Integration**:

1. **Worker Runtime**: Calls `buildProgressionSnapshot()` with live coordinator state after each tick (`packages/shell-web/src/runtime.worker.ts:228-232`)
2. **Session Restore**: Initial snapshot uses serialized state from save file before coordinator rehydrates (`packages/shell-web/src/runtime.worker.ts:652-798`)
3. **Save Preview** (future): Tooling can display save file contents by passing `SerializedResourceState` directly

**Implementation Reference**:
- Dual-mode snapshot builder: `packages/core/src/progression.ts:138-214`
- Live state path: `packages/core/src/progression.ts:146-176`
- Serialized state path: `packages/core/src/progression.ts:178-211`
- Integration in worker: `packages/shell-web/src/runtime.worker.ts:228-232`

Consumers should continue to respect the dirty index list when emitting deltas, and because the publish path zeros `targetPublish.tickDelta` only for the explicitly dirty candidates (step 1 below), a resource that resolves to clean state never exposes a stale delta. Comparisons reuse the shared `epsilonEquals` helper, meaning near-zero differences neither propagate into the publish buffer nor keep indices marked dirty.

During `snapshot({ mode: 'publish' })` the runtime selects the inactive publish buffer (`targetPublish`) and records the current active buffer as `sourcePublish`. Rather than cloning the entire snapshot, the runtime reapplies just the slots that may have diverged while `targetPublish` sat idle:
1. Visit the prior publish's dirty list and the current tick's scratch prefix in turn, zeroing `targetPublish.tickDelta` for each unique index. We reuse `dirtyIndexPositions` to skip duplicates: before the pass we write a sentinel (`SCRATCH_VISITED = -2`) into `dirtyIndexPositions[index]` for every index we touch, and we skip further work whenever an index already equals that sentinel. After the pass the loop restores `dirtyIndexPositions[index] = -1`, so the map is ready for the copy stage without allocating additional sets or arrays. No concatenation or temporary buffers are required and the work remains proportional to the dirty set.
2. Compute `previousDirtyCount = sourcePublish.dirtyCount` and iterate the prefix `sourcePublish.dirtyIndices[0..previousDirtyCount)`, copying the corresponding amount/capacity/rate/flag entries from `sourcePublish` into `targetPublish` while leaving their `tickDelta` at zero. This guarantees the inactive buffer matches the authoritative snapshot for everything that changed last tick.
3. Reset `targetPublish.dirtyCount = 0` and capture the current `dirtyIndexCount` into a local `scratchCount`; the scratch array contents remain intact until the loop finishes.
4. Iterate the first `scratchCount` entries in `dirtyIndexScratch`, compare each candidate against `sourcePublish` using the epsilon test, and write the live values (amount, capacity, income, expense, net, tick delta, flags, tolerance) into `targetPublish` when they diverge. `dirtyTolerance` only changes during initialization, hydration, or content reload flows; the tick loop never mutates it, so the comparison normally short-circuits unless a tooling action explicitly updates the buffer. The flag copy masks out the engine-only `DIRTY_THIS_TICK` bit so consumers never observe internal bookkeeping. Slots that converge leave the live `tickDelta` untouched so recorder snapshots captured immediately after publish still observe the accumulated delta; they simply skip the dirty list. `resetPerTickAccumulators()` (or `forceClearDirtyState()`) remains responsible for clearing the live accumulator once consumers finish reading it.

For each surviving index we write it into `targetPublish.dirtyIndices[targetPublish.dirtyCount++]` and mark `dirtyIndexPositions[index] = -1` so the next tick appends from a clean slate. After the loop the runtime flips `activePublishIndex`, exposes the read-only views, sets `dirtyIndexCount = 0`, and walks both the `previousDirtyCount` and `scratchCount` ranges to ensure every corresponding `dirtyIndexPositions` entry is `-1` (debug builds may also zero the scratch slots for readability). Because consumers read from the now-active publish buffer only, later mutations operate on the live arrays and the alternate publish buffer without affecting the snapshot in circulation. `clearDirtyScratch()` remains an escape hatch for test harnesses that need to force-reset live buffers without emitting a snapshot.

#### Integration Points

- **Command handlers:** `COLLECT_RESOURCE` routes through `addAmount`, `PURCHASE_GENERATOR` and future `APPLY_MODIFIER` commands use `spendAmount` and `setCapacity`. All handlers include resource ids to translate into indices via `requireIndex`, ensuring invalid content references surface as telemetry.
- **Systems:** Production, automation, and prestige systems receive the shared `ResourceState` instance on registration. Each system operates on indices rather than ids for tight loops; helper utilities resolve ids only during initialization.
- **Telemetry:** The resource module records events via the existing `telemetry` facade (`TelemetryEventData`) for invalid operations, capacity clamping, overflow detection, and comparisons that saturate a resource's dirty tolerance ceiling. Metrics aggregate per-second income/expense totals for diagnostics dashboards.
- **Presentation bridge:** When publishing state to the UI, the runtime emits either the full snapshot (initial load) or a delta referencing dirty indices with updated `amount`, `capacity`, per-second rates, `netPerSecond`, and `visibility` flags. Before calling `worker.postMessage` the bridge converts the immutable typed-array views into a `ResourcePublishTransport` built from a pooled set of transferable slabs sized exactly to `dirtyCount`. Each field is copied with a tight `Float64Array`/`Uint8Array` whose length equals the number of dirty indices, meaning the transport cost grows with the delta rather than `resourceCount`. Slabs come from a `TransportBufferPool` so the runtime reuses `ArrayBuffer`s across frames; the pool guarantees buffers are detached only after the worker acknowledges receipt.

The transport contract is versioned (`version: 2`) and self-describing:

```ts
type TransportComponent =
  | 'amounts'
  | 'capacities'
  | 'incomePerSecond'
  | 'expensePerSecond'
  | 'netPerSecond'
  | 'tickDelta'
  | 'flags'
  | 'dirtyTolerance';

interface TransportBufferDescriptor {
  readonly component: TransportComponent;
  readonly ctor: 'Float64Array' | 'Uint8Array';
  readonly buffer: ArrayBuffer;
  readonly byteOffset: number;
  readonly length: number;
}

interface ResourcePublishTransport {
  readonly version: 2;
  readonly ids: readonly string[];
  readonly dirtyIndices: Uint32Array;
  readonly buffers: readonly TransportBufferDescriptor[];
}
```

Every descriptor includes the typed-array constructor string, length, and byte offset so consumers can rebuild deterministic views without hard-coded assumptions. Single-threaded presentation (no worker) still goes through the transport builder, but instead of transferring the buffers we hand the pooled typed arrays directly to the UI diff routine, keeping the zero-copy path.

- **Command recorder:** The recorder uses `snapshot({ mode: 'recorder' })` before/after command execution to capture deterministic replays; this mode deep-clones the live view so structured cloning succeeds without disturbing the dirty tracking that the presentation layer relies on.

### 6.3 Operational Considerations
- **Deployment**: No specific CI/CD updates required; implementation will be integrated through standard PR workflow.
- **Telemetry & Observability**: Telemetry events will be emitted for invalid operations, capacity clamping, overflow detection, and dirty tolerance saturation. Metrics will aggregate per-second income/expense totals for diagnostics dashboards.
- **Security & Compliance**: No security or compliance impacts; all data remains in-memory and under player control.

## 7. Work Breakdown & Delivery Plan
### 7.1 Issue Map

| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| feat(core): implement ResourceState struct-of-arrays storage | Scaffold buffer structs, factory, and façade in `packages/core/src/resource-state.ts` | Runtime Implementation Agent | None | Module checked in with TypeScript interfaces and factory function |
| feat(core): add snapshot guard helpers | Implement `createImmutableTypedArrayView` wrapper and `SNAPSHOT_GUARDS` configuration | Runtime Implementation Agent | ResourceState scaffolding | Vitest coverage for guarded and unguarded modes |
| feat(core): implement transport buffer pool | Add `TransportBufferPool` and `ResourcePublishTransport` builder | Runtime Implementation Agent | ResourceState scaffolding | Unit tests for pooled buffer reuse and worker/non-worker paths |
| feat(core): add save reconciliation helpers | Implement `reconcileSaveAgainstDefinitions` and digest emission | Runtime Implementation Agent | ResourceState scaffolding | Unit tests for id matching, version validation, and telemetry |
| test(core): comprehensive ResourceState coverage | Add Vitest tests for all mutation semantics, dirty tracking, and snapshots | Runtime Implementation Agent | All ResourceState implementation | All acceptance criteria pass |
| docs: update runtime-command-queue-design references | Add references to ResourceState contract | Docs Agent | ResourceState implementation complete | Documentation links updated |

### 7.2 Milestones
- **Phase 1**: Core ResourceState implementation (issues 1-4) - 2 weeks
- **Phase 2**: Testing and documentation (issues 5-6) - 1 week

### 7.3 Coordination Notes
- **Hand-off Package**: Access to `packages/core` source code, existing `CommandRecorder` and `immutable-snapshots.ts` utilities, design document.
- **Communication Cadence**: Daily standup updates, PR reviews within 24 hours, escalation path through Runtime Core workstream lead.

## 8. Agent Guidance & Guardrails
- **Context Packets**: Must review `docs/idle-engine-design.md` §6.2, `packages/core/src/runtime-state.ts`, `packages/core/src/immutable-snapshots.ts` before implementation.
- **Prompting & Constraints**:
  - Use conventional commit messages: `feat(core): <description>`
  - All public APIs must include JSDoc comments
  - TypeScript strict mode required
  - No `any` types permitted
- **Safety Rails**:
  - Do not modify existing save file formats without migration path
  - Do not expose mutable typed arrays through public API
  - Do not skip telemetry emission for validation failures
- **Validation Hooks**:
  - Run `npm test` before marking task complete
  - Verify no TypeScript errors: `npm run type-check`
  - Ensure coverage threshold maintained: `npm run test:coverage`

## 9. Alternatives Considered

**Alternative 1: Array-of-structs layout**
- Rejected because it would cause poor cache locality during systems iteration
- Would require full object cloning for snapshots instead of typed array slicing
- Less friendly to serialization and cross-thread transport

**Alternative 2: Single-buffered snapshots with deep cloning**
- Rejected because `O(resourceCount)` clones every tick would not scale
- Would eliminate zero-copy benefits for presentation layer
- Double buffering provides better performance characteristics

**Alternative 3: Mutable snapshots with copy-on-read**
- Rejected because accidental mutations would corrupt determinism
- Debugging mutation bugs would be harder than with immutable-by-contract approach
- Proxy-based guards provide better developer experience

**Alternative 4: BigInt for resource amounts**
- Rejected for initial implementation due to serialization complexity
- Float64 provides sufficient precision for current content scale
- Can be reconsidered in future if balance tuning requires larger magnitudes
- Would require significant changes to math operations and serialization

## 10. Testing & Validation Plan
- **Unit / Integration**:
  - Deterministic preservation of definition-supplied resource order
  - Duplicate id detection and telemetry
  - Initial amount sanitization and capacity clamping
  - Spending failure paths and balance integrity
  - `requireIndex` and `assertValidIndex` guards
  - `finalizeTick` rate conversion and epsilon suppression
  - `applyIncome`/`applyExpense` input validation
  - `dirtyTolerance` override clamping and round-trip
  - Zero-value income/expense handling
  - Dirty index tracking and position map maintenance
  - Snapshot immutability guards
  - Transport buffer pooling and reconstruction
  - Save reconciliation and rehydration
  - Property-based tests (future) for additive/subtractive symmetry
- **Performance**:
  - Benchmark dirty tracking overhead vs full-buffer iteration
  - Profile snapshot generation with varying dirty set sizes
  - Measure transport buffer pooling allocation savings
- **Tooling / A11y**: N/A (server-side runtime module)

## 11. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| **Precision drift & magnitude ceiling** | High - Values above 2^53 lose integer precision | Medium | Monitor growth curves, plan fixed-point/logarithmic representation for future |
| **Serialization cost** | Medium - Large typed arrays inflate save size | Low | Implement delta-encoding or compression in follow-up |
| **Publish diff cost** | Medium - Worst-case churn degenerates to full-buffer copies | Low | Track telemetry on publish duration, revisit strategy if content scales dramatically |
| **Content churn** | Medium - New resources require reinitialization | Medium | Define migration utilities for save compatibility |
| **Future threading needs** | Low - Shared buffers would require atomics | Low | Document invariants for future extension |
| **Proxy guard complexity** | Low - Zero-copy proxies must replicate immutability | Low | Exhaustive tests for mutator trapping |

## 12. Rollout Plan
- **Milestones**:
  - Week 1-2: Core implementation (Phase 1)
  - Week 3: Testing and documentation (Phase 2)
  - Week 4: Integration with existing command handlers and systems
- **Migration Strategy**: No migration required for new implementation; future command handlers will adopt ResourceState API
- **Communication**: Update team wiki with ResourceState API documentation, announce availability in weekly engineering sync

## 13. Open Questions
- Should we implement property-based tests for additive/subtractive symmetry in Phase 2 or defer to follow-up?
- What telemetry aggregation period should be used for per-second income/expense summaries?
- Should `SNAPSHOT_GUARDS` default to `'auto'` or `'force-on'` in production builds?

## 14. Follow-Up Work
- Implement property-based tests for resource mutation symmetry (deferred from Phase 2)
- Design fixed-point or logarithmic representation for high-magnitude resources (tracked separately)
- Implement delta-encoding or compression for save serialization (tracked separately)
- Update command handlers to use ResourceState API (separate workstream)
- Extend documentation in `docs/runtime-command-queue-design.md` with ResourceState references

## 15. References
- `docs/idle-engine-design.md` §6.2 - Original struct-of-arrays commitment
- `packages/core/src/runtime-state.ts` - Existing state management helpers
- `packages/core/src/immutable-snapshots.ts` - Immutable snapshot utilities
- `docs/automation-system-api.md` - Automation state serialization details
- `packages/core/src/progression.ts:138-214` - Dual-mode progression snapshot implementation (PR #303)
- `packages/shell-web/src/runtime.worker.ts:228-232` - Worker runtime integration
- `packages/shell-web/src/runtime.worker.ts:652-798` - Session restore implementation

## Appendix A — Glossary

| Term | Definition |
|------|------------|
| **Struct-of-arrays (SoA)** | Data layout pattern where each attribute is stored in a separate array, improving cache locality for iteration |
| **Double buffering** | Technique using two buffers (ping-pong) to enable reading from one while writing to the other |
| **Dirty tracking** | Optimization tracking which resources have changed since last snapshot to minimize delta size |
| **Epsilon comparison** | Floating-point comparison using tolerance threshold to handle rounding errors |
| **Typed array** | JavaScript array types (Float64Array, Uint8Array, etc.) providing direct memory access |
| **Immutable snapshot** | Read-only view of state guaranteed not to change after creation |
| **Façade pattern** | Structural design pattern providing simplified interface to complex subsystem |
| **Resource index** | Integer offset into typed arrays for O(1) resource lookup |
| **Publish buffer** | Double-buffered typed array snapshot exposed to presentation layer |
| **Recorder mode** | Snapshot mode that deep-clones data for deterministic replay without affecting publish pipeline |

## Appendix B — Change Log

| Date | Author | Change Summary |
|------|--------|----------------|
| 2025-10-12 | Original design team | Initial design document |
| 2025-12-21 | Claude Opus 4.5 | Migrated to design document template format |
