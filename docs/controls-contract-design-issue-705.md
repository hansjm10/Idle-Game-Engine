---
title: Controls Contract Design (Issue 705)
sidebar_position: 5
---

# Controls Contract Design (Issue 705)

## Document Control
- **Title**: Define controls contract package for Issue 705
- **Authors**: Codex (AI)
- **Reviewers**: TODO (Owner: Runtime Core Maintainers)
- **Status**: Draft
- **Last Updated**: 2025-12-30
- **Related Issues**: https://github.com/hansjm10/Idle-Game-Engine/issues/705, https://github.com/hansjm10/Idle-Game-Engine/issues/706
- **Execution Mode**: AI-led

## 1. Summary
Regarding issue 705 on GitHub, use gh: this design introduces `@idle-engine/controls`, a platform-agnostic controls contract and helper layer that maps input intents into deterministic runtime `Command` objects aligned with `RUNTIME_COMMAND_TYPES` and payloads, keeping `packages/core` presentation-agnostic while giving downstream shells a stable API and documentation in `docs/`.

## 2. Context & Problem Statement
- **Background**: Issue 705 builds on deterministic command definitions (`packages/core/src/command.ts:18`) and queue semantics (`packages/core/src/command-queue.ts:18`) documented in `docs/runtime-command-queue-design.md:19`, with automation already providing a deterministic mapping helper (`packages/core/src/automation-system.ts:862`).
- **Problem**: Issue 705 lacks a shared control/binding contract for shells, resulting in inconsistent input mappings and no standard helper to stamp `step`, `timestamp`, and `priority` compatible with the core command model.
- **Forces**: Issue 705 must keep `packages/core` presentation-agnostic, avoid DOM/Node dependencies, preserve determinism with step-based timestamps, and align naming with `RUNTIME_COMMAND_TYPES` (`packages/core/src/command.ts:107`).

## 3. Goals & Non-Goals
- **Goals**:
  - Issue 705 defines `ControlAction`, `ControlBinding`, `ControlScheme`, `ControlEvent`, and `ControlContext` in a new `packages/controls` package, aligned to `RuntimeCommandType` payloads (`packages/core/src/command.ts:107`).
  - Issue 705 delivers helpers that create deterministic `Command` objects with `CommandPriority.PLAYER` defaults (`packages/core/src/command.ts:77`) and step-based timestamps, matching command queue expectations (`packages/core/src/command-queue.ts:74`).
  - Issue 705 adds `docs/` guidance and a sidebar entry for shell usage (`packages/docs/sidebars.ts:15`).
  - Issue 705 optionally normalizes and validates control schemes with stable ordering and required references.
- **Non-Goals**:
  - Issue 705 does not implement device-specific capture (keyboard/mouse/gamepad/touch).
  - Issue 705 does not add UI or persistence for bindings.
  - Issue 705 does not change runtime command queue semantics or dispatcher behavior (`packages/core/src/command-queue.ts:74`).

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**: Issue 705 is owned by Runtime Core maintainers, with downstream shell maintainers and Docs maintainers as key stakeholders.
- **Agent Roles**:

| Agent | Responsibilities |
|-------|------------------|
| Controls Contract Agent | Issue 705: define control types and exports in `packages/controls`. |
| Controls Helper Agent | Issue 705: implement control-to-command helpers and normalization utilities. |
| Testing Agent | Issue 705: add unit coverage for mapping and validation helpers. |
| Docs Agent | Issue 705: add and wire documentation in `docs/` and `packages/docs/sidebars.ts:15`. |
| Integration Agent | Issue 705: validate workspace build/test wiring and exports. |

- **Affected Packages/Services**: Issue 705 introduces `packages/controls`, references `@idle-engine/core` exports (`packages/core/src/index.ts:971`), and updates `docs/` plus `packages/docs/sidebars.ts:15`.
- **Compatibility Considerations**: Issue 705 is additive, preserves backwards compatibility in `packages/core`, and requires a stable contract version field for control schemes.

## 5. Current State
Issue 705 currently relies on command definitions (`packages/core/src/command.ts:18`), deterministic queue ordering (`packages/core/src/command-queue.ts:18`), and queue tests (`packages/core/src/command-queue.test.ts:45`) without a shared control/binding contract for shells. There is no `packages/controls` package today (follow-up: create `packages/controls` as a new workspace module), and presentation shell docs are archived (`docs/index.md:22`).

