---
title: Runtime Event Broadcast Design (Issue 547)
sidebar_position: 4
---

# Runtime Event Broadcast Design (Issue 547)

## Document Control
- **Title**: Add runtime event broadcast streaming for Issue 547
- **Authors**: Codex (AI, Runtime Systems)
- **Reviewers**: Runtime Core maintainers
- **Status**: Draft
- **Last Updated**: 2025-12-30
- **Related Issues**: https://github.com/hansjm10/Idle-Game-Engine/issues/547, https://github.com/hansjm10/Idle-Game-Engine/pull/704
- **Execution Mode**: AI-led

## 1. Summary
Issue 547 adds a server-to-client event broadcast layer that serializes runtime event frames into JSON-friendly broadcast frames, filters or batches them for network efficiency, and hydrates them on the client to trigger local handlers. The solution builds on existing runtime event frames and event bus dispatch order, adding checksum and manifest hash validation for integrity checks plus optional deduplication for replay scenarios.

## 2. Context & Problem Statement
- **Background**: The runtime already captures per-tick events in `RuntimeEventFrame` via `buildRuntimeEventFrame` and dispatches events locally with `EventBus`, but there is no standardized server-to-client broadcast format or hydration helper. Clients and transports must currently invent their own serialization, filtering, and ordering behavior.
- **Problem**: Without a shared broadcast format, server-to-client event streaming is inconsistent, hard to validate, and lacks support for filtering, batching, and replay deduplication.
- **Forces**: The solution must remain deterministic, preserve existing event ordering semantics, be JSON friendly for transport, and stay additive to the existing runtime event bus and frame APIs.

## 3. Goals & Non-Goals
- **Goals**:
  1. Define a broadcast frame format derived from `RuntimeEventFrame` with optional checksum and manifest hash.
  2. Provide event filtering by type for server-side or client-side visibility control.
  3. Support batching, priority flush, and optional coalescing to reduce network overhead.
  4. Hydrate broadcast frames into the runtime event bus to trigger local handlers.
  5. Provide replay deduplication for repeated frames.
  6. Add tests and a benchmark that validates batching behavior.
- **Non-Goals**:
  - Implement network transports, authentication, or encryption.
  - Persist event history beyond the batch window.
  - Replace existing state sync or command transport designs.
  - Provide cryptographic integrity or anti-tamper guarantees.

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**: Runtime Core maintainers, networking/transport integrators, client shell developers, QA.
- **Agent Roles**:

| Agent | Responsibilities |
|-------|------------------|
| Runtime Implementation Agent | Implement broadcast frame, batching, dedupe, and hydration helpers in core. |
| Testing Agent | Add unit tests for filtering, batching, coalescing, checksum, and hydration. |
| Benchmark Agent | Add batching overhead benchmark and integrate into benchmark script. |
| Docs Agent | Document usage and options in core README. |

- **Affected Packages/Services**:
  - `packages/core` (broadcast helpers, tests, exports)
  - `packages/core/benchmarks` (batching benchmark)
  - `docs/` (design doc, README updates)
- **Compatibility Considerations**:
  - Additive API only; existing event bus behavior and event frames remain unchanged.
  - Broadcast frames remain JSON compatible and do not require changes to runtime event frame serialization.

## 5. Current State
`packages/core` already exposes `EventBus` and `RuntimeEventFrame` generation via `buildRuntimeEventFrame`, but there are no helpers to serialize frames into a broadcast-friendly payload, apply per-client filtering, batch frames, or hydrate them back into the event bus. Transports must implement these behaviors manually, risking inconsistent ordering or replay handling.

## 6. Proposed Solution
### 6.1 Architecture Overview
- **Narrative**: The server builds `RuntimeEventFrame` objects each tick, converts them into `EventBroadcastFrame` payloads with optional filtering and checksums, and feeds them through an `EventBroadcastBatcher` for network efficiency. Clients receive batches, optionally deduplicate replays, and apply frames to a local `EventBus` using `applyEventBroadcastFrame`.
- **Diagram**:
```text
Server EventBus -> buildRuntimeEventFrame -> createEventBroadcastFrame
                                   |                   |
                                   |               filter/checksum
                                   v                   v
                           EventBroadcastBatcher -> EventBroadcastBatch
                                                   |
                                                   v
                                              Transport
                                                   |
                                                   v
Client applyEventBroadcastBatch -> applyEventBroadcastFrame -> EventBus.dispatch
```

