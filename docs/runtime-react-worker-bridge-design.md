# Implement Runtime->React Worker Bridge

Issue: #16 (implementation) / #251 (design doc) - Presentation Shell Workstream

## Document Control
- **Title**: Implement runtime->React Worker bridge
- **Authors**: Idle Engine Design Authoring Agent (AI)
- **Reviewers**: TODO (Presentation Shell Lead)
- **Status**: Approved
- **Last Updated**: 2025-11-11
- **Related Issues**: [#16](https://github.com/hansjm10/Idle-Game-Engine/issues/16), [#251](https://github.com/hansjm10/Idle-Game-Engine/issues/251)
- **Operational Runbook**: [Runtime->React Worker Bridge Operational Runbook](runtime-worker-bridge-runbook.md)
- **Execution Mode**: AI-led
- **Schema Package**: `@idle-engine/runtime-bridge-contracts`

## 1. Summary
Responding to the directive "Create a design document for issue #16, use gh to find more about it," this plan formalises how we deliver a resilient Worker-mediated bridge from the deterministic runtime to the React presentation shell. Issue #16 ("Create Worker bridge for runtime -> React") requires hardened message contracts, lifecycle management, and diagnostics propagation so the shell can safely emit player commands and render authoritative state snapshots without compromising the runtime loop. The proposed architecture refines the existing worker prototype, codifies command and telemetry flows (READY/ERROR handshake, diagnostics toggles), and documents the session snapshot protocol to reach production readiness.

## 2. Context & Problem Statement
- **Background**: The implementation plan highlights the Presentation Shell workstream's dependency on a Worker channel to consume runtime snapshots (`docs/implementation-plan.md:18`). Prototype wiring already instantiates `IdleEngineRuntime` inside a dedicated worker (`packages/shell-web/src/runtime.worker.ts:74`) and exposes a hook-based bridge for React (`packages/shell-web/src/modules/worker-bridge.ts:181`). Architecture notes confirm the importance of keeping command stamping consistent with the fixed-step lifecycle (`docs/runtime-step-lifecycle.md:19`).
- **Problem**: Issue #16 lacks an approved design describing the Worker bridge contract, error handling, diagnostics handshake, and React integration boundaries. The current bridge prototype (`packages/shell-web/src/modules/worker-bridge.ts:63`) is functional but undocumented, omits replay protection, and hardcodes payload shapes that downstream agents cannot rely on. Without a sanctioned design, AI agents risk diverging implementations and UI regressions.
- **Forces**: The bridge must preserve runtime determinism, remain Vite/React compatible, expose diagnostics for performance tuning, and sustain long-lived sessions without memory leaks. Presentation increments depend on a stable API, while runtime owners require guardrails that prevent untrusted UI code from mutating engine state directly.

## 3. Goals & Non-Goals
- **Goals**
  - Publish an authoritative Worker message contract for issue #16 covering command, state, diagnostics, session snapshot, and lifecycle envelopes.
  - Establish a canonical schema package: `@idle-engine/runtime-bridge-contracts` for all worker bridge message types and constants (e.g., `WORKER_MESSAGE_SCHEMA_VERSION`).
  - Ship a reusable React-facing bridge that enforces disposal, subscription control, and monotonic timestamps.
  - Provide diagnostics opt-in wiring so shell agents can enable the runtime timeline without polluting baseline runs.
  - Document operational runbooks for bundling, error surfacing, snapshot restore, and testing under Vite-driven dev/CI workflows.
- **Non-Goals**
  - Redesigning the IdleEngineRuntime scheduler or command queue internals (covered elsewhere).
  - Delivering final presentation components beyond the thin shell required to validate the bridge.
  - Integrating social-service or content-pack APIs; those will follow once the bridge is proven.

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**
  - Presentation Shell workstream coordinating issue #16 delivery.
  - Runtime Core maintainers ensuring Worker boundary safety.
  - Developer Experience owners who uphold build/test ergonomics.
- **Agent Roles**
  - Runtime Worker Implementation Agent: owns worker harness, message schemas, and diagnostics delta logic.
  - React Bridge Integration Agent: owns TypeScript bridge, React hooks, and UI consumption patterns.
  - Quality & Diagnostics Agent: owns test coverage, telemetry assertions, and lint/test automation updates.
- **Affected Packages/Services**
  - `packages/shell-web/src/runtime.worker.ts`
  - `packages/shell-web/src/modules/worker-bridge.ts`
  - `packages/core/src/index.ts`
  - `packages/shell-web/src/modules/App.tsx`
- **Compatibility Considerations**
  - Maintain backward compatibility for command queue priorities and step stamping defined in `IdleEngineRuntime` (`packages/core/src/index.ts:82`). Honor `WORKER_MESSAGE_SCHEMA_VERSION` negotiation.
  - Ensure Worker bundling remains ES module compliant for Vite and future React upgrades.
  - Guard against API changes that could invalidate diagnostics consumers or content packs waiting on snapshot schemas.

## 5. Current State
Issue #16 currently relies on a minimal Worker harness that exposes state snapshots and diagnostics updates but lacks formal documentation. The worker bootstrap constructs a runtime, handles messages, and emits state deltas (`packages/shell-web/src/runtime.worker.ts:74`). The React hook lazily instantiates `WorkerBridgeImpl`, subscribes to worker messages, and disposes on unmount (`packages/shell-web/src/modules/worker-bridge.ts:181`). The shell's `App` component consumes this hook to push commands and render simple diagnostics (`packages/shell-web/src/modules/App.tsx:14`). Architecture docs confirm alignment with the runtime lifecycle but do not specify failure handling or contract versioning (`docs/runtime-step-lifecycle.md:19`). Tests cover core bridging scenarios, including gating diagnostics updates behind a subscription handshake (`packages/shell-web/src/runtime.worker.test.ts:186`), yet they do not address reconnection resilience or malformed message rejection.

## 6. Proposed Solution

### 6.1 Architecture Overview
- **Narrative**
  - Dedicated Worker hosts `IdleEngineRuntime` and orchestrates command queue execution, pushing deterministic state snapshots to the UI. The React bridge encapsulates Worker lifecycle, exposes subscription hooks, and ensures commands cross the thread boundary with consistent metadata.
  - Message envelopes are versioned and validated before entering the runtime queue, safeguarding the runtime from malformed UI input. Diagnostics remain opt-in to avoid unnecessary load.
- **Diagram**

  Runtime worker ↔ React bridge message flow covering READY, COMMAND, STATE_UPDATE, and DIAGNOSTICS envelopes. Source: `docs/assets/diagrams/runtime-react-worker-bridge.mmd` (keep in sync).

  ```mermaid
  %% Source of truth also stored at docs/assets/diagrams/runtime-react-worker-bridge.mmd
  sequenceDiagram
    autonumber
    participant React as React Shell
    participant Bridge as WorkerBridge
    participant Worker as Runtime Worker
    participant Runtime as IdleEngineRuntime

    React->>Bridge: instantiate WorkerBridge & awaitReady()
    Bridge->>Worker: create worker(module)
    Worker-->>Bridge: READY {handshakeId}
    Bridge-->>React: resolve awaitReady()

    React->>Bridge: sendCommand(type, payload)
    Note right of Bridge: Wraps payload with requestId,<br/>source, issuedAt (performance.now())
    Bridge->>Worker: COMMAND {schemaVersion, requestId, source, command}
    Worker->>Runtime: enqueue(command)

    Worker-->>Bridge: STATE_UPDATE {state snapshot}
    Bridge-->>React: onStateUpdate(state)

    React->>Bridge: enableDiagnostics()
    Bridge->>Worker: DIAGNOSTICS_SUBSCRIBE
    Worker->>Runtime: enableDiagnostics()
    Runtime-->>Worker: diagnostics delta
    Worker-->>Bridge: DIAGNOSTICS_UPDATE {timeline}
    Bridge-->>React: onDiagnosticsUpdate(diagnostics)
  ```

### 6.2 Detailed Design
- **Runtime Changes**
  - Extend `initializeRuntimeWorker` to include an optional `handshakeId` and emit a `READY` message after registering listeners, allowing the React bridge to wait for readiness before sending commands (`packages/shell-web/src/runtime.worker.ts:74`).
  - Harden message validation by rejecting commands missing `type`, `payload`, or non-monotonic `timestamp`; log structured errors to aid diagnostics.
  - Add replay protection by tracking the last processed UI command timestamp and dropping stale commands.
- **Data & Schemas**
  - Formalise Worker message types:
    - `COMMAND` (UI->Worker): `{type, payload, requestId, source, issuedAt}`
    - `STATE_UPDATE` (Worker->UI): `{currentStep, events[], backPressure}`
    - `DIAGNOSTICS_UPDATE` (Worker->UI): timeline delta snapshot
    - `RESTORE_SESSION` (UI->Worker): `{state?, elapsedMs?, resourceDeltas?}` session resume payload
    - `SESSION_RESTORED` (Worker->UI): acknowledgement that queueing may resume
    - `DIAGNOSTICS_SUBSCRIBE` / `DIAGNOSTICS_UNSUBSCRIBE`
    - `READY`, `ERROR`, and `TERMINATE` control messages
  - Maintain schema definitions in `packages/shell-web/src/modules/worker-bridge.ts` with TypeScript discriminated unions for agent reuse (`packages/shell-web/src/modules/worker-bridge.ts:55`).
- **APIs & Contracts**
  - Expand `WorkerBridge` interface to expose `awaitReady()`, `restoreSession()`, `disableDiagnostics()`, and `onError` callbacks while keeping existing `sendCommand`, `onStateUpdate`, and diagnostics observers (`packages/shell-web/src/modules/worker-bridge.ts:14`).
  - Queue outbound traffic while a session restore is pending so UI code can emit user commands without racing the worker handshake.
  - Provide typed event emitters so React components receive strongly typed snapshots (`RuntimeStateSnapshot`) and diagnostics payloads.
  - Surface worker errors through the optional `__IDLE_ENGINE_TELEMETRY__` facade so hosts can forward incidents without bundling server-only dependencies.
  - Document contract versioning in `/docs` with change log entries referencing issue #16.
- **Tooling & Automation**
  - Update Vitest suites to cover handshake, replay protection, diagnostics gating, and disposal semantics (`packages/shell-web/src/runtime.worker.test.ts:1`).
  - Add lint rule exceptions or ESLint configuration updates if Worker globals require adjustments.
  - Ensure `pnpm test --filter shell-web` becomes the canonical validation command for agents, aligning with doc guidance.

### 6.3 Operational Considerations
Full build, rollout, and troubleshooting procedures live in the [Runtime->React Worker Bridge Operational Runbook](runtime-worker-bridge-runbook.md); keep that guide updated alongside the contract changes described below.
- **Deployment**
  - Incorporate Worker bundle into Vite build pipeline, verifying production builds include hashed worker assets. Document `pnpm build --filter shell-web` as the release artifact generator.
- **Telemetry & Observability**
  - Expose console warnings when commands are dropped or diagnostics are disabled by policy, guiding agents during debugging.
  - Forward runtime diagnostics deltas downstream without flooding logs; implement throttling if the UI main thread lags.
- **Security & Compliance**
  - Restrict Worker context to treat all UI-originating commands as `CommandPriority.PLAYER`, preventing privilege escalation (`packages/shell-web/src/runtime.worker.ts:170`).
  - Ensure no PII crosses the bridge; payloads should remain gameplay data scoped to the local session. Clarify that the Worker runs in-browser only, limiting exposure.

## 7. Work Breakdown & Delivery Plan

### 7.1 Issue Map
| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| feat(shell-web): harden runtime worker handshake | Implement READY/ERROR control flow, command validation, replay protection | Runtime Worker Implementation Agent | Design approval (this doc) | Vitest coverage proves handshake, queue stamping, replay guard |
| feat(shell-web): expand React worker bridge API | Extend bridge with awaitReady, error surface, diagnostics toggles; update hook | React Bridge Integration Agent | Handshake issue | Bridge unit tests updated; App consumes new API without regressions |
| test(shell-web): diagnostics and lifecycle coverage | Add tests for diagnostics subscribe/unsubscribe, disposal, throttled logs | Quality & Diagnostics Agent | React bridge update | Tests cover DIAGNOSTICS_SUBSCRIBE and disposal; CI green |

### 7.2 Milestones
- **Phase 1**: Finalise Worker message contract and handshake, including READY/ERROR flow; target completion within three working days of design approval.
- **Phase 2**: Update React bridge and UI integration to consume new contract; target completion two days after Phase 1, contingent on green tests.
- **Phase 3**: Diagnostics and lifecycle hardening, including documentation updates; finalise within two days after Phase 2.

### 7.3 Coordination Notes
- **Hand-off Package**: Provide agents with references to `packages/shell-web/src/runtime.worker.ts:74`, `packages/shell-web/src/modules/worker-bridge.ts:63`, and `docs/runtime-step-lifecycle.md:19`.
- **Communication Cadence**: Daily async status ping via project board comments; escalate blockers immediately to Presentation Shell lead.
- **Escalation Path**: Runtime Core maintainers adjudicate disputes about command queue invariants; Dev Experience ensures bundler compatibility.

## 8. Agent Guidance & Guardrails
- **Context Packets**
  - Load `docs/runtime-step-lifecycle.md:1` and `docs/implementation-plan.md:18` before coding.
  - Cache TypeScript typings from `packages/core` to align command structures.
- **Prompting & Constraints**
  - Agents must reference issue #16 and this design doc in commit messages.
  - Follow Conventional Commit syntax; example: `feat(shell-web): implement worker READY handshake`.
- **Safety Rails**
  - Do not bypass Worker boundary by importing runtime directly into React components.
  - Avoid modifying `packages/core` unless explicitly approved; prefer adapter changes in shell-web.
  - Never disable diagnostics safeguards when writing tests; use provided toggles.
- **Validation Hooks**
  - Run `pnpm lint` and `pnpm test --filter shell-web` locally before completion.
  - For diagnostics changes, run `pnpm test --filter "runtime.worker"` to target integration tests.

## 9. Alternatives Considered
- **Main-thread runtime execution**: Rejected because it violates determinism guarantees and blocks UI responsiveness.
- **Service Worker or SharedWorker**: Discarded due to increased complexity and limited browser support relative to dedicated Worker simplicity for issue #16.
- **postMessage-based RPC library**: Unnecessary; custom discriminated unions give tighter control over payload validation and reduce bundle size.

## 10. Testing & Validation Plan
- **Unit / Integration**
  - Extend Vitest suites for worker harness and bridge to cover handshake, replay guard, diagnostics enablement, and disposal.
  - Mock Worker context to assert messages emitted on error and termination.
- **Performance**
  - Benchmark tick loop under simulated high-frequency commands to confirm no regression beyond current `RAF_INTERVAL_MS` budget.
  - Validate diagnostics throttling to ensure UI thread remains responsive during stress tests.
- **Tooling / A11y**
  - After bridge integration, run `pnpm test:a11y` if UI surfaces change.
  - Confirm Vite build outputs include worker bundle without warnings.

## 11. Risks & Mitigations
- **Bundler compatibility**: Vite upgrades or React 19 changes could destabilise Worker imports; mitigation is to pin versions and run smoke builds per milestone.
- **Command drift**: If runtime command contracts evolve, UI could break; mitigate by centralising TypeScript types and adding compile-time checks.
- **Diagnostics overload**: High-frequency diagnostics may overwhelm UI; enforce throttling and optional subscription.
- **Resource leaks**: Failure to dispose Worker on navigation could leak memory; ensure `useWorkerBridge` always calls `dispose()` and add regression tests.

## 12. Rollout Plan
- **Milestones**
  - Milestone 1: Merge worker handshake updates behind feature guard.
  - Milestone 2: Enable new React bridge in dev builds; monitor for regressions.
  - Milestone 3: Promote to production build once tests and manual smoke pass.
- **Migration Strategy**
  - Introduce the `VITE_ENABLE_WORKER_BRIDGE` (`ENABLE_WORKER_BRIDGE`) flag so shells can fall back to the inline legacy bridge until confidence is established; leave it disabled by default and retire it after Phase 3 sign-off.
  - Provide migration notes for agents touching UI components.
- **Communication**
  - Announce bridge availability in weekly status report; include testing commands.
  - Update onboarding documentation to reference new bridge once rollout completes.

## 13. Decisions Since Draft
- **Telemetry routing** *(Owner: Presentation Shell analytics lead)* — Worker-side errors publish through the shell analytics pipeline via the global `__IDLE_ENGINE_TELEMETRY__` facade (`packages/shell-web/src/modules/worker-bridge.ts:126`). Implementation completed in [#267](https://github.com/hansjm10/Idle-Game-Engine/issues/267) installs the browser shell analytics facade (`packages/shell-web/src/modules/shell-analytics.ts`), wiring worker bridge telemetry into dashboards and exposing the `VITE_SHELL_ANALYTICS_ENDPOINT` fallback for hosts that rely on sendBeacon/fetch delivery.
- **Content pack messaging** *(Owner: Content Systems integration lead)* — Presentation shells continue to consume pack-provided events exclusively through the `STATE_UPDATE.state.events` array; no additional message envelopes are required. We verified this against existing pack samples and worker emission logic, so downstream agents can rely on the current contract without schema changes.
- **Resumable session handshake** *(Owner: Runtime Core liaison)* — The `RESTORE_SESSION` / `SESSION_RESTORED` sequence and `WorkerBridge.restoreSession()` helper are considered ready for rollout. Coordination with the persistence work in [#258](https://github.com/hansjm10/Idle-Game-Engine/issues/258) will cover storage handoff requirements before enabling offline progression in production.

## 14. Follow-Up Work

### 14.1 Worker↔Shell Persistence Handoff (Issue #258)

**Goals**
- Persist authoritative runtime state so the shell can restore sessions without violating determinism or the existing `RESTORE_SESSION` contract.
- Support offline catch-up by capturing wall-clock metadata alongside the serialized state.
- Keep persistence infrastructure reusable across shells (web, native wrappers) and tolerant of future content pack migrations.

**Constraints**
- The worker must remain deterministic and cannot touch DOM-only APIs such as `localStorage`; all storage I/O runs on the shell side.
- Existing validation in `runtime.worker.ts:200` expects `SerializedResourceState` payloads that pass `reconcileSaveAgainstDefinitions`; storage must never mutate those structures.
- Autosave cadence cannot interfere with the simulation tick loop—snapshot requests must be explicit and queued through the bridge.

**Storage Evaluation**

| Option | Pros | Cons | Notes |
| --- | --- | --- | --- |
| IndexedDB (Recommended) | Available in dedicated workers and windows, async, structured-clone friendly, ~50 MB quota in most browsers | Needs promise-based wrapper, requires schema/version bookkeeping | Use a single `idle-engine.sessions` database with version upgrades handled by the shell |
| Cache API | Streams suited to HTTP responses, versioned caches | Cannot store arbitrary structured data without manual serialization, unclear worker support for our use case | Rejected; better for asset caching than game state |
| localStorage | Simple API | Not accessible inside workers, synchronous (janks UI), ~5 MB quota | Rejected; fails worker requirement and risks deadlocks |

**Chosen Strategy: Shell-managed IndexedDB**
- Introduce a `SessionPersistenceAdapter` in the React shell that owns all IndexedDB access. The worker exposes a new `SESSION_SNAPSHOT` outbound message and `REQUEST_SESSION_SNAPSHOT` inbound command so snapshot requests travel over the existing bridge.
- Persisted entries store raw `SerializedResourceState`, offline metadata, and runtime/content digests. The worker never performs I/O; it only marshals deterministic data.
- Provide a thin abstraction (`PersistenceDriver`) so native shells can swap in filesystem-backed implementations while reusing message flow and schema.

**Message Flow**

**Save / Autosave**
1. Shell calls `WorkerBridge.requestSessionSnapshot(reason)` (new API) when autosave timers, user actions, or shutdown events fire. The bridge enqueues a `REQUEST_SESSION_SNAPSHOT` message after `awaitReady()` and outside `restoreSession` windows.
2. Worker captures deterministic data: `SerializedResourceState` via `resourceState.exportForSave()`, pending commands via `commandQueue.exportForSave()`, current tick step, monotonic clock reference, and optional offline progression metadata (mode, net rates, preconditions). It responds with `SESSION_SNAPSHOT { requestId, capturedAt, state, commandQueue, step, monotonicNow, offlineProgression }`.
3. Shell adapter normalises metadata (e.g., converts `capturedAt` to UTC, clamps offline caps) and writes the entry to the `sessions` object store within a single IndexedDB transaction. On error it surfaces telemetry through the existing `WorkerBridge` error channel.

**Restore**
1. Shell reads the latest slot at startup (or when the user selects a save) and validates it against current content definitions using `reconcileSaveAgainstDefinitions`.
2. Shell computes offline elapsed time as `min(now - capturedAt, OFFLINE_CAP_MS)` and derives optional `resourceDeltas` if migrations supply them.
3. Shell calls `WorkerBridge.restoreSession({ state, commandQueue, elapsedMs, resourceDeltas, offlineProgression })`. The worker follows the existing restore path, emitting either `SESSION_RESTORED` or `ERROR { code: 'RESTORE_FAILED' }`.
4. On success the shell resumes normal command flow; on failure it records telemetry, surfaces UI prompts, and may retry after running migrations.

**Stored Payload (v1)**
- `schemaVersion`: number (start at `1` to decouple from `WORKER_MESSAGE_SCHEMA_VERSION`).
- `slotId`: string (`"default"` initially; enables future multi-slot UI).
- `capturedAt`: ISO timestamp.
- `workerStep`: number (runtime `currentStep` for diagnostics).
- `monotonicMs`: number captured from worker to help derive elapsed time safely.
- `state`: `SerializedResourceState` (immutable snapshot).
- `commandQueue`: `SerializedCommandQueue` (optional pending commands captured at snapshot time).
- `runtimeVersion`: semver string of `@idle-engine/core`.
- `contentDigest`: `ResourceDefinitionDigest` for compatibility checks.
- `offlineProgression`: optional `{ mode, resourceNetRates, preconditions }` captured from the latest state update for constant-rate fast path restores.
- `flags`: `{ pendingMigration?: boolean; abortedRestore?: boolean }`.

**Migration Considerations**
- Content packs publish digests; the adapter compares stored `contentDigest` against the live pack before restore. When digests diverge but a pack-supplied migration exists, the adapter runs it prior to calling `restoreSession`.
- Schema upgrades use IndexedDB version migrations. Each bump records a deterministic transform function so older saves can be rewritten in place without loading them into the worker.
- Record `runtimeVersion` and `persistenceSchemaVersion` to gate restores when the runtime introduces breaking changes. Future workers can advertise supported versions via `READY { supportedPersistence }`.
- Clear `offlineProgression` after migrations to avoid applying stale net-rate snapshots; migrated restores fall back to step-based offline catch-up.
- For detailed guidance on authoring migrations, see [Persistence Migration Guide](./persistence-migration-guide.md).

**Risks & Mitigations**
- *Quota exhaustion*: add size guards (e.g., trim history to `MAX_SNAPSHOTS_PER_SLOT`) and surface telemetry when writes fail. Provide user-facing guidance to clear space.
- *Cross-tab conflicts*: namespace keys by `profileId` and use IndexedDB transactions with `versionchange` listeners to detect concurrent schema upgrades. Future enhancement: advisory locking via BroadcastChannel.
- *Snapshot cost*: snapshot export is synchronous in the worker; autosave cadence must respect frame budgets. Default schedule is every 60 s or on significant events; shells throttle additional requests during high back-pressure.
- *Data corruption*: persist a checksum (e.g., SHA-256 over the serialized payload) and verify before restore; fallback to previous snapshot when verification fails.

**Testing & Telemetry**
- Add Vitest suites with mocked `IDBFactory` to cover happy-path save/restore, schema upgrades, and corruption fallbacks.
- Integration tests should spin up the worker harness, request a snapshot, round-trip through an in-memory IndexedDB polyfill, and assert the worker accepts the restored session.
- Extend telemetry to record `PersistenceSaveFailed`, `PersistenceRestoreFailed`, and `PersistenceMigrationApplied` events routed through `__IDLE_ENGINE_TELEMETRY__`.

**Follow-Up Tasks**
1. Extend `@idle-engine/runtime-bridge-contracts` with `REQUEST_SESSION_SNAPSHOT` / `SESSION_SNAPSHOT` message definitions and update runtime.worker harness.
2. Implement `SessionPersistenceAdapter` and autosave controller inside `packages/shell-web`, including IndexedDB schema management (`sessions` store keyed by slot/profile).
3. Ship shell UI affordances for manual save/load, error reporting, and migration prompts (flagged behind dev toggle until persistence stabilises).
4. ~~Document migration authoring guidelines for content pack maintainers alongside updated CLI scaffolding.~~ **Completed**: See [Persistence Migration Guide](./persistence-migration-guide.md) (Issue [#273](https://github.com/hansjm10/Idle-Game-Engine/issues/273)).

#### 14.1.1 Troubleshooting & Operations

- Resetting saves (Web):
  - Open DevTools → Application → IndexedDB.
  - Expand `idle-engine.sessions` → `sessions` and delete records, or delete the entire database.
  - The shell UI also exposes “Clear Data” in the Persistence panel which calls `SessionPersistenceAdapter.deleteSlot(...)` for the active slot.

- Inspecting IndexedDB (Web):
  - Keys are `{slotId}:{timestamp}`. Values include `schemaVersion`, `capturedAt`, `workerStep`, `contentDigest`, and a checksum.
  - Corrupted snapshots (checksum mismatch) are skipped automatically; the adapter falls back to the next newest snapshot and emits telemetry.

- Common errors and remedies:
  - `DB_OPEN_FAILED`: IndexedDB unavailable/blocked. Avoid private mode and ensure storage isn’t disabled.
  - `DB_UPGRADE_BLOCKED`: Another tab holds the DB during upgrade. Close other tabs or refresh.
  - `SNAPSHOT_FAILED`: Worker export failed; snapshot requests are blocked during restoration. Retry after `SESSION_RESTORED`.
  - `SNAPSHOT_VALIDATION_FAILED`: All snapshots failed checksum verification. Delete the DB and start fresh.
  - `RESTORE_FAILED`: Worker rejected restore payload. Check `flags.pendingMigration`, digests, and migration availability.

- CI determinism:
  - Use `fake-indexeddb` to stub IndexedDB in Vitest. See `packages/shell-web/src/modules/session-persistence-integration.test.ts` for worker ↔ bridge ↔ persistence coverage.

- Extending for native shells:
  - Swap `SessionPersistenceAdapter` with a platform adapter (filesystem/SQLite/MMKV) that preserves the `StoredSessionSnapshot` contract and checksum semantics, then reuse the same wiring in the shell integration.

**Open Questions**
- Do we need encryption or obfuscation for competitive modes? (Out of scope for v1, document in security backlog.)
- Should command replay logs be persisted alongside resource snapshots for richer debugging? (Candidate for follow-up issue once save slots land.)

### 14.2 Remaining Items
- Integrate social-service command hooks after bridge stabilises. Owner: Social Services Lead.
- Produce developer tutorial documenting how to extend the bridge for custom commands. Owner: React Bridge Integration Agent (post-delivery).
- Implement shell analytics sink for worker bridge telemetry routing. Owner: Presentation Shell analytics lead. **Status**: Completed via [#267](https://github.com/hansjm10/Idle-Game-Engine/issues/267); configure hosts with `VITE_SHELL_ANALYTICS_ENDPOINT` (or `SHELL_ANALYTICS_ENDPOINT`) when routing through custom collectors.

## 15. References
- `docs/implementation-plan.md:18`
- `docs/runtime-step-lifecycle.md:19`
- `packages/shell-web/src/runtime.worker.ts:74`
- `packages/shell-web/src/modules/worker-bridge.ts:63`
- `packages/shell-web/src/modules/App.tsx:14`
- `packages/core/src/index.ts:82`

## Appendix A - Glossary
- **Worker bridge**: The communication layer transporting commands, state, and diagnostics between the IdleEngine runtime Worker and the React shell for issue #16.
- **Diagnostics timeline**: Runtime-produced stream of performance entries sampling slow ticks and system budgets, accessible via the worker bridge.

## Appendix B - Change Log

- 2025-11-11 (Fixes #379): Promote status to Approved, align spec with live implementation including READY/ERROR handshake and session snapshot protocol, and extract the message schema into `@idle-engine/runtime-bridge-contracts`. Updated Mermaid diagram (`docs/assets/diagrams/runtime-react-worker-bridge.mmd`) and linked consumers to the schema package.
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2025-10-27 | Idle Engine Design Authoring Agent (AI) | Initial draft for issue #16 bridge design |
| 2025-10-28 | Codex Agent (AI) | Added worker↔shell persistence handoff mini-spec (Fixes #258) |
## Diagnostics Overlay and Headless Simulation (Issue #383)
This increment adds a dev-facing diagnostics overlay and a headless runtime simulator that share the same data shapes to keep consumption consistent across surfaces.
- UI overlay subscribes to diagnostics only when visible and throttles updates for responsiveness. See `packages/shell-web/src/modules/DiagnosticsPanel.tsx`.
- Shared helpers for summarizing and evaluating diagnostics live in `@idle-engine/core` at `src/diagnostics/format.ts` and are exported via the package index.
- A headless CLI (`pnpm core:tick-sim`) advances the runtime for N ticks and prints the diagnostics JSON (single-line, no trailing text), with optional failure on configured thresholds.
These align with the bridge design: opt-in subscriptions, consistent schema (`DiagnosticTimelineResult`), and no baseline overhead when diagnostics are disabled.
