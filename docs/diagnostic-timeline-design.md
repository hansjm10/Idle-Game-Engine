# Diagnostic Timeline Instrumentation

Issue: #9 — Runtime Core Workstream

## 1. Problem Statement
- The runtime core lacks a structured view of per-tick execution time, queue pressure, and system-level latency, making it hard to diagnose scheduling regressions described in `docs/idle-engine-design.md` §9.1.
- Current telemetry only records coarse counters (`telemetry.recordTick`, event back-pressure snapshots) and cannot explain why a tick exceeded its budget or which system introduced jitter.
- Without a deterministic diagnostic timeline, downstream tooling (shell devtools overlay, automated profiling agents) cannot surface actionable insights when the engine stutters or falls behind real time.

## 2. Goals
- Capture high-resolution timing for each runtime tick, including queue drain, event dispatch, and system execution segments.
- Attribute time spent to individual systems so integrators can identify hotspots while preserving deterministic execution.
- Record queue depth, command throughput, and event bus counters alongside timing data to contextualize slow ticks.
- Provide a structured-clone-safe ring buffer snapshot API usable from Workers (shell-web) and Node hosts without leaking mutable references.[^structured-clone]
- Emit guard-rail warnings (over-budget ticks, repeated slow systems) through the existing telemetry facade so production builds can trigger alerts without devtools attached.

## 3. Non-Goals
- Shipping a visualization layer inside `packages/shell-web`; that devtools overlay remains a follow-up.
- Persisting historical diagnostics beyond the in-memory ring buffer or streaming them to external observability stacks (Prometheus ingestion stays optional via telemetry).
- Replacing the existing event bus diagnostics; the timeline consumes those snapshots but does not redefine their structure.
- Enforcing adaptive scheduling or auto-throttling based on timeline results; the scope ends at recording and surfacing metadata.

## 4. Current State
- `IdleEngineRuntime.tick` (see `packages/core/src/index.ts`) executes the fixed-step loop but only calls `telemetry.recordTick()` and event back-pressure counters after each iteration. There is no instrumentation around command draining, per-system execution, or total wall time.
- `CommandQueue` records overflow warnings but does not expose queue depth trends or per-tick throughput.
- `EventBus` exposes `getBackPressureSnapshot()` and frame export diagnostics, yet the runtime only samples these at the end of the tick, leaving large gaps between dispatch phases.
- The design doc (`docs/implementation-plan.md`) tracks “Add DiagnosticTimeline to capture tick durations and system timings” as a TODO, and no API surfaces a timeline to consumers today.

## 5. Proposed Solution

### 5.1 Data Model & Storage
- Introduce `DiagnosticTimeline` inside `packages/core/src/diagnostics/`, backed by a fixed-capacity circular buffer (default 512 ticks, configurable).
- Each `DiagnosticTimelineEntry` records:
  - `tick`: runtime step number.
  - `stepBudgetMs`: fixed-step budget applied to that simulation iteration (mirrors the resolved `stepSizeMs` so diagnostics stay deterministic across replays).[^fixed-step]
  - `hostFrameMs`: raw wall-clock time supplied to the outer `tick` invocation, kept separate from the deterministic step budget so tooling can spot long render frames that trigger catch-up processing.
  - `lagBeforeMs` / `lagAfterMs`: accumulator backlog immediately before and after the step, exposing how far the runtime is behind real time when multiple fixed steps are executed in one host frame.[^fixed-step-lag]
  - `startedAtMs` / `durationMs`: high-resolution start timestamp and total wall-clock duration (converted to milliseconds with microsecond precision).
  - `queue`: `{ pendingBefore, drained, accepted, dropped, rejected }` captured via extended `CommandQueue` instrumentation so the timeline mirrors the accepted/outstanding counters that queueing platforms expose for monitoring (incoming, completed, abandoned, dead-lettered). Each tick begins by reading the queue size into `pendingBefore`; enqueue/dequeue paths increment `accepted`, `rejected`, `dropped`, and `drained`; and `commandQueue.flushDiagnostics()` returns the delta snapshot while resetting counters so every entry reports per-tick throughput rather than monotonic totals.[^azure-service-bus-metrics][^otel-delta]
  - `phases`: ordered segments (`commands`, `eventDispatchBeforeSystems`, `system:<id>`, `eventDispatchAfterSystems`, `publish`) with `durationMs` and `offsetMs` from tick start.
  - `systems`: normalized table capturing `{ id, durationMs, slow: boolean, error?: ErrorLike }`.
  - `events`: structured counters captured once before systems run and once at tick end (`before`, `final`), plus optional per-system delta records when event pressure crosses configured thresholds. Calm ticks avoid copying the full `BackPressureSnapshot` payload multiple times, while spikes still surface enough detail for diagnosis.[^perfetto-interning][^otel-performance]
  - `warnings`: bit flags (e.g., `EXCEEDED_STEP_BUDGET`, `SYSTEM_SLOW`, `QUEUE_STARVATION`) derived from thresholds in options.
