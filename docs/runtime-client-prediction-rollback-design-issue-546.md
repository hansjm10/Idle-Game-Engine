---
title: Client Prediction and Rollback Design (Issue 546)
sidebar_position: 4
---

# Client Prediction and Rollback Design (Issue 546)

## Document Control
- **Title**: Add client-side prediction and rollback for Issue 546
- **Authors**: Codex (AI, Senior Network Game Engineer)
- **Reviewers**: Runtime Core maintainers
- **Status**: Draft
- **Last Updated**: 2025-12-28
- **Related Issues**: https://github.com/hansjm10/Idle-Game-Engine/issues/546, https://github.com/hansjm10/Idle-Game-Engine/issues/684
- **Execution Mode**: AI-led

## 1. Summary
Issue 546 introduces client-side prediction and rollback for networked play in the Idle Engine. This design adds a core PredictionManager that buffers local commands, records per-step checksums, applies authoritative server snapshots, and performs rollback plus deterministic replay when divergence is detected. The approach explicitly builds on the existing command queue and state-sync snapshot/restore APIs to keep simulation deterministic, minimize prediction latency, and bound memory usage while remaining transport-agnostic for Issue 546. Authority is explicitly server-side: client-supplied metadata is treated as advisory and validated or overridden by the transport layer.

## 2. Context & Problem Statement
- **Background**:
  - The runtime executes fixed-step ticks with deterministic command ordering and step stamping (`packages/core/src/index.ts:132`, `packages/core/src/command-queue.ts:18`, `docs/runtime-command-queue-design.md`).
  - State synchronization already provides unified snapshots, checksums, and restore utilities (`packages/core/src/state-sync/capture.ts:13`, `packages/core/src/state-sync/checksum.ts:1`, `packages/core/src/state-sync/restore.ts:188`, `docs/state-synchronization-protocol-design.md`).
  - Command transport (Issue 545) introduces request IDs and acknowledgments but explicitly excludes client prediction (`packages/core/src/command-transport.ts:1`, `docs/runtime-command-transport-design-issue-545.md`).
- **Problem**:
  - Issue 546 requires clients to advance simulation without blocking on server round-trips, but there is no core prediction buffer or rollback coordinator today.
  - Existing snapshot restore requires manual wiring of runtime systems and does not provide automatic rollback/replay orchestration (see manual restore in `packages/core/src/state-sync/restore.test.ts:48`).
  - Without Issue 546, network latency forces either blocked input or custom per-shell reconciliation logic that risks breaking determinism.
- **Forces**:
  - Determinism is mandatory across replay, including RNG seed/state restoration (`packages/core/src/state-sync/restore.ts:227`, `packages/core/src/command-recorder.ts:393`).
  - Performance budgets from state sync must be preserved: checksum under 100 microseconds, capture under 1ms, restore under 5ms (`docs/state-synchronization-protocol-design.md:833`).
  - Prediction should not violate runtime cadence; maintain 60Hz where configured and respect `maxStepsPerFrame` (`packages/core/src/index.ts:110`, `docs/runtime-event-pubsub-design.md:24`).
  - Memory must stay bounded: avoid unbounded command buffering or full snapshot histories in Issue 546.
  - Compatibility must remain additive: no changes to save formats or command queue schemas (`packages/core/src/game-state-save.ts:319`, `packages/core/src/command-queue.ts:40`).

## 3. Goals & Non-Goals
- **Goals**:
  1. Issue 546 adds a PredictionManager in `packages/core` that records local commands with step metadata and tracks pending buffers.
  2. Issue 546 applies server snapshots and confirmed steps using checksums, avoiding rollback when predicted state matches.
  3. Issue 546 performs rollback and deterministic replay of unconfirmed commands on divergence.
  4. Issue 546 uses `GameStateSnapshot` and `computeStateChecksum` for authoritative comparison (`packages/core/src/state-sync/types.ts:7`, `packages/core/src/state-sync/checksum.ts:56`).
  5. Issue 546 enforces bounded prediction windows with explicit overflow handling.
  6. Issue 546 provides telemetry hooks for rollback outcomes and checksum mismatches (`packages/core/src/telemetry.ts:3`).
  7. Issue 546 includes deterministic unit and stress tests in `packages/core` with `pnpm test --filter @idle-engine/core`.
