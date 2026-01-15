---
title: Validation Primitives & String Semantics (Issue 764)
sidebar_position: 6
---

# Validation Primitives & String Semantics (Issue 764)

## Document Control
- **Title**: Standardize validation primitives and string semantics (Issue 764)
- **Authors**: Codex (AI)
- **Reviewers**: TODO (Owner: Runtime Core Maintainers)
- **Status**: Draft
- **Last Updated**: 2026-01-14
- **Related Issues**: https://github.com/hansjm10/Idle-Game-Engine/issues/764
- **Execution Mode**: AI-led

## 1. Summary
Issue 764 standardizes primitive validation logic (string/number/integer/boolean predicates) across `packages/core` and documents consistent string semantics (especially for identifiers). Runtime event validation is tightened to reject whitespace-only identifier and user-visible string fields while preserving each subsystem’s policy (throw vs return error vs normalize) and existing telemetry contracts.

## 2. Context & Problem Statement
- **Background**: `packages/core` contains several duplicated/near-duplicated validation and normalization helpers across event validation, command validation, transport parsing, and save/restore code paths.
- **Problem**: The same “non-empty string” concept has inconsistent semantics across layers. For example, runtime event payload validation treats `'   '` as non-empty via `value.length > 0` (`packages/core/src/events/runtime-event-catalog.ts:85`), while command validation uses `trim().length > 0` (`packages/core/src/command-validation.ts:49`) and restore/parse paths do the same (`packages/core/src/transform-system.ts:167`, `packages/core/src/progression-coordinator-save.ts:97`).
- **Forces**: Refactors must preserve determinism and subsystem behavior contracts (telemetry/error codes/messages) while reducing maintenance overhead and preventing accidental semantic drift.

## 3. Goals & Non-Goals
- **Goals**:
  - Provide a single, shared set of pure predicate helpers for common primitives (string, finite number, non-negative integer, boolean).
  - Record a clear semantic decision for identifier strings and apply it consistently where identifiers are validated.
  - Refactor high-impact call sites (`runtime-event-catalog` and `command-validation`) to use shared predicates while preserving existing error handling and telemetry behavior.
  - Ensure changes are unit-tested, including explicit coverage for whitespace-only strings.
- **Non-Goals**:
  - Rewrite all existing “normalize*” helpers and parse pipelines in one PR.
  - Harmonize all error message strings or error codes across subsystems.
  - Introduce a new third-party schema validation library (e.g. Zod) as part of this issue.

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**: Runtime Core maintainers; downstream shell/transport maintainers; content pipeline maintainers (indirectly impacted via runtime surface expectations).
- **Agent Roles**:

| Agent | Responsibilities |
|-------|------------------|
| Runtime Refactor Agent | Add shared predicates; refactor `runtime-event-catalog` and `command-validation`; preserve behavior/telemetry contracts. |
| Test Agent | Add/adjust unit tests for predicate semantics and whitespace cases; ensure suite remains deterministic. |
| Docs Agent | Ensure the string semantics decision is recorded and discoverable (this document + any follow-up guidelines). |

- **Affected Packages/Services**: `packages/core` (primary), with optional follow-ups in `tools/` and other core modules that currently implement one-off validation.
- **Compatibility Considerations**: Tightening identifier/user-visible string validation from “non-empty” (length) to “non-blank” (trim) may surface previously accepted invalid data (e.g. whitespace-only IDs) at runtime event boundaries; this must be treated as an intentional behavior change and covered by tests.

## 5. Current State
- `packages/core/src/events/runtime-event-catalog.ts` defines local “require*” helpers and validates strings using `value.length` (`packages/core/src/events/runtime-event-catalog.ts:85`), which accepts whitespace-only strings for identifiers and other string fields.
- `packages/core/src/command-validation.ts` defines `validateNonEmptyString` using `value.trim().length > 0` (`packages/core/src/command-validation.ts:49`) and has unit tests covering whitespace-only rejection (`packages/core/src/command-validation.test.ts:114`).
- Other core parsing/normalization paths re-implement similar checks (examples: `parseNonEmptyString` in `packages/core/src/transform-system.ts:167`, id checks in `packages/core/src/progression-coordinator-save.ts:97`), contributing to inconsistent semantics and duplicated logic.

## 6. Proposed Solution

### 6.1 Architecture Overview
- **Narrative**: Introduce a shared predicate module with small, pure helpers. Subsystems (events, commands, transport, save/restore) keep their own policy (throw vs return value vs normalize), but rely on the shared predicates to avoid semantic drift.
- **Diagram**: N/A (localized refactor; no new runtime components).

### 6.2 Detailed Design

#### Shared predicate module
Add `packages/core/src/validation/primitives.ts` exporting type-guard predicates:
- `isNonEmptyString(value: unknown): value is string` (length-based; no trim).
- `isNonBlankString(value: unknown): value is string` (`trim().length > 0`).
- `isFiniteNumber(value: unknown): value is number` (`typeof === 'number' && Number.isFinite`).
- `isNonNegativeInteger(value: unknown): value is number` (`Number.isInteger && >= 0`).
- `isBoolean(value: unknown): value is boolean` (`typeof === 'boolean'`).

