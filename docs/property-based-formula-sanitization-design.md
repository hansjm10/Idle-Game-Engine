# Expand Property-Based Formula Sanitization Coverage

## Document Control
- **Title**: Establish AI-led property-based tests for formula sanitization
- **Authors**: Idle Engine Design Authoring Agent (Content Quality Pod)
- **Reviewers**: TODO — Content Pipeline Maintainers
- **Status**: Draft
- **Last Updated**: 2025-10-23
- **Related Issues**: [Issue #14](https://github.com/hansjm10/Idle-Game-Engine/issues/14)
- **Execution Mode**: AI-led

## 1. Summary
This design fulfils GitHub Issue #14 by extending property-based formula sanitization for the Idle Engine content pipeline, grounding each decision in `docs/idle-engine-design.md` and reinforcing deterministic behaviour guaranteed by `packages/content-schema/src/base/formulas.ts:1`. The proposal equips AI agents with richer fast-check arbitraries, cross-package invariants, and CI gating so that all numeric formulas authored for Idle Engine remain finite, monotonic where required, and non-negative for protected outputs.

## 2. Context & Problem Statement
- **Background**: The Idle Engine runtime depends on declarative numeric formulas to model progression (`docs/idle-engine-design.md` §6.2). Core schema validation occurs in `numericFormulaSchema` (`packages/content-schema/src/base/formulas.ts:38`), and existing property-based checks focus on narrow cases (`packages/content-schema/src/base/formulas.test.ts:151`). Implementation Plan Section 4 flagged property-based tests as outstanding (`docs/implementation-plan.md:100`).
- **Problem**: Current fast-check suites cover only single-formula families and run solely within `content-schema`, leaving expression references, cross-module invariants, and CLI sanitization paths unverified. This gap risks accepting formulas that yield negative totals, overflow, or illegal references during content ingestion.
- **Forces**: Constraints include deterministic Vitest execution, low-noise reporters for downstream AI agents, and the requirement to align with the Content Pipeline roadmap (`docs/content-schema-rollout-decisions.md:298`). Tests must complete within CI budgets and remain reproducible.

## 3. Goals & Non-Goals
- **Goals**:
  1. Generate comprehensive fast-check arbitraries that exercise every `NumericFormula` variant and nested expression depth.
  2. Enforce cross-surface invariants (finite outputs, monotonic constraints, sanitized entity references) across schema, CLI, and sample content packs.
  3. Provide CI-enforced test suites and documentation so AI agents can autonomously extend coverage without regressions.
- **Non-Goals**:
  - Modify runtime formula evaluation semantics in `packages/core`.
  - Implement new content author tooling UI; scope is limited to automated tests and documentation.
  - Replace existing deterministic unit tests; property-based suites augment them.

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**: Content Pipeline Maintainers, QA & Reliability, Idle Engine Runtime Owners.
- **Agent Roles**:
  - Formula Property Test Agent — authors and maintains fast-check suites.
  - CLI Integration Agent — ensures validation CLI invokes sanitization harness.
  - Documentation Agent — updates authoring guidance.
- **Affected Packages/Services**: `packages/content-schema`, `packages/content-validation-cli`, `packages/content-sample`, CI workflows under `.github/`.
- **Compatibility Considerations**: No backward-incompatible schema changes; tests must pass with existing content packs and keep deterministic outputs for replayable simulations.

## 5. Current State
- `numericFormulaSchema` enforces structural limits and depth caps (`packages/content-schema/src/base/formulas.ts:135`).
- Property-based tests exist but target only exponential, linear, polynomial, piecewise, and constant formulas in isolation (`packages/content-schema/src/base/formulas.test.ts:151`).
- CLI and downstream packs rely on schema validation without probabilistic fuzzing, leaving sanitization coverage incomplete.

## 6. Proposed Solution
### 6.1 Architecture Overview
- **Narrative**: Introduce a shared fast-check arbitrary library that composes schema-constrained formula generators, run them through deterministic evaluators, and assert sanitization invariants across schema, CLI, and sample packs.
- **Diagram**: TODO — Formula Sanitization Flow (Owner: Formula Property Test Agent).

### 6.2 Detailed Design
- **Runtime Changes**: None; reuse existing evaluation helpers under `packages/content-schema`.
- **Data & Schemas**:
  - Add `createFormulaArbitrary` utilities exporting sanitized generators with depth caps and reference pools.
  - Extend piecewise validation tests to randomize boundary ordering and ensure catch-all compliance.
- **APIs & Contracts**:
  - Expose evaluators via `packages/content-schema` test helpers for reuse in CLI tests.
  - Provide typed helper to run formulas against synthetic resource states to verify non-negativity.
- **Tooling & Automation**:
  - Add Vitest suite `packages/content-schema/src/base/formulas.property.test.ts`.
  - Wire CLI command `pnpm --filter content-validation-cli test` to import shared arbitraries.
  - Configure CI matrix entry executing property suites with `VITEST_MAX_THREADS=1`.

### 6.3 Operational Considerations
- **Deployment**: Update `.github/workflows/ci.yml` to add property-test job gating merges.
- **Telemetry & Observability**: Capture Vitest JSON reporter output for property suites; no additional runtime telemetry required.
- **Security & Compliance**: Ensure generated references respect content ID format, preventing path traversal or PII in test fixtures.

## 7. Work Breakdown & Delivery Plan
### 7.1 Issue Map

| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| test(content-schema): add shared numeric formula arbitraries | Build fast-check generators + invariants for schema layer | Formula Property Test Agent | Issue #14 | All formula variants covered; tests deterministic across runs |
| test(content-validation-cli): enforce sanitization via property suites | Reuse arbitraries in CLI validation path and assert outputs | CLI Integration Agent | test(content-schema) | CLI tests fail on unsanitized formulas; CI job green |
| docs(content): document formula sanitization guidelines | Update author handbook with invariants + troubleshooting | Documentation Agent | test(content-schema) | Guidance published under `docs/content-schema-rollout-decisions.md`; references updated |

### 7.2 Milestones
- **Phase 1**: Generator library + schema suite (1 sprint) — deliver shared arbitraries and schema-focused properties.
- **Phase 2**: CLI integration + documentation (1 sprint) — wire into validation tooling, update docs, finalize CI gating.

### 7.3 Coordination Notes
- **Hand-off Package**: Provide agents with formula AST examples, current tests, and `pnpm` scripts.
- **Communication Cadence**: Async daily updates via project board comment; design review checkpoint after Phase 1; escalation to Content Pipeline Maintainers for schema adjustments.

## 8. Agent Guidance & Guardrails
- **Context Packets**: Load `docs/idle-engine-design.md`, `docs/content-schema-rollout-decisions.md`, and relevant test files before execution.
- **Prompting & Constraints**: Agents must follow Conventional Commits, keep Vitest reporter JSON intact, and avoid modifying `dist/`.
- **Safety Rails**: Do not alter runtime logic or relax schema limits; avoid non-deterministic randomness.
- **Validation Hooks**: Run `pnpm test --filter content-schema` and `pnpm --filter content-validation-cli test`; verify Vitest JSON event is preserved.

## 9. Alternatives Considered
- Snapshot-based formula fixtures: Rejected due to maintenance burden and poor coverage of edge cases.
- Static lint rules: Insufficient for runtime-dependent invariants like monotonic growth.
- Manual QA scripts: Non-repeatable and misaligned with AI-led automation.

## 10. Testing & Validation Plan
- **Unit / Integration**: New Vitest property suites in `packages/content-schema` and `packages/content-validation-cli`.
- **Performance**: Monitor test runtime; property suites must finish under 60 seconds per job.
- **Tooling / A11y**: No UI changes; ensure `vitest-llm-reporter` output remains valid JSON.

## 11. Risks & Mitigations
- Flaky randomness → Mitigate by seeding fast-check and bounding runs.
- Overly strict invariants rejecting valid formulas → Collaborate with maintainers, add configurability for monotonic checks.
- CI runtime increase → Parallelize across workers and limit sample counts while maintaining coverage.

## 12. Rollout Plan
- **Milestones**: Phase 1 (schema suite) and Phase 2 (CLI + docs) with explicit sign-off.
- **Migration Strategy**: Introduce tests as optional warnings, then escalate to required gating once stable.
- **Communication**: Announce in Content Pipeline stand-up and update runbooks.

## 13. Open Questions
- TODO — Who owns long-term maintenance of shared arbitraries? (Owner: Content Pipeline Maintainers)
- TODO — Should sanitization enforce domain-specific monotonicity for prestige layers? (Owner: Game Design Lead)

## 14. Follow-Up Work
- Extend property-based checks to runtime evaluation benchmarks (Owner: Runtime Implementation Agent, Timing: Post-Phase 2).
- Investigate leveraging WebAssembly fuzzers for future formula optimizations (Owner: Research Agent, Timing: Backlog).

## 15. References
- `docs/idle-engine-design.md` §1
- `docs/implementation-plan.md:100`
- `docs/content-schema-rollout-decisions.md:298`
- `packages/content-schema/src/base/formulas.ts:38`
- `packages/content-schema/src/base/formulas.test.ts:151`
- `packages/content-schema/src/base/numbers.ts:21`

## Appendix A — Glossary
- **NumericFormula**: Schema-defined structure describing resource progression.
- **Sanitization**: Validation ensuring formulas remain finite, monotonic, and safe to evaluate.
- **fast-check**: Property-based testing library used to generate randomized inputs.
- **Vitest**: Testing framework producing deterministic results required by CI.

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2025-10-23 | Idle Engine Design Authoring Agent | Initial draft addressing Issue #14 |
