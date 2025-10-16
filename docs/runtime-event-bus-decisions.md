# Decision Record: Runtime Event Bus Follow-ups

**Status:** Accepted  
**Date:** 2025-10-16  
**Related Work:** `docs/runtime-event-pubsub-design.md`, issue #87

## Context

The runtime event bus design introduced in issue #8 left four areas open for
validation before the feature could be considered production-ready:

1. Auto-registration of content-pack-defined events without destabilising replay
   manifests.
2. Whether the bus requires dedicated priority tiers to guarantee dispatch
   ordering for urgent channels.
3. A policy for throttling soft-limit diagnostics so repeated warnings remain
   actionable while respecting channel-specific thresholds.
4. Confirmation that the struct-of-arrays transport proposed for event frames
   is still the best fit, or definition of a fallback path for sparse workloads.

This record captures the final calls for each topic so downstream work can
assume a stable contract.

## Decisions

### 1. Content packs declare events through schema-backed manifests

- Content packs may define additional runtime events, but registration happens
  during the offline build pipeline. Pack manifests contribute `eventTypes`
  entries that include a `namespace`, `name`, `version`, and schema reference.
- The build tooling emits a deterministic manifest ordered by the pair
  `(packSlug, eventKey)` and generates the TypeScript declaration used to extend
  the `RuntimeEventType` union. Generation is stable because the manifest is
  sorted and versioned; replays key off the `(packSlug, eventKey, version)` tuple
  and refuse to load if the manifest hash changes.
- Runtime registration is forbidden. Content packs shipped to players contain
  the baked manifest so all environments share the exact event catalogue.
- Follow-up: extend the existing content schema CLI to merge `eventTypes` during
  `pnpm generate`. Owners of `packages/content-sample` provide the first example.
- Authoring flow: `docs/runtime-event-manifest-authoring.md` captures the manifest
  format, generation command, and how the recorder validates the hash.

### 2. No additional priority tiers; deterministic order follows publish time

- The event bus keeps a single FIFO queue per tick. Priority tiers are deferred
  because they complicate determinism and make it harder to reason about replay
  equivalence.
- Systems that need earlier reactions must publish earlier (inside the command
  handler) or subscribe to an explicit pre-commit hook. This remains consistent
  with the command queue strategy.
- To prevent starvation, the dispatcher processes listeners in the order their
  subscriptions were registered. Test fixtures will cover the deterministic
  ordering contract.
- Follow-up: document the sequencing expectations for system authors and audit
  the initial consumers to ensure they do not rely on implied priorities.

### 3. Channel-scoped diagnostic throttling with adaptive soft limits

- The bus exposes `EventDiagnostics` helpers that rate-limit soft-limit warnings
  per channel. Each channel provides a configuration with `maxEventsPerTick`,
  `maxEventsPerSecond`, and an optional `cooldownTicks`. Defaults are applied
  from the runtime config but can be tuned by integrators.
- When a publisher exceeds the soft limit, the bus logs a warning once and
  increases the cooldown (exponential backoff) before emitting the next warning.
  Hard limits still throw determinism-breaking errors immediately.
- Telemetry exports aggregate counters so dashboards can alert on sustained
  pressure without spamming logs.
- Follow-up: wire the diagnostic struct into the existing telemetry adapter and
  add focused tests in the bus package.

### 4. Struct-of-arrays remains the primary wire format with guard rails

- Measurements with representative content indicate that struct-of-arrays keeps
  transfer frames compact when multiple systems emit events in the same tick.
  The approach also aligns with the resource delta pipeline, simplifying reuse.
- A fallback JSON object array is defined but only toggled when the average
  frame density drops below 2 events per channel over a rolling 256-tick window.
  The toggle is feature-flagged to allow per-environment experimentation.
- The runtime exporter surfaces diagnostics when the fallback is activated so we
  can revisit the default if sparse workloads become dominant.
- Follow-up: add benchmark coverage for both formats and document the flag in
  the shell transport guide.

## Consequences

- Content packs gain a predictable path to extend the event taxonomy without
  risking replay drift, but they must participate in the generation pipeline.
- Consumers can rely on strict FIFO ordering, which simplifies tests, though
  special-case preemption must be handled within publishers themselves.
- Diagnostics are actionable without overwhelming telemetry sinks, and the rate
  limiter parameters can evolve per channel as new systems come online.
- The transport remains optimised for dense workloads while providing metrics
  and guard rails to detect when a simpler format would be preferable.

## Next Steps

1. Update the content tooling to accept `eventTypes` manifests and emit the
   generated union (`packages/content-sample` supplies the reference config).
2. Implement the diagnostic helpers and wire them into the event bus exporter.
3. Add benchmark and test coverage once the event bus lands to verify queue
   ordering, throttling, and serialization toggling.
