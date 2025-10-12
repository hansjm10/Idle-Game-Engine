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
  readonly indexById: ReadonlyMap<string, number>;
  readonly amounts: Float64Array;
  readonly capacities: Float64Array;
  readonly incomePerSecond: Float64Array;
  readonly expensePerSecond: Float64Array;
  readonly netPerSecond: Float64Array;
  readonly tickDelta: Float64Array;
  readonly flags: Uint8Array;
}
```

- `ids`: canonical resource ordering derived from the active content pack.
- `indexById`: Map for O(1) lookup; remains immutable after initialization.
- `amounts`: current balances (double precision for cumulative accuracy).
- `capacities`: hard caps enforced on mutation; populated from definitions and
  upgrade modifiers.
- `incomePerSecond` / `expensePerSecond`: running totals populated by systems
  each tick to support production diagnostics and UI stat panels.
- `netPerSecond`: derived buffer updated at the end of each tick to avoid
  recomputing `income - expense` during reads.
- `tickDelta`: tracks the signed delta applied during the current tick, enabling
  compact state diffs for the presentation layer and recorder.
- `flags`: bit field storing boolean metadata (`VISIBLE`, `UNLOCKED`,
  `DIRTY_THIS_TICK`). The low bit toggles when any mutation occurs so snapshot
  builders can skip untouched entries.

All numeric buffers share a single `ArrayBuffer` per numeric type to improve
serialization locality. For example, `amounts`, `capacities`, and
`tickDelta` reside in a shared `ArrayBuffer` sized as `Float64Array.BYTES_PER_ELEMENT * resourceCount`.

### 5.2 Runtime API Surface

Expose a `ResourceState` façade owning the buffers and providing mutation and
query helpers:

```ts
interface ResourceState {
  readonly buffers: ResourceStateBuffers;
  getIndex(id: string): number | undefined;
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
  snapshot(): ResourceStateSnapshot;
  exportForSave(): SerializedResourceState;
}
```

- Mutation helpers return the actual delta applied to support downstream
  bookkeeping.
- `finalizeTick(deltaMs)` converts accumulated per-second rates into tick
  deltas, clamps amounts to capacities/zero, recomputes `netPerSecond`, and sets
  the dirty flag.
- `resetPerTickAccumulators()` clears `incomePerSecond`, `expensePerSecond`, and
  `tickDelta` after a snapshot publish.

### 5.3 Initialization & Lifecycle

Provide a factory `createResourceState(defs: readonly ResourceDefinition[])`
that:

1. Sorts incoming definitions deterministically (`localeCompare` on `id`) to
   guarantee consistent indexing across devices and replays.
2. Allocates typed arrays sized to the resource count, pre-filling `amounts`
   with `startAmount`, `capacities` with either `definition.capacity` (future) or
   `Number.POSITIVE_INFINITY` when absent.
3. Initializes `flags` with `VISIBLE | UNLOCKED` for starting resources and
   zero for locked ones.
4. Freezes `ids`/`indexById` to prevent mutation after creation.

On content reload or save restore, callers reuse the factory with definitions
and then hydrate numeric buffers from persisted data. The runtime stores the
`ResourceState` inside the broader game state object managed by
`setGameState(...)`.

### 5.4 Mutation Semantics

- **Additions:** `addAmount` increases `amounts[index]`, optionally clamping to
  capacity. Negative input throws to catch misuse; callers use `spendAmount`
  for decrements.
- **Spending:** `spendAmount` verifies `amounts[index] >= amount` before
  subtracting. It returns `true/false` to signal insufficient resources and
  never allows negative balances. When spending fails, telemetry records a
  `ResourceSpendFailed` event with the offending command/system id.
- **Per-second accumulation:** Systems call `applyIncome` / `applyExpense`
  during their tick. Each helper writes into `incomePerSecond` and
  `expensePerSecond`, marking the dirty flag. These values remain raw rates until
  `finalizeTick` converts them into deltas using `deltaMs / 1000`.
- **Capacity updates:** `setCapacity` updates the `capacities` buffer, clamps
  the current amount if it now exceeds the cap, and returns the applied cap so
  command handlers can publish diffs.
- **Visibility/unlock:** `grantVisibility` and `unlock` set bits inside the
  flag buffer and mark the resource dirty so the UI is notified.

Dirty tracking (flag bit `0b100`) is cleared when the snapshot builder consumes
the resource during delta publication.

### 5.5 Snapshot & Persistence

- `snapshot()` returns an immutable view (`ResourceStateSnapshot`) containing:
  - `ids` (frozen array)
  - Immutable typed-array wrappers (leveraging `ImmutableTypedArraySnapshot`
    from `immutable-snapshots.ts`)
  - A compact list of dirty indices for the current tick
  - Flag bits encoded as a read-only `Uint8Array` snapshot
- `exportForSave()` returns a POJO suitable for persistence:

```ts
interface SerializedResourceState {
  readonly ids: readonly string[];
  readonly amounts: readonly number[];
  readonly capacities: readonly number[];
  readonly unlocked: readonly boolean[];
  readonly visible: readonly boolean[];
}
```

Offline catch-up consumes `SerializedResourceState`, rehydrates the typed arrays,
and continues deterministic execution.

### 5.6 Integration Points

- **Command handlers:** `COLLECT_RESOURCE` routes through `addAmount`,
  `PURCHASE_GENERATOR` and future `APPLY_MODIFIER` commands use `spendAmount`
  and `setCapacity`. All handlers include resource ids to translate into indices.
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
   and snapshot generation.
4. Update command handlers (future issue) to depend on `ResourceState`.
5. Extend documentation (`docs/runtime-command-queue-design.md`) with references
   to the new storage contract after implementation lands.

## 6. Testing Strategy

- Unit tests verifying:
  - Deterministic index ordering from unordered definitions.
  - Capacity enforcement and telemetry emission on attempted overflows.
  - Spending failure paths leave balances untouched.
  - `finalizeTick` converts rates into clamped deltas given various `deltaMs`.
  - Dirty index tracking only flags mutated resources per tick.
- Snapshot tests ensuring immutable wrappers block mutation attempts.
- Property-based tests (future follow-up) around additive/subtractive symmetry.

## 7. Risks & Mitigations

- **Precision drift:** Using `Float64Array` mitigates cumulative rounding error
  common in idle economies. Future balance tuning may switch to fixed-point
  arithmetic if we observe drift.
- **Serialization cost:** Large typed arrays can inflate save size. Mitigate by
  delta-encoding saves or compressing offline, tracked in a follow-up issue.
- **Content churn:** New resources require reinitialization. Mitigate by
  defining migration utilities that map old saves onto new resource ordering.
- **Future threading needs:** If a separate worker manipulates resources, shared
  buffers would require atomics. Out of scope now; document invariants so future
  work can extend safely.

## 8. Open Questions

- Do we need separate buffers for prestige currencies or can they reuse the same
  `ResourceState` with tagging?
- Should income/expense rates reset each tick or accumulate as rolling averages
  for analytics?
- What telemetry format best serves the diagnostics overlay (per-resource stats
  vs. aggregated totals)?
- How should we expose localized resource names for UI deltas without leaking
  mutable references?

## 9. Acceptance Criteria

- Struct-of-arrays `ResourceState` module checked into `packages/core`.
- Deterministic initialization from sample content definitions.
- Mutation helpers enforce caps and prevent negative balances.
- Snapshot API returns immutable data compatible with `CommandRecorder`.
- Unit tests cover initialization, mutation, and snapshot behaviors.

