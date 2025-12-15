# Diagnostic Timeline Design Document

## Document Control
- **Title**: Diagnostic Timeline Instrumentation
- **Authors**: Jordan Hans
- **Reviewers**: TODO – Runtime Core + Shell Web maintainers
- **Status**: Draft
- **Last Updated**: 2025-12-14
- **Related Issues**: Idle-Game-Engine#9; Idle-Game-Engine#196
- **Execution Mode**: AI-led

## 1. Summary
The Diagnostic Timeline is the runtime’s structured, structured-clone-safe trace of fixed-step tick execution. It records per-tick wall-clock duration and metadata (queue metrics, event back-pressure counters, per-system spans) so tooling can attribute jitter or over-budget ticks to specific runtime work while keeping the simulation deterministic and the diagnostics payload portable across Workers and Node hosts.[^structured-clone]

## 2. Context & Problem Statement
- **Background**: `packages/core` runs a deterministic fixed-step loop (default 100ms) that may process multiple steps per host frame (accumulator catch-up). When ticks slow down, developers need to understand whether the source is command backlog, event pressure, or a single expensive system.
- **Problem**: Coarse per-tick counters do not explain *why* a tick exceeded its budget or *which* system introduced jitter. Without a bounded, queryable timeline, downstream tooling (shell devtools overlays, automated profiling agents, CI verification) cannot surface actionable diagnostics.
- **Forces**:
  - Diagnostics must not affect simulation determinism; they cannot feed back into game state decisions.
  - Data must be safe to send across structured-clone boundaries (Worker ↔ main thread) without leaking mutable references.
  - Instrumentation must be bounded in memory and low-overhead enough to keep within tick budgets.
  - Production builds must remain opt-in to avoid payload/telemetry noise.

## 3. Goals & Non-Goals
- **Goals**:
  - Capture high-resolution timing per runtime tick, including per-system execution spans.
  - Attribute time spent to individual systems while preserving deterministic execution.
  - Record queue depth / throughput and event-bus counters alongside timing data to contextualize slow ticks.
  - Provide a ring-buffer snapshot + delta API that is structured-clone safe.[^structured-clone]
  - Emit guard-rail warnings (slow ticks, slow systems) through the telemetry facade so Prometheus adapters and logs can alert without devtools attached.
- **Non-Goals**:
  - Shipping a full visualization layer inside `packages/shell-web` (UI overlays remain separate follow-up work).
  - Persisting diagnostics beyond the in-memory ring buffer or exporting them to external observability stacks by default.
  - Replacing existing event bus diagnostics; the timeline consumes snapshots but does not redefine the event-bus data model.
  - Enforcing adaptive scheduling or auto-throttling; scope ends at recording and surfacing metadata.

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**: Runtime Core maintainers; Shell Web maintainers; Tooling/Observability maintainers; partner integrators.
- **Agent Roles**:
  - *Docs Agent*: Maintains this design, cross-links, and changelog.
  - *Runtime Diagnostics Agent*: Extends runtime instrumentation and keeps diagnostics schemas stable.
  - *Shell Devtools Agent*: Builds UI surfaces that consume diagnostics updates from the worker bridge.
  - *Observability Agent*: Wires telemetry warnings into Prometheus/exporters and validates signal quality.
- **Affected Packages/Services**: `packages/core` (runtime, diagnostics, telemetry), `packages/shell-web` (worker bridge, state provider), `tools/` (benchmarks/sim harnesses), `docs/`.
- **Compatibility Considerations**:
  - Diagnostics payloads must remain plain JSON-friendly objects and structured-clone safe (no functions, class instances, cyclic graphs).
  - Worker message schemas (`DIAGNOSTICS_UPDATE`) must remain backward compatible; large payloads should remain opt-in.

