---
title: "content-schema: add generator-count achievement track kind (Issue 821)"
sidebar_position: 99
---

# content-schema: add generator-count achievement track kind (Issue 821)

## Document Control
- **Title**: Add `generator-count` achievement track kind for aggregate generator ownership
- **Authors**: Ralph (AI agent)
- **Reviewers**: @hansjm10
- **Status**: Draft
- **Last Updated**: 2026-01-25
- **Related Issues**: https://github.com/hansjm10/Idle-Game-Engine/issues/821
- **Execution Mode**: AI-led

## 1. Summary
Add a new achievement track kind, `generator-count`, that measures total generator ownership by summing generator “levels” (owned counts) across all generators (or an explicit subset). This makes “Own N total generators (of any type)” achievable purely in content definitions, without requiring the `custom-metric` workaround and a runtime `getCustomMetricValue` callback.

## 2. Context & Problem Statement
- **Background**:
  - The achievement `track` discriminated union in `packages/content-schema/src/modules/achievements.ts` currently supports `resource`, `generator-level`, `upgrade-owned`, `flag`, `script`, and `custom-metric`.
  - `generator-level` tracks the owned count for a *single* generator id.
  - Runtime evaluation lives in `packages/core/src/progression/achievement-tracker.ts` via `getAchievementTrackValue(...)`, using a `ConditionContext` backed by the `ProgressionFacade` (`packages/core/src/progression/progression-facade.ts`).
- **Problem**:
  - Content authors cannot define aggregate ownership achievements like “Own 10 generators total” across all generator types.
  - The current workaround (`custom-metric`) requires code integration (`getCustomMetricValue`) and therefore cannot be solved purely in content packs.
- **Forces**:
  - Keep the achievement system deterministic and content-first (avoid requiring callbacks for common progression patterns).
  - Minimise surface-area changes to `ConditionContext` (used broadly for unlock/visibility/automation evaluation).
  - Avoid introducing per-step cost that scales poorly with large numbers of generators/achievements.

## 3. Goals & Non-Goals
- **Goals**:
  1. Support aggregate generator ownership achievements in content via a first-class track kind.
  2. Allow “all generators” by default, with an optional filter to specific generator ids.
  3. Keep behaviour deterministic and consistent with existing achievement progress semantics.
  4. Update schema validation, runtime evaluation, tests, and schema reference docs.
- **Non-Goals**:
  - Tracking other aggregates (e.g., total generator production rate) as part of this change.
  - Replacing or deprecating `custom-metric` (it remains the escape hatch for bespoke logic).
  - Redesigning achievement progress modes (oneShot/incremental/repeatable).

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**:
  - Content authors / pack maintainers
  - `@idle-engine/content-schema` maintainers
  - `@idle-engine/core` progression maintainers
- **Agent Roles**:
  - **Schema Agent**: Add `generator-count` to the content schema and cross-reference validators.
  - **Runtime Agent**: Implement `generator-count` evaluation in the achievement tracker.
  - **Docs Agent**: Document the new track kind in `docs/content-schema-reference.md`.
  - **Test Agent**: Add/extend Vitest coverage for schema + runtime behaviour.
- **Affected Packages/Services**:
  - `packages/content-schema` (track schema + pack validator + tests)
  - `packages/core` (achievement tracker + coordinator wiring + tests)
  - `docs/content-schema-reference.md` (documentation)
- **Compatibility Considerations**:
  - This is an additive schema/runtime change; existing packs remain valid.
  - Packs that previously attempted to use a non-existent `generatorCount` kind will still fail until they migrate to `generator-count` (see Open Questions re: aliases).

## 5. Current State
- Content schema defines achievement track kinds in `packages/content-schema/src/modules/achievements.ts` (see `trackSchema` around line 46).
- Cross-reference validation checks track references in `packages/content-schema/src/pack/validators/achievements.ts` (e.g., verifying `generator-level.generatorId` exists).
- Runtime measurement uses `AchievementTracker.getAchievementTrackValue(...)` in `packages/core/src/progression/achievement-tracker.ts` (see switch around line 457):
  - `generator-level` delegates to `conditionContext.getGeneratorLevel(generatorId)` which resolves to generator owned counts in `ProgressionFacade` (see `conditionContext` wiring around line 112 in `packages/core/src/progression/progression-facade.ts`).
- No runtime or schema support exists for summing across multiple generators without `custom-metric`.