- The buffer reuses a pooled set of mutable entry structs to avoid per-tick allocations, then clones and freezes plain-object copies on export. This follows the object-pool pattern for high-churn data while still handing immutable snapshots to consumers.[^object-pool][^object-freeze][^structured-clone]
- Define `ErrorLike` as a plain object `{ readonly name: string; readonly message: string; readonly stack?: string; readonly cause?: string }` so structured clones remain deterministic across Workers while preserving telemetry details browsers guarantee when serializing errors.[^mdn-structured-clone]
- Split the instrumentation hooks from exported data by introducing a mutable `DiagnosticTimelineRecorder` (exposing `beginTick`, `capturePhase`, `captureSystem`, `endTick`) that never crosses structured-clone boundaries, plus an immutable `DiagnosticTimelineResult` returned by `readDiagnosticsDelta`. This mirrors telemetry guidelines where instrumentation libraries depend only on an API while exporters and tooling consume serialized snapshots.[^otel-api-sdk]

### 5.2 Clock Abstraction
- Define `HighResolutionClock` with `now(): number` returning a monotonically increasing timestamp in milliseconds with microsecond precision.
- Default implementation wraps `performance.now()` in browsers/Workers and `performance.now()` (via `import { performance } from 'node:perf_hooks'`) in Node; fallback to `Date.now()` when unavailable.
- Allow dependency injection through `IdleEngineRuntimeOptions.diagnostics?.clock` for deterministic testing (Vitest can supply a fake clock).

### 5.3 Runtime Integration
- Extend `IdleEngineRuntimeOptions` with an optional `diagnostics` block:
  ```ts
  interface DiagnosticTimelineOptions {
    readonly enabled?: boolean; // default true in development, false otherwise
    readonly capacity?: number; // default 512
    readonly slowTickBudgetMs?: number; // defaults to current stepSizeMs (100)
    readonly slowSystemThresholdMs?: number; // defaults to 25% of step budget
    readonly clock?: HighResolutionClock;
  }
  ```
- Maintain a lightweight controller inside `IdleEngineRuntime` that forwards to either a real `DiagnosticTimelineRecorder` or a noop implementation; diagnostics-disabled builds defer recorder allocation until explicitly enabled while keeping the hot path branchless.
- Instrument `tick` as follows:
  1. Snapshot `const accumulatorBefore = this.accumulator + deltaMs` before we clamp `steps`, then keep a local `remainingAccumulator` that we decrement inside the per-step loop. Each `beginTick(tick, { hostFrameMs: deltaMs, lagBeforeMs, stepBudgetMs: this.stepSizeMs, queueSize })` call uses that running remainder (`lagBeforeMs = Math.max(0, remainingAccumulator - this.stepSizeMs)`) so the entry reflects the backlog still outstanding before the slice runs. After the step finishes subtract `this.stepSizeMs` from `remainingAccumulator`, compute `lagAfterMs = Math.max(0, remainingAccumulator)`, and pass it to `endTick(...)` so every entry records both the pre- and post-step accumulator in line with fixed-step accumulator guidance.[^fixed-step-lag][^gaffer-accumulator]
  2. On the first iteration call `const queueDiagnostics = commandQueue.beginDiagnosticsTick()` (cheap view over the shared counters) so the recorder starts with `pendingBefore = queueDiagnostics.pendingBefore`. As `enqueue` and `dequeue` operations occur they update the per-tick counters, and `commandQueue.flushDiagnostics()` returns the delta structure used when sealing the entry.
  3. Wrap both command dequeuing and execution inside `timeline.capturePhase('commands', () => { ... })`, using the enhanced dequeue helper to capture `{ pendingBefore, drained, accepted, dropped, rejected }` in lockstep with the queue metrics we surface elsewhere. Nested slices per command type remain optional but provide richer traces when enabled.[^perfetto-track-events][^azure-service-bus-metrics]
  4. Bracket every call to `eventBus.dispatch(...)` with `timeline.capturePhase` blocks so dispatch costs appear in the phase array (`eventDispatchBeforeSystems` before any systems run, `eventDispatchAfterSystems` between systems). A lightweight helper lets `resource-publish-transport` (or any alternative exporter) call `timeline.capturePhase('publish', ...)` around its own work so the timeline records publish costs without assuming the core runtime owns the transport call.[^perfetto-track-events]
  5. Before running systems, capture `events.before = eventBus.getBackPressureSnapshot()`. During the system loop, only request a delta snapshot when utilization crosses configured thresholds; the recorder diffs that snapshot against the cached one so routine ticks avoid extra allocations while still logging the channels that spiked. After dispatch completes, capture a single `events.final` snapshot for context.
  6. For each registered system, call `timeline.captureSystem(system.id, () => system.tick(context))`. The helper measures duration, marks slow flags, annotates thrown errors on the entry using the serialized `ErrorLike`, and rethrows so existing runtime telemetry (`SystemExecutionFailed`) continues to fire.
  7. After system iteration, finalize any active phase spans, collect `const queue = commandQueue.flushDiagnostics()`, compute the merged warning set, and call `endTick({ backPressure, queue, warnings, lagAfterMs })` to seal the entry and write it into the ring buffer.
