---
title: Runtime Event Pub/Sub Design
---

# Runtime Event Pub/Sub Design

Use this design document to understand the event publication and subscription system that powers cross-system signalling inside the Idle Engine runtime.

## Document Control
- **Title**: Introduce deterministic runtime event pub/sub system
- **Authors**: Original design team
- **Reviewers**: Runtime Core team
- **Status**: Draft
- **Last Updated**: 2025-10-14
- **Related Issues**: #8
- **Execution Mode**: Hybrid

## 1. Summary
The Idle Engine requires a deterministic in-process event bus to enable systems, command handlers, and integrations to react to runtime activity without tight coupling or shared mutable state. This design introduces a type-safe, bounded-allocation pub/sub system that emits immutable event payloads tagged with tick metadata, routed to both internal systems running inside the simulation worker and external observers (presentation shell, telemetry, persistence replay). The solution maintains the single-threaded simulation model while providing explicit contracts for domain events such as threshold triggers, automation toggles, and social notifications.

## 2. Context & Problem Statement
- **Background**: The engine currently relies on direct callbacks and resource polling for cross-system communication. `packages/core` exposes a command queue, dispatcher, and recorder but lacks a general event aggregation mechanism. Systems communicate via direct function calls and shared resource state (`resource-state.ts`). The `resource-publish-transport.ts` mirrors resource deltas to the presentation shell but cannot emit domain-specific events (e.g., achievement unlocked). Telemetry utilities (`telemetry.ts`) provide logging hooks but cannot subscribe to structured runtime events.
- **Problem**: The lack of an explicit event layer creates tight coupling between systems, makes it difficult to implement reactive features (threshold triggers, automation toggles, social notifications), and prevents deterministic replay validation of domain events. No test scaffolding exists to assert deterministic delivery order or to validate that subscriptions remain isolated between saves.
- **Forces**: Must preserve the single-threaded simulation model described in `docs/idle-engine-design.md` §6.2. Must maintain 60 Hz tick cadence under typical load (≤200 events per tick). Must support offline catch-up and deterministic replay for recorded sessions. Must integrate with existing transport buffers for presentation shell communication.

## 3. Goals & Non-Goals
- **Goals**:
  1. **Deterministic ordering**: Events flow through a single queue processed in a repeatable sequence per tick so offline catch-up and replays remain stable.
  2. **Type-safe contracts**: Event payloads use shared discriminated unions to prevent runtime casting, mirroring the command payload strategy.
  3. **Bounded allocations**: Event storage relies on recyclable buffers to avoid per-tick garbage that would erode performance over long sessions.
  4. **Scoped subscriptions**: Systems register interest during initialization and receive only the event categories they declare to keep dispatch efficient.
  5. **Snapshot-ready batches**: The bus emits compact frames the existing transport layer can forward to the presentation shell without bespoke wiring.

- **Non-Goals**:
  - Building cross-process or network delivery (handled later by social services and backend integrations).
  - Persisting a long-lived analytics stream; the bus retains only the current tick plus the in-flight snapshot batch.
  - Supporting asynchronous listeners; all handlers execute within the simulation tick and may not yield control or schedule promises.
  - Publishing UI layout events or rendering hints (handled by the shell based on state snapshots).

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**: Runtime Core team, Content team, Tooling team
- **Agent Roles**:
  - Runtime Implementation Agent: Core event bus implementation, buffer management, tick lifecycle integration
  - Testing Agent: Unit tests, integration tests, replay verification, performance benchmarks
  - Docs Agent: API documentation, event catalog tables, usage examples
- **Affected Packages/Services**:
  - `packages/core` (primary implementation)
  - `packages/core/src/events` (new directory)
  - `packages/core/src/command-recorder.ts` (replay integration)
  - `packages/shell-web` (event frame consumption)
  - `resource-publish-transport.ts` (transport integration)
- **Compatibility Considerations**: Must maintain backward compatibility with existing command queue and resource state systems. Event frames must be versioned for forward compatibility as new event types are added.

## 5. Current State
- `packages/core` exposes a command queue, dispatcher, and recorder but lacks a general event aggregation mechanism.
- Systems communicate via direct function calls and shared resource state (`resource-state.ts`).
- `resource-publish-transport.ts` mirrors resource deltas to the presentation shell yet cannot emit domain-specific events (e.g., achievement unlocked).
- Telemetry utilities (`telemetry.ts`) provide logging hooks but cannot subscribe to structured runtime events.
- No test scaffolding exists to assert deterministic delivery order or to validate that subscriptions remain isolated between saves.
- This design pairs with the command queue design (`docs/runtime-command-queue-design.md`) and aligns with the implementation sequencing captured in `docs/implementation-plan.md` Phase 1.