## 6. Proposed Solution
### 6.1 Architecture Overview
- Introduce a new achievement track kind: `generator-count`.
- The runtime calculates the track’s measurement as:
  - `sum(getGeneratorLevel(id))` over `generatorIds` if specified, otherwise
  - `sum(getGeneratorLevel(id))` over all generator ids in the loaded content pack.
- Completion uses a comparator against the computed achievement target:
  - Default comparator: `gte` (consistent with existing comparator defaults).

### 6.2 Detailed Design
- **Runtime Changes**:
  - Extend `AchievementTracker` to support a `generator-count` case in `getAchievementTrackValue(...)`.
  - Provide `AchievementTracker` access to “all generator ids” (via `ProgressionFacade`, since it already receives `options.content.generators`).
  - Update track completion logic so `generator-count` can use its `comparator` (similar to `resource` tracks).
- **Data & Schemas**:
  - Extend `trackSchema` in `packages/content-schema/src/modules/achievements.ts` with:
    - `kind: 'generator-count'`
    - `threshold: numericFormulaSchema`
    - `comparator: comparatorSchema` (defaulting to `gte`)
    - `generatorIds?: string[]` (content ids, intended to reference generators)
  - Extend the achievements pack cross-reference validator (`packages/content-schema/src/pack/validators/achievements.ts`) to:
    - validate all `generatorIds` (if present) exist in the generator index
    - validate `threshold` formula references (like `resource` / `custom-metric` do)
- **APIs & Contracts**:
  - No public API changes are required if `generator-count` measurement is computed using existing `ConditionContext.getGeneratorLevel(...)` plus a generator id list passed into `AchievementTracker`.
  - Content shape change is additive: old packs remain valid; new packs can opt into `generator-count`.
- **Tooling & Automation**:
  - Update `docs/content-schema-reference.md` to list `generator-count`, required fields, and examples.

Example achievement definition:
```json
{
  "id": "achievement.ten-generators",
  "name": { "default": "Generator Collector" },
  "description": { "default": "Own 10 generators of any type" },
  "category": "progression",
  "tier": "bronze",
  "track": {
    "kind": "generator-count",
    "threshold": { "kind": "constant", "value": 10 },
    "comparator": "gte"
  }
}
```

Example filtered definition (subset of generators):
```json
{
  "track": {
    "kind": "generator-count",
    "generatorIds": ["generator.cursor", "generator.grandma"],
    "threshold": { "kind": "constant", "value": 25 },
    "comparator": "gte"
  }
}
```

### 6.3 Operational Considerations
- **Deployment**:
  - Standard workspace flow: `pnpm lint` and `pnpm test`.
  - If tests/coverage change, regenerate `docs/coverage/index.md` via `pnpm coverage:md` (per repo guidelines).
- **Telemetry & Observability**:
  - Not applicable (no runtime telemetry added).
- **Security & Compliance**:
  - Not applicable (no new external inputs or permissions).

## 7. Work Breakdown & Delivery Plan
### 7.1 Issue Map
| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| `feat(content-schema): add generator-count achievement track` | Add `generator-count` to `trackSchema` + cross-reference validation + schema tests | Schema Agent | Design doc approved | Pack validates `generator-count`; bad generator ids rejected; tests added |
| `feat(core): evaluate generator-count achievement tracks` | Sum generator owned counts for `generator-count` and respect comparator | Runtime Agent | Schema merged | Unit tests cover track value + completion semantics |
| `docs: document generator-count achievement tracks` | Update schema reference doc and add examples | Docs Agent | Schema merged | `docs/content-schema-reference.md` includes new kind + example |

### 7.2 Milestones
- **Phase 1**: Ship schema + runtime support + tests + docs for `generator-count`.
- **Phase 2**: Optional follow-ups (alias support, sample pack additions, performance caching) if needed.

### 7.3 Coordination Notes
- **Hand-off Package**:
  - Issue context: https://github.com/hansjm10/Idle-Game-Engine/issues/821
  - Relevant schema/runtime entry points:
    - `packages/content-schema/src/modules/achievements.ts`
    - `packages/content-schema/src/pack/validators/achievements.ts`
    - `packages/core/src/progression/achievement-tracker.ts`
    - `packages/core/src/progression/progression-facade.ts`
    - `docs/content-schema-reference.md`
