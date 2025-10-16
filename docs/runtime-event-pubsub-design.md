# Runtime Event Pub/Sub Design

**Issue:** #8  
**Workstream:** Runtime Core  
**Status:** Draft  
**Last Updated:** 2025-10-14

> This document specifies the event publication and subscription system that
> powers cross-system signalling inside the Idle Engine runtime. It pairs with
> the command queue design (`docs/runtime-command-queue-design.md`) and aligns
> with the implementation sequencing captured in `docs/implementation-plan.md`
> Phase 1.

## 1. Overview

Issue #8 calls for a deterministic in-process event bus so systems, command
handlers, and integrations can react to runtime activity without tight coupling
or shared mutable state. The engine currently relies on direct callbacks and
resource polling; the new event layer supplies an explicit contract for domain
events (threshold triggers, automation toggles, social notifications, etc.)
while preserving the single-threaded simulation model described in
`docs/idle-engine-design.md` §9.

The pub/sub system emits immutable event payloads tagged with tick metadata and
routes them to two audiences:

1. **Internal systems** running inside the simulation worker.
2. **External observers** (presentation shell, telemetry, persistence replay)
   that consume batched event frames via existing transport buffers.

## 2. Goals

- **Deterministic ordering:** Events flow through a single queue processed in a
  repeatable sequence per tick so offline catch-up and replays remain stable.
- **Type-safe contracts:** Event payloads use shared discriminated unions to
  prevent runtime casting, mirroring the command payload strategy.
- **Bounded allocations:** Event storage relies on recyclable buffers to avoid
  per-tick garbage that would erode performance over long sessions.
- **Scoped subscriptions:** Systems register interest during initialization and
  receive only the event categories they declare to keep dispatch efficient.
- **Snapshot-ready batches:** The bus emits compact frames the existing
  transport layer can forward to the presentation shell without bespoke wiring.

## 3. Non-Goals

- Building cross-process or network delivery (handled later by social services
  and backend integrations).
- Persisting a long-lived analytics stream; the bus retains only the current
  tick plus the in-flight snapshot batch.
- Supporting asynchronous listeners; all handlers execute within the simulation
  tick and may not yield control or schedule promises.
- Publishing UI layout events or rendering hints (handled by the shell based on
  state snapshots).

## 4. Current State

- `packages/core` exposes a command queue, dispatcher, and recorder but lacks a
  general event aggregation mechanism. Systems communicate via direct function
  calls and shared resource state (`resource-state.ts`).
- `resource-publish-transport.ts` mirrors resource deltas to the presentation
  shell yet cannot emit domain-specific events (e.g., achievement unlocked).
- Telemetry utilities (`telemetry.ts`) provide logging hooks but cannot
  subscribe to structured runtime events.
- No test scaffolding exists to assert deterministic delivery order or to
  validate that subscriptions remain isolated between saves.

## 5. Requirements

### 5.1 Functional Requirements

1. Register event categories and payload schemas at engine bootstrap with
   compile-time typing (leveraging TypeScript discriminated unions).
2. Allow command handlers, systems, and scripts to publish events during the
   active tick via a lightweight `EventPublisher`.
3. Deliver published events to subscribing systems during the same tick, after
   command execution but before snapshot emission, so state mutations precede
   reactions.
4. Accumulate events into a `RuntimeEventFrame` structure exported alongside
   resource deltas for the presentation shell.
5. Reset the event buffers between ticks (or when the simulation is paused) to
   prevent stale payload leakage across frames.

### 5.2 Non-Functional Requirements

1. Zero observable impact on tick cadence at 60 Hz under typical load (≤200
   events per tick).
2. No reliance on dynamic reflection; event routing must remain pure TypeScript
   for compatibility with worker contexts.
3. Provide explicit back-pressure diagnostics when publisher volume exceeds the
   configured buffer limits.
4. Ensure the bus is replayable: given the same command stream, the emitted
   event batches must be identical.

## 6. Proposed Solution

### 6.1 Event Taxonomy & Schema

- Define `RuntimeEvent<TType extends string, TPayload>` in
  `packages/core/src/events/runtime-event.ts`. Each event is a readonly object:
  ```ts
  interface RuntimeEvent<TType extends RuntimeEventType, TPayload> {
    readonly type: TType;
    readonly tick: number;
    readonly issuedAt: number; // monotonic ms within session
    readonly payload: Readonly<TPayload>;
  }
  ```
- `RuntimeEventType` is a string literal union grouped by domains (`resource`,
  `automation`, `social`, `telemetry`). Runtime-owned types live in
  `packages/core`, while content packs contribute additional entries through an
  offline manifest. Pack manifests emit `eventTypes` metadata that is sorted by
  `(packSlug, eventKey)` during generation so every build produces the same
  declaration file and replay manifests stay stable.
- Export canonical payload types under `@idle-engine/core/events` (e.g.,
  `ResourceThresholdReachedEvent`, `AutomationToggleEvent`) so command handlers
  and systems share definitions.