### 6.2 Detailed Design
- **Runtime Changes**:
  - Add a new module `packages/core/src/events/event-broadcast.ts` that defines broadcast frame types, filtering utilities, checksum helpers, batcher/deduper classes, and hydration helpers.
  - Export broadcast APIs from `packages/core/src/index.ts` and `packages/core/src/index.browser.ts`.

- **Data & Schemas**:
```ts
export interface EventBroadcastFrame {
  readonly serverStep: number;
  readonly events: readonly SerializedRuntimeEvent[];
  readonly checksum?: string;
  readonly manifestHash?: RuntimeEventManifestHash;
}

export interface EventBroadcastBatch {
  readonly frames: readonly EventBroadcastFrame[];
  readonly fromStep: number;
  readonly toStep: number;
  readonly eventCount: number;
}
```
  - `SerializedRuntimeEvent` mirrors the runtime event object record and includes `type`, `channel`, `issuedAt`, `dispatchOrder`, and `payload`.
  - `checksum` is an optional deterministic checksum over `serverStep`, `events`, and `manifestHash` when present.

- **APIs & Contracts**:
  - `createEventTypeFilter(allowedTypes)` produces a simple allowlist filter for event types.
  - `createEventBroadcastFrame(frame, options)` serializes a runtime frame, applies filters, sorts by `dispatchOrder` by default, and optionally includes checksum and manifest hash.
  - `applyEventBroadcastFrame(bus, frame, options)` validates manifest and checksum (unless disabled), filters and orders events, begins the tick with `resetOutbound` defaulting to true, publishes events with their `issuedAt`, and dispatches the tick.
  - `EventBroadcastBatcher` batches frames by `maxSteps`, `maxEvents`, and `maxDelayMs`, supports priority event types that flush immediately, and supports coalescing with `mode: 'first' | 'last'`.
  - `EventBroadcastDeduper` deduplicates replayed events using a ring buffer keyed by `{serverStep}:{dispatchOrder}:{type}` with a configurable capacity.

- **Tooling & Automation**:
  - Add `packages/core/benchmarks/event-broadcast-batching.bench.mjs` and include it in the `benchmark` script.
  - Add `packages/core/src/events/event-broadcast.test.ts` to cover filtering, hydration order, batching, coalescing, dedupe, and checksum behaviors.
  - Document usage in `packages/core/README.md`.

### 6.3 Operational Considerations
- **Deployment**: Core-only, additive change; no migrations or runtime wiring changes.
- **Telemetry & Observability**: No new runtime telemetry; the benchmark uses telemetry no-ops to avoid noise.
- **Security & Compliance**: Checksum uses fnv1a32 over deterministic JSON and is not cryptographic. Treat it as an integrity check, not an authentication or anti-tamper mechanism.

## 7. Work Breakdown & Delivery Plan
### 7.1 Issue Map
| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| feat(core): add event broadcast frame helpers | Define frame type, filter, checksum, and hydration helpers | Runtime Implementation Agent | Design approval | APIs exported; unit tests added |
| feat(core): add broadcast batching and dedupe | Implement batcher, coalescing, and deduper | Runtime Implementation Agent | Frame helpers | Batching and dedupe behaviors covered by tests |
| test(core): cover event broadcast scenarios | Add unit tests for filtering, checksum, ordering, batching | Testing Agent | Core helpers | `pnpm test --filter @idle-engine/core` passes |
| bench(core): add broadcast batching benchmark | Add benchmark and wire into benchmark script | Benchmark Agent | Core helpers | Benchmark outputs JSON payload and asserts expectations |
| docs(core): document broadcast usage | Update README and design doc | Docs Agent | Core helpers | Usage example documented |