## 5. Current State
- `packages/core/src/diagnostics/diagnostic-timeline.ts` implements a fixed-capacity ring buffer with a monotonic `head` cursor and `dropped` counter so clients can request deltas and detect buffer rollover.[^otel-delta]
- `packages/core/src/diagnostics/runtime-diagnostics-controller.ts` wraps the recorder with runtime helpers for per-system spans, tick metadata, and telemetry warnings (`TickExecutionSlow`, `SystemExecutionSlow`).
- `packages/core/src/index.ts` records per-tick system spans, command-queue size/capture/execution counts, event bus back-pressure metrics, and accumulator backlog when diagnostics are enabled.
- `packages/shell-web` supports `DIAGNOSTICS_SUBSCRIBE`/`DIAGNOSTICS_UPDATE` and exposes a subscription API via `ShellDiagnosticsContext` so UI tooling can opt-in to streaming deltas.
- Known gaps:
  - Named tick phases are supported (`RuntimeTickDiagnostics.addPhase`) but the core tick loop does not currently record command/event/publish phases.
  - `ResourcePublishTransport` can carry an immutable diagnostics payload, but publish work itself is not timed as a phase today.
  - The recorder default capacity is currently short (120 entries) and may need tuning for longer inspection windows.[^performanceobserver-buffer]

## 6. Proposed Solution

### 6.1 Architecture Overview
Record diagnostics alongside the deterministic tick loop, store them in a fixed-capacity ring buffer, and expose a delta API keyed by a monotonic `head`. The worker bridge enables diagnostics only when tooling subscribes, then streams deltas through a dedicated envelope so normal state updates stay lean.

```
IdleEngineRuntime.tick()
  -> diagnostics.beginTick(step)
  -> execute commands / dispatch events / run systems
  -> diagnostics.complete() (writes ring-buffer entry)

WorkerBridge (shell-web)
  -> DIAGNOSTICS_SUBSCRIBE enables runtime diagnostics
  -> runtime.readDiagnosticsDelta(lastHead) after ticks
  -> DIAGNOSTICS_UPDATE streams deltas to UI
```

### 6.2 Detailed Design
- **Data Model & Storage**
  - Each `DiagnosticTimelineEntry` records `{ tick, startedAt, endedAt, durationMs, budgetMs?, isSlow, overBudgetMs, error?, metadata? }`.
  - `metadata` attaches optional, structured-clone-safe payloads: accumulator backlog, queue metrics, event metrics, system spans, and (future) named phases.
  - The recorder stores entries in a fixed-capacity circular buffer. Consumers read snapshots via `readDelta(sinceHead?)`, receiving `{ entries, head, dropped, configuration }` so they can detect overwrites.[^otel-delta]
  - Errors are serialized into a plain `ErrorLike` object to keep worker transfers deterministic across environments.[^mdn-structured-clone]
- **Clock Abstraction**
  - Use `HighResolutionClock` (`now(): number`) backed by `performance.now()` when available, Node `hrtime.bigint()` when available, and `Date.now()` as a last resort.
  - Allow dependency injection for deterministic tests and benchmark harnesses.
- **Runtime Integration**
  - Diagnostics are opt-in via `IdleEngineRuntimeOptions.diagnostics.timeline` or `runtime.enableDiagnostics()`.
  - Each tick uses `diagnostics.beginTick(step)` and records:
    - Per-system spans via `tickDiagnostics.startSystem(system.id)`.
    - Queue metrics (size before/after and executed/captured/skipped counts) from the command queue.
    - Event-bus metrics from `eventBus.getBackPressureSnapshot()`.
    - Accumulator backlog (`this.accumulator`) so tooling can correlate catch-up pressure with slow ticks.[^fixed-step-lag][^gaffer-accumulator]
  - The controller emits telemetry warnings:
    - `TickExecutionSlow` when a tick exceeds its configured budget.
    - `SystemExecutionSlow` when a system exceeds its configured budget (with rolling history for context).[^datadog-multi-alert]
- **Worker & Transport Integration**
  - Worker enables diagnostics on-demand via `DIAGNOSTICS_SUBSCRIBE`, resets its cursor, and emits an initial baseline `DIAGNOSTICS_UPDATE` so tooling learns configuration immediately.
  - After each tick, the worker calls `runtime.readDiagnosticsDelta(lastHead)` and forwards updates only when new entries arrive or drops occurred.
  - Resource publishing can optionally attach a diagnostics payload (`diagnostics?: DiagnosticTimelineResult`) to transports without affecting consumers when disabled.
- **Extensibility (Planned)**
  - Record named phases (`commands`, `eventDispatch`, `publish`, etc.) via `RuntimeTickDiagnostics.addPhase(...)` so the timeline can attribute time to sub-phases even when system spans are flat.

