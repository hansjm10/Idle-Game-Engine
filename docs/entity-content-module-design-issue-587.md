---
title: Entity Content Module Design (Issue 587)
sidebar_position: 4
---

# Entity Content Module Design (Issue 587)

## Document Control
- **Title**: Define entity content module schema for issue 587
- **Authors**: Design-Authoring Agent (AI)
- **Reviewers**: TODO (Owner: Content Schema Maintainer)
- **Status**: Draft
- **Last Updated**: 2026-01-02
- **Related Issues**: https://github.com/hansjm10/Idle-Game-Engine/issues/587, https://github.com/hansjm10/Idle-Game-Engine/issues/735
- **Execution Mode**: AI-led

## 1. Summary
For issue 587 on GitHub, this design defines the entity content module schema in `@idle-engine/content-schema`, integrates it into the content pack contract, and establishes validation, normalization, and typing expectations so entity authoring is deterministic, safe, and ready for AI-led implementation.

## 2. Context & Problem Statement
- **Background (Issue 587)**: The content pack schema currently validates resources, generators, upgrades, metrics, achievements, automations, transforms, prestige layers, and runtime events in `packages/content-schema/src/pack/schema.ts`, but lacks an entity module despite upcoming entity-focused systems described in issue 587.
- **Problem (Issue 587)**: Content authors cannot express units, heroes, or NPCs with stats and progression in a validated pack, blocking authoring workflows and schema-level safety checks for issue 587.
- **Forces (Issue 587)**:
  - Preserve strict schema conventions and deterministic normalization established in `packages/content-schema/src/modules/resources.ts` and `packages/content-schema/src/modules/generators.ts`.
  - Maintain backward compatibility by defaulting new pack fields in `packages/content-schema/src/pack/schema.ts`.
  - Keep validation aligned with existing cross-reference and formula validation in `packages/content-schema/src/pack/validate-cross-references.ts` and `packages/content-schema/src/base/formulas.ts`.

## 3. Goals & Non-Goals
- **Goals (Issue 587)**:
  1. Add an `entities` content module schema with stat, progression, and visibility fields, exporting Zod schemas and TypeScript types.
  2. Integrate `entities` into `contentPackSchema`, normalization, lookup maps, and digest generation for issue 587.
  3. Extend cross-reference validation to cover entity fields that reference resources, formulas, and conditions.
  4. Add unit and integration tests that mirror existing patterns in `packages/content-schema/src/modules/__tests__/resources.test.ts` and `packages/content-schema/src/__tests__/types.test.ts`.
- **Non-Goals (Issue 587)**:
  - Implement entity runtime state, mission transforms, or progression logic in `packages/core`.
  - Introduce new condition kinds or formula reference types beyond current schemas in `packages/content-schema/src/base/conditions.ts` and `packages/content-schema/src/base/formulas.ts`.
  - Update `packages/content-sample/content/pack.json` unless explicitly requested.

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders (Issue 587)**:
  - Content schema maintainers.
  - Content authors validating entity data.
  - Runtime system designers preparing entity systems.
- **Agent Roles (Issue 587)**:
  - Schema Implementation Agent: implement `packages/content-schema/src/modules/entities.ts` and exports.
  - Validation Agent: update `packages/content-schema/src/pack/validate-cross-references.ts` for entity fields.
  - Normalization Agent: extend `packages/content-schema/src/pack/normalize.ts` and pack types.
  - Testing Agent: add `packages/content-schema/src/modules/__tests__/entities.test.ts` and integration updates.
  - Docs Agent: align schema documentation in `docs/content-dsl-schema-design.md` if required.
- **Affected Packages/Services (Issue 587)**:
  - `packages/content-schema` (module schema, pack schema, normalization, validation, digest).
  - `docs/` (design doc and optional schema documentation).