## 6. Proposed Solution
### 6.1 Architecture Overview
- **Narrative**: The event bus encapsulates three core concepts: (1) EventRegistry maps event types to payload validators/encoders and assigns numeric channel indices for fast lookups, (2) EventBuffer provides ring buffers storing RuntimeEvent instances for the current tick with separate buffers for internal subscribers and outbound snapshot frames, and (3) SubscriberTable maintains fixed-length arrays of subscription callbacks keyed by channel index. Events flow through a single queue during each tick, processed after command execution but before snapshot emission, ensuring state mutations precede reactions. The bus emits compact RuntimeEventFrame structures exported alongside resource deltas for the presentation shell.
- **Diagram**: See tick lifecycle integration diagram in section 6.3.

### 6.2 Detailed Design
#### Runtime Changes

**Event Taxonomy & Schema**
- Define `RuntimeEvent<TType extends string, TPayload>` in `packages/core/src/events/runtime-event.ts`. Each event is a readonly object:
  ```ts
  interface RuntimeEvent<TType extends RuntimeEventType, TPayload> {
    readonly type: TType;
    readonly tick: number;
    readonly issuedAt: number; // monotonic ms within session
    readonly payload: Readonly<TPayload>;
  }
  ```
- `RuntimeEventType` is a string literal union grouped by domains (`resource`, `automation`, `social`, `telemetry`). Runtime-owned types live in `packages/core`, while content packs contribute additional entries through an offline manifest.
- Pack manifests emit `eventTypes` metadata that is sorted by `(packSlug, eventKey)` during generation so every build produces the same declaration file and replay manifests stay stable.
- Export canonical payload types under `@idle-engine/core/events` (e.g., `ResourceThresholdReachedEvent`, `AutomationToggleEvent`) so command handlers and systems share definitions.

**Event Bus Core**
- Introduce `EventBus` in `packages/core/src/events/event-bus.ts` exposing:
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
- `EventDispatchContext` carries references to immutable runtime state snapshots needed for read-only inspection while forbidding mutation outside commands.

**Tick Lifecycle Integration**
1. **Tick Start**: Scheduler resets all event buffers, bumping the logical tick counter. Systems may register or deregister subscriptions only at this boundary (avoids mid-tick mutations to the subscriber table).
2. **Command Execution**: Command queue drains and mutates state as designed in issue #6. Command handlers can call `publish` to emit domain events.
3. **System Update Phase**: After all commands, systems execute in their deterministic order (§9 of the engine design). Systems can publish additional events and receive events emitted earlier in the same tick.
4. **Event Dispatch**: For each channel, the bus iterates events in FIFO order and invokes subscriber handlers synchronously. The dispatcher guards against re-entrant publication causing infinite loops by allowing nested publishes but enqueuing them to the tail of the current tick buffer.
5. **Snapshot Emission**: Once internal subscribers finish, the bus compacts the outbound buffers into a `RuntimeEventFrame` (typed arrays + string table) handed to `resource-publish-transport` so the presentation shell receives both state deltas and events in the same transferable payload.
6. **Tick End**: Telemetry records buffer metrics (events per channel, dropped events) and clears transient data.

**Buffer Management & Back-Pressure**
- Default buffer capacity per channel is 256 events. `EventChannelConfiguration` exposes an optional `diagnostics` block and `channelConfigs` allows per-channel overrides so integrators can tune `maxEventsPerTick`, `maxEventsPerSecond`, `cooldownTicks`, and `maxCooldownTicks` without rewriting the bus.
- Publishing beyond the configured soft limit triggers the `EventDiagnostics` rate limiter. The first breach issues an `EventSoftLimitBreach` warning with remaining capacity and increments `events.soft_limited` alongside the per-channel `events.soft_limit_breaches` telemetry counter.
- Overflowing the hard capacity throws `EventBufferOverflowError` and records `events.overflowed`, causing the tick to rewind at `beginTick()`.
- `eventBus.getBackPressureSnapshot()` surfaces per-channel `inUse`, `remainingCapacity`, `highWaterMark`, `cooldownTicksRemaining`, `softLimitBreaches`, and the most recent `eventsPerSecond` sample for dashboards and transports.
- Buffers use struct-of-arrays layouts mirroring resource storage for efficient transfer to the shell with minimal copying.