### 6.3 Operational Considerations
- **Telemetry & Observability**: `packages/core/src/telemetry-prometheus.ts` translates slow-tick and slow-system warnings into `runtime_ticks_over_budget_total` and `runtime_system_slow_total`.
- **Performance**: Keep diagnostics disabled by default in production paths; validate overhead with `packages/core/benchmarks/diagnostic-timeline-overhead.bench.mjs`.
- **Security & Privacy**: Diagnostics must not include PII; errors should be serialized and sanitized as needed before crossing process boundaries.

## 7. Work Breakdown & Delivery Plan

### 7.1 Issue Map
| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| docs: migrate Diagnostic Timeline design to template | Align `docs/diagnostic-timeline-design.md` with the standard template and add agent guidance | Docs Agent | Template stable | Document merged; changelog updated; issue map actionable |
| feat(core): record tick phases in diagnostics | Emit named phases for commands + event dispatch + publish | Runtime Diagnostics Agent | Doc approval | Phases visible in `DiagnosticTimelineEntry.metadata.phases`; unit tests cover stability |
| feat(core): capture publish-phase diagnostics | Time resource publish/build work and attach phase durations | Runtime Diagnostics Agent | Phase recording | Publish work appears as a phase when enabled; transport remains backward compatible |
| feat(shell-web): diagnostics timeline UI panel | Consume `DIAGNOSTICS_UPDATE` and render recent ticks/systems | Shell Devtools Agent | Diagnostics stream stable | UI can toggle diagnostics; renders deltas without impacting baseline state updates |
| docs: document enabling diagnostics | Add usage notes to `docs/runtime-step-lifecycle.md` and/or shell guides | Docs Agent | Feature stability | Docs show how to subscribe/toggle; links are repo-relative and current |

### 7.2 Milestones
- **Phase 1**: Land doc migration + phase recording (target: 1–2 weeks).
- **Phase 2**: Publish-phase capture + shell UI surfaces (target: next iteration after Phase 1).

### 7.3 Coordination Notes
- **Hand-off Package**: `docs/diagnostic-timeline-design.md`, `packages/core/src/diagnostics/`, `packages/core/src/index.ts`, `packages/shell-web/src/runtime.worker.ts`, `packages/shell-web/src/modules/worker-bridge.ts`.
- **Communication Cadence**: Post status updates in the GitHub issue thread for each mapped issue at least twice weekly; escalate schema changes before implementation.

## 8. Agent Guidance & Guardrails
- **Context Packets**: `docs/diagnostic-timeline-design.md`, `docs/design-document-template.md`, `docs/idle-engine-design.md`, `packages/core/src/diagnostics/diagnostic-timeline.ts`, `packages/core/src/diagnostics/runtime-diagnostics-controller.ts`, `packages/shell-web/src/runtime.worker.ts`.
- **Prompting & Constraints**:
  - Keep the simulation deterministic: diagnostics may observe clocks but must not influence simulation state decisions.
  - Keep diagnostics payloads structured-clone safe (plain objects/arrays; no functions/classes; avoid cyclic graphs).
  - Follow workspace TypeScript conventions (`import type`, consistent exports) and Conventional Commits.
- **Safety Rails**:
  - Do not enable diagnostics by default in production code paths without explicit stakeholder sign-off.
  - Do not introduce unbounded allocations; respect ring-buffer capacity and avoid per-tick logging.
  - Do not modify checked-in `dist/` outputs by hand.
  - Avoid history rewrites (`git reset --hard`, force pushes) while collaborating.
- **Validation Hooks**:
  - `pnpm lint`
  - `pnpm test --filter @idle-engine/core`
  - `pnpm test --filter @idle-engine/shell-web` (if worker bridge/UI changes)
  - `pnpm --filter @idle-engine/core run benchmark:diagnostics` (when changing capture overhead)

## 9. Alternatives Considered
- **Counters-only telemetry**: Too coarse to attribute regressions to specific systems/phases.
- **Browser-only tracing (PerformanceObserver/Long Tasks API)**: Helpful for UI thread stalls but not portable to Node hosts and does not map cleanly to deterministic tick steps.[^longtasks]
- **Full OpenTelemetry tracing integration**: Powerful but adds complexity and exporter concerns; the current design keeps the runtime dependent on a small, stable telemetry facade.[^otel-api-sdk]

