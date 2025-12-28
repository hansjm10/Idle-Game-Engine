---
title: Runtime Command Transport Design (Issue 545)
sidebar_position: 4
---

# Runtime Command Transport Design (Issue 545)

## Document Control
- **Title**: Introduce command transport envelope, responses, and idempotency for Issue 545
- **Authors**: TODO (Owner: Runtime Core Maintainer)
- **Reviewers**: TODO (Owner: Runtime Core Maintainers)
- **Status**: Draft
- **Last Updated**: 2025-12-27
- **Related Issues**: https://github.com/hansjm10/Idle-Game-Engine/issues/545, https://github.com/hansjm10/Idle-Game-Engine/issues/666
- **Execution Mode**: AI-led

## 1. Summary
Issue 545 defines a command transport layer that wraps runtime commands in a network-ready envelope, produces authoritative acknowledgments or rejections, and enforces idempotency with client-side pending tracking so networked command execution can be built without altering Idle Engine determinism.

## 2. Context & Problem Statement
- **Background**: Issue 545 builds on the existing command model with optional request identifiers (`packages/core/src/command.ts:18`), deterministic queueing and serialization (`packages/core/src/command-queue.ts:33`, `packages/core/src/command-queue.ts:207`), and dispatcher error reporting (`packages/core/src/command-dispatcher.ts:7`), while state sync documentation explicitly defers transport (`docs/state-synchronization-protocol-design.md`).
- **Problem**: Issue 545 highlights missing transport primitives: no command envelope with `clientId`/`requestId`, no acknowledgment or rejection response protocol, no idempotency registry, and no client-side pending tracker.
- **Forces**: Issue 545 must preserve deterministic tick execution, remain transport-agnostic inside `packages/core`, avoid breaking existing command serialization, and keep tests stable for `pnpm test --filter @idle-engine/core`.

## 3. Goals & Non-Goals
- **Goals**: Issue 545 will define `CommandEnvelope` and `CommandResponse` types, add an idempotency registry with configurable retention, add a pending command tracker for acknowledgments and timeouts, and deliver acceptance tests for accepted, rejected, and duplicate flows.
- **Non-Goals**: Issue 545 does not implement WebSocket/HTTP transports, authentication, compression, client prediction, or changes to the deterministic queue semantics.

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**: Issue 545 is owned by Runtime Core maintainers, with Shell maintainers and QA as secondary stakeholders.
- **Agent Roles**:

| Agent | Responsibilities |
|-------|------------------|
| Transport Protocol Agent | Define Issue 545 transport types, registries, and exports. |
| Runtime Implementation Agent | Integrate Issue 545 outcomes and server adapter hooks in `packages/core`. |
| Testing Agent | Add Issue 545 unit and integration coverage. |
| Docs Agent | Maintain Issue 545 documentation and references. |

- **Affected Packages/Services**: Issue 545 impacts `packages/core` and related runtime-facing docs under `docs/`.
- **Compatibility Considerations**: Issue 545 APIs are additive, `Command.requestId` remains optional for local commands (`packages/core/src/command.ts:18`), and serialized command queue formats remain unchanged (`packages/core/src/command-queue.ts:207`).

## 5. Current State
Issue 545 starts from a runtime that queues and serializes commands without transport metadata (`packages/core/src/command-queue.ts:207`), uses `CommandError` for failures (`packages/core/src/command-dispatcher.ts:7`), and exposes only failure draining (`packages/core/src/index.ts:237`). There is no idempotency registry, no pending command tracker, and no integration tests for request/response flows beyond queue unit tests (`packages/core/src/command-queue.test.ts:39`).

## 6. Proposed Solution
### 6.1 Architecture Overview
- **Narrative**: Issue 545 adds a transport protocol layer that wraps serialized commands in an envelope, routes them through an idempotency registry and server adapter, and returns an acknowledgment or rejection response while leaving deterministic runtime execution unchanged.
- **Diagram**:
```text
Client                         Transport Layer                          Server
--------------  CommandEnvelope  -----------------------  CommandEnvelope  -----------------
Runtime UI   -> Pending Tracker -> Network Adapter   ->  Transport Server -> Idle Runtime
Runtime UI   <- CommandResponse <- Pending Tracker <-    Idempotency Reg  <- CommandQueue
--------------                  -----------------------                  -----------------
```