- Per-pack manifests authored in `content/event-types.json` files describe
  additional event types. Running `pnpm generate` merges the manifests with the
  core catalogue, refreshes the deterministic manifest hash, and updates the
  `ContentRuntimeEventType` union exported by `@idle-engine/core`. See
  `docs/runtime-event-manifest-authoring.md` for authoring guidance.
- The generator also publishes a manifest hash consumed by the recorder; replay
  files embed the hash and fail fast if the runtime attempts to load a different
  catalogue, preventing content drift across environments.

### 6.2 Event Bus Core

- Introduce `EventBus` in `packages/core/src/events/event-bus.ts` encapsulating
  three concepts:
  1. `EventRegistry`: maps event type → payload validator/encoder and assigns
     each type a numeric channel index for fast lookups.
  2. `EventBuffer`: ring buffer storing `RuntimeEvent` instances for the current
     tick. Two buffers exist per channel: one for internal subscribers, one for
     outbound snapshot frames. Buffers reuse preallocated slots (`ObjectPool`).
  3. `SubscriberTable`: fixed-length array of subscription callbacks keyed by
     channel index.
- The bus exposes:
  ```ts
  interface EventPublisher {
    publish<TType extends RuntimeEventType>(
      eventType: TType,
      payload: RuntimeEventPayload<TType>,
    ): void;
  }

  type EventHandler<TType extends RuntimeEventType> = (
    event: RuntimeEvent<TType>,
    context: EventDispatchContext,
  ) => void;
  ```
- `EventDispatchContext` carries references to immutable runtime state snapshots
  needed for read-only inspection while forbidding mutation outside commands.

### 6.3 Tick Lifecycle Integration

1. **Tick Start:** Scheduler resets all event buffers, bumping the logical tick
   counter. Systems may register or deregister subscriptions only at this
   boundary (avoids mid-tick mutations to the subscriber table).
2. **Command Execution:** Command queue drains and mutates state as designed in
   issue #6. Command handlers can call `publish` to emit domain events.
3. **System Update Phase:** After all commands, systems execute in their
   deterministic order (§9 of the engine design). Systems can publish additional
   events and receive events emitted earlier in the same tick.
4. **Event Dispatch:** For each channel, the bus iterates events in FIFO order
   and invokes subscriber handlers synchronously. The dispatcher guards against
   re-entrant publication causing infinite loops by allowing nested publishes
   but enqueuing them to the tail of the current tick buffer.
5. **Snapshot Emission:** Once internal subscribers finish, the bus compacts the
   outbound buffers into a `RuntimeEventFrame` (typed arrays + string table)
   handed to `resource-publish-transport` so the presentation shell receives
   both state deltas and events in the same transferable payload.
6. **Tick End:** Telemetry records buffer metrics (events per channel, dropped
   events) and clears transient data.

### 6.4 Buffer Management & Back-Pressure

- Default buffer capacity per channel is 256 events. `EventBusOptions` now
  accepts per-channel configs that include `capacity`, `softLimitPercent`,
  `maxEventsPerTick`, `maxEventsPerSecond`, and `cooldownTicks` so integrators
  can tune pressure controls without rewriting the bus.
- Publishing beyond the configured soft limit triggers the `EventDiagnostics`
  rate limiter. The first breach issues a warning with remaining capacity and
  increments `events.soft_limited`; subsequent breaches back off exponentially
  before logging again, keeping telemetry actionable while publishers adapt.
- Overflowing the hard capacity still throws `EventBufferOverflowError` and
  records `events.overflowed`, causing the tick to rewind at `beginTick()`. Hard
  limits remain deterministic safeguards and bypass the rate limiter.
- `eventBus.getBackPressureSnapshot()` surfaces per-channel `inUse`,
  `remainingCapacity`, `highWaterMark`, and the current rate-limiter cooldown so
  dashboards and transports can plot sustained load alongside cumulative
  counters (`events.published`, `events.soft_limited`, `events.overflowed`,
  `events.subscribers`).
- Buffers use struct-of-arrays layouts mirroring resource storage so we can
  transfer them to the shell with minimal copying. Strings (event types, IDs)
  enter a deduplicated string table shared with resource snapshots. When the
  rolling 256-tick average drops below two events per channel, the exporter can
  flip a feature flag to emit compact object arrays instead; diagnostics record
  the transition so we can revisit the default if sparse workloads dominate.
- When offline catch-up runs for many hours, the bus batches events into
  configurable windows (default 5 minutes) to prevent unbounded array growth.
  The implementation segments the backlog into `RuntimeEventFrame` chunks and
  streams them through the existing recorder infrastructure.

### 6.5 Subscription API Ergonomics

- Systems register via:
  ```ts
  interface EventSubscriptionHost {
    on<TType extends RuntimeEventType>(
      eventType: TType,
      handler: EventHandler<TType>,
    ): EventSubscription;
  }
  ```
