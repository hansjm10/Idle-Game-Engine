---
title: Runtime Event Bus Follow-up Decisions
---

# Runtime Event Bus Follow-up Decisions

Use this document to understand the final architectural decisions made for the runtime event bus feature, particularly regarding event registration, dispatch ordering, diagnostics throttling, and transport format optimization.

## Document Control
- **Title**: Runtime Event Bus Follow-up Decisions
- **Authors**: TODO
- **Reviewers**: TODO
- **Status**: Accepted
- **Last Updated**: 2025-10-16
- **Related Issues**: Issue #87, docs/runtime-event-pubsub-design.md, Issue #8
- **Execution Mode**: Manual

## 1. Summary
This document captures the final architectural decisions for four critical areas of the runtime event bus implementation: (1) auto-registration of content-pack-defined events without destabilizing replay manifests, (2) dispatch ordering guarantees and priority tier requirements, (3) diagnostic throttling policies for soft-limit warnings, and (4) validation of the struct-of-arrays transport format. These decisions establish a stable contract for downstream work and ensure the event bus is production-ready while maintaining deterministic replay, extensibility, and performance.

## 2. Context & Problem Statement
- **Background**: The runtime event bus design introduced in issue #8 provided the foundation for a deterministic event system but left four areas open for validation before production readiness could be confirmed.
- **Problem**: Four specific aspects required resolution:
  1. How to allow content packs to define events without destabilizing replay manifests
  2. Whether priority tiers are needed to guarantee dispatch ordering for urgent channels
  3. How to throttle soft-limit diagnostics to keep warnings actionable while respecting channel-specific thresholds
  4. Whether the struct-of-arrays transport remains optimal or if a fallback is needed for sparse workloads
- **Forces**: Deterministic replay equivalence must be preserved, content pack extensibility is required, diagnostic noise must be controlled, and transport efficiency must be balanced against complexity.

## 3. Goals & Non-Goals
- **Goals**:
  1. Enable content packs to declare custom events without breaking replay determinism
  2. Define clear dispatch ordering guarantees for the event bus
  3. Implement actionable diagnostic throttling that prevents telemetry overload
  4. Validate or provide alternatives to the struct-of-arrays transport format
  5. Establish a stable contract for downstream work
- **Non-Goals**:
  - Runtime event registration (forbidden to preserve determinism)
  - Priority tier implementation (deferred due to complexity)
  - Changing the fundamental event bus architecture

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**: Runtime team, content pack authors, tooling maintainers
- **Agent Roles**: N/A (manual execution)
- **Affected Packages/Services**:
  - `packages/core` (event bus implementation)
  - `packages/content-sample` (example event manifest)
  - Content schema CLI tooling
  - Runtime exporter and telemetry adapter
- **Compatibility Considerations**: Replay manifests must remain stable; event type union generation must be deterministic; telemetry format is extensible

## 5. Current State
The runtime event bus introduced in issue #8 provides the foundational architecture for deterministic event publishing and subscription. The system supports channel-based organization and maintains FIFO ordering within ticks. However, four specific areas were left open pending validation: content pack event registration strategy, priority tier requirements, diagnostic throttling implementation, and transport format optimization for varying workload densities.

## 6. Proposed Solution
### 6.1 Architecture Overview
- **Narrative**: The solution consists of four independent decisions that together complete the runtime event bus contract. Content packs declare events through schema-backed manifests processed during the build pipeline. The bus maintains a single FIFO queue per tick without priority tiers, relying on publish-time ordering. Diagnostics use channel-scoped throttling with exponential backoff to control warning frequency. The transport format remains struct-of-arrays with automatic fallback to object arrays when workload density drops below defined thresholds.
- **Diagram**: N/A

### 6.2 Detailed Design
- **Runtime Changes**:
  - **Event Registration**: Content packs declare events in manifests during offline build. Build tooling emits deterministic manifest ordered by `(packSlug, eventKey)` and generates TypeScript declarations for the `RuntimeEventType` union. Replays key off `(packSlug, eventKey, version)` tuple and refuse to load if manifest hash changes.
  - **Dispatch Ordering**: Single FIFO queue per tick. No priority tiers. Dispatcher processes listeners in subscription registration order. Systems requiring earlier reactions must publish earlier or subscribe to pre-commit hooks.
  - **Diagnostic Throttling**: `EventDiagnostics` helpers rate-limit soft-limit warnings per channel. Each channel configures `maxEventsPerTick`, `maxEventsPerSecond`, and optional `cooldownTicks`. Exponential backoff between warnings. Hard limits throw immediately.
  - **Transport Format**: Struct-of-arrays primary format. Fallback to JSON object array when average frame density drops below 2 events per channel over rolling 256-tick window. Feature-flagged via `EventBusOptions.frameExport.autoFallback.enabled`.

- **Data & Schemas**:
  - Content pack manifests include `eventTypes` entries with `namespace`, `name`, `version`, and schema reference
  - `RuntimeEventFrame` payloads include `format` discriminator and optional `diagnostics` block
  - Object-array exports provide `events[]` records instead of typed arrays

- **APIs & Contracts**:
  - `EventBus.getFrameExportState()` exposes rolling window, density threshold, and active format
  - Telemetry emits `EventSoftLimitBreach` warnings and `RuntimeEventFrameFormatChanged` events
  - Metrics counters: `events.soft_limit_breaches`, `events.cooldown_ticks`
  - Prometheus metrics: `idle_engine_events_soft_limit_breaches_total`, `idle_engine_events_soft_limit_cooldown_ticks`