### 6.2 Detailed Design
- **Runtime Changes**: Issue 545 adds a `CommandExecutionOutcome` stream (success or failure with `requestId`, `serverStep` for the execution step, and `CommandError`) and a `drainCommandOutcomes()` API alongside `drainCommandFailures()` (`packages/core/src/index.ts:237`). The transport server uses these outcomes to finalize responses without changing command queue order (`packages/core/src/command-queue.ts:74`) and serializes `CommandError` into a JSON-safe transport error.
- **Data & Schemas**: Issue 545 introduces a JSON-safe `SerializedCommand` and transport wrappers aligned with existing payload serialization (`packages/core/src/command-queue.ts:33`). `CommandResponse.serverStep` records the server enqueue step (acknowledgment), not the execution step.
```typescript
export type SerializedCommand = Readonly<{
  readonly type: string;
  readonly priority: CommandPriority;
  readonly timestamp: number;
  readonly step: number;
  readonly payload: JsonValue;
  readonly requestId?: string;
}>;

export interface CommandEnvelope {
  readonly requestId: string;
  readonly clientId: string;
  readonly command: SerializedCommand;
  readonly sentAt: number;
}

export type CommandResponseError = Readonly<{
  readonly code: string;
  readonly message: string;
  readonly details?: JsonValue;
}>;

export interface CommandResponse {
  readonly requestId: string;
  readonly status: 'accepted' | 'rejected' | 'duplicate';
  readonly serverStep: number;
  readonly error?: CommandResponseError;
}
```
- **APIs & Contracts**: Issue 545 adds idempotency and pending tracking interfaces with deterministic, in-memory implementations.
```typescript
export interface IdempotencyRegistry {
  get(key: string): CommandResponse | undefined;
  record(key: string, response: CommandResponse, expiresAt: number): void;
  purgeExpired(now: number): void;
  size(): number;
}

export interface PendingCommandTracker {
  track(envelope: CommandEnvelope): void;
  resolve(response: CommandResponse): void;
  expire(now: number): CommandEnvelope[];
  getPending(): readonly CommandEnvelope[];
}
```
- **Tooling & Automation**: Issue 545 exports transport types and helpers from `packages/core/src/index.ts`, adds unit/integration tests in `packages/core/src`, and updates docs references in `docs/`.

### 6.3 Operational Considerations
- **Deployment**: Issue 545 is additive and requires no runtime deployment changes.
- **Telemetry & Observability**: Issue 545 adds telemetry events for duplicate requests and timeouts without logging payload contents.
- **Security & Compliance**: Issue 545 validates `clientId`/`requestId` length and format, and scopes idempotency keys to `{clientId, requestId}`.

### 6.4 Usage Guidance (Initial)
- **When to use**: Apply the transport protocol when commands originate outside the runtime process (networked client, multi-process shell). Local-only commands can enqueue directly without envelopes.
- **Envelope creation**: Wrap commands in `CommandEnvelope` with stable `clientId`, unique `requestId` per client, and `sentAt` for observability; keep payloads JSON-safe via `SerializedCommand`.
- **Server handling**: Validate identifiers, check the idempotency registry by `{clientId, requestId}`, return cached `duplicate` responses, and record `accepted` responses keyed to the enqueue `serverStep`; return `rejected` with `CommandResponseError` for invalid requests.
- **Server adapter example**:
  ```ts
  const server = createCommandTransportServer({
    commandQueue,
    getNextExecutableStep: () => runtime.getNextExecutableStep(),
    drainCommandOutcomes: () => runtime.drainCommandOutcomes(),
  });

  const response = server.handleEnvelope(envelope);
  const outcomes = server.drainOutcomeResponses();
  ```
- **Client handling**: Track pending envelopes, resolve on `CommandResponse`, and expire/retry based on configured timeouts using the pending tracker.
- **Defaults**: Recommend `DEFAULT_IDEMPOTENCY_TTL_MS = 5 * 60 * 1000` and `DEFAULT_PENDING_COMMAND_TIMEOUT_MS = 30 * 1000`; tune per transport latency and retry strategy.
- **Related runtime guidance**: A runtime-facing stub lives in [Runtime Command Queue Design](./runtime-command-queue-design.md) for quick discovery and links back here for full protocol details.

## 7. Work Breakdown & Delivery Plan
### 7.1 Issue Map
| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| feat(core): add transport types for Issue 545 | Define `SerializedCommand`, `CommandEnvelope`, `CommandResponse` and exports | Transport Protocol Agent | Design approval | Types exported; lint clean; `pnpm test --filter @idle-engine/core` passes |
| feat(core): add idempotency registry for Issue 545 | Implement registry interface + default in-memory registry | Runtime Implementation Agent | Transport types | Registry handles duplicates with TTL; unit tests added |
| feat(core): add pending command tracker for Issue 545 | Implement client-side tracker for in-flight commands | Runtime Implementation Agent | Transport types | Timeouts tracked; retry hooks defined; unit tests added |
| feat(core): add command outcome drain for Issue 545 | Expose success/failure outcomes with requestId | Runtime Implementation Agent | Transport types | `drainCommandOutcomes()` returns accepted/rejected outcomes; tests updated |
| feat(core): add transport server adapter for Issue 545 | Convert envelopes to runtime commands and responses | Transport Protocol Agent | Registry + outcomes | Accept/reject/duplicate behavior verified; integration tests added |
| test(core): cover transport flows for Issue 545 | Add accept/reject/duplicate integration tests | Testing Agent | Server adapter | Tests added for ack, rejection, duplicate; `pnpm test --filter @idle-engine/core` passes |