- Telemetry integration:
  - Emit `telemetry.recordWarning('TickOverBudget', { tick, durationMs, budgetMs })` when `durationMs > slowTickBudgetMs`.
  - Emit `telemetry.recordWarning('SystemSlow', { systemId, durationMs, thresholdMs, tick })` when a system’s own execution history shows repeated slow samples—track a per-system ring buffer of the last `windowSize` executions so infrequent systems still surface regressions without being hidden by globally sparse tick windows.[^datadog-multi-alert]

### 5.4 Snapshot & API Surface
- Add `IdleEngineRuntime.readDiagnosticsDelta(sinceHead?: number): DiagnosticTimelineResult` exposing:
  ```ts
  interface DiagnosticTimelineResult {
    readonly entries: readonly DiagnosticTimelineEntry[];
    readonly head: number; // incrementing sequence for delta consumers
    readonly configuration: Readonly<ResolvedDiagnosticTimelineOptions>;
    readonly dropped: number;
  }
  ```
- When `sinceHead` is omitted the recorder exports the full buffer contents; otherwise it returns only the new entries since that head. The export path deep-clones the pooled structs, freezes the resulting plain objects, and hands back structured-clone-safe data without leaking mutable references.
- The recorder stores `head` as a monotonic counter so clients can request only new entries and determine when the ring buffer overwrote older samples without juggling separate snapshot and delta APIs.[^otel-delta]
- Extend `CommandRecorder` replay context to optionally attach timeline entries when present, enabling deterministic replay comparisons.

### 5.5 Worker & Transport Integration
- Update `packages/core/src/resource-publish-transport.ts` to accept two optional diagnostics fields: `diagnosticsRecorder?: DiagnosticTimelineRecorder` for wrapping `capturePhase('publish', ...)` around build/release work, and `diagnosticsPayload?: DiagnosticTimelineResult` so call-sites can attach immutable timeline slices to the transport without smuggling recorder methods through structured-clone boundaries. The runtime hands the recorder directly to the transport, while the worker receives only the serialized payload.
- The worker bridge (`packages/shell-web/src/runtime.worker.ts`) can request diagnostics by:
  1. Storing the last seen `head`.
  2. Calling `runtime.readDiagnosticsDelta(lastHead)` after each resource publish or on a polling cadence.
  3. Forwarding only new entries to the UI devtools overlay.
- Timeline entries remain optional; publishing code should skip them when diagnostics are disabled to avoid extra bytes on production channels.
- Devtools must explicitly opt in before the worker starts emitting timeline buffers. The UI posts a `DIAGNOSTICS_SUBSCRIBE` envelope via `WorkerBridge.enableDiagnostics()`, the worker enables the runtime timeline, resets its delta cursor, and immediately returns a baseline `DIAGNOSTICS_UPDATE` so tooling learns the configuration before streaming increments. Because `postMessage()` copies data by default,[^postmessage-copy] follow-up deltas are sent over the dedicated `DIAGNOSTICS_UPDATE` envelope only while the overlay is listening. Regular state updates stay slim, while the diagnostics envelope can transfer typed buffers once the overlay requests high-volume samples.[^transferable-zero-copy]
- `WorkerBridge.onDiagnosticsUpdate` forwards those `DIAGNOSTICS_UPDATE` payloads to devtools so the overlay can render timeline entries alongside existing state updates.

### 5.6 Configuration & Extensibility
- Expose `IdleEngineRuntime.enableDiagnostics(options)` to toggle recording at runtime (useful for automated test harnesses). The controller resolves defaults during construction, keeps a noop recorder active when disabled, and allocates the real recorder on demand without disrupting in-flight ticks.
- Allow future hooks to append additional phases (e.g., persistence flush, social sync) by offering `diagnostics.addPhase(name, durationMs)` APIs outside of `IdleEngineRuntime`.
- Store thresholds in the resolved configuration so downstream systems (e.g., shell overlay) know which budget triggered warnings.