**Subscription API**
- Systems register via:
  ```ts
  interface EventSubscriptionHost {
    on<TType extends RuntimeEventType>(
      eventType: TType,
      handler: EventHandler<TType>,
    ): EventSubscription;
  }
  ```
- `EventSubscription` exposes `unsubscribe()` used during system teardown (prestige resets, content unload). Teardown defers actual removal until the next tick boundary.
- Convenience helpers for common patterns:
  - `onResourceThreshold(resourceId, comparator, handler)` to reduce boilerplate.
  - `once(eventType, handler)` that auto-unsubscribes after first invocation.

#### Data & Schemas
- Per-pack manifests authored in `content/event-types.json` files describe additional event types.
- Running `pnpm generate` merges the manifests with the core catalogue, refreshes the deterministic manifest hash, and updates the `ContentRuntimeEventType` union exported by `@idle-engine/core`.
- See `docs/runtime-event-manifest-authoring.md` for authoring guidance.
- The generator publishes a manifest hash consumed by the recorder; replay files embed the hash and fail fast if the runtime attempts to load a different catalogue, preventing content drift across environments.

#### APIs & Contracts
- Event frames feed into the command recorder (`packages/core/src/command-recorder.ts`) so replay files contain both commands and events. Replays validate that emitted events match recorded ones.
- Presentation shell consumes event frames to trigger UI transitions (e.g., toast notifications). The Vite web shell filters events client-side to avoid jank during heavy tick loads, as detailed in `packages/shell-web`.
- Persistence layer optionally stores the most recent N frames (configurable) to resume UI transitions after reload.
- Scripts running inside the deterministic sandbox receive a limited proxy that only allows them to subscribe to whitelisted event types (guarded by content permissions).

#### Tooling & Automation
- Expose a developer-mode event inspector in the web shell that reads the transfer frame and renders the last N events for debugging, including the current soft-limit cooldown, breach counts, and per-channel rates sourced from the back-pressure snapshot.

### 6.3 Operational Considerations
- **Deployment**: Integration follows Phase 1 Runtime Core sequencing: command queue integration precedes transport updates to keep merges small and reviewable.
- **Telemetry & Observability**:
  - Emit telemetry counters for `events.published`, `events.soft_limited`, `events.overflowed`, and `events.subscribers` per tick.
  - Surface per-channel gauges (`idle_engine_events_soft_limit_cooldown_ticks`) and counters (`idle_engine_events_soft_limit_breaches_total`) so dashboards can highlight channels that continue to push into the soft limit window.
  - Log structured warnings when handlers exceed execution time thresholds (e.g., >2 ms) to surface slow subscribers.
- **Security & Compliance**: Scripts running inside the deterministic sandbox receive limited event subscription capabilities restricted by content permissions whitelist.

## 7. Work Breakdown & Delivery Plan
### 7.1 Issue Map

| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| feat(core): implement event bus core | EventBus, EventRegistry, EventBuffer, SubscriberTable | Runtime Implementation Agent | Design approval | Unit tests pass; exports public API |
| feat(core): add runtime event types | RuntimeEvent, RuntimeEventType unions, payload schemas | Runtime Implementation Agent | Event bus core | TypeScript compilation; types exported |
| feat(core): integrate tick lifecycle | Wire event dispatch into scheduler phases | Runtime Implementation Agent | Event bus core, command queue #6 | Integration tests validate deterministic ordering |
| feat(core): add buffer management | Back-pressure diagnostics, soft/hard limits, telemetry | Runtime Implementation Agent | Event bus core | Performance tests validate `<100ms` tick budget |
| feat(core): implement subscription API | EventSubscriptionHost, convenience helpers | Runtime Implementation Agent | Event bus core | Unit tests cover subscribe/unsubscribe lifecycle |
| feat(core): integrate transport layer | RuntimeEventFrame serialization, resource-publish-transport updates | Runtime Implementation Agent | Event bus core | Shell receives event frames alongside resource deltas |
| feat(core): add replay support | Command recorder integration, manifest hash validation | Runtime Implementation Agent | Event bus core, transport layer | Replay tests validate deterministic emission |
| feat(content): add event manifest generation | Content pack event-types.json, pnpm generate integration | Tooling Agent | Event bus core | Generate produces deterministic manifest hash |
| feat(shell): add event frame consumption | Parse and display events in web shell | UI Agent | Transport layer | Shell renders toast notifications from events |
| docs(core): publish event catalog | API documentation, usage examples, event type tables | Docs Agent | All implementation complete | Docs published in runtime-step-lifecycle.md |
| test(core): performance benchmarks | Validate 10k events/tick `<100ms` | Testing Agent | Event bus core | CI includes performance regression suite |