- **Compatibility Considerations (Issue 587)**:
  - Backward compatible with existing packs by defaulting `entities` to `[]`.
  - Digest version stays the same but payload expands to include entities in `packages/content-schema/src/runtime-helpers.ts`.
  - Feature gate version for entities is **0.5.0** (resolved in #738).

## 5. Current State
For issue 587, the content schema validates pack modules in `packages/content-schema/src/pack/schema.ts`, normalizes localized text in `packages/content-schema/src/pack/normalize.ts`, and performs cross-reference checks in `packages/content-schema/src/pack/validate-cross-references.ts`. Entity-like concepts are not modeled, and there is no `entities` entry in `ParsedContentPack` or `NormalizedContentPack`. Validation and ordering patterns for new modules should follow `packages/content-schema/src/modules/resources.ts` and `packages/content-schema/src/modules/generators.ts`.

## 6. Proposed Solution
### 6.1 Architecture Overview
- **Narrative (Issue 587)**: Add a new `entities` module under `packages/content-schema/src/modules`, integrate it into the pack schema, normalization pipeline, cross-reference validation, and digest calculation, and export types and factories from `packages/content-schema/src/index.ts` and `packages/content-schema/src/factories.ts`.
- **Diagram (Issue 587)**: N/A. TODO(owner: Content Schema Maintainer) if a schema flow diagram is required.

### 6.2 Detailed Design
- **Runtime Changes (Issue 587)**:
  - None. This design affects schema validation only.
- **Data & Schemas (Issue 587)**:
  - New module: `packages/content-schema/src/modules/entities.ts`.
  - Reuse base schemas:
    - `contentIdSchema` from `packages/content-schema/src/base/ids.ts`.
    - `localizedTextSchema` and `localizedSummarySchema` from `packages/content-schema/src/base/localization.ts`.
    - `numericFormulaSchema` from `packages/content-schema/src/base/formulas.ts`.
    - `conditionSchema` from `packages/content-schema/src/base/conditions.ts`.
    - `positiveIntSchema` and `integerSchema` from `packages/content-schema/src/base/numbers.ts`.
  - Proposed entity stat schema:
    - `entityStatSchema`: `{ id, name, baseValue, minValue?, maxValue? }` with `id` normalized to lowercase and validated with a stat id regex, and `name` as localized text.
    - Enforce unique stat ids within each entity definition (same pattern as `ensureUniqueResourceHandles` in `packages/content-schema/src/modules/generators.ts`).
  - Proposed progression schema:
    - `entityProgressionSchema`: `{ experienceResource?, levelFormula, maxLevel?, statGrowth }` with `statGrowth` keyed by stat ids and validated against declared stats.
    - `experienceResource` must reference a resource id when set; validate via cross-reference checks.
  - Entity definition schema:
    - Fields aligned with issue 587: `id`, `name`, `description`, `stats`, `maxCount`, `startCount`, `trackInstances`, `progression`, `unlockCondition`, `visibilityCondition`, `unlocked`, `visible`, `tags`, `order`.
    - `startCount` should be a non-negative integer; use the `integerSchema` pattern in `packages/content-schema/src/modules/generators.ts`.
    - `tags` follow the existing normalization pattern in `packages/content-schema/src/modules/resources.ts` and are deduped + lowercased.
  - Collection schema:
    - `entityCollectionSchema` should enforce unique entity ids and deterministic ordering by `order` then `id`, consistent with `resourceCollectionSchema` and `generatorCollectionSchema`.
- **APIs & Contracts (Issue 587)**:
  - `packages/content-schema/src/pack/schema.ts`: add `entities: entityCollectionSchema.default([])` and update `ParsedContentPack`.
  - `packages/content-schema/src/pack/types.ts`: add `NormalizedEntity`, update lookup maps and `serializedLookup` with entities.
  - `packages/content-schema/src/runtime-helpers.ts`: include entities in `ContentPackDigestModules` and the digest payload.
  - `packages/content-schema/src/index.ts`: export new schemas and types.
  - `packages/content-schema/src/factories.ts`: add `createEntity` and `EntityInput` for ergonomic authoring.
- **Tooling & Automation (Issue 587)**:
  - Extend tests under `packages/content-schema/src/modules/__tests__` and `packages/content-schema/src/__tests__`.
  - Run `pnpm test --filter @idle-engine/content-schema` and update coverage via `pnpm coverage:md` if required.

### 6.3 Operational Considerations
- **Deployment (Issue 587)**:
  - Publish updated `@idle-engine/content-schema` after merge.
  - No runtime deployment changes are required.
- **Telemetry & Observability (Issue 587)**:
  - Not applicable for schema-only work.
- **Security & Compliance (Issue 587)**:
  - No PII or new security surfaces introduced.

## 7. Work Breakdown & Delivery Plan
### 7.1 Issue Map
Populate the table as the canonical source for downstream GitHub issues for issue 587.

| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| feat(content-schema): add entity module schemas (issue-587) | Implement `entities.ts` schemas, defaults, and ordering | Schema Implementation Agent | Design approval | `entityDefinitionSchema` and `entityCollectionSchema` exported; stats normalized and unique |
| feat(content-schema): integrate entities into pack schema (issue-587) | Update `pack/schema.ts`, `pack/types.ts`, `pack/normalize.ts` | Normalization Agent | Module schema | Pack parses `entities`, normalized pack includes entities, lookups updated |
| feat(content-schema): extend validation for entity references (issue-587) | Add cross-reference validation for entity formulas and experienceResource | Validation Agent | Pack integration | Invalid references fail; formulas checked with `collectFormulaEntityReferences` |
| test(content-schema): add entity schema tests (issue-587) | Add unit and integration tests, update type assertions | Testing Agent | Schema + integration | Tests added, `pnpm test --filter @idle-engine/content-schema` passes |
| docs(content-schema): document entity module (issue-587) | Update schema documentation and quick reference | Docs Agent | Schema merged | Docs reflect entity module fields and examples |

### 7.2 Milestones
- **Phase 1 (Issue 587)**: Land schema, pack integration, and normalization updates.
- **Phase 2 (Issue 587)**: Land cross-reference validation, tests, and documentation updates.

### 7.3 Coordination Notes
- **Hand-off Package (Issue 587)**:
  - `packages/content-schema/src/modules/resources.ts`
  - `packages/content-schema/src/modules/generators.ts`
  - `packages/content-schema/src/pack/schema.ts`
  - `packages/content-schema/src/pack/normalize.ts`
  - `packages/content-schema/src/pack/validate-cross-references.ts`
  - `packages/content-schema/src/runtime-helpers.ts`
- **Communication Cadence (Issue 587)**:
  - Async daily updates in issue 587; review checkpoints after each issue-map row.

## 8. Agent Guidance & Guardrails
- **Context Packets (Issue 587)**:
  - `docs/design-document-template.md`
  - `docs/content-dsl-schema-design.md`
  - `packages/content-schema/src/base/formulas.ts`
  - `packages/content-schema/src/base/conditions.ts`
  - `packages/content-schema/src/pack/schema.ts`
  - `packages/content-schema/src/pack/normalize.ts`
  - `packages/content-schema/src/pack/validate-cross-references.ts`
- **Prompting & Constraints (Issue 587)**:
  - Use `import type` and `export type` for type-only symbols (eslint enforced).
  - Follow existing tag normalization and ordering conventions in `packages/content-schema/src/modules/resources.ts`.
  - Keep schema strict with `.strict()` and provide defaults for optional fields.
- **Safety Rails (Issue 587)**:
  - Do not edit generated `dist/` outputs.
  - Do not reset git history or remove unrelated changes.
  - Avoid console output that could corrupt the `vitest-llm-reporter` JSON payload.
- **Validation Hooks (Issue 587)**:
  - `pnpm test --filter @idle-engine/content-schema`
  - `pnpm lint`
  - `pnpm coverage:md` if coverage changes

## 9. Alternatives Considered
- **Alternative (Issue 587)**: Reuse `resources` as entities. Rejected because resources lack stat, progression, and per-entity semantics.
- **Alternative (Issue 587)**: Allow untyped JSON blobs for entities. Rejected due to loss of validation, normalization, and type safety.
- **Alternative (Issue 587)**: Defer entity schema until mission transforms land. Rejected because issue 587 requires entity authoring now.

## 10. Testing & Validation Plan
- **Unit / Integration (Issue 587)**:
  - Add `packages/content-schema/src/modules/__tests__/entities.test.ts` mirroring patterns in `packages/content-schema/src/modules/__tests__/resources.test.ts`.
  - Update `packages/content-schema/src/__tests__/types.test.ts` to assert entity types in `NormalizedContentPack`.
  - Extend integration fixtures in `packages/content-schema/src/__fixtures__/integration-packs.ts` if needed.
- **Performance (Issue 587)**:
  - No new benchmarks required; keep validation cost consistent with existing pack validation.
- **Tooling / A11y (Issue 587)**:
  - Not applicable for schema-only work.

## 11. Risks & Mitigations
- **Risk (Issue 587)**: Digest cache fails to update when entities change.
  - **Mitigation (Issue 587)**: Add entities to digest payload in `packages/content-schema/src/runtime-helpers.ts` and cover with tests.
- **Risk (Issue 587)**: Stat growth keys drift from declared stats.
  - **Mitigation (Issue 587)**: Validate `statGrowth` keys against `stats` ids in the entity schema.
- **Risk (Issue 587)**: Feature gate version for entities remains undefined.
  - **Mitigation (Issue 587)**: Decide and add a new gate entry in `packages/content-schema/src/runtime-compat.ts` if required.

## 12. Rollout Plan
- **Milestones (Issue 587)**:
  - Merge schema and pack integration changes.
  - Merge validation and tests.
  - Publish updated `@idle-engine/content-schema`.
- **Migration Strategy (Issue 587)**:
  - Maintain backward compatibility by defaulting `entities` to `[]` in `contentPackSchema`.
  - Update downstream TypeScript types and integration points to include entities.
- **Communication (Issue 587)**:
  - Announce schema update in release notes and link to this design doc.

## 13. Open Questions
- **Issue 587**: TODO(owner: Content Schema Maintainer) Should stat ids reuse `contentIdSchema` or remain a stricter snake_case pattern?
- **Issue 587**: Resolved in #738: Entities require runtime >=0.5.0 (`packages/content-schema/src/runtime-compat.ts`).
- **Issue 587**: TODO(owner: Content Design Lead) Should `statGrowth` be required when `progression` is present?
- **Issue 587**: TODO(owner: Systems Designer) Should `minValue` and `maxValue` enforce constant-formula bounds at schema time?

## 14. Follow-Up Work
- **Issue 587**: TODO(owner: Docs Agent) Update `docs/content-dsl-schema-design.md` and `docs/content-quick-reference.md`.
- **Issue 587**: TODO(owner: Content Team) Add entity examples to `packages/content-sample/content/pack.json`.
- **Issue 587**: TODO(owner: Runtime Agent) Implement entity runtime systems in `packages/core`.

## 15. References
- `docs/design-document-template.md`
- `docs/content-dsl-schema-design.md`
- `packages/content-schema/src/pack/schema.ts`
- `packages/content-schema/src/pack/normalize.ts`
- `packages/content-schema/src/pack/validate-cross-references.ts`
- `packages/content-schema/src/runtime-helpers.ts`
- `packages/content-schema/src/modules/resources.ts`
- `packages/content-schema/src/modules/generators.ts`
- https://github.com/hansjm10/Idle-Game-Engine/issues/587

## Appendix A - Glossary
- **Entity (Issue 587)**: A content-defined unit, hero, or NPC with stats, progression, and visibility controls.
- **Entity Stat (Issue 587)**: A named numeric attribute within an entity definition.
- **Progression (Issue 587)**: Leveling rules that govern XP requirements and stat growth.
- **trackInstances (Issue 587)**: Flag indicating whether entities are tracked individually rather than as counts.

## Appendix B - Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2026-01-02 | Design-Authoring Agent (AI) | Initial draft for issue 587 |