- **Non-Goals**:
  - Issue 546 does not implement transport protocols, authentication, or compression (Issue 545 scope).
  - Issue 546 does not ship UI smoothing, interpolation, or render-layer rewinds.
  - Issue 546 does not introduce server-side continuous simulation or authoritative replay services.
  - Issue 546 does not change command queue ordering, command schemas, or save formats.

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**:
  - Runtime Core maintainers (Issue 546 implementation and API review).
  - Network/transport integrators (Issue 545 consumers relying on prediction state).
  - QA/Testing (determinism and rollback validation).
- **Agent Roles**:

| Agent | Responsibilities |
|-------|------------------|
| Runtime Prediction Agent | Implement PredictionManager, buffers, and rollback logic for Issue 546 in `packages/core`. |
| State Sync Agent | Extend snapshot/restore integration and add runtime restore helpers for Issue 546. |
| Testing Agent | Add deterministic and stress tests for Issue 546. |
| Telemetry Agent | Add rollback/prediction instrumentation for Issue 546. |
| Docs Agent | Update docs and usage guidance for Issue 546. |

- **Affected Packages/Services**:
  - `packages/core` (new prediction module, exports, tests).
  - `docs/` (Issue 546 design and future API docs).
- **Compatibility Considerations**:
  - Issue 546 APIs are additive; no changes to `SerializedCommandQueueV1` or game save schema.
  - Prediction must respect command step stamping and replay determinism (`packages/core/src/index.ts:258`, `packages/core/src/command.ts:18`).
  - Type-only imports and exports remain mandatory under lint rules.

## 5. Current State
Issue 546 builds on existing deterministic infrastructure but lacks a prediction coordinator:
- **Deterministic runtime**: `IdleEngineRuntime` executes fixed-step ticks with command queue integration and step stamping (`packages/core/src/index.ts:132`).
- **Command queue**: Priority lanes with deterministic ordering and JSON-safe serialization (`packages/core/src/command-queue.ts:18`).
- **State sync**: Unified snapshots, checksums, compare, and restore functions (`packages/core/src/state-sync/capture.ts:13`, `packages/core/src/state-sync/checksum.ts:56`, `packages/core/src/state-sync/compare.ts:965`, `packages/core/src/state-sync/restore.ts:188`).
- **Runtime wiring**: `createGameRuntime` and `wireGameRuntime` assemble systems and provide save/hydrate helpers (`packages/core/src/index.ts:846`, `packages/core/src/index.ts:904`).
- **Transport layer**: requestId and ack semantics are in core but exclude prediction (`packages/core/src/command-transport.ts:1`, `docs/runtime-command-transport-design-issue-545.md`).
- **Gap for Issue 546**: there is no pending prediction buffer, rollback orchestration, or checksum-based reconciliation loop in core.

## 6. Proposed Solution
### 6.1 Architecture Overview
- **Narrative**: Issue 546 adds a PredictionManager that sits above the deterministic runtime. The manager records local commands, captures per-step checksums, and reconciles with server snapshots. On checksum mismatch, it restores to the authoritative snapshot, re-enqueues pending commands, and replays ticks to catch up to the local step.
- **Diagram**:
```text
Local Input -> recordLocalCommand -> CommandQueue -> Runtime Tick -> Prediction History
                           |                                    |
                           v                                    v
                    Pending Buffer                       checksum per step
                           |
Server Snapshot + step ----+----> compare checksums ----> match?
                                                   | yes
                                                   v
                                             drop pending <= confirmed
                                                   |
                                                   v
                                               continue predict
                                                   |
                                                   | no
                                                   v
                                   restore snapshot -> replay pending -> update runtime
```

### 6.2 Detailed Design
- **API Surface (Issue 546)**:
  - New module: `packages/core/src/state-sync/prediction-manager.ts`.
  - Export from `packages/core/src/index.ts` alongside state-sync APIs.
  - Baseline interface aligned with Issue 546 and extended for integration:
