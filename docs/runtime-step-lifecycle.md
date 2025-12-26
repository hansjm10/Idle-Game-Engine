---
title: Runtime Step Lifecycle Alignment
---

# Runtime Step Lifecycle Alignment

This design document confirms implementation alignment with the command queue design specification. It cross-references runtime, systems, and UI sources to verify that commands are stamped consistently with the fixed-step lifecycle described in the runtime command queue design.

## Document Control
- **Title**: Runtime Step Lifecycle Alignment
- **Authors**: N/A
- **Reviewers**: N/A
- **Status**: Approved
- **Last Updated**: 2025-12-21
- **Related Issues**: N/A
- **Execution Mode**: Manual

## 1. Summary

This document verifies that the Idle Engine runtime implementation correctly follows the fixed-step lifecycle and command stamping protocol defined in the runtime command queue design (docs/runtime-command-queue-design.md). It confirms that the IdleEngineRuntime worker, Worker Bridge, and Presentation Shell all maintain proper step synchronization for deterministic command execution.

## 2. Context & Problem Statement

- **Background**: The runtime command queue design specification defines a deterministic fixed-step execution model where all commands must be stamped with appropriate step numbers to ensure reproducible game state progression. This document serves as verification that the implementation matches the design.

- **Problem**: Without proper step lifecycle management across the runtime, worker bridge, and UI layers, command execution could become non-deterministic, breaking offline progression, debugging, and testing scenarios.

- **Forces**: The system must maintain strict determinism while coordinating between untrusted UI code (player commands) and trusted worker systems (automation), all while keeping the presentation layer synchronized with internal tick progression.

## 3. Goals & Non-Goals

- **Goals**:
  - Verify IdleEngineRuntime manages currentStep/nextExecutableStep as specified
  - Confirm command ingress correctly stamps player commands
  - Validate presentation integrations maintain proper lifecycle synchronization
  - Ensure automation system uses deterministic timestamps
  - Document diagnostics timeline integration

- **Non-Goals**:
  - Redesigning the step lifecycle (this is verification only)
  - Performance optimization of the tick loop
  - Adding new command sources or priorities

## 4. Stakeholders, Agents & Impacted Surfaces

- **Primary Stakeholders**: Runtime team, QA
- **Agent Roles**: N/A (verification document)
- **Affected Packages/Services**:
  - `packages/core` (IdleEngineRuntime, automation system, diagnostics)
  - Presentation shell integrations (archived)
- **Compatibility Considerations**: Implementation must maintain backward compatibility with existing command queue behavior.

## 5. Current State

The implementation spans three key layers:

1. **IdleEngineRuntime (Worker)** - Core tick loop and step management
2. **Worker Bridge** - Security boundary and command stamping for UI commands
3. **Presentation Shell** - UI integration and state synchronization

All components implement the design specified in docs/runtime-command-queue-design.md §4.3.

## 6. Proposed Solution

### 6.1 Architecture Overview

**Narrative**: The runtime step lifecycle ensures deterministic command execution through a three-layer architecture. The IdleEngineRuntime manages authoritative step counters, the Worker Bridge acts as a security boundary for player commands, and the Presentation Shell provides UI integration without exposing internal state.

**Diagram**: Refer to runtime-command-queue-design.md for system architecture diagrams.

### 6.2 Detailed Design

#### IdleEngineRuntime (Worker)

**File**: `packages/core/src/index.ts`

The runtime manages `currentStep` / `nextExecutableStep` exactly as described in the design:

- The tick loop sets `nextExecutableStep = currentStep` before capturing the queue batch
- Advances to `currentStep + 1` as soon as the batch is secured
- Records a `CommandStepMismatch` telemetry event if a queued command is stamped for a different tick

**TickContext Integration**:
- `TickContext.step` surfaces the just-executed tick so internal systems stamp follow-up commands with `context.step + 1`
- This aligns system enqueues with the next tick boundary automatically

#### Worker Bridge

Acts as the security boundary for UI commands:

- Incoming messages are always treated as `PLAYER` priority
- Commands are stamped with the Worker's monotonic clock plus the runtime's `getNextExecutableStep()` value before entering the queue (per §7.2 of the command queue design)
- Systems running inside the Worker can enqueue with elevated priorities because they already execute within the trusted boundary
- The Worker runs the simulation loop on a fixed interval, forwarding the current step back to the UI so presentation code can confirm progression without accessing internal counters directly

#### Presentation Integrations (Archived)