Unit tests live alongside the module as `packages/core/src/validation/primitives.test.ts`.

This module is an internal engine utility and should not be exported from the stable `@idle-engine/core` entrypoint. If engine-contributor tooling needs access, export it via `@idle-engine/core/internals`.

#### String semantics decision
- **Identifiers**: Treat identifiers as **non-blank** strings (must contain at least one non-whitespace character). This aligns with existing command validation (`packages/core/src/command-validation.ts:49`) and restore/parse behavior (`packages/core/src/transform-system.ts:167`, `packages/core/src/progression-coordinator-save.ts:97`).
- **Non-identifier strings**: Default to non-blank unless a specific field explicitly allows whitespace-only content. If such fields exist, use `isNonEmptyString` intentionally and document the exception at the call site.
- **User-visible strings** (e.g. `prompt`, `option.label`): Treat as **non-blank** (whitespace-only strings rejected), but do not strip or normalize whitespace in the value.
- **Identifier formatting**: Treat “no leading/trailing whitespace” as a stricter transport boundary rule (e.g. `packages/core/src/command-transport-server.ts:292`). For Phase 1, core validators standardize only “non-blank”; if we want trimmed identifiers everywhere, introduce an explicit predicate (e.g. `isTrimmedNonBlankString`) and roll it out intentionally.

#### Refactors (in-scope for issue 764)
- `packages/core/src/events/runtime-event-catalog.ts`
  - Update local “require*” helpers to use shared predicates and explicitly apply **non-blank** semantics to:
    - Identifier-like fields: `resourceId`, `automationId`, `transformId`, `batchId`, `stageId`, `option.id`, `optionId`, `nextStageId` (when non-null), `entityInstanceIds[*]`, `output.resourceId`.
    - User-visible strings: `prompt`, `option.label`.
  - Add/adjust tests in `packages/core/src/events/runtime-event-catalog.test.ts` to ensure whitespace-only strings are rejected for identifier and user-visible string fields.
  - Preserve error message text (e.g. “must be a non-empty string.”) unless explicitly rewording is agreed upon.
- `packages/core/src/command-validation.ts`
  - Replace inline primitive checks with shared predicates while preserving public API and telemetry/error behavior.
  - Keep `validateNonEmptyString` name/behavior for compatibility (it already enforces “non-blank”); optionally add `validateNonBlankString` as an alias for clarity.
  - Keep existing tests as the contract, adding new predicate tests rather than duplicating validation tests unless needed.

#### Optional follow-ups (out of scope for issue 764, but enabled by predicates)
- Refactor `packages/core/src/command-transport-server.ts` and its identifier normalization (`packages/core/src/command-transport-server.ts:292`) to reuse predicates where it improves clarity (while retaining stricter transport rules like “no leading/trailing whitespace”).
- Consolidate one-off normalize/parse helpers in `packages/core/src/transform-system.ts`, `packages/core/src/progression-coordinator-save.ts`, `packages/core/src/offline-progress-limits.ts`, and `packages/core/src/internals.browser.ts` onto shared predicates where it reduces duplication without changing semantics.
- Update content-generated event validators (in `CONTENT_EVENT_CHANNELS`) to use the same primitives to prevent semantic drift between generated and hand-written validators.

### 6.3 Operational Considerations
- **Deployment**: N/A (library refactor in core; consumed at build time).
- **Telemetry & Observability**: Must preserve existing telemetry event names and payload structure in command validation (`packages/core/src/command-validation.ts:13`).
- **Security & Compliance**: Improves input hygiene by rejecting whitespace-only identifiers earlier; no new PII handling.

## 7. Work Breakdown & Delivery Plan

### 7.1 Issue Map

| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| feat(core): add validation predicate module | Add `validation/primitives.ts` + unit tests | Runtime Refactor Agent + Test Agent | None | Predicates exist; unit tests cover trim vs length semantics; module remains internal (not exported from stable entrypoint). |
| refactor(core): use shared predicates in runtime event catalog | Replace local primitive checks with shared predicates; add whitespace tests | Runtime Refactor Agent + Test Agent | Predicate module | Event catalog uses predicates; whitespace-only identifiers and user-visible strings rejected; tests updated. |
| refactor(core): use shared predicates in command validation | Replace inline checks with predicates while preserving telemetry and return shapes | Runtime Refactor Agent + Test Agent | Predicate module | Command validation uses predicates; tests pass unchanged. |

### 7.2 Milestones
- **Phase 1**: Add predicate module + tests; refactor `runtime-event-catalog` and `command-validation`; run `pnpm test --filter @idle-engine/core`.
- **Phase 2**: Optional follow-ups for transport/server and restore/parse paths (separate issues to avoid scope creep).