### 7.2 Milestones
- **Phase 1**: Frame helpers, batcher/deduper, exports (delivered in PR #704).
- **Phase 2**: Tests and benchmark coverage (delivered in PR #704).
- **Phase 3**: Documentation updates (delivered in PR #704).

### 7.3 Coordination Notes
- **Hand-off Package**: `packages/core/src/events/event-bus.ts`, `packages/core/src/events/runtime-event-frame.ts`, Issue 547, and PR #704 diff.
- **Communication Cadence**: Review at PR time; follow-up questions tracked on Issue 547.

## 8. Agent Guidance & Guardrails
- **Context Packets**:
  - `packages/core/src/events/event-bus.ts`
  - `packages/core/src/events/runtime-event-frame.ts`
  - `packages/core/src/events/event-broadcast.ts`
  - `docs/runtime-event-pubsub-design.md`
- **Prompting & Constraints**:
  - Use type-only imports and exports for type symbols.
  - Preserve deterministic ordering by default; any skips must be explicit (`assumeSorted`, `filter`).
  - Do not edit generated `dist/` artifacts.
- **Safety Rails**:
  - Avoid non-deterministic inputs in checksum generation.
  - Do not add console output in tests that could corrupt the Vitest JSON summary.
  - Do not mutate the event bus dispatch semantics.
- **Validation Hooks**:
  - `pnpm test --filter @idle-engine/core`
  - `pnpm -r run typecheck`
  - `pnpm lint`

## 9. Alternatives Considered
1. **Reuse RuntimeEventFrame directly over the wire**: Rejected because typed-array frames are less JSON friendly, lack built-in filtering, and require a dedicated transport schema.
2. **Rely on state sync snapshots alone**: Rejected because UI and gameplay reactions depend on discrete events, not just state deltas.
3. **Stream full event history**: Rejected due to bandwidth and memory costs; batching provides bounded, configurable windows instead.

## 10. Testing & Validation Plan
- **Unit / Integration**:
  - Filtering, hydration ordering, checksum validation, dedupe reset, batching triggers, and coalescing scenarios in `packages/core/src/events/event-broadcast.test.ts`.
  - Round-trip JSON serialization test to confirm hydration from a serialized frame.
- **Performance**:
  - `packages/core/benchmarks/event-broadcast-batching.bench.mjs` compares unbatched vs batched scenarios and asserts reduced message overhead.
- **Tooling / A11y**:
  - Not applicable (runtime-only).

## 11. Risks & Mitigations
| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Batches never flush when `maxDelayMs` is set but no new frames arrive | Medium | Medium | Call `flush()` during idle periods or on transport heartbeat. |
| Deduper drops intentional replays with identical `{serverStep, dispatchOrder, type}` | Low | Low | Allow deduper reset and opt-in usage per client. |
| Checksum is misinterpreted as cryptographic integrity | Medium | Low | Document checksum as non-cryptographic and optional. |
| Client ordering differs if `assumeSorted` is misused | Low | Medium | Default to sorting by `dispatchOrder` and document `assumeSorted` behavior. |

## 12. Rollout Plan
- **Milestones**: Ship core helpers, tests, and benchmark; then integrate with transport adapters.
- **Migration Strategy**: Additive API; existing local-only event bus usage remains unchanged.
- **Communication**: Update core README and link this design doc from Issue 547.

## 13. Open Questions
- Should a timer-driven batching helper be added so `maxDelayMs` can flush without new frames?
- Should the dedupe key include `channel` or `payload` for additional safety, or is `{serverStep, dispatchOrder, type}` sufficient?

## 14. Follow-Up Work
- Provide a transport-facing helper to schedule `flush()` on idle intervals.
- Add tests for deduper capacity eviction and `assumeSorted` behavior.
- Add optional binary encoding for broadcast frames to reduce payload size.

## 15. References
- https://github.com/hansjm10/Idle-Game-Engine/issues/547
- https://github.com/hansjm10/Idle-Game-Engine/pull/704
- `packages/core/src/events/event-broadcast.ts`
- `packages/core/src/events/event-broadcast.test.ts`
- `packages/core/benchmarks/event-broadcast-batching.bench.mjs`
- `packages/core/src/events/event-bus.ts`
- `packages/core/src/events/runtime-event-frame.ts`
- `packages/core/src/index.ts`
- `packages/core/src/index.browser.ts`
- `packages/core/README.md`
- `docs/runtime-event-pubsub-design.md`

## Appendix A - Glossary
- **EventBroadcastFrame**: JSON-friendly payload carrying serialized runtime events for a single server step.
- **EventBroadcastBatch**: Aggregation of one or more broadcast frames with step range and event count metadata.
- **EventFilter**: Predicate used to allow or exclude events from broadcast or hydration.
- **EventBroadcastBatcher**: Helper that groups frames by steps, event counts, delay, and priority events.
- **EventBroadcastDeduper**: Ring-buffer dedupe helper for replayed frames.
- **Manifest Hash**: Digest of the runtime event manifest used to validate compatibility.
- **Checksum**: Deterministic fnv1a32 hash over broadcast payload data for integrity checks.
- **Coalescing**: Removal of duplicate events within a batch based on a computed key.

## Appendix B - Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2025-12-30 | Codex | Initial Issue 547 design draft based on PR #704 |