The bridge exposes `sendCommand` that mirrors the design's `WorkerBridge` API (§7.1):

- Wraps UI commands with `CommandSource.PLAYER` and a UI-side timestamp
- Delegates actual step stamping to the Worker
- Presentation code consumes the bridge and reacts to state updates
- Keeps UI logic aligned with the Worker-driven tick lifecycle rather than assuming direct access to runtime internals

#### Automation System Timestamps

**File**: `packages/core/src/automation-system.ts`

The automation system enqueues commands using deterministic timestamps derived from `step * stepDurationMs` rather than wall-clock time (`Date.now()` or `performance.now()`).

**Benefits**:
- **Reproducibility**: Offline progression and catch-up simulations produce consistent results across different execution environments
- **Debugging**: Command recorder logs can be reliably replayed to reproduce issues without timing-dependent variations
- **Testing**: Integration tests verify deterministic behavior by comparing command timestamps across multiple runs

**Implementation**:
- The `enqueueAutomationCommand` function accepts `stepDurationMs` as a parameter
- Calculates `timestamp = currentStep * stepDurationMs` before enqueueing
- Aligns with the runtime's fixed-step tick lifecycle
- Ensures all automation commands use simulation time rather than real-world time

### 6.3 Operational Considerations

#### Diagnostics Timeline

**Configuration**:
- Enable diagnostics by providing `diagnostics: { timeline: { enabled: true } }` when constructing `IdleEngineRuntime`
- Or call `runtime.enableDiagnostics({ enabled: true })` mid-session
- The controller resolves budgets from the runtime configuration so thresholds stay consistent across hosts

**Usage**:

```ts
import { formatLatestDiagnosticTimelineEntry } from '@idle-engine/core/devtools/diagnostics';

const diagnostics = runtime.readDiagnosticsDelta();
const formatted = formatLatestDiagnosticTimelineEntry(diagnostics);
if (formatted) {
  console.info(formatted.message, formatted.context.entry);
}
```

**File**: `packages/core/src/devtools/diagnostics.ts`

The devtools helper `formatLatestDiagnosticTimelineEntry()` converts the most recent timeline entry into a console-friendly message while preserving full metadata for inspection.

**Telemetry Integration**:
- When the Prometheus telemetry adapter is active:
  - Slow ticks increment `runtime_ticks_over_budget_total`
  - Slow systems increment `runtime_system_slow_total{system_id="..."}`
  - Counters align with runtime warning thresholds

## 7. Work Breakdown & Delivery Plan

### 7.1 Issue Map

N/A - This is a verification document confirming existing implementation.

### 7.2 Milestones

N/A - Implementation already complete.

### 7.3 Coordination Notes

N/A - No active coordination required.

## 8. Agent Guidance & Guardrails

N/A - This is a verification document.

## 9. Alternatives Considered

N/A - This document verifies existing implementation rather than proposing alternatives.

## 10. Testing & Validation Plan

- **Unit / Integration**: Existing test suites verify deterministic command execution
- **Performance**: Diagnostics timeline tracks tick budget violations
- **Tooling / A11y**: N/A

## 11. Risks & Mitigations

**Risk**: Step counter desynchronization between layers could break determinism.

**Mitigation**:
- Worker Bridge always delegates step stamping to runtime's `getNextExecutableStep()`
- UI has no direct access to internal step counters
- Telemetry events track step mismatches

## 12. Rollout Plan

N/A - Implementation already deployed.

## 13. Open Questions

None - Implementation matches design specification.

## 14. Follow-Up Work

None identified.

## 15. References

- `docs/runtime-command-queue-design.md` - Primary design specification (§4.3, §7.1, §7.2)
- `packages/core/src/index.ts` - IdleEngineRuntime implementation
- Archived worker bridge harness (removed with presentation shell deprecation)
- `packages/core/src/automation-system.ts` - Automation timestamp handling
- `packages/core/src/devtools/diagnostics.ts` - Diagnostics utilities

## Appendix A — Glossary

- **Step**: A discrete simulation tick in the fixed-step execution model
- **currentStep**: The step number that was just executed
- **nextExecutableStep**: The step number for which commands are currently being accepted
- **TickContext**: Context object passed to systems during tick execution
- **Worker Bridge**: Security boundary between untrusted UI and trusted runtime
- **CommandStepMismatch**: Telemetry event indicating a command was stamped for the wrong tick

## Appendix B — Change Log

| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2025-12-21 | Claude Opus 4.5 | Migrated to design document template format |