### 7.3 Coordination Notes
- **Hand-off Package**: Key files: `packages/core/src/events/runtime-event-catalog.ts`, `packages/core/src/command-validation.ts`, `packages/core/src/validation/primitives.ts`.
- **Communication Cadence**: Single PR for Phase 1 with focused review from Runtime Core maintainers; follow-ups tracked as separate issues.

## 8. Agent Guidance & Guardrails
- **Context Packets**: Load issue 764, and review current validation semantics in `packages/core/src/events/runtime-event-catalog.ts:85` and `packages/core/src/command-validation.ts:49`.
- **Prompting & Constraints**:
  - Keep new predicates pure and dependency-free.
  - Use `import type` / `export type` for type-only imports/exports as required by lint rules.
  - Preserve existing error messages/telemetry behavior unless explicitly changing and updating tests.
- **Safety Rails**:
  - Do not silently broaden acceptance (e.g. treating `NaN` as valid).
  - Avoid large-scale refactors across unrelated modules in the same PR.
- **Validation Hooks**:
  - `pnpm lint`
  - `pnpm test --filter @idle-engine/core`

## 9. Alternatives Considered
- **Status quo**: Keep duplicated helpers and accept semantic drift. Rejected due to inconsistent behavior and higher maintenance cost.
- **Centralize “throwing validators” instead of predicates**: Would not fit subsystems that return structured errors or normalize values (e.g. command transport). Predicates keep policy decisions local.
- **Adopt a schema validation library**: Adds dependency and potentially larger refactor surface; not necessary for simple primitives.

## 10. Testing & Validation Plan
- **Unit / Integration**:
  - Add `packages/core/src/validation/primitives.test.ts` covering:
    - `'': false` and `'   ': false` for `isNonBlankString`
    - `'   ': true` and `'\n': true` for `isNonEmptyString`
    - finite number and integer boundaries for numeric predicates
  - Extend `packages/core/src/events/runtime-event-catalog.test.ts` to validate whitespace-only strings are rejected for identifier and user-visible string fields.
- **Performance**: N/A (micro-level predicates; no expected measurable impact).
- **Tooling / A11y**: N/A.

## 11. Risks & Mitigations
- **Risk**: Tightened string validation breaks consumers that emit whitespace-only identifiers or user-visible strings.
  - **Mitigation**: Treat as bug fix; add explicit tests; ensure any failures surface early and with clear error messages.
- **Risk**: Overloading “non-empty” terminology remains ambiguous.
  - **Mitigation**: Provide both `isNonEmptyString` and `isNonBlankString` to force explicit decisions; keep `validateNonEmptyString` for compatibility but consider adding a `validateNonBlankString` alias to reduce confusion at new call sites.
- **Risk**: Predicates accidentally change numeric edge-case behavior (e.g. `Infinity`, `NaN`).
  - **Mitigation**: Unit tests for boundary values; preserve existing checks by routing through `Number.isFinite`, `Number.isInteger`.

## 12. Rollout Plan
- **Milestones**: Land Phase 1 in a small PR; optional follow-up PRs for other call sites.
- **Migration Strategy**: No runtime migration; updates are internal refactors plus stricter validation at event boundaries.
- **Communication**: Note identifier semantics change in PR description and link this document; call out any discovered upstream emitters producing whitespace.

## 13. Open Questions
- Are there any runtime event fields that intentionally allow whitespace-only strings? If yes, enumerate them and explicitly validate with `isNonEmptyString` (documenting the exception).

## 14. Follow-Up Work
- Refactor `packages/core/src/command-transport-server.ts` and other parsing/normalizer helpers to use shared predicates where appropriate.
- Update content-generated event validators (`CONTENT_EVENT_CHANNELS`) to reuse the shared primitives.
- Add a short “validation semantics” section to `docs/testing-guidelines.md` or a dedicated runtime validation guideline doc.
- Consider a lightweight lint rule or convention check to discourage new ad-hoc primitive validators.

## 15. References
- Issue 764: https://github.com/hansjm10/Idle-Game-Engine/issues/764
- Event validation helpers: `packages/core/src/events/runtime-event-catalog.ts:85`
- Command validation helpers: `packages/core/src/command-validation.ts:49`
- Transport identifier normalization: `packages/core/src/command-transport-server.ts:292`
- Restore/parse examples: `packages/core/src/transform-system.ts:167`, `packages/core/src/progression-coordinator-save.ts:97`

## Appendix A — Glossary
- **Blank string**: A string whose `trim()` is empty (e.g. `'   '`).
- **Non-empty string**: A string with `length > 0` (may still be blank/whitespace-only).
- **Non-blank string**: A string with `trim().length > 0`.
- **Predicate**: A pure boolean check (preferably a TypeScript type guard) used to build validators/normalizers.
- **Validator**: Code that enforces correctness by throwing or returning structured errors.
- **Normalizer**: Code that coerces/repairs invalid inputs to defaults or a canonical form.

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2026-01-14 | Codex (AI) | Initial draft for issue 764. |
| 2026-01-14 | Codex (AI) | Resolved open questions and clarified string semantics decisions. |
