---
title: Document Content Schema Enums
sidebar_position: 4
---

# Design Document: Document Content Schema Enums

## Document Control
- **Title**: Document Content Schema Enums
- **Authors**: opencode
- **Reviewers**: hansjm10
- **Status**: Draft
- **Last Updated**: 2026-01-22
- **Related Issues**: #773
- **Execution Mode**: AI-led

## 1. Summary
This design proposes the creation of a new documentation file, `docs/content-schema-reference.md`, to provide a comprehensive reference for enum values and discriminated union kinds within the content schema. This will reduce content authoring friction by explicitly listing valid values, their semantic meanings, and usage examples, addressing the lack of discoverability in the current validation-only feedback loop.

## 2. Context & Problem Statement
- **Background**: The Idle Engine uses Zod schemas to validate content packs. While validation ensures correctness, valid values for enums and union discriminators are currently buried in the schema source code.
- **Problem**: Content authors frequently resort to trial-and-error or source code diving to discover valid values for fields like `upgrade.category`, `achievement.track.kind`, `automation.targetType`, and `condition.kind`. Valid values like `generator-level` vs `resource` (inconsistent hyphenation) cause confusion.
- **Forces**:
    - **Developer Experience**: Must improve discoverability without changing the schema itself.
    - **Accuracy**: Documentation must match the Zod definitions in `packages/content-schema`.

## 3. Goals & Non-Goals
- **Goals**:
    1. Create `docs/content-schema-reference.md`.
    2. Document all enum values for `Upgrade Categories`.
    3. Document all discriminator kinds for `Achievement Tracks`.
    4. Document all enum values for `Automation Target Types`.
    5. Document all discriminator kinds for `Conditions`.
    6. Ensure the new doc is accessible via the documentation sidebar.
- **Non-Goals**:
    - Modifying the actual schema or Zod definitions.
    - documenting every single field in the schema (focus is on enums/unions identified in the issue).

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**: Content Authors, Core Developers.
- **Agent Roles**:
    - **Docs Agent**: Responsible for creating and populating the markdown file.
- **Affected Packages/Services**:
    - `docs/` (new file).
- **Compatibility Considerations**: None (documentation only).

## 5. Current State
Currently, valid values are defined in:
- `packages/content-schema/src/modules/upgrades.ts`
- `packages/content-schema/src/modules/achievements.ts`
- `packages/content-schema/src/modules/automations.ts`
- `packages/content-schema/src/base/conditions.ts`

No central reference exists. `docs/content-dsl-usage-guidelines.md` provides high-level guidance but lacks an exhaustive reference.

## 6. Proposed Solution
### 6.1 Architecture Overview
A new static markdown file `docs/content-schema-reference.md` will be added to the documentation site. It will serve as a glossary and reference for specific schema fields.

### 6.2 Detailed Design
The document will be structured as follows:

1.  **Upgrade Categories**: Table of values (`global`, `resource`, etc.) with descriptions.
2.  **Achievement Track Kinds**: List of kinds (`resource`, `generator-level`, etc.) with schema snippets showing required fields.
3.  **Automation Target Types**: Table of values (`generator`, `system`, etc.) with usage context.
4.  **Condition Kinds**: List of kinds (`resourceThreshold`, `upgradeOwned`, etc.) with special attention to non-obvious properties like `requiredPurchases`.

### 6.3 Operational Considerations
- **Deployment**: Standard Docusaurus build.
- **Maintenance**: Future schema changes must update this file. (Ideally enforced by a test, but out of scope for this task).

## 7. Work Breakdown & Delivery Plan
### 7.1 Issue Map

| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| feat(docs): create content schema reference | Create `docs/content-schema-reference.md` with all sections | Docs Agent | Design Approval | File exists, covers all 4 topics, linked in sidebar |

### 7.2 Milestones
- **Phase 1**: Create and populate the document.

### 7.3 Coordination Notes
- **Hand-off Package**: None.

## 8. Agent Guidance & Guardrails
- **Context Packets**: `packages/content-schema` source files.
- **Prompting & Constraints**: Ensure examples match the Zod schema exactly (e.g., correct property names).
- **Safety Rails**: Do not modify code, only docs.

## 9. Alternatives Considered
- **Inline Comments**: Adding JSDoc to the schema files. Rejected because it doesn't help authors writing JSON/YAML directly without IDE support, and doesn't generate a browsable web page.
- **Generated Docs**: Using a tool to generate docs from Zod. Rejected as too complex for this specific need; manual documentation allows for better semantic explanations and examples.

## 10. Testing & Validation Plan
- **Manual Review**: Verify the generated markdown matches the schema definitions.
- **Build Check**: Ensure Docusaurus builds without errors.

## 11. Risks & Mitigations
- **Risk**: Documentation drift (docs becoming outdated).
- **Mitigation**: Add a note in the docs to check the schema files for the absolute source of truth.

## 12. Rollout Plan
- **Milestones**: Merge PR.

## 13. Open Questions
- None.

## 14. Follow-Up Work
- Consider automated documentation generation from Zod schemas in the future.

## 15. References
- Issue #773
- `packages/content-schema`