### 7.2 Milestones
- **Phase 1 - Core Implementation**: Land event bus with unit tests and documentation stubs. Integrate resource threshold events and confirm shell transport round-trip.
- **Phase 2 - Feature Expansion**: Expand coverage to automation toggles and prestige resets. Enable recording/replay validation.
- **Phase 3 - Developer Tooling**: Ship developer tooling for inspection. Update implementation plan and project board cards once early adopters integrate (saves, UI toasts, analytics).

### 7.3 Coordination Notes
- **Hand-off Package**: Share `docs/idle-engine-design.md` §6.2, `docs/runtime-command-queue-design.md`, `docs/implementation-plan.md` Phase 1 with implementing agents.
- **Communication Cadence**: Weekly sync on Runtime Core progress; flag blocking issues immediately via GitHub issue comments.

## 8. Agent Guidance & Guardrails
- **Context Packets**:
  - Required reading: `docs/idle-engine-design.md` §6.2 (single-threaded simulation model), `docs/runtime-command-queue-design.md` (command execution lifecycle)
  - Environment: Must run in worker contexts; no DOM or async APIs allowed in event handlers
  - Repository: `packages/core/src/events/` for all new event system code
- **Prompting & Constraints**:
  - All event types must be readonly discriminated unions
  - Event handlers must be synchronous and side-effect free (read-only access to state)
  - Commit messages must follow conventional commits format: `feat(core): <description>`
  - TypeScript strict mode required; no `any` types
- **Safety Rails**:
  - Do not mutate shared state in event handlers; pass EventDispatchContext with readonly snapshots
  - Do not allow unbounded buffer growth; enforce hard capacity limits with clear error messages
  - Do not skip telemetry instrumentation; all critical paths must emit metrics
- **Validation Hooks**:
  - Run `pnpm test` before marking tasks complete
  - Run `pnpm build` to validate TypeScript compilation
  - Run performance benchmarks (`pnpm bench:events`) to validate `<100ms` tick budget
  - Validate replay determinism with `pnpm test:replay`

## 9. Alternatives Considered
1. **External event broker (Redis pub/sub, NATS)**: Rejected due to cross-process coordination overhead, network latency unpredictability, and complexity of maintaining deterministic replay across network boundaries. In-process solution keeps simulation single-threaded and deterministic.

2. **Observable/RxJS streams**: Rejected due to async nature conflicting with synchronous tick model, large bundle size for web shell, and difficulty enforcing deterministic execution order with operators like `debounce` or `throttle`.

3. **Event sourcing with persistent event log**: Rejected as over-engineering for current requirements. The bus only needs current tick + snapshot batch; full event sourcing would require database integration and increase complexity without clear benefit. May revisit for analytics workloads.