```typescript
export interface PredictionManager {
  recordLocalCommand(command: Command, atStep?: number): void;
  recordPredictedStep(step?: number): void;
  applyServerState(
    snapshot: GameStateSnapshot,
    confirmedStep: number,
  ): RollbackResult;
  getPendingCommands(): readonly Command[];
  getPredictionWindow(): PredictionWindow;
}

export type RollbackResult = Readonly<{
  readonly status: 'confirmed' | 'rolled-back' | 'resynced' | 'ignored';
  readonly confirmedStep: number;
  readonly localStep: number;
  readonly replayedSteps: number;
  readonly pendingCommands: number;
  readonly checksumMatch?: boolean;
  readonly reason?: 'checksum-match' | 'checksum-mismatch' | 'stale-snapshot' | 'prediction-window-exceeded';
}>;
```
  - `recordPredictedStep` is required for Issue 546 to record checksums at each simulated step. For networked clients, configure `maxStepsPerFrame = 1` to ensure per-step recording (`packages/core/src/index.ts:110`).

- **Authority & Trust Boundaries (Issue 546)**:
  - Server is authoritative for confirmed steps and snapshot content; clients never decide the canonical state.
  - Client-supplied `step`, `priority`, and `timestamp` are treated as advisory. The transport layer MUST stamp authoritative `serverStep` (`runtime.getNextExecutableStep()`), normalize client commands to `CommandPriority.PLAYER`, and apply server-side timestamps on receipt (`packages/core/src/command-transport-server.ts:145`, `packages/core/src/command-queue.ts:18`).
  - Idempotency is enforced by `{clientId, requestId}` keys; duplicate or replayed envelopes resolve to cached `CommandResponse` (`packages/core/src/command-transport.ts:1`, `packages/core/src/command-transport-server.ts:106`).
  - Authentication/authorization is transport-layer scope (Issue 545); core prediction assumes envelopes have been validated and authorized before enqueue.

- **Prediction History (Issue 546)**:
  - Store a ring buffer of `{ step, checksum }` only; optionally store snapshots in debug mode for diffing.
  - Default history window: 50 steps or 5 seconds at `stepSizeMs = 100` (configurable).
  - Checksum uses `computeStateChecksum` and excludes `capturedAt` (`packages/core/src/state-sync/checksum.ts:56`).
  - If the confirmed step is outside the stored history window, treat it as a prediction window overflow and resync from the authoritative snapshot.
  - If `maxStepsPerFrame > 1`, record checksums every `checksumIntervalSteps` (default 1) and accept coarser rollback granularity to keep capture overhead bounded.

- **Pending Command Buffer (Issue 546)**:
  - Store `Command` objects in step order with requestId and timestamp.
  - Default maximum pending commands: 1000 (configurable, independent of `DEFAULT_MAX_QUEUE_SIZE`).
  - On buffer overflow: return `status = 'resynced'` and force authoritative restore.
  - Pending commands are client-originated only. Authoritative remote commands must arrive via snapshots or a server-authored command stream and are applied before replay.

- **Server State Application (Issue 546)**:
  1. Ignore stale snapshots where `confirmedStep < lastConfirmedStep`.
  2. If `confirmedStep === lastConfirmedStep`, treat the snapshot as idempotent; only rollback if the checksum differs.
  3. If the local checksum history does not include `confirmedStep`, resync immediately (treat as prediction window overflow).
  4. Compute server checksum and compare to local checksum stored for `confirmedStep`.
  5. If checksums match: drop pending commands at or before `confirmedStep` and advance confirmed pointer.
  6. If checksums differ: trigger rollback and replay.