- **Communication Cadence**:
  - One implementation PR is sufficient; review checkpoint after tests + docs update.

## 8. Agent Guidance & Guardrails
- **Context Packets**:
  - Load Issue 821 and inspect the track schema + runtime tracker implementation before coding.
  - Compare to existing track behaviour (`resource`, `generator-level`, `custom-metric`) for consistency.
- **Prompting & Constraints**:
  - Follow workspace TypeScript conventions: ES modules, 2-space indent, type-only imports/exports.
  - Do not edit checked-in `dist/` outputs by hand.
- **Safety Rails**:
  - Avoid adding noisy console output during Vitest runs (the LLM reporter expects clean JSON end-of-run output).
  - Keep achievement evaluation deterministic (no access to wall-clock time or randomness).
- **Validation Hooks**:
  - `pnpm test --filter @idle-engine/content-schema`
  - `pnpm test --filter @idle-engine/core`
  - `pnpm lint`

## 9. Alternatives Considered
1. **Continue using `custom-metric`**:
   - Pros: no schema/runtime changes.
   - Cons: requires runtime integration, preventing content-only packs from expressing a common achievement pattern.
2. **Require explicit `generatorIds` (no “all generators” default)**:
   - Pros: avoids needing runtime access to generator lists.
   - Cons: burdens content authors and makes “all generators” difficult/verbose.
3. **Extend `ConditionContext` with a “total generator count” API**:
   - Pros: avoids `AchievementTracker` needing generator ids.
   - Cons: broadens a shared interface and requires more widespread wiring/migration.

## 10. Testing & Validation Plan
- **Unit / Integration**:
  - `packages/content-schema`: add schema tests for `generator-count` (parsing, default progress target derivation) and validator tests for `generatorIds` references.
  - `packages/core`: add unit tests validating measurement and completion with `generator-count` using a small content pack fixture.
- **Performance**:
  - Validate that summing across generator ids is acceptable for typical pack sizes; consider caching if necessary.
- **Tooling / A11y**:
  - Not applicable.

## 11. Risks & Mitigations
1. **Performance overhead with many generators/achievements**:
   - Mitigation: keep `generatorIds` optional for narrowing; add caching later if benchmarks show need.
2. **Ambiguity (“level” vs “count”)**:
   - Mitigation: document clearly that generator “level” equals owned count; `generator-count` sums owned counts.
3. **Early adopters using `generatorCount` (camelCase) in content**:
   - Mitigation: document the correct kind (`generator-count`); optionally add an alias if that becomes a recurring pain point.

## 12. Rollout Plan
- **Milestones**:
  1. Merge schema + validator changes.
  2. Merge core runtime support + tests.
  3. Update docs.
- **Migration Strategy**:
  - Packs using the `custom-metric` workaround can migrate to `generator-count` to become content-only.
- **Communication**:
  - Note in release/PR description: “New achievement track kind: `generator-count` (total generators owned).”

## 13. Open Questions
1. Should we accept `generatorCount` as an alias for `generator-count` to reduce schema mismatch footguns?
2. Should `generatorIds` (when present) be required to be non-empty and de-duplicated/normalized?
3. Do we need step-level caching in `AchievementTracker` for `generator-count`, or is naive summation sufficient for expected pack sizes?

## 14. Follow-Up Work
- Add a sample-pack achievement demonstrating `generator-count` once the kind is available (optional).
- Consider additional aggregate track kinds if content author feedback suggests a pattern (e.g., “total upgrades purchased”).

## 15. References
- Issue 821: https://github.com/hansjm10/Idle-Game-Engine/issues/821
- Track schema: `packages/content-schema/src/modules/achievements.ts`
- Pack achievement validator: `packages/content-schema/src/pack/validators/achievements.ts`
- Achievement runtime evaluation: `packages/core/src/progression/achievement-tracker.ts`
- Condition context wiring: `packages/core/src/progression/progression-facade.ts`
- Schema reference docs: `docs/content-schema-reference.md`

## Appendix A — Glossary
- **Generator level**: The owned count of a specific generator id (`ConditionContext.getGeneratorLevel(...)`).
- **generator-count**: Proposed achievement track kind that sums generator levels across multiple generator ids.
- **custom-metric**: Existing escape hatch track kind whose measurement is provided by a runtime callback.

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2026-01-25 | Ralph (AI agent) | Initial draft for Issue 821 |