4. **Priority-based event channels**: Rejected in favor of single FIFO dispatch order. Publishers control sequencing by when they emit events rather than via priority tiers. Simplifies implementation and reasoning about deterministic behavior. Documented in `docs/runtime-event-bus-decisions.md` (issue #87).

5. **Object arrays vs struct-of-arrays serialization**: Chose struct-of-arrays as default for memory efficiency and transfer performance, with feature-flagged fallback to object arrays when rolling density metrics show sparse workloads. Both formats share a `format` discriminator for safe downstream branching.

## 10. Testing & Validation Plan
- **Unit / Integration**:
  - Validate publish/subscribe order, handler isolation, buffer limits, and nested publication semantics in `packages/core/src/events/event-bus.test.ts`.
  - Simulate a multi-system tick (resource system + automation system) to confirm deterministic playback across multiple ticks.
  - Extend `command-recorder.test.ts` to assert that recorded event frames match live emissions when re-running the same command sequence.
- **Performance**:
  - Benchmark publishing 10k events per tick to ensure the bus respects the 100ms budget, mirroring the profiling harness planned in the implementation plan.
  - Validate zero observable impact on tick cadence at 60 Hz under typical load (≤200 events per tick).
  - Profile buffer allocation patterns to confirm bounded allocations without per-tick garbage collection pressure.
- **Tooling / A11y**: Developer-mode event inspector in web shell must render events with clear visual hierarchy and support screen readers.

## 11. Risks & Mitigations
| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Runaway publishers exceeding event limits | Tick time starvation, degraded UX | Medium | Channel-level soft/hard thresholds with telemetry alerts and exponential backoff on warnings |
| Subscriber handlers mutating shared state | Breaks determinism, corrupts replays | Medium | Pass read-only EventDispatchContext; audit tests for unauthorized mutations; runtime checks in dev mode |
| Event frame transport bloat | Increased network payload, shell lag | Low | Compress string tables; allow shell to opt into specific channels; monitor payload size metrics |
| Content manifest hash mismatches during replay | Replay fails to load, bad user experience | Low | Fail fast with clear error message; version manifest schema; document upgrade path in migration guide |
| Performance regression from event overhead | Cannot maintain 60 Hz tick rate | Low | Continuous performance benchmarking in CI; profile event dispatch critical path; buffer pooling to minimize GC |

## 12. Rollout Plan
- **Milestones**:
  1. **Week 1-2**: Land the core event bus with unit tests and documentation stubs.
  2. **Week 3**: Integrate resource threshold events and confirm shell transport round-trip.
  3. **Week 4-5**: Expand coverage to automation toggles and prestige resets.
  4. **Week 6**: Enable recording/replay validation and ship developer tooling for inspection.
  5. **Week 7+**: Update implementation plan and project board cards once early adopters integrate (saves, UI toasts, analytics).
- **Migration Strategy**: No breaking changes to existing systems. Event bus is additive; systems opt-in to publishing/subscribing. Existing command queue and resource state mechanisms remain unchanged.
- **Communication**:
  - Publish API documentation and usage examples in `docs/runtime-step-lifecycle.md` once initial channels ship.
  - Update project board to reflect completion of issue #8.
  - Announce availability to content team for event manifest authoring.

## 13. Open Questions
All deferred decisions from the draft have been finalized in `docs/runtime-event-bus-decisions.md` (issue #87). No open questions remain.

## 14. Follow-Up Work
- **Cross-process event delivery**: Build network transport for social services and backend integrations (deferred to Phase 2).
- **Long-lived analytics stream**: Investigate persistent event storage for analytics workloads beyond current tick + snapshot batch (deferred pending analytics requirements).
- **Advanced subscription patterns**: Explore filtered subscriptions (e.g., subscribe to specific resource IDs) if common patterns emerge (deferred until usage data available).
- **Event replay UI**: Build dedicated replay viewer with timeline scrubbing and event filtering (deferred to tooling roadmap).

## 15. References
- `docs/idle-engine-design.md` §6.2: Single-threaded simulation model
- `docs/runtime-command-queue-design.md`: Command execution lifecycle and dispatcher integration
- `docs/implementation-plan.md` Phase 1: Runtime Core task sequencing
- `docs/runtime-event-bus-decisions.md` (issue #87): Resolved design decisions on content-defined events, priority channels, back-pressure strategy, serialization format
- `docs/runtime-event-manifest-authoring.md`: Content pack event type authoring guidance
- `docs/runtime-step-lifecycle.md`: Target location for event catalog tables documentation
- `packages/core/src/events/`: Event system implementation directory
- `packages/core/src/command-recorder.ts`: Replay integration point
- `packages/shell-web`: Event frame consumption implementation
- `resource-publish-transport.ts`: Transport layer integration point

## Appendix A — Glossary
- **Event Bus**: In-process pub/sub system for routing domain events between runtime systems
- **RuntimeEvent**: Immutable event payload tagged with tick metadata and event type
- **RuntimeEventType**: String literal union discriminating event categories (resource, automation, social, telemetry)
- **EventPublisher**: Interface for publishing events during command execution or system updates
- **EventHandler**: Synchronous callback invoked when subscribed event is dispatched
- **EventDispatchContext**: Read-only runtime state snapshot passed to event handlers
- **EventBuffer**: Ring buffer storing RuntimeEvent instances for the current tick
- **EventRegistry**: Maps event types to payload validators/encoders with numeric channel indices
- **SubscriberTable**: Fixed-length array of subscription callbacks keyed by channel index
- **RuntimeEventFrame**: Compact serialization of tick events using typed arrays and string table
- **Back-pressure**: Rate limiting mechanism when event volume exceeds configured thresholds
- **Soft limit**: Configurable threshold triggering diagnostic warnings with exponential backoff
- **Hard limit**: Maximum capacity causing tick rewind when exceeded
- **Deterministic replay**: Ability to reproduce exact event sequence given same command stream
- **Manifest hash**: Cryptographic hash of event type catalogue for replay validation

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2025-10-14 | Original design team | Initial draft |
| 2025-12-21 | Claude Opus 4.5 | Migrated to design document template format (issue #205) |