- `EventSubscription` exposes `unsubscribe()` used during system teardown
  (prestige resets, content unload). Teardown defers actual removal until the
  next tick boundary.
- Provide convenience helpers for common patterns:
  - `onResourceThreshold(resourceId, comparator, handler)` to reduce boilerplate.
  - `once(eventType, handler)` that auto-unsubscribes after first invocation.
- Scripts running inside the deterministic sandbox receive a limited proxy that
  only allows them to subscribe to whitelisted event types (guarded by content
  permissions).

### 6.6 External Publishing & Replay

- Event frames feed into the command recorder (`packages/core/src/command-recorder.ts`) so replay files contain both commands and events. Replays validate
  that emitted events match recorded ones.
- Presentation shell consumes event frames to trigger UI transitions (e.g.,
  toast notifications). The Vite web shell filters events client-side to avoid
  jank during heavy tick loads, as detailed in `packages/shell-web`.
- Persistence layer optionally stores the most recent N frames (configurable) to
  resume UI transitions after reload.

## 7. Integration & Sequencing

1. **Bootstrap wiring:** Extend the runtime initialization entry point
   (`packages/core/src/index.ts`) to accept an `EventBusOptions` object and
   provide a default bus instance.
2. **Command queue hook:** Inject the publisher into the existing command
  dispatcher so handlers can emit events without importing the bus directly.
3. **System registration:** Update system registries to declare event
  dependencies alongside execution order. This change blocks systems that
  subscribe to unknown events at bootstrap.
4. **Transport linkage:** Enhance `resource-publish-transport.ts` (or extract a
  shared `state-transport.ts`) to serialise `RuntimeEventFrame` payloads.
5. **Telemetry coupling:** Forward bus stats into the telemetry facade for Grafana instrumentation when running under Node.
6. **Documentation:** Publish event catalog tables in `docs/runtime-step-lifecycle.md` once initial channels ship.

Sequencing aligns with the Phase 1 Runtime Core tasks outlined in the
implementation plan: command queue integration precedes transport updates to
keep merges small and reviewable.

## 8. Testing Strategy

- **Unit tests:** Validate publish/subscribe order, handler isolation, buffer
  limits, and nested publication semantics in
  `packages/core/src/events/event-bus.test.ts`.
- **Integration tests:** Simulate a multi-system tick (resource system +
  automation system) to confirm deterministic playback across multiple ticks.
- **Replay verification:** Extend `command-recorder.test.ts` to assert that
  recorded event frames match live emissions when re-running the same command
  sequence.
- **Performance tests:** Benchmark publishing 10k events per tick to ensure the
  bus respects the 100ms budget, mirroring the profiling harness planned in the
  implementation plan.

## 9. Observability

- Emit telemetry counters for `events.published`, `events.soft_limited`,
  `events.overflowed`, and `events.subscribers` per tick.
- Surface per-channel gauges for rate limiter cooldowns and soft-limit breaches
  so dashboards can show which channels are approaching thresholds.
- Log structured warnings when handlers exceed execution time thresholds (e.g.,
  >2 ms) to surface slow subscribers.
- Expose a developer-mode event inspector in the web shell that reads the
  transfer frame and renders the last N events for debugging.

## 10. Resolved Follow-Ups

All deferred decisions from the draft have been finalised in
`docs/runtime-event-bus-decisions.md` (issue #87). Highlights:

1. **Content-defined events:** Content packs contribute event types through
   schema-backed manifests generated at build time, preserving deterministic
   replay manifests.
2. **Priority channels:** The bus keeps a single FIFO dispatch order; publishers
   control sequencing by when they emit events rather than via priority tiers.
3. **Back-pressure strategy:** Channel-scoped diagnostics throttle soft-limit
   warnings with configurable limits and exponential backoff while hard caps
   still abort the tick.
4. **Serialization format:** Struct-of-arrays remains the default, with a
   feature-flagged downgrade to object arrays when rolling density metrics show
   sparse workloads.

## 11. Risks & Mitigations

- **Runaway publishers:** Excessive event emission could starve tick time.
  Mitigation: channel-level thresholds with telemetry alerts and optional
  publisher throttles.
- **Subscriber side effects:** Handlers mutating shared state outside commands
  would break determinism. Mitigation: pass read-only contexts and audit tests
  for unauthorized mutations.
- **Transport bloat:** Event frames may enlarge the payload sent to the shell.
  Mitigation: compress string tables and allow shell to opt into specific
  channels.

## 12. Rollout Plan

1. Land the core event bus with unit tests and documentation stubs.
2. Integrate resource threshold events and confirm shell transport round-trip.
3. Expand coverage to automation toggles and prestige resets.
4. Enable recording/replay validation and ship developer tooling for inspection.
5. Update implementation plan and project board cards once early adopters
   integrate (saves, UI toasts, analytics).

Completion of this rollout closes issue #8 and unlocks downstream features that
depend on structured runtime event streams.
