---
title: Expand Sample Pack and Balance Validation (issue-420)
sidebar_position: 4
---

## Document Control
- Title: Expand sample pack coverage and balance validation (issue-420, scope from issue-419)
- Authors: Idle Engine Design-Authoring Agent
- Reviewers: Content Pipeline Maintainers; Runtime Core Maintainers; Shell UX Maintainers
- Status: Draft
- Last Updated: 2025-11-22
- Related Issues: https://github.com/hansjm10/Idle-Game-Engine/issues/419, https://github.com/hansjm10/Idle-Game-Engine/issues/420
- Execution Mode: AI-led

## 1. Summary
around github issue 419 expands the sample pack with new resources, generators, multi-tier upgrades, and a prestige layer while adding fast-check-based balance validation to the content schema and compiler pipeline. Balance failures will block `pnpm generate (--check)` and CI, and updated core/shell fixtures will consume the richer content without regressions.

## 2. Context & Problem Statement
- **Background**: Sample content is minimal (energy/crystal, few upgrades) in `packages/content-sample/content/pack.json`; docs outline usage (`packages/content-sample/README.md`) but no prestige coverage. Schema checks are structural (`packages/content-schema/src/modules/generators.ts`) with property tests only for formulas (`packages/content-schema/src/base/formulas.property.test.ts`). Compiler artifacts are deterministic (`packages/content-compiler/src/__tests__/compiler.test.ts`) yet balance is unchecked, and `pnpm generate` via `tools/content-schema-cli/src/compile.js` omits balance validation (`docs/content-validation-cli-design.md`). Shell progression relies on pack IDs/costs (`packages/core/src/progression-coordinator.ts`).
- **Problem**: Issue 419 calls out insufficient content coverage and missing balance/property validation, risking negative rates or unstable costs and leaving prestige untested.
- **Forces**: Maintain deterministic artifacts/hashes and structured logs (`vitest-llm-reporter` final JSON); honor DSL rules (`docs/content-dsl-usage-guidelines.md`) and implementation plan expectations for richer packs (`docs/implementation-plan.md`); avoid manual `dist/` edits.

## 3. Goals & Non-Goals
- **Goals**:
  1. Expand the sample pack with additional resources/generators, multi-tier upgrades, and a prestige layer per issue 419.
  2. Add fast-check-backed balance validation to `@idle-engine/content-schema`, surfaced through compiler/CLI and CI.
  3. Extend compiler tests for balance gating and deterministic hashes.
  4. Align core and shell consumers/tests with new content IDs/tiers and prestige flows.
  5. Update docs (content DSL usage, sample README) to describe new content and validation rules.
- **Non-Goals**:
  - Changing runtime economic algorithms or command contracts beyond content wiring.
  - Shipping full prestige UX in shell-web (only fixtures/tests).
  - Adding guild perks/social features (defer).

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**: Content pipeline maintainers; Runtime core maintainers; Shell UX maintainers.
- **Agent Roles**: Content Authoring Agent (pack expansion); Balance Validation Agent (fast-check invariants); Compiler Integration Agent (CLI wiring); Shell Consumer Agent (progression updates); Docs Agent (guides/readme).
- **Affected Packages/Services**: `packages/content-schema`, `packages/content-compiler`, `packages/content-sample`, `packages/core`, `packages/shell-web`, `tools/content-schema-cli`, `docs/`.
- **Compatibility Considerations**: Preserve deterministic ordering/hashes; keep `content/compiled/index.json` shape; avoid schema breaks; maintain shell cost/visibility expectations (`packages/core/src/progression-coordinator.ts`).

## 5. Current State
- Sample pack limited to two resources/two generators, minimal upgrades, no prestige (`packages/content-sample/content/pack.json`).
- Schema validation enforces structure/uniqueness; no balance/monotonicity (`packages/content-schema/src/modules/generators.ts`, `packages/content-schema/src/modules/prestige.ts`); property suites only for formulas (`packages/content-schema/src/base/formulas.property.test.ts`).
- Compiler and CLI ignore balance results (`packages/content-compiler/src/compiler/index.ts`, `packages/content-compiler/src/__tests__/compiler.test.ts`, `tools/content-schema-cli/src/compile.js`).
- Shell progression uses pack data for costs/unlocks (`packages/core/src/progression-coordinator.ts`); new IDs would currently break fixtures.
- Implementation plan demands richer packs and prestige coverage (`docs/implementation-plan.md`); progression guidance exists (`docs/progression-coordinator-design.md`).

## 6. Proposed Solution
### 6.1 Architecture Overview
- **Narrative**: Author richer pack content (mid/late resources, generators, multi-tier upgrades, prestige), add fast-check balance invariants in `@idle-engine/content-schema`, wire balance gating into compiler/CLI, and refresh core/shell consumers so deterministic artifacts remain stable.
- **Diagram**:
  ```
  pack.json/json5 → schema + balance validator (fast-check) → compiler (deterministic artifacts) → sample pack exports
        ↑                    |                               ↓
   docs/guides           CLI/CI logs                 core + shell tests
  ```