## 6. Observability & Tooling
- Prometheus adapter (`telemetry-prometheus.ts`) increments new counters (`runtime_ticks_over_budget_total`, `runtime_system_slow_total`) when warnings fire, gated by explicit label registration.
- Provide a small helper in `packages/core/src/devtools/diagnostics.ts` that formats the latest `DiagnosticTimelineEntry` for human-readable console output, mirroring the existing console telemetry scheme.
- Document the timeline API in `docs/runtime-step-lifecycle.md` follow-up so implementation notes stay in sync with the design.

## 7. Performance Considerations
- Timeline recording adds ~5 object allocations per tick (entry + phase arrays). The ring buffer reuses arrays via preallocation to avoid garbage churn.
- High-resolution timestamps rely on monotonic clocks; fallbacks degrade precision but remain deterministic because start/end are still measured within the same clock.
- Instrumentation branches are minimized by caching the recorder (either real or noop) and inline guards for disabled configuration.
- Export snapshots clone arrays at most once per request; by freezing entries on write, consumers can reuse references safely.
- A dedicated micro-benchmark (`packages/core/benchmarks/diagnostic-timeline-overhead.bench.mjs`) exercises multiple systems and high queue churn. On Node.js v22.20.0 running under WSL2, `pnpm --filter @idle-engine/core run benchmark:diagnostics` reported a mean +10.8 ms cost per 320 ticks (about 10.1% overhead) with a median delta of +9.0 ms.

## 8. Rollout Steps
1. Scaffold `packages/core/src/diagnostics/diagnostic-timeline.ts` with recorder, data model, and tests covering ring-buffer rollover, slow-tick detection, and noop mode.
2. Wire the recorder into `IdleEngineRuntime` constructor and tick loop; add integration tests (`packages/core/src/index.test.ts`) capturing synthetic ticks with fake clocks.
3. Extend `telemetry-prometheus.ts` to record new counters and verify via tests.
4. Update `resource-publish-transport.ts` (and worker bridge) to optionally include timeline deltas; cover with unit tests ensuring serialization safety.
5. Add developer documentation (`README.md` or `docs/runtime-step-lifecycle.md`) describing how to enable diagnostics in local builds.
6. Validate instrumentation overhead with a micro-benchmark and document observed cost in the PR summary.

## 9. Risks & Mitigations
- **Clock precision variance across environments**: Provide explicit clock injection and unit tests using deterministic timers; fall back to `Date.now()` only when necessary.
- **Timeline flood in production builds**: Keep diagnostics opt-in (`enabled: false` by default outside development) and ensure publish paths check configuration before attaching data.
- **Telemetry noise from transient spikes**: Use dampening thresholds (e.g., require two slow samples within the last three ticks) before emitting warnings; expose configuration knobs so integrators can tune sensitivity.

## 10. Resolved Questions
- **Shell diagnostics transport**: Provide a subscription handshake from the devtools overlay and stream timeline deltas only through a dedicated diagnostics message once listeners are active. Default state updates remain lean, minimizing structured-clone churn, and the diagnostics envelope can switch to transferable typed arrays for larger batches where supported.[^postmessage-copy][^transferable-zero-copy]
- **GC visibility**: Detect long GC pauses indirectly by observing `longtask` entries via `PerformanceObserver`, which surfaces 50ms+ main-thread stalls regardless of source.[^longtasks] First-phase scope stops there; direct heap snapshots use `performance.measureUserAgentSpecificMemory()` only when shell builds opt into cross-origin isolation, because the legacy `performance.memory` API is deprecated, Chromium-only, and unreliable for multi-context captures.[^perf-memory][^measure-uasm]
- **Timeline buffer depth**: Set the default ring buffer to 512 entries (~51 seconds at 100ms steps) so tooling can inspect a minute of history without triggering drops. This mirrors guidance from the Performance Timeline that buffers silently drop entries once full; exposing capacity controls and the dropped-entry count keeps the channel deterministic for observers.[^performanceobserver-buffer]
- **Event counter snapshots**: Cache the `BackPressureSnapshot` once before system execution and reuse it to compute diff payloads only when channel utilization breaches configured thresholds, keeping the steady-state payload small while still reusing the existing event bus diagnostic shape (`packages/core/src/events/event-bus.ts`).
- **System error handling**: `timeline.captureSystem()` annotates thrown errors but rethrows them so the existing `IdleEngineRuntime` catch block continues to emit `SystemExecutionFailed` telemetry and keeps later systems running (`packages/core/src/index.ts:198`, `packages/core/src/index.test.ts:250`).

## 11. Acceptance Criteria
- Runtime exposes a documented `DiagnosticTimeline` API that records tick phases, per-system durations, and queue/event metrics.
- Telemetry warnings fire when ticks exceed configured budgets, and Prometheus integration reflects the new counters.
- Resource publish transport (or equivalent channel) can surface timeline deltas to the Worker bridge without breaking existing consumers when diagnostics are disabled.
- Unit tests cover timeline recording, slow-tick detection, and disabled/noop scenarios.

## 12. References
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
