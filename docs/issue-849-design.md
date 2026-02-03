---
title: "shell-desktop: centralize sim-worker protocol types (Issue 849)"
sidebar_position: 99
---

# shell-desktop: centralize sim-worker protocol types (Issue 849)

## Document Control
- **Title**: Centralize sim-worker protocol types to prevent drift
- **Authors**: Codex (AI)
- **Reviewers**: @hansjm10
- **Status**: Draft
- **Last Updated**: 2026-02-03
- **Related Issues**: https://github.com/hansjm10/Idle-Game-Engine/issues/849
- **Execution Mode**: AI-led

## 1. Summary
`@idle-engine/shell-desktop` currently defines the sim-worker message protocol in multiple places (`main.ts`, `sim-worker.ts`, and tests), which has led to protocol drift (`frames` vs `frame`) and dead branches in the main process. This design centralizes the protocol in a single shared module (`packages/shell-desktop/src/sim/worker-protocol.ts`), standardizes the outbound frame payload to the existing coalesced `frame` message (with `droppedFrames`), and updates main/worker/tests to import the shared types so future changes cannot silently diverge.

## 2. Context & Problem Statement
- **Background**:
  - The desktop shell’s sim runs in a Node worker thread (`packages/shell-desktop/src/sim-worker.ts`) and communicates with the main process (`packages/shell-desktop/src/main.ts`) using `worker_threads` message passing.
  - Recent refactors (e.g., frame coalescing in the worker) changed runtime behavior but did not fully converge the protocol types used in main/worker/tests.
- **Problem**:
  - `packages/shell-desktop/src/main.ts` defines an outbound message variant `{ kind: 'frames', frames: RenderCommandBuffer[], nextStep }` and contains a handler branch for it, but `packages/shell-desktop/src/sim-worker.ts` never emits it (only `{ kind: 'frame', frame?, droppedFrames, nextStep }`).
  - `packages/shell-desktop/src/main.test.ts` still simulates both `frames` and `frame`, masking dead code paths and allowing drift to persist.
  - This drift is brittle: it can hide broken behavior behind branches that are never exercised in production.
- **Forces**:
  - Keep the sim loop deterministic and the protocol stable within the package.
  - Maintain the current worker behavior (coalesced `frame` output) unless there is a compelling reason to reintroduce `frames`.
  - Enforce type consistency without introducing runtime dependencies or circular imports.

## 3. Goals & Non-Goals
- **Goals**:
  - Define sim-worker inbound/outbound message types in exactly one module and reuse them from the main process, worker, and tests.
  - Choose a single outbound “frame delivery” shape and remove dead branches in `packages/shell-desktop/src/main.ts`.
  - Keep the chosen protocol explicit and test-covered so future changes require coordinated updates.
  - Ensure `pnpm test --filter @idle-engine/shell-desktop` passes after implementation.
- **Non-Goals**:
  - Changing simulation semantics (tick scheduling, frame generation, or command processing) beyond protocol type consolidation.
  - Redesigning the renderer IPC surface (`IPC_CHANNELS.frame`, `IPC_CHANNELS.simStatus`).
  - Introducing a cross-package protocol dependency (this remains internal to `@idle-engine/shell-desktop`).

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**:
  - Desktop shell maintainers (`packages/shell-desktop`)
  - Runtime integration/test maintainers (tests in `packages/shell-desktop`)
- **Agent Roles**:
  - **Runtime/Shell Implementation Agent**: Create the shared protocol module and migrate main/worker code to import it.
  - **Test Agent**: Update unit tests to use the shared protocol and remove coverage for deleted protocol variants.
  - **Docs Agent**: Keep this document and code references accurate during review.
- **Affected Packages/Services**:
  - `packages/shell-desktop` only:
    - `packages/shell-desktop/src/main.ts`
    - `packages/shell-desktop/src/sim-worker.ts`
    - `packages/shell-desktop/src/main.test.ts`
    - `packages/shell-desktop/src/sim-worker.test.ts` (type imports)
    - New: `packages/shell-desktop/src/sim/worker-protocol.ts`
- **Compatibility Considerations**:
  - This is an internal protocol inside the packaged desktop app; main and worker are shipped together, so removing `frames` does not introduce a compatibility matrix across releases.
  - During development with hot reload, ensure both the worker script (`sim-worker.js`) and main process code are rebuilt together; the protocol module helps make divergence less likely.

## 5. Current State
- `packages/shell-desktop/src/main.ts` declares:
  - Inbound: `init`, `tick`, `enqueueCommands`.
  - Outbound: `ready`, `frames`, `frame`, `error`.
  - Runtime handler branches for `frames` and `frame` (both forward the last frame to `IPC_CHANNELS.frame`).
- `packages/shell-desktop/src/sim-worker.ts` declares its own protocol types:
  - Inbound: `init`, `tick`, `enqueueCommands`, `shutdown`.
  - Outbound: `ready`, `frame`, `error`.
  - On `tick`, it computes `droppedFrames = max(0, frames.length - 1)` and emits a single coalesced `frame` message with the last frame (or no `frame` field when none were produced).