### 6.2 Detailed Design
- **Runtime Changes**:
  - No new runtime systems; update `packages/core` fixtures and shell progression expectations for new IDs and prestige currency.
  - Ensure progression coordinator handles added tiers/resources without command contract changes.
- **Data & Schemas**:
  - **Resources**: Keep `energy`, `crystal`; add `sample-pack.alloy` (tier 2 soft crafting, unlock after crystal threshold), `sample-pack.data-core` (tier 2 research, produced from alloy), `sample-pack.prestige-flux` (prestige currency, hidden until unlock).
  - **Generators**:
    - `sample-pack.forge`: consumes energy+crystal → alloy; linear cost (base 75 energy, slope 12).
    - `sample-pack.lab`: consumes energy+alloy → data-core; exponential cost (base 120 energy, growth 1.12).
    - `sample-pack.gate-reactor`: consumes data-core → prestige-flux post-prestige unlock; exponential cost (base 500 data-core, growth 1.08).
    - Keep `reactor`/`harvester`; specify sensible `maxLevel`/`maxBulk` to exercise validation.
  - **Upgrades (multi-tier)**:
    - Reactor: existing tiers plus `reactor-phase-cooling` (tier 3, ×1.75, unlock at owned ≥5).
    - Harvester: add `harvester-deep-core` (tier 2, ×1.5, unlock at crystal ≥150) and `harvester-quantum-sieve` (tier 3 repeatable up to 5, +15% each).
    - Forge: `forge-heat-shield` (reduces alloy cost growth), `forge-auto-feed` (automation-ready).
    - Lab: `lab-insight-boost` (×1.4), `lab-simulation-stack` (repeatable, prestige-flux gated).
  - **Prestige Layer**:
    - Add `sample-pack.ascension-alpha` rewarding `prestige-flux`; unlock when `data-core` ≥ 500 and `reactor` level ≥ 10.
    - Reward formula: `floor((totalEnergySpent + totalCrystalSpent + 2 * totalDataProduced) / 750)` capped at 5,000; minimum 1 per reset.
    - Effects: global production multiplier `1 + prestige-flux * 0.01`; resets resources/generators/upgrades; no carry-over except prestige currency.
    - Document automation gating and unlock text for UI.
  - **Balance Checks (schema)**:
    - New `balanceChecks` module with fast-check invariants: finite/non-negative rates; non-decreasing generator/upgrade costs across purchase indices 0–100 with `maxGrowth` cap (default 20x); prestige rewards non-negative/monotone and capped; unlock ordering ensures consumed resources unlock no later than dependent generators.
    - `ContentSchemaOptions` gains `balance` config (sample size, growth cap, warn-vs-error).
- **APIs & Contracts**:
  - `createContentPackValidator` emits `balanceWarnings`/`balanceErrors`; add structured log events `content_pack.balance_failed`/`content_pack.balance_warning`.
  - Keep pack export shape; prestige appears in generated modules/indices (`packages/content-sample/src/generated/*.generated.ts`).
- **Tooling & Automation**:
  - Update `tools/content-schema-cli/src/compile.js` to run balance before compilation; fail fast on errors; include balance status in `content/compiled/index.json`.
  - Extend compiler tests to assert balance gating and deterministic hashes.
  - Seed fast-check deterministically with capped `numRuns`; document seeds to protect `vitest-llm-reporter` output.
  - Add sample pack tests for prestige/reset behaviors; regenerate artifacts via `pnpm generate`.

### 6.3 Operational Considerations
- **Deployment**: No runtime deploy change; CI must run `pnpm generate --check` plus targeted tests on content changes.
- **Telemetry & Observability**: Logs remain single-line JSON; record balance check duration for perf tracking.
- **Security & Compliance**: Static JSON/TS only; bound fast-check to avoid resource exhaustion.

## 7. Work Breakdown & Delivery Plan
### 7.1 Issue Map
Populate the table as the canonical source for downstream GitHub issues.

| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| feat(content-schema): add balance property checks (issue 419) | Implement fast-check invariants, options, and warnings/errors | Balance Validation Agent | None | Balance failures surface structured errors; `pnpm test --filter content-schema` green; seeds documented |
| feat(content-compiler): enforce balance in CLI/summary (issue 419) | Wire balance results into compiler and logs; halt on errors | Compiler Integration Agent | Balance checks | `pnpm generate --check` fails on balance errors; summary includes balance status; compiler tests updated |
| feat(content-sample): expand pack with upgrades and prestige (issue 419) | Author new resources/generators/upgrades/prestige; regenerate artifacts | Content Authoring Agent | Balance checks merged | Pack compiles warning-free; prestige rewards per design; digests refreshed |
| chore(shell-web/core): align progression fixtures to new content | Update shell/core tests for new IDs/tiers/prestige | Shell Consumer Agent | Expanded pack | `pnpm test --filter shell-web` and core progression tests pass; no runtime errors |
| docs: update content DSL usage/sample pack README | Document new content, prestige flows, validation | Docs Agent | Expanded pack | `docs/content-dsl-usage-guidelines.md` and `packages/content-sample/README.md` updated with links |