## 6. Proposed Solution
### 6.1 Architecture Overview
- **Narrative**: Issue 705 adds a `@idle-engine/controls` package that accepts `ControlEvent` intents from shells, resolves them against a `ControlScheme`, and emits deterministic `Command` objects using a `ControlContext` for step/timestamp stamping. The runtime remains unchanged; shells enqueue commands using the existing queue API (`packages/core/src/command-queue.ts:93`).
- **Diagram**:
```text
Shell input capture
  -> ControlEvent (intent + phase)
  -> ControlScheme (bindings + actions)
  -> resolveControlActions(scheme, event)
  -> createControlCommand(action, context)
  -> CommandQueue.enqueue(Command)
```

### 6.2 Detailed Design
- **Runtime Changes**: Issue 705 introduces no runtime changes; `packages/core` remains deterministic and presentation-agnostic (`packages/core/src/command.ts:18`).
- **Data & Schemas**: Issue 705 defines platform-agnostic contracts aligned to `RuntimeCommandType` payloads, e.g., `ControlEvent`, `ControlAction`, `ControlBinding`, `ControlScheme`, and `ControlContext` in `packages/controls` (follow-up: create `packages/controls/src/index.ts`).
- **APIs & Contracts**: Issue 705 exports `resolveControlActions`, `createControlCommand`, and `createControlCommands` to resolve actions and create commands, including defaults for priority and step offsets consistent with automation stamping (`packages/core/src/automation-system.ts:862`). Binding order in a `ControlScheme` is meaningful for execution sequencing, and helpers preserve it; `canonicalizeControlScheme` is intended for deterministic storage/diffing, not execution ordering. Action ids are expected to be unique; helpers reject duplicates.
- **Tooling & Automation**: Issue 705 adds documentation under `docs/` and updates `packages/docs/sidebars.ts:15`, plus workspace scripts for `packages/controls` (follow-up: define `packages/controls/package.json`).

### 6.3 Operational Considerations
- **Deployment**: Issue 705 is additive; no runtime migrations are required.
- **Telemetry & Observability**: Issue 705 introduces no new telemetry in `packages/core`; shells may instrument control event ingestion.
- **Security & Compliance**: Issue 705 requires JSON-safe metadata only and forbids DOM/Node APIs to keep contracts portable.

## 7. Work Breakdown & Delivery Plan
### 7.1 Issue Map
| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| chore(controls): scaffold package | Issue 705: add `packages/controls` with build/test/lint scripts | Controls Contract Agent | Doc approval | Package builds; exports defined; no DOM/Node deps |
| feat(controls): define control contracts | Issue 705: types for actions, bindings, schemes, events, context | Controls Contract Agent | Package scaffold | Type-only imports used; contracts exported |
| feat(controls): helper mapping | Issue 705: map control events to `Command` with deterministic stamping | Controls Helper Agent | Contract types | Default priority/step/timestamp applied; docs updated |
| feat(controls): normalize/validate | Issue 705: optional normalization + validation of schemes | Controls Helper Agent | Contract types | Stable ordering; validation errors returned |
| test(controls): helpers | Issue 705: unit tests for mapping/validation | Testing Agent | Helpers | `pnpm test --filter @idle-engine/controls` passes |
| docs: controls contract design | Issue 705: add design doc + sidebar update | Docs Agent | None | Doc in `docs/`; sidebar updated |

### 7.2 Milestones
- **Phase 1**: Issue 705 doc approval and `packages/controls` scaffolding complete.
- **Phase 2**: Issue 705 helpers, validation, and tests complete.

### 7.3 Coordination Notes
- **Hand-off Package**: Issue 705 agents should load `packages/core/src/command.ts:18`, `packages/core/src/command-queue.ts:18`, `packages/core/src/automation-system.ts:862`, and `docs/runtime-command-queue-design.md:19`.
- **Communication Cadence**: Issue 705 updates at phase boundaries, with daily updates during implementation.