- **Rollback and Replay (Issue 546)**:
  - Restoration is built on state-sync snapshot restore and runtime wiring:
    - New helper `restoreGameRuntimeFromSnapshot` in `packages/core/src/state-sync/restore-runtime.ts` (proposed).
    - The helper composes `restoreFromSnapshot`, `createProgressionCoordinator`, `wireGameRuntime`, and system restore hooks (`packages/core/src/state-sync/restore.ts:188`, `packages/core/src/index.ts:904`, `packages/core/src/automation-system.ts:267`, `packages/core/src/transform-system.ts:1100`).
  - Replay flow:
    1. Restore authoritative snapshot to a fresh runtime wiring.
    2. Restore the authoritative command queue from the snapshot (included in `GameStateSnapshot.commandQueue`).
    3. Re-enqueue pending client commands with original step values where `step > confirmedStep`.
       - Commands at or before `confirmedStep` are dropped as confirmed.
       - Queue ordering remains deterministic via priority + timestamp + sequence (`packages/core/src/command-queue.ts:18`).
       - If the server provides a separate authoritative command stream, apply it before pending replay; otherwise disable prediction when snapshots are partial.
    4. Tick forward from `confirmedStep` to the prior local step using fixed-step ticks.
    5. Replace the active runtime wiring and emit a rollback telemetry event.

- **Runtime Restore Helper (Issue 546)**:
  - Proposed signature:
```typescript
export function restoreGameRuntimeFromSnapshot(options: {
  readonly content: NormalizedContentPack;
  readonly snapshot: GameStateSnapshot;
  readonly enableProduction?: boolean;
  readonly enableAutomation?: boolean;
  readonly enableTransforms?: boolean;
}): GameRuntimeWiring;
```
  - Implementation references:
    - Build resource definitions from `content.resources` (see mapping in `packages/core/src/progression-coordinator.ts:359`).
    - Use `restoreFromSnapshot` for runtime + resources (`packages/core/src/state-sync/restore.ts:188`).
    - Hydrate coordinator and restore automation/transform states with step rebasing (`packages/core/src/progression-coordinator-save.ts:331`, `packages/core/src/automation-system.ts:267`, `packages/core/src/transform-system.ts:1100`).

- **Event and Telemetry Behavior (Issue 546)**:
  - Emit telemetry events: `PredictionChecksumMatch`, `PredictionChecksumMismatch`, `PredictionRollback`, `PredictionResync`, `PredictionBufferOverflow` via `telemetry` (`packages/core/src/telemetry.ts:3`).
  - External observers should treat events emitted during replay as non-authoritative unless explicitly opted in; default to suppress external side effects during replay by wiring a no-op `EventPublisher` (mirrors replay safety in `CommandRecorder`, `packages/core/src/command-recorder.ts:79`).
  - Telemetry payloads SHOULD include `confirmedStep`, `localStep`, `pendingCommands`, `replayedSteps`, `snapshotVersion`, `runtimeVersion` (defaults to the core runtime version), `definitionDigest` (from resources), `queueSize`, and `replayDurationMs` for live debugging.

- **Configuration Defaults (Issue 546)**:
  - `maxPredictionSteps`: 50
  - `maxPendingCommands`: 1000
  - `checksumIntervalSteps`: 1
  - `snapshotHistorySteps`: 0 (checksums only, enable snapshots for debug)
  - `maxReplayStepsPerTick`: align with `maxStepsPerFrame`
  - Recommended server snapshot cadence: ~10 steps at `stepSizeMs = 100` (about 1s), and no more than half the prediction window to avoid history eviction.

### 6.3 Operational Considerations
- **Deployment**: Issue 546 is core-only and additive; no build or infrastructure changes.
- **Telemetry & Observability**: new prediction telemetry events plus existing diagnostics timelines for tick performance (`packages/core/src/diagnostics/runtime-diagnostics-controller.ts:699`).
- **Security & Compliance**: snapshots contain gameplay state, not PII; checksums are non-cryptographic and should not be used for authentication.
- **Versioning & Compatibility**:
  - Require `snapshot.version === 1` and reject/force resync on mismatch (`packages/core/src/state-sync/types.ts:1`).
  - Validate resource definition digest on restore; mismatch triggers resync or session rejection (`packages/core/src/resource-state.ts:1368`).
  - Transport should include `runtimeVersion` and `contentDigest` in the snapshot envelope for mixed-client compatibility; prediction should disable on incompatible versions (`packages/core/src/version.ts:1`).

## 7. Work Breakdown & Delivery Plan
### 7.1 Issue Map
Populate the table as the canonical source for downstream GitHub issues tied to Issue 546.

| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| feat(core): add PredictionManager interfaces for Issue 546 | Define prediction types, buffers, and exports | Runtime Prediction Agent | Design approval | Types exported; lint clean; Issue 546 API available |
| feat(core): implement prediction history and buffer for Issue 546 | Checksum history + pending command buffer | Runtime Prediction Agent | Prediction interfaces | Checksums recorded per step; buffers bounded |
| feat(core): add restoreGameRuntimeFromSnapshot helper for Issue 546 | Restore wiring from snapshot + content | State Sync Agent | State-sync APIs | Helper returns wiring with restored systems |
| feat(core): implement rollback and replay pipeline for Issue 546 | Apply server snapshots, rollback, replay | Runtime Prediction Agent | History + restore helper | Rollback replays pending commands; telemetry emitted |
| test(core): add prediction rollback tests for Issue 546 | Unit + stress tests | Testing Agent | Core implementation | Tests pass; `pnpm test --filter @idle-engine/core` |
| docs(core): document prediction usage for Issue 546 | Usage notes + API reference | Docs Agent | Implementation | Docs merged; references updated |

### 7.2 Milestones
- **Phase 1 (Issue 546)**: Prediction interfaces, history buffer, and exports in core.
- **Phase 2 (Issue 546)**: Runtime restore helper and rollback/replay pipeline.
- **Phase 3 (Issue 546)**: Tests, telemetry, and documentation updates.

### 7.3 Coordination Notes
- **Hand-off Package**:
  - `packages/core/src/index.ts:804` (runtime wiring)
  - `packages/core/src/state-sync/*` (snapshot, checksum, restore)
  - `packages/core/src/command-queue.ts` (command ordering)
  - `packages/core/src/command-transport.ts` (requestId semantics)
  - `docs/state-synchronization-protocol-design.md`
- **Communication Cadence**:
  - Issue 546 status updates per PR, with a rollback test checkpoint before merge.

## 8. Agent Guidance & Guardrails
- **Context Packets**:
  - `packages/core/src/index.ts` (runtime wiring and step semantics)
  - `packages/core/src/state-sync/capture.ts` and `packages/core/src/state-sync/restore.ts`
  - `packages/core/src/command-queue.ts`
  - `packages/core/src/automation-system.ts` and `packages/core/src/transform-system.ts`
  - `docs/state-synchronization-protocol-design.md`
  - `docs/runtime-command-transport-design-issue-545.md`
- **Prompting & Constraints**:
  - "You are the Runtime Prediction Agent for Issue 546. Implement PredictionManager in `packages/core`, use type-only imports, preserve deterministic replay, and export new APIs from `packages/core/src/index.ts`."
  - "Use `captureGameStateSnapshot` and `computeStateChecksum` for reconciliation; do not introduce non-deterministic hashing."
  - "Maintain command step stamping with `runtime.getNextExecutableStep()`."
- **Safety Rails**:
  - Do not modify `dist/` outputs or save format schemas.
  - Do not introduce network dependencies in `packages/core`.
  - Do not emit console output from tests that could corrupt Vitest JSON reporting.
  - Do not use `Date.now()` in checksums or determinism-critical paths.
  - Do not reset git history or force push.