## 10. Testing & Validation Plan
- **Unit / Integration**:
  - Ring-buffer behavior, delta semantics, and error serialization (`packages/core/src/diagnostics/diagnostic-timeline.test.ts`).
  - Runtime integration and structured-clone safety (`packages/core/src/command-recorder.test.ts`, worker bridge tests in `packages/shell-web`).
- **Performance**: Track benchmark deltas for diagnostics overhead; investigate when overhead exceeds budget targets.
- **Tooling / A11y**: If new shell UI flows are added for diagnostics, run `pnpm test:a11y`.

## 11. Risks & Mitigations
- **Clock precision variance across environments**: Provide explicit clock injection and deterministic tests; fall back to `Date.now()` only when necessary.
- **Diagnostics flood in production builds**: Keep opt-in defaults and stream deltas only while a subscriber is active.[^postmessage-copy][^transferable-zero-copy]
- **Telemetry noise from transient spikes**: Prefer budgets and rolling history; expose thresholds in configuration so integrators can tune sensitivity.[^datadog-multi-alert]

## 12. Rollout Plan
- **Milestones**: Keep diagnostics disabled by default; enable only via explicit worker/UI subscription; roll out phase recording behind the same opt-in.
- **Migration Strategy**: Maintain backwards compatibility for `DiagnosticTimelineResult` schema; add optional fields (like phases) without breaking consumers.
- **Communication**: Link follow-up issues from `Idle-Game-Engine#9` and update developer docs once phase instrumentation lands.

## 13. Open Questions
- Should the default ring-buffer capacity be increased (e.g., from 120 to 512) to provide longer history without drops?[^performanceobserver-buffer]
- Should shell-web enable diagnostics automatically in development mode (e.g., behind a debug flag), or remain strictly user-triggered?
- Should the timeline include per-command-type spans (high cardinality risk) or remain system/phase focused?

## 14. Follow-Up Work
- Add a devtools overlay/panel in `packages/shell-web` that visualizes system spans and slow-tick warnings.
- Explore exporting diagnostics to Perfetto/trace-event formats for offline analysis.[^perfetto-track-events]
- Add docs coverage in `docs/runtime-step-lifecycle.md` once the phase model is finalized.