- `packages/shell-desktop/src/main.test.ts` still simulates `frames` messages even though they are never emitted by the worker implementation.

## 6. Proposed Solution
### 6.1 Architecture Overview
- Add a shared protocol module within `@idle-engine/shell-desktop`: `packages/shell-desktop/src/sim/worker-protocol.ts`.
- Move all sim-worker message type definitions into this module.
- Standardize the outbound “frame delivery” message to the existing coalesced `frame` shape:
  - `{ kind: 'frame', frame?: RenderCommandBuffer, droppedFrames: number, nextStep: number }`
- Remove the `frames` message shape from the protocol and delete the corresponding handler branch in `main.ts`.
- Update `main.ts`, `sim-worker.ts`, and tests to import the shared message types.

### 6.2 Detailed Design
- **Runtime Changes**:
  - No changes to sim runtime behavior.
  - No changes to tick scheduling or coalescing logic; only type consolidation and dead-branch removal.
- **Data & Schemas**: N/A (no persisted data changes).
- **APIs & Contracts**:
  - New internal module: `packages/shell-desktop/src/sim/worker-protocol.ts`.
  - Contract definitions (TypeScript, structural at runtime):
    - Inbound messages (main -> worker):
      - `SimWorkerInitMessage`: `{ kind: 'init', stepSizeMs?: number, maxStepsPerFrame?: number }`
      - `SimWorkerTickMessage`: `{ kind: 'tick', deltaMs: number }`
      - `SimWorkerEnqueueCommandsMessage`: `{ kind: 'enqueueCommands', commands: readonly Command[] }`
      - `SimWorkerShutdownMessage`: `{ kind: 'shutdown' }` (currently used by `sim-worker.test.ts`; main process does not need to send it yet)
      - `SimWorkerInboundMessage`: union of the above.
    - Outbound messages (worker -> main):
      - `SimWorkerReadyMessage`: `{ kind: 'ready', stepSizeMs: number, nextStep: number }`
      - `SimWorkerFrameMessage`: `{ kind: 'frame', frame?: RenderCommandBuffer, droppedFrames: number, nextStep: number }`
      - `SimWorkerErrorMessage`: `{ kind: 'error', error: string }`
      - `SimWorkerOutboundMessage`: union of the above.
  - Implementation notes:
    - Use `import type { ... }` for type-only imports (`Command`, `RenderCommandBuffer`) to satisfy `@typescript-eslint/consistent-type-imports`.
    - Keep local imports using `.js` specifiers (consistent with existing `packages/shell-desktop/src/*` patterns), e.g. `import type { SimWorkerOutboundMessage } from './sim/worker-protocol.js'`.
    - `main.ts` must not include any `kind === 'frames'` branch after migration; `SimWorkerFramesMessage` must not exist.
- **Tooling & Automation**:
  - No new tooling required. Ensure the package test suite still runs under existing Vitest config.

### 6.3 Operational Considerations
- **Deployment**: No special deployment considerations; this is packaged with the desktop app.
- **Telemetry & Observability**:
  - Keep existing error logging behavior in `main.ts` and `sim-worker.ts` unchanged.
  - No additional console logging should be introduced (tests rely on clean output).
- **Security & Compliance**:
  - No new external inputs or PII surfaces are introduced.
  - Message parsing continues to treat untrusted payloads defensively (existing `typeof message === 'object'` checks in `sim-worker.ts` remain).

## 7. Work Breakdown & Delivery Plan
### 7.1 Issue Map
| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| feat(shell-desktop): add shared sim-worker protocol module | Introduce `worker-protocol.ts` defining inbound/outbound message types | Runtime/Shell Implementation Agent | Doc approved | Module added; exports cover all used message kinds; no `frames` type in protocol |
| refactor(shell-desktop): migrate main/worker to shared protocol | Replace inline protocol type declarations with imports; delete `frames` handler branch | Runtime/Shell Implementation Agent | Shared module merged | `main.ts` no longer references `frames`; `sim-worker.ts` uses shared types; build passes |
| test(shell-desktop): update protocol tests | Remove `frames` simulations; update tests to compile against shared protocol types | Test Agent | Main/worker migration merged | `pnpm test --filter @idle-engine/shell-desktop` passes; no `frames` message remains in tests |

### 7.2 Milestones
- **Phase 1**: Implement shared protocol module + migrate main/worker + update tests (single PR).
- **Phase 2**: (Optional follow-up) Add runtime-level validation helpers (type guards) if future protocol expansion warrants stricter checks.

### 7.3 Coordination Notes
- **Hand-off Package**:
  - Files to modify:
    - `packages/shell-desktop/src/sim/worker-protocol.ts` (new)
    - `packages/shell-desktop/src/main.ts`
    - `packages/shell-desktop/src/sim-worker.ts`
    - `packages/shell-desktop/src/main.test.ts`
    - `packages/shell-desktop/src/sim-worker.test.ts` (optional: type imports)
  - Core behavioral constraint: keep worker’s coalesced `frame` behavior unchanged.