### 7.2 Milestones
- **Phase 1 (Week 0-1)**: Balance validation + CLI/compiler wiring with tests.
- **Phase 2 (Week 1-2)**: Pack expansion (resources/generators/upgrades/prestige) and artifact regeneration.
- **Phase 3 (Week 2-3)**: Consumer fixture updates, docs refresh, CI stabilization.

### 7.3 Coordination Notes
- **Hand-off Package**: Provide pack drafts, expected digests, and fast-check seeds when transferring work.
- **Communication Cadence**: Daily async updates in issue 419; reviewer checkpoints at each phase; escalate schema questions to content pipeline maintainers.

## 8. Agent Guidance & Guardrails
- **Context Packets**: `docs/content-dsl-usage-guidelines.md`, `docs/content-compiler-design.md`, `docs/content-validation-cli-design.md`, `docs/progression-coordinator-design.md`, `packages/content-sample/content/pack.json`, `packages/core/src/progression-coordinator.ts`.
- **Prompting & Constraints**: Use ES modules, two-space indentation, type-only imports/exports; keep generated output deterministic; never edit `dist/` manually.
- **Safety Rails**: Avoid destructive git commands; keep console output JSON-only; cap fast-check runs; avoid non-ASCII text.
- **Validation Hooks**: `pnpm generate --check`, `pnpm test --filter content-schema`, `pnpm test --filter content-compiler`, `pnpm test --filter content-sample`, `pnpm test --filter shell-web`, `pnpm coverage:md` when coverage changes.

## 9. Alternatives Considered
- Manual heuristic balance checks: rejected for low coverage and maintenance cost.
- Runtime simulation-based balance validation: deferred; heavier and less deterministic for CI.
- Separate prestige-only pack: rejected; single sample pack should exercise resets and base progression together.

## 10. Testing & Validation Plan
- **Unit / Integration**: Balance property suites in `packages/content-schema`; compiler pipeline tests for gating; sample pack prestige/reset fixtures; shell progression tests for new IDs.
- **Performance**: Track balance check runtime; target under 5s per suite with bounded fast-check.
- **Tooling / A11y**: Preserve `vitest-llm-reporter` JSON; run `pnpm coverage:md` after test changes; no UI delta to trigger new a11y tests.

## 11. Risks & Mitigations
- Fast-check flakiness → Fix seeds and bound `numRuns`; document defaults.
- Cost/rate regressions break shell progression → Run progression coordinator checks and property suites per change.
- Artifact drift → Enforce `pnpm generate --check` in CI; commit regenerated outputs.
- Prestige reward errors → Add unit tests for reward caps and monotonicity; include in balance checks.

## 12. Rollout Plan
- **Milestones**: Follow §7.2 with reviewer approval after balance wiring and after content expansion.
- **Migration Strategy**: Bump sample pack version (e.g., 0.3.x) when prestige lands; regenerate `content/compiled/` and `src/generated/`; update fixtures.
- **Communication**: Post commands and digest updates in issue 419; highlight prestige addition in content DSL guide and release notes.

## 13. Open Questions
- Final numeric tuning for new generators/upgrades/prestige curve (Owner: Content Authoring Agent).
- Should prestige-flux bonuses stack multiplicatively or additively with upgrades? (Owner: Runtime Core Maintainers).
- Should balance warnings be fatal in CI but soft locally? (Owner: Balance Validation Agent).

## 14. Follow-Up Work
- Add guild perk stub per implementation plan (Owner: Content Authoring Agent).
- Extend balance checks to localization completeness and automation cooldown sanity (Owner: Balance Validation Agent).
- Publish JSON schema for `content/compiled/index.json` for external tooling (Owner: Compiler Integration Agent).

## 15. References
- `packages/content-sample/content/pack.json`
- `packages/content-sample/README.md`
- `packages/content-schema/src/modules/generators.ts`
- `packages/content-schema/src/modules/prestige.ts`
- `packages/content-schema/src/base/formulas.property.test.ts`
- `packages/content-compiler/src/__tests__/compiler.test.ts`
- `tools/content-schema-cli/src/compile.js`
- `packages/core/src/progression-coordinator.ts`
- `docs/content-dsl-usage-guidelines.md`
- `docs/content-compiler-design.md`
- `docs/content-validation-cli-design.md`
- `docs/progression-coordinator-design.md`
- `docs/implementation-plan.md`

## Appendix A — Glossary
- **Balance validation**: Fast-check-backed invariants ensuring costs, rates, and rewards are finite, non-negative, and monotone where applicable.
- **Prestige layer**: Reset mechanic granting `sample-pack.prestige-flux` and global multipliers while resetting base progression.
- **Deterministic artifact**: Compiler output with stable ordering/hashes when inputs do not change.
- **Content pack**: Authored JSON/JSON5 definitions compiled into normalized runtime content.

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2025-11-22 | Idle Engine Design-Authoring Agent | Initial draft for issues 419/420 |