- **Validation Hooks**:
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test --filter @idle-engine/core`

## 9. Alternatives Considered
- **Always resync without prediction**:
  - Pros: Simplest implementation.
  - Cons: Violates Issue 546 latency requirements and blocks local input.
- **Use CommandRecorder for prediction replay**:
  - Pros: Reuses replay machinery (`packages/core/src/command-recorder.ts:393`).
  - Cons: Recorder is optimized for offline replay logs, not rolling prediction windows.
- **Store full snapshots per step**:
  - Pros: Simplifies debug diffing.
  - Cons: High memory cost; not aligned with Issue 546 bounded memory goals.

## 10. Testing & Validation Plan
- **Unit / Integration (Issue 546)**:
  - Predict-then-confirm: checksum match drops pending buffer with no rollback.
  - Predict-then-mismatch: rollback restores snapshot and replays commands deterministically.
  - Pending buffer overflow triggers resync fallback.
  - RequestId preservation across rollback and replay (`packages/core/src/command.ts:18`).
- **Performance**:
  - Validate checksum and restore budgets from state-sync design remain within limits.
  - Record replay duration per rollback and ensure it stays below one frame at configured cadence.
- **Tooling / A11y**:
  - Not applicable for Issue 546 (runtime-only feature).

## 11. Risks & Mitigations
| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Replay determinism drift | High | Medium | Use state-sync snapshots + RNG restore; add property tests (`packages/core/src/__tests__/state-sync.property.test.ts:31`). |
| Prediction window overflow | Medium | Medium | Bound pending commands and enforce resync fallback. |
| Snapshot step mismatch | Medium | Low | Reject stale snapshots; emit telemetry for diagnostics. |
| Event side effects during replay | Medium | Medium | Use a no-op `EventPublisher` during replay by default; require explicit opt-in for side effects. |
| Performance regression | Medium | Low | Track replay time via telemetry; keep checksum history lightweight. |

## 12. Rollout Plan
- **Milestones (Issue 546)**:
  1. Ship PredictionManager API and internal buffers (core-only).
  2. Add rollback/replay integration with runtime restore helper.
  3. Add tests, telemetry, and documentation updates.
- **Migration Strategy**:
  - Additive API; existing single-player flows remain unchanged.
- **Communication**:
  - Announce new prediction APIs in release notes and link Issue 546 design doc.

## 13. Resolved Decisions
- Rollback rebuilds runtime wiring using snapshot restore helpers; there is no step-reset API on `IdleEngineRuntime` (`packages/core/src/state-sync/restore.ts:188`, `packages/core/src/index.ts:904`).
- Server snapshots are expected to include command queue state (`GameStateSnapshot.commandQueue`) for authoritative reconciliation; if partial snapshots are used, prediction is disabled until a full resync is applied (`packages/core/src/state-sync/types.ts:7`).
- External event observers are suppressed during replay by default; replay uses a no-op event publisher unless explicitly configured (`packages/core/src/command-recorder.ts:79`).
- Recommended snapshot cadence is ~1s (10 steps at `DEFAULT_STEP_MS = 100`), capped at half the prediction window to avoid history eviction (`packages/core/src/index.ts:110`).

## 14. Follow-Up Work
- Integrate Issue 546 with transport-level acknowledgments and pending tracking (Issue 545).
- Add optional debug mode to store local snapshots for diffing on mismatch.
- Extend prediction to support partial snapshot validation via `computePartialChecksum` (`packages/core/src/state-sync/checksum.ts:79`).
- Provide a replay-safe UI notification pipeline to avoid double firing on rollback.

## 15. References
- `packages/core/src/index.ts:132` - `IdleEngineRuntime` tick loop and step stamping
- `packages/core/src/command-queue.ts:18` - Command queue ordering and serialization
- `packages/core/src/state-sync/capture.ts:13` - Snapshot capture API
- `packages/core/src/state-sync/checksum.ts:56` - Checksum computation
- `packages/core/src/state-sync/compare.ts:965` - State diffing
- `packages/core/src/state-sync/restore.ts:188` - Snapshot restore
- `packages/core/src/automation-system.ts:267` - Automation state restore with step rebase
- `packages/core/src/transform-system.ts:1100` - Transform state restore with step rebase
- `packages/core/src/command-transport.ts:1` - RequestId and command envelopes
- `docs/state-synchronization-protocol-design.md` - State sync foundation
- `docs/runtime-command-transport-design-issue-545.md` - Transport layer scope separation
- https://github.com/hansjm10/Idle-Game-Engine/issues/546

## Appendix A - Glossary
- **Prediction buffer**: The ordered list of local commands not yet confirmed by the server in Issue 546.
- **Rollback**: Restoring to the last authoritative snapshot and replaying pending commands for Issue 546.
- **Confirmed step**: The server-authoritative step number that the client uses to prune prediction history in Issue 546.
- **Prediction window**: The maximum number of steps or commands stored for Issue 546 reconciliation.
- **Replay**: Deterministic re-execution of pending commands after rollback.

## Appendix B - Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2025-12-28 | Codex | Resolve review feedback on authority, reconciliation, replay safety, and compatibility |
| 2025-12-28 | Codex | Initial Issue 546 design draft |
