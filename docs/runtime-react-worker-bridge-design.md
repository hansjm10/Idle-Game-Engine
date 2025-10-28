# Implement Runtime->React Worker Bridge

Issue: #16 (implementation) / #251 (design doc) - Presentation Shell Workstream

## Document Control
- **Title**: Implement runtime->React Worker bridge
- **Authors**: Idle Engine Design Authoring Agent (AI)
- **Reviewers**: TODO (Presentation Shell Lead)
- **Status**: Draft
- **Last Updated**: 2025-10-27
- **Related Issues**: [#16](https://github.com/hansjm10/Idle-Game-Engine/issues/16), [#251](https://github.com/hansjm10/Idle-Game-Engine/issues/251)
- **Execution Mode**: AI-led

## 1. Summary
Responding to the directive "Create a design document for issue #16, use gh to find more about it," this plan formalises how we deliver a resilient Worker-mediated bridge from the deterministic runtime to the React presentation shell. Issue #16 ("Create Worker bridge for runtime -> React") requires hardened message contracts, lifecycle management, and diagnostics propagation so the shell can safely emit player commands and render authoritative state snapshots without compromising the runtime loop. The proposed architecture refines the existing worker prototype, codifies command and telemetry flows, and sequences AI-led execution to reach production readiness.

## 2. Context & Problem Statement
- **Background**: The implementation plan highlights the Presentation Shell workstream's dependency on a Worker channel to consume runtime snapshots (`docs/implementation-plan.md:18`). Prototype wiring already instantiates `IdleEngineRuntime` inside a dedicated worker (`packages/shell-web/src/runtime.worker.ts:74`) and exposes a hook-based bridge for React (`packages/shell-web/src/modules/worker-bridge.ts:181`). Architecture notes confirm the importance of keeping command stamping consistent with the fixed-step lifecycle (`docs/runtime-step-lifecycle.md:19`).
- **Problem**: Issue #16 lacks an approved design describing the Worker bridge contract, error handling, diagnostics handshake, and React integration boundaries. The current bridge prototype (`packages/shell-web/src/modules/worker-bridge.ts:63`) is functional but undocumented, omits replay protection, and hardcodes payload shapes that downstream agents cannot rely on. Without a sanctioned design, AI agents risk diverging implementations and UI regressions.
- **Forces**: The bridge must preserve runtime determinism, remain Vite/React compatible, expose diagnostics for performance tuning, and sustain long-lived sessions without memory leaks. Presentation increments depend on a stable API, while runtime owners require guardrails that prevent untrusted UI code from mutating engine state directly.

## 3. Goals & Non-Goals
- **Goals**
  - Publish an authoritative Worker message contract for issue #16 covering command, state, diagnostics, and lifecycle envelopes.
  - Ship a reusable React-facing bridge that enforces disposal, subscription control, and monotonic timestamps.
  - Provide diagnostics opt-in wiring so shell agents can enable the runtime timeline without polluting baseline runs.
  - Document operational runbooks for bundling, error surfacing, and testing under Vite-driven dev/CI workflows.
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
  - Maintain backward compatibility for command queue priorities and step stamping defined in `IdleEngineRuntime` (`packages/core/src/index.ts:82`).
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
  - Introduce a feature flag allowing fallback to legacy bridge until confidence is established.
  - Provide migration notes for agents touching UI components.
- **Communication**
  - Announce bridge availability in weekly status report; include testing commands.
  - Update onboarding documentation to reference new bridge once rollout completes.

## 13. Decisions Since Draft
- Worker-side errors now surface through a lightweight telemetry hook (`__IDLE_ENGINE_TELEMETRY__`) so hosts can forward incidents to their preferred sink without pulling Node-only dependencies into the browser bundle (`packages/shell-web/src/modules/worker-bridge.ts:126`).
- Presentation shells continue to consume content-pack events solely through the `STATE_UPDATE.state.events` array; no additional message envelopes are required for pack-defined channels.
- A resumable session handshake ships via the `RESTORE_SESSION` / `SESSION_RESTORED` messages and the `WorkerBridge.restoreSession()` helper so offline progression can hydrate state before UI commands resume.

## 14. Follow-Up Work
- Design persistent storage handoff between Worker and shell for save/load scenarios. Owner: TODO (Runtime Core Liaison).
- Integrate social-service command hooks after bridge stabilises. Owner: TODO (Social Services Lead).
- Produce developer tutorial documenting how to extend the bridge for custom commands. Owner: React Bridge Integration Agent (post-delivery).

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
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2025-10-27 | Idle Engine Design Authoring Agent (AI) | Initial draft for issue #16 bridge design |