## 15. References
- `docs/design-document-template.md`
- `docs/runtime-step-lifecycle.md`
- `packages/core/src/diagnostics/diagnostic-timeline.ts`
- `packages/core/src/diagnostics/runtime-diagnostics-controller.ts`
- `packages/core/src/index.ts`
- `packages/core/src/telemetry-prometheus.ts`
- `packages/shell-web/src/runtime.worker.ts`
- `packages/shell-web/src/modules/worker-bridge.ts`
- [^fixed-step]: Glenn Fiedler, “Fix Your Timestep!”, *Gaffer On Games*. Highlights maintaining a constant simulation `dt` per step for deterministic behavior. https://gafferongames.com/post/fix_your_timestep/
- [^object-pool]: Robert Nystrom, *Game Programming Patterns: Object Pool*, on reusing preallocated objects to avoid allocation spikes in high-churn systems. https://gameprogrammingpatterns.com/object-pool.html
- [^object-freeze]: MDN Web Docs, “Object.freeze()”, noting that frozen objects cannot be modified or extended. https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/freeze
- [^otel-api-sdk]: *OpenTelemetry Client Design Principles*, OpenTelemetry Specification. Highlights keeping the API (instrumentation) separate from the SDK/exporters so libraries depend only on stable hooks. https://raw.githubusercontent.com/open-telemetry/opentelemetry-specification/main/specification/library-guidelines.md
- [^perfetto-track-events]: “Tracing SDK - Perfetto Tracing Docs”, describing time-bounded track events via `TRACE_EVENT` spans to attribute work in profiling traces. https://perfetto.dev/docs/instrumentation/tracing-sdk
- [^postmessage-copy]: “Data is sent between workers and the main thread via a system of messages… The data is copied rather than shared.” — *Using Web Workers*, MDN Web Docs. https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers
- [^transferable-zero-copy]: “Transferable objects are transferred… with a zero-copy operation, which results in a vast performance improvement when sending large data sets.” — *Using Web Workers*, MDN Web Docs. https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers
- [^longtasks]: Long Tasks API introduction describing 50ms+ main-thread stalls and their impact on responsiveness. https://w3c.github.io/longtasks/
- [^perf-memory]: “performance.memory… Deprecated… Non-standard… API is only available in Chromium-based browsers.” — *Performance: memory property*, MDN Web Docs. https://developer.mozilla.org/en-US/docs/Web/API/Performance/memory
- [^measure-uasm]: *Monitor your web page's total memory usage with measureUserAgentSpecificMemory()* — highlights cross-origin isolation requirements and sampling guidance. https://web.dev/articles/monitor-total-page-memory-usage
- [^performanceobserver-buffer]: PerformanceObserver constructor docs noting dropped entries when the internal buffer fills and recommending explicit buffer sizing. https://developer.mozilla.org/en-US/docs/Web/API/PerformanceObserver/PerformanceObserver
- [^structured-clone]: “Structured clone creates a copy of most types of objects, and the original object is not transferred.” — *Structured clone algorithm*, MDN Web Docs. https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm
- [^perfetto-interning]: “Interning can be used to avoid repeating the same constant data (e.g., event names) throughout the trace.” — *Track events (Tracing SDK)*, Perfetto Docs. https://raw.githubusercontent.com/google/perfetto/master/docs/instrumentation/track-events.md
- [^otel-performance]: “Library should not consume unbounded memory resource… API should not degrade the end-user application as possible.” — *Performance and Blocking of OpenTelemetry API*, OpenTelemetry Specification. https://raw.githubusercontent.com/open-telemetry/opentelemetry-specification/main/specification/performance.md
- [^mdn-structured-clone]: “Browsers must serialize the properties `name` and `message`, and are expected to serialize other ‘interesting’ properties of the errors such as `stack`...” — *Structured clone algorithm*, MDN content repository. https://raw.githubusercontent.com/mdn/content/main/files/en-us/web/api/web_workers_api/structured_clone_algorithm/index.md
- [^otel-delta]: “Metrics that are input and output with Delta temporality unburden the client from keeping high-cardinality state… The use of deltas allows downstream services to bear the cost of conversion into cumulative timeseries.” — *Metrics Data Model*, OpenTelemetry Specification. https://raw.githubusercontent.com/open-telemetry/opentelemetry-specification/main/specification/metrics/data-model.md
- [^fixed-step-lag]: Glenn Fiedler, “Fix Your Timestep!”, *Gaffer On Games*. Discusses accumulating frame deltas, executing multiple fixed steps during catch-up, and retaining the remainder in an accumulator to reflect real-time lag. https://gafferongames.com/post/fix_your_timestep/
- [^gaffer-accumulator]: Glenn Fiedler, “Fix Your Timestep!”, *Gaffer On Games*. Notes that the accumulator remainder directly expresses how far the simulation is between fixed steps, making it a reliable backlog signal. https://gafferongames.com/post/fix_your_timestep/
- [^azure-service-bus-metrics]: “Monitoring data reference for Azure Service Bus,” Microsoft Learn. Documents per-queue metrics such as incoming, completed, abandoned, and dead-lettered messages used to track throughput and loss. https://learn.microsoft.com/en-us/azure/service-bus-messaging/service-bus-metrics-azure-monitor
- [^datadog-multi-alert]: “Multi Alert mode,” *Datadog Monitors Configuration*. Highlights emitting one notification per group (dimension) so thresholds evaluate per entity instead of across aggregated series. https://docs.datadoghq.com/monitors/configuration/?tab=multi-alert

## Appendix A — Glossary
- **Accumulator**: The runtime’s remaining host-time backlog used to decide how many fixed steps to execute on each `tick()` call.
- **Delta (Diagnostics)**: A timeline slice returned by `readDiagnosticsDelta(lastHead)` that includes only entries after a cursor.
- **Head**: A monotonic counter used as the cursor for diagnostic deltas; enables consumers to detect dropped/overwritten entries.[^otel-delta]
- **Ring Buffer**: Fixed-capacity storage that overwrites oldest entries when full.
- **Structured Clone**: The browser/Worker algorithm used by `postMessage()` to copy objects between threads/contexts.[^structured-clone]
- **Tick**: One deterministic fixed-step simulation iteration.

## Appendix B — Change Log
| Date       | Author      | Change Summary |
|------------|-------------|----------------|
| 2025-12-14 | Jordan Hans | Migrated document to standard template; added issue map and agent guidance; refreshed references for current diagnostics implementation (Fixes #196) |