- **Tooling & Automation**:
  - Content schema CLI extended to merge `eventTypes` during `pnpm generate`
  - Benchmark suite under `packages/core/benchmarks` for format comparison
  - Run via `pnpm --filter @idle-engine/core run benchmark`

### 6.3 Operational Considerations
- **Deployment**: N/A (design decisions)
- **Telemetry & Observability**: Aggregate counters prevent log spam. Cooldown gauges feed Prometheus. Format change warnings signal when fallback activates.
- **Security & Compliance**: N/A

## 7. Work Breakdown & Delivery Plan
### 7.1 Issue Map
| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| Update content tooling for event manifests | Extend CLI to accept `eventTypes` and emit TypeScript union | Manual | This design approval | `packages/content-sample` reference config; generation stable |
| Implement diagnostic helpers | Wire `EventDiagnostics` into event bus exporter | Manual | This design approval | Tests cover throttling; telemetry adapter connected |
| Add benchmark and test coverage | Verify queue ordering, throttling, serialization toggle | Manual | Event bus landed | Benchmarks in CI; tests pass |

### 7.2 Milestones
- **Phase 1**: Content tooling update and diagnostic implementation
- **Phase 2**: Benchmark coverage and documentation updates

### 7.3 Coordination Notes
- **Hand-off Package**: Reference `docs/runtime-event-manifest-authoring.md` for manifest format
- **Communication Cadence**: Standard review workflow

## 8. Agent Guidance & Guardrails
- **Context Packets**: N/A
- **Prompting & Constraints**: N/A
- **Safety Rails**: Runtime registration is forbidden to preserve determinism
- **Validation Hooks**: N/A

## 9. Alternatives Considered
- **Priority Tiers**: Rejected due to complexity and determinism concerns. Systems needing earlier reactions must publish earlier or use pre-commit hooks.
- **Runtime Registration**: Rejected to preserve replay determinism. All events must be declared at build time.
- **Always-on Object Array Format**: Rejected because struct-of-arrays performs better for dense workloads. Fallback provides escape hatch for sparse scenarios.

## 10. Testing & Validation Plan
- **Unit / Integration**:
  - Test fixtures cover deterministic ordering contract
  - Focused tests for diagnostic throttling in bus package
  - Format branching validation for consumers
- **Performance**:
  - Benchmarks compare struct-of-arrays vs object-array representations
  - Dense and sparse workload timing in CI logs
  - Rolling window density monitoring
- **Tooling / A11y**: N/A

## 11. Risks & Mitigations
| Risk | Mitigation |
|------|------------|
| Content packs may not adopt manifest format | Provide clear reference implementation in `packages/content-sample` and authoring documentation |
| Diagnostic throttling may suppress important warnings | Exponential backoff balances noise vs visibility; telemetry counters enable alerting |
| Struct-of-arrays may underperform for sparse workloads | Automatic fallback with feature flag and density monitoring provides escape hatch |
| Lack of priority tiers may cause ordering issues | Document sequencing expectations and audit initial consumers |

## 12. Rollout Plan
- **Milestones**: See section 7.2
- **Migration Strategy**: N/A (new feature decisions)
- **Communication**: Document manifest authoring flow and shell transport guide updates

## 13. Open Questions
None. All four decision areas have been resolved.

## 14. Follow-Up Work
1. Extend content schema CLI to merge `eventTypes` during `pnpm generate` (owner: tooling team)
2. Document manifest format in `docs/runtime-event-manifest-authoring.md` (owner: docs)
3. Wire diagnostic struct into telemetry adapter (owner: runtime team)
4. Add benchmark coverage for both transport formats (owner: runtime team)
5. Document frame export flag in shell transport guide (owner: docs)
6. Audit initial consumers to ensure no implied priority dependencies (owner: runtime team)

## 15. References
- `docs/runtime-event-pubsub-design.md` - Original event bus design
- Issue #8 - Initial runtime event bus implementation
- Issue #87 - Follow-up validation work
- `packages/core/benchmarks` - Transport format benchmarks
- `docs/runtime-event-manifest-authoring.md` - Manifest authoring guide (to be created)

## Appendix A — Glossary
- **FIFO**: First-In-First-Out queue ordering
- **Struct-of-arrays**: Data layout where each field is stored in a separate array, optimized for dense workloads
- **Soft limit**: Configurable threshold that triggers warnings but does not halt execution
- **Hard limit**: Threshold that throws determinism-breaking errors immediately
- **Replay manifest**: Deterministic record of events keyed by `(packSlug, eventKey, version)` tuple
- **Content pack**: Modular game content that can extend the engine's event taxonomy

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2025-10-16 | TODO   | Initial decision record |
| 2025-12-21 | Claude Opus 4.5 | Migrated to template format |

---

## Consequences

- Content packs gain a predictable path to extend the event taxonomy without risking replay drift, but they must participate in the generation pipeline.
- Consumers can rely on strict FIFO ordering, which simplifies tests, though special-case preemption must be handled within publishers themselves.
- Diagnostics are actionable without overwhelming telemetry sinks, and the rate limiter parameters can evolve per channel as new systems come online.
- The transport remains optimized for dense workloads while providing metrics and guard rails to detect when a simpler format would be preferable.
