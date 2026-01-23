---
title: Document Cost Calculation Formulas
sidebar_position: 4
---

# Document Cost Calculation Formulas

## Document Control
- **Title**: Document Cost Calculation Formulas
- **Authors**: Opencode (AI Agent)
- **Reviewers**: TBD
- **Status**: Draft
- **Last Updated**: 2026-01-23
- **Related Issues**: #775
- **Execution Mode**: AI-led

## 1. Summary
This design document proposes documenting the exact mathematical formulas used to calculate generator and upgrade costs within the Idle Game Engine. The documentation will cover the various `costCurve` types (exponential, linear, polynomial, etc.) and how `costMultiplier` and upgrade effects are applied. This will enable content creators to accurately balance their games using spreadsheets or other external tools.

## 2. Context & Problem Statement
- **Background**: The engine uses a flexible system for defining costs via `costCurve` (which supports various mathematical functions) and `costMultiplier`.
- **Problem**: The exact formulas are not documented. Content creators resort to trial-and-error or reverse-engineering to understand how costs scale with level, leading to unexpected values and inefficient balancing workflows. The issue reporter specifically noted confusion around the `exponential` curve and how `offset` applies.
- **Forces**: 
    - Accuracy: The documentation must strictly reflect the runtime implementation.
    - Clarity: Formulas should be expressed in standard mathematical notation where possible, alongside JSON examples.

## 3. Goals & Non-Goals
- **Goals**:
    - Document the cost calculation flow in `docs/content-dsl-usage-guidelines.md`.
    - Provide explicit formulas for `linear`, `exponential`, `polynomial`, `constant`, and `piecewise` curve types.
    - Explain the role of `costMultiplier` and runtime upgrade multipliers.
    - Clarify the behavior of the `offset` property in exponential curves (additive vs level-offset).
- **Non-Goals**:
    - Changing the actual cost calculation logic.
    - Implementing new formula types.

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**: Content Creators / Game Designers.
- **Agent Roles**: 
    - **Documentation Agent**: Responsible for updating the markdown files.
- **Affected Packages/Services**: 
    - `docs/` (documentation only).
- **Compatibility Considerations**: None (doc change only).

## 5. Current State
The cost calculation logic resides in:
- `packages/core/src/progression/generator-manager.ts`: Orchestrates the cost calculation, applying `costMultiplier` and upgrade effects.
- `packages/content-schema/src/base/formula-evaluator.ts`: Evaluates the raw `NumericFormula`.

The core logic is:
```typescript
cost = evaluateNumericFormula(curve, { level: purchaseIndex }) * costMultiplier * upgradeMultiplier
```

Where `evaluateNumericFormula` behaves as follows:
- **Exponential**: `base * growth^level + offset` (where offset defaults to 0)
- **Linear**: `base + slope * level`
- **Constant**: `value`

## 6. Proposed Solution
### 6.1 Documentation Updates
We will add a new section "Cost Calculation Formulas" to `docs/content-dsl-usage-guidelines.md` (or `docs/content-quick-reference.md` as requested, but "Usage Guidelines" seems more appropriate for deep dives).

The section will detail:
1.  **Generator Cost Formula**: `FinalCost = BaseCostFromCurve * CostMultiplier * GlobalMultipliers`
2.  **Upgrade Cost Formula**: `FinalCost = BaseCostFromCurve * CostMultiplier * RepeatableAdjustment` (no global multipliers; RepeatableAdjustment comes from `repeatable.costCurve` for repeatable upgrades, defaults to 1 otherwise)
3.  **Curve Formulas**:
    *   **Exponential**: `Cost(level) = base * growth^level + offset`
        *   *Note: Explicitly clarify that `offset` is added to the result, not the level.*
    *   **Linear**: `Cost(level) = base + slope * level`
    *   **Constant**: `Cost(level) = value`
    *   **Polynomial**: `Cost(level) = sum(coefficient_i * level^i)`
4.  **Examples**: JSON snippets + calculated values for levels 0, 1, 10.

### 6.2 Detailed Design
No code changes.

### 6.3 Operational Considerations
None.

## 7. Work Breakdown & Delivery Plan
### 7.1 Issue Map

| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| docs: add cost calculation formulas | Update `content-dsl-usage-guidelines.md` with formulas and examples | General/Docs Agent | Design approval | Docs contain correct formulas matching code |

### 7.2 Milestones
- **Phase 1**: Update documentation.

## 8. Agent Guidance & Guardrails
- **Context Packets**: `packages/core/src/progression/generator-manager.ts`, `packages/content-schema/src/base/formula-evaluator.ts`.
- **Validation**: Ensure formulas in docs match the TS implementation exactly.

## 9. Alternatives Considered
- **Changing the formula**: We could change `exponential` to support `growth^(level+offset)`, but that would break existing content or require a schema change. Better to just document the current behavior clearly.

## 10. Testing & Validation Plan
- **Verification**: Manually verify the documented examples against a simple script or the existing unit tests in `packages/core`.

## 11. Risks & Mitigations
- **Risk**: Users might still be confused if they want "level offset" behavior.
- **Mitigation**: Provide a "Common Patterns" subsection showing how to achieve level offset mathematically (e.g. adjust `base` to `base * growth^k`).

## 12. Rollout Plan
- Merge PR.
- Content creators will see updated docs.

## 13. Open Questions
- None.

## 14. Follow-Up Work
- None.