## 8. Agent Guidance & Guardrails
- **Context Packets**: Issue 705 agents must read `docs/design-document-template.md`, `docs/runtime-command-queue-design.md:19`, `packages/core/src/command.ts:18`, `packages/core/src/automation-system.ts:862`, and `packages/docs/sidebars.ts:15`.
- **Prompting & Constraints**: Issue 705 prompt snippet:
```text
You are the Controls Contract Agent for Issue 705. Implement @idle-engine/controls with type-only imports from @idle-engine/core, keep helpers pure and deterministic, avoid DOM/Node APIs, and align naming with RUNTIME_COMMAND_TYPES.
```
- **Safety Rails**: Issue 705 agents must not edit `dist/` outputs, must not use non-deterministic timestamps, and must keep changes within `packages/controls` and `docs/`.
- **Validation Hooks**: Issue 705 completion requires `pnpm lint`, `pnpm test --filter @idle-engine/controls`, and `pnpm coverage:md` if tests or coverage change.

## 9. Alternatives Considered
Issue 705 alternatives considered and rejected:
- Put control contracts in `packages/core` (breaks presentation-agnostic boundary).
- Let each shell define its own binding schema (fragmented API, inconsistent priorities).
- Reuse transport envelopes from `packages/core` (transport semantics do not express bindings).

## 10. Testing & Validation Plan
- **Unit / Integration**: Issue 705 adds `packages/controls` unit tests for mapping, defaults, and validation, with the core command queue tested in `packages/core/src/command-queue.test.ts:45` as a reference baseline.
- **Performance**: Issue 705 ensures mapping helpers are linear in scheme size and avoid per-event allocations beyond lookup.
- **Tooling / A11y**: Issue 705 has no UI surface; accessibility testing is not applicable.

## 11. Risks & Mitigations
| Risk | Impact | Mitigation |
|------|--------|------------|
| Issue 705 contract is too generic | Shells diverge and tooling fragments | Provide canonical intent patterns and validation defaults in docs |
| Issue 705 helpers use wall-clock time | Determinism breaks | Require step-based timestamps in `ControlContext` |
| Issue 705 adds runtime coupling | Version skew between controls and core | Use type-only imports and keep helpers pure |

## 12. Rollout Plan
- **Milestones**: Issue 705 ships in two phases (contract + docs, then helpers + tests).
- **Migration Strategy**: Issue 705 is additive with no data migration required.
- **Communication**: Issue 705 release notes should link to this doc and reference `@idle-engine/controls` usage.

## 13. Open Questions
- Issue 705 TODO (Owner: Shell Maintainers): Should `ControlEvent` support analog axis values beyond metadata?
- Issue 705 TODO (Owner: Runtime Core Maintainers): What canonical `ControlIntent` naming scheme should be recommended?
- Issue 705 TODO (Owner: Docs Maintainers): Where should controls docs sit in the Docusaurus sidebar hierarchy?

## 14. Follow-Up Work
- Issue 705 follow-up (Owner: Shell Maintainers): Integrate `@idle-engine/controls` into downstream shells.
- Issue 705 follow-up (Owner: Content Team): Add a sample control scheme to `packages/content-sample`.
- Issue 705 follow-up (Owner: Tooling Team): Consider a CLI validator for control schemes.

## 15. References
- https://github.com/hansjm10/Idle-Game-Engine/issues/705
- https://github.com/hansjm10/Idle-Game-Engine/issues/706
- `docs/design-document-template.md`
- `docs/runtime-command-queue-design.md:19`
- `docs/index.md:22`
- `packages/core/src/command.ts:18`
- `packages/core/src/command.ts:77`
- `packages/core/src/command.ts:107`
- `packages/core/src/command-queue.ts:18`
- `packages/core/src/command-queue.ts:93`
- `packages/core/src/command-queue.test.ts:45`
- `packages/core/src/automation-system.ts:862`
- `packages/core/src/index.ts:971`
- `packages/docs/sidebars.ts:15`

## Appendix A — Glossary
- **Issue 705**: The GitHub issue requesting a controls contract package for the Idle Engine.
- **ControlAction**: Issue 705 action definition that maps to a runtime command payload.
- **ControlBinding**: Issue 705 binding that links an intent to a control action.
- **ControlScheme**: Issue 705 collection of actions and bindings for a shell.
- **ControlEvent**: Issue 705 normalized input intent emitted by a shell.
- **ControlContext**: Issue 705 timing context for deterministic command stamping.

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2025-12-30 | Codex (AI) | Issue 705 initial design doc draft |