- **Communication Cadence**: Request review after tests pass for `@idle-engine/shell-desktop`.

## 8. Agent Guidance & Guardrails
- **Context Packets**:
  - GitHub issue: #849
  - Source files: `packages/shell-desktop/src/main.ts`, `packages/shell-desktop/src/sim-worker.ts`
  - Tests: `packages/shell-desktop/src/main.test.ts`, `packages/shell-desktop/src/sim-worker.test.ts`
- **Prompting & Constraints**:
  - Keep TypeScript style consistent: ES modules, two-space indentation, `import type` usage.
  - Do not edit generated `dist/` outputs.
  - Avoid expanding scope to renderer IPC or runtime internals.
- **Safety Rails**:
  - Do not introduce new runtime logging beyond existing `console.error` sites.
  - Avoid changing tick-loop timing or message ordering semantics.
- **Validation Hooks**:
  - `pnpm test --filter @idle-engine/shell-desktop`
  - (Optional) `pnpm lint --filter @idle-engine/shell-desktop` if available in workspace scripts.

## 9. Alternatives Considered
- **Keep both `frames` and `frame` variants**:
  - Pros: could support bulk frame delivery for debugging.
  - Cons: increases surface area, encourages drift, and requires additional tests and runtime branches; violates the issue’s “no dead branch” goal.
- **Reintroduce `frames` intentionally (worker emits `frames`)**:
  - Pros: more explicit about multiple frames per tick.
  - Cons: renderer only needs the latest frame; the existing worker already computes `droppedFrames` and provides a coalesced shape; switching back would increase message size and introduce additional main-process logic.
- **Move protocol types into `ipc.ts`**:
  - Pros: fewer files.
  - Cons: mixes renderer IPC surface with worker protocol; increases coupling and makes it harder to evolve independently.

## 10. Testing & Validation Plan
- **Unit / Integration**:
  - Update `packages/shell-desktop/src/main.test.ts`:
    - Remove cases that emit `{ kind: 'frames', ... }`.
    - Ensure forwarding behavior is still covered for `frame` messages:
      - When `frame` is present, main forwards it to `IPC_CHANNELS.frame`.
      - When `frame` is absent, main does not send any frame IPC.
      - When forwarding throws, main logs an error (existing test remains valid).
  - Update `packages/shell-desktop/src/sim-worker.test.ts` (optional type coverage):
    - Import protocol types for message payloads to ensure compile-time contract adherence.
    - Keep runtime behavior assertions unchanged (ready, frame coalescing, error emission).
- **Performance**: N/A (no algorithmic changes).
- **Tooling / A11y**: N/A.

## 11. Risks & Mitigations
- **Risk**: Removing `frames` breaks any hidden callers relying on that shape.
  - **Mitigation**: `frames` is not emitted by the worker implementation; update tests to match production behavior and keep the protocol internal to the package.
- **Risk**: TS-only refactor accidentally changes runtime payload shapes.
  - **Mitigation**: Keep runtime emit sites unchanged; validate with existing unit tests; ensure message shapes in tests match actual worker emissions.
- **Risk**: Future protocol additions drift again.
  - **Mitigation**: Require all additions to go through `worker-protocol.ts` and update main/worker/tests by importing from it.

## 12. Rollout Plan
- **Milestones**: Single PR landing with protocol module + refactor + test updates.
- **Migration Strategy**: N/A (internal protocol shipped together).
- **Communication**: Mention in PR description that `frames` was removed as dead code and that `frame` is the canonical outbound message.

## 13. Open Questions
- Should the shared protocol explicitly include `shutdown` as a supported main->worker message (even though the main process does not currently send it), or should `sim-worker.test.ts` be updated to treat it as an internal-only message?
- Should `SimWorkerInitMessage.stepSizeMs` / `maxStepsPerFrame` be required in the protocol (matching main’s usage) or remain optional (matching worker flexibility)?

## 14. Follow-Up Work
- Add optional runtime type-guard helpers (e.g., `isSimWorkerOutboundMessage`) if future debugging indicates malformed messages are a recurring source of crashes.

## 15. References
- GitHub issue: https://github.com/hansjm10/Idle-Game-Engine/issues/849
- `packages/shell-desktop/src/main.ts` (sim worker protocol types and message handler branches)
- `packages/shell-desktop/src/sim-worker.ts` (current worker emission uses `kind: 'frame'` only)
- `packages/shell-desktop/src/main.test.ts` (tests currently simulate both `frames` and `frame`)

## Appendix A — Glossary
- **Coalesced frame**: A protocol behavior where the worker may produce multiple render frames per tick but only sends the latest frame (plus a `droppedFrames` count) to avoid flooding the main/renderer.
- **Protocol drift**: When message type definitions used by different components diverge over time without coordinated changes.

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2026-02-03 | Codex (AI) | Initial draft |