### 7.2 Milestones
- **Phase 1**: Issue 545 transport types, registry, and pending tracker implemented and tested.
- **Phase 2**: Issue 545 runtime outcomes, server adapter, and integration tests completed.

### 7.3 Coordination Notes
- **Hand-off Package**: Issue 545 context includes `docs/runtime-command-queue-design.md`, `docs/state-synchronization-protocol-design.md`, `packages/core/src/command.ts:18`, `packages/core/src/command-dispatcher.ts:7`.
- **Communication Cadence**: Issue 545 status updates daily until Phase 2 completion, with a review checkpoint after Phase 1.

## 8. Agent Guidance & Guardrails
- **Context Packets**: Issue 545 agents must load `packages/core/src/command.ts`, `packages/core/src/command-queue.ts`, `packages/core/src/command-dispatcher.ts`, `packages/core/src/index.ts`, and `docs/state-synchronization-protocol-design.md`.
- **Prompting & Constraints**: Issue 545 agent prompt example: "You are the Runtime Implementation Agent for Issue 545. Implement idempotency registry and pending tracker in `packages/core`, use type-only imports, do not alter command queue ordering, and run `pnpm test --filter @idle-engine/core`."
- **Safety Rails**: Issue 545 agents must not edit `dist/` outputs, must avoid console output that could disrupt Vitest JSON reporting, and must not add network dependencies to `packages/core`.
- **Validation Hooks**: Issue 545 completion requires `pnpm lint` and `pnpm test --filter @idle-engine/core`.

## 9. Alternatives Considered
Issue 545 alternatives considered:
- Implement transport in shell code only (rejected: fragments protocol definitions and reduces test coverage).
- Extend command queue serialization to serve as transport (rejected: lacks acknowledgment and idempotency semantics).
- Use state sync snapshots for command delivery (rejected: excessive bandwidth and mismatch with request/response flows).

## 10. Testing & Validation Plan
- **Unit / Integration**: Issue 545 adds unit tests for idempotency registry and pending tracker plus integration tests for accept, reject, and duplicate flows.
- **Performance**: Issue 545 validates O(1) average registry operations and TTL eviction behavior.
- **Tooling / A11y**: Issue 545 has no UI surface, so accessibility validation is not applicable.

## 11. Risks & Mitigations
Issue 545 risks and mitigations:
- Duplicate requestId collisions across clients lead to incorrect responses. Mitigation: scope registry keys by `{clientId, requestId}` and validate input formats.
- Pending tracker leaks entries when no response arrives. Mitigation: require timeout eviction and expose pending counts for diagnostics.
- Command rejection lacks explicit error payload. Mitigation: standardize rejection errors using `CommandError` (`packages/core/src/command-dispatcher.ts:7`) and serialize to `CommandResponseError` for transport.

## 12. Rollout Plan
- **Milestones**: Issue 545 ships in two phases (types/registry first, adapter and tests second).
- **Migration Strategy**: Issue 545 introduces additive APIs with no data migration.
- **Communication**: Issue 545 release notes should link to this doc and reference issue 545 acceptance criteria.

## 13. Open Questions
- Resolved: default idempotency retention is 5 minutes and pending timeout is 30 seconds (both configurable).

## 14. Follow-Up Work
- Issue 545 follow-up: build concrete WebSocket/HTTP transport adapters in shell repos.
- Issue 545 follow-up: add metrics dashboards for transport acknowledgments.
- Issue 545 follow-up: evaluate batching/compression strategies for command envelopes.

## 15. References
- https://github.com/hansjm10/Idle-Game-Engine/issues/545
- `docs/runtime-command-queue-design.md`
- `docs/state-synchronization-protocol-design.md`
- `packages/core/src/command.ts:18`
- `packages/core/src/command.ts:230`
- `packages/core/src/command-queue.ts:33`
- `packages/core/src/command-queue.ts:207`
- `packages/core/src/command-dispatcher.ts:7`
- `packages/core/src/index.ts:237`
- `packages/core/src/command-queue.test.ts:39`

## Appendix A - Glossary
- **Issue 545 CommandEnvelope**: Transport wrapper containing `clientId`, `requestId`, `command`, and `sentAt`.
- **Issue 545 CommandResponse**: Server response with acceptance, rejection, or duplication status.
- **Issue 545 Idempotency Registry**: Server-side cache preventing duplicate command execution.
- **Issue 545 Pending Command Tracker**: Client-side tracker for in-flight command acknowledgments and timeouts.
- **Issue 545 SerializedCommand**: JSON-safe command payload used for transport.

## Appendix B - Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2025-12-27 | TODO (Owner: Runtime Core Maintainer) | Initial Issue 545 draft |
| 2025-12-27 | Codex | Clarify `CommandResponse.serverStep` as enqueue step |
| 2025-12-27 | Codex | Add initial transport usage guidance and runtime doc stub (Issue #677) |
