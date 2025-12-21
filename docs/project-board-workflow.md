---
title: Project Board Workflow
sidebar_position: 4
---

# Project Board Workflow

Use this document to understand how the Idle Engine project board is configured and the conventions AI agents must follow when managing work on https://github.com/users/hansjm10/projects/1.

## Document Control
- **Title**: Project Board Workflow for AI-Led Development
- **Authors**: Idle Engine Team
- **Reviewers**: N/A
- **Status**: Approved
- **Last Updated**: 2025-12-21
- **Related Issues**: N/A
- **Execution Mode**: AI-led

## 1. Summary
This document defines the configuration and operational conventions for the Idle Engine project board (GitHub Projects v2). It establishes the authoritative state machine based on the custom `Stage` field, maps workstreams to custom fields, and prescribes transition rules that autonomous AI agents must follow to manage tasks from backlog through completion. The workflow enables AI-led execution while maintaining visibility, enforcing PR-based delivery, and supporting weekly progress monitoring.

## 2. Context & Problem Statement
- **Background**: The Idle Engine prototype uses GitHub Projects v2 (https://github.com/users/hansjm10/projects/1) to track issues across multiple workstreams (Tooling & QA, Runtime Core, Content Pipeline, Presentation Shell, Social Services, Delivery & Ops). AI agents autonomously select, execute, and transition tasks through the board columns.
- **Problem**: Without explicit conventions for field usage, stage transitions, and automation triggers, AI agents lack the deterministic rules needed to manage work consistently. Manual triage overhead increases, and tracking fidelity degrades.
- **Forces**: AI agents require unambiguous state-transition rules. GitHub Projects v2 automation is configured via web UI rather than CLI/API. The board must remain compatible with GitHub Insights and human oversight workflows.

## 3. Goals & Non-Goals
- **Goals**:
  1. Define the canonical board layout (columns, custom fields) and their semantics.
  2. Establish clear stage-transition rules AI agents must follow.
  3. Document automation triggers and manual override policies.
  4. Ensure all work ships via pull requests linked to issues.
- **Non-Goals**:
  - Describing how to create or configure a GitHub Projects v2 board from scratch (assumes board exists).
  - Automating all GitHub Projects v2 workflows via CLI/API (manual setup required).
  - Defining the implementation plan phases (see `docs/implementation-plan.md`).

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**: AI agents executing tasks, project maintainers reviewing weekly summaries.
- **Agent Roles**: All autonomous agents interacting with the project board must adhere to the task selection, stage transition, status sync, and documentation rules specified in this document.
- **Affected Packages/Services**: N/A (process document).
- **Compatibility Considerations**: The board retains GitHub's default `Status` field for Insights compatibility while treating `Stage` as the authoritative state machine.

## 5. Current State
The project board is a GitHub Projects v2 Board layout with columns mapped from a custom `Stage` field. All existing items (issues #1–30) are preset with `Workstream` and `Stage` values matching the implementation plan backlog. Automation rules for target-date assignment and review notifications are configured manually via the web UI. Branch protection on `main` requires PRs, status checks, and approving reviews before merge.

## 6. Proposed Solution
### 6.1 Architecture Overview
- **Narrative**: The workflow centers on a custom `Stage` field (Backlog, In Progress, Review, Done) as the authoritative state machine. AI agents select tasks from Backlog, transition them through In Progress and Review, and mark them Done after verification. Automations update target dates and post review notifications. Branch protection and a GitHub Action enforce the policy that all issues close via merged PRs.
- **Diagram**: N/A

### 6.2 Detailed Design

#### Board Configuration
- **Layout**: Board (Project v2)
- **Columns**: mapped from the custom `Stage` field
  - `Backlog`
  - `In Progress`
  - `Review`
  - `Done` (auto-archive after 14 days)
- **Default Status field**: retains GitHub defaults (`Todo`, `In Progress`, `Done`) for reporting. The AI workflow treats `Stage` as the authoritative state machine.

#### Custom Fields
- `Stage` (single-select): `Backlog`, `In Progress`, `Review`, `Done`
- `Workstream` (single-select): `Tooling & QA`, `Runtime Core`, `Content Pipeline`, `Presentation Shell`, `Social Services`, `Delivery & Ops`
- `Target date` (optional GitHub field): set automatically when Stage → `In Progress`.

All existing items (issues #1–30) have `Workstream` and `Stage` preset to match the implementation plan backlog (`Backlog` + relevant workstream).

#### AI Execution Rules
1. **Task selection**
   - Pick the highest-priority `Backlog` item within the current phase (see `docs/implementation-plan.md`).
   - Honor dependencies noted in issue descriptions before moving an item to `In Progress`.
2. **Stage transitions**
   - `Backlog → In Progress`: when coding or setup begins.
   - `In Progress → Review`: when code/docs/tests are ready for validation; include links to PRs.
   - `Review → Done`: after verification passes and work merges/deploys.
   - Reverse transitions require notes explaining the rollback.
3. **Status sync**
   - Mirror the `Stage` transition in the default `Status` field for compatibility with Insights/automations.
4. **Documentation**
   - Update the corresponding issue with implementation notes, test evidence, and links before moving to `Review` or `Done`.

#### Automation & Monitoring
- **Target dates**: configure a field-update workflow so that when `Stage` transitions to `In Progress`, the `Target date` field is set to 7 days in the future, and when `Stage` transitions to `Done`, the field is cleared.
- **Review notifications**: configure an automation rule that posts a canned comment (e.g., "Ready for verification – run checklist") when `Stage` becomes `Review`. AI agents monitor these comments and run the verification checklist.
- **Weekly summary**: the automation in Section 6 triggers the AI agent to post a weekly summary (items moved by stage and blockers discovered).
- **Views**: maintain saved views grouped by `Workstream` and filtered by each `Stage` for retrospectives.

#### Manual Overrides
- Major scope or dependency changes require human approval before altering `Workstream` values.
- If new issues are added, assign the correct `Workstream` and set `Stage` to `Backlog` immediately so automations pick them up.

#### Maintenance Checklist
- **Weekly**: ensure no item remains in `In Progress` or `Review` for more than 5 days without an update.
- **Phase completion**: archive or close completed issues and snapshot board metrics for the milestone retrospective.
- **Quarterly**: review automation rules and adjust target-date windows if throughput changes.

#### Repository Enforcement
- Enable branch protection on `main`/`master`: require pull requests, block direct pushes, and disallow force pushes/deletions (GitHub → Settings → Branches → Branch protection rules).
- Require status checks (`pnpm lint`, `pnpm test`) and at least one approving review before merge so each task ships via its own PR.
- Add a GitHub Action that listens to `issues: closed` and reopens any issue without an associated merged PR (verify with the REST `issues/{issue_number}/events` API) to enforce "issues close via PR" policy.
- Encourage PRs to reference issues with closing keywords (`Fixes #123`) so automation links artifacts automatically.

### 6.3 Operational Considerations
- **Deployment**: N/A (process document).
- **Telemetry & Observability**: Weekly summaries capture stage transitions and blockers. Board views enable retrospective analysis by workstream.
- **Security & Compliance**: Branch protection prevents force pushes and direct commits to main. All changes require review before merge.

## 7. Work Breakdown & Delivery Plan
### 7.1 Issue Map
N/A (this document describes the process for managing issues, not a specific implementation).

### 7.2 Milestones
N/A (milestones are defined in `docs/implementation-plan.md`).

### 7.3 Coordination Notes
- **Hand-off Package**: AI agents must read this document and `docs/implementation-plan.md` before selecting tasks.
- **Communication Cadence**: Weekly summary posts to capture progress and blockers.

## 8. Agent Guidance & Guardrails
- **Context Packets**: AI agents must load `docs/implementation-plan.md` to understand phase dependencies and `docs/project-board-workflow.md` (this document) for state-transition rules.
- **Prompting & Constraints**: Always honor dependencies noted in issue descriptions. Mirror `Stage` transitions to the default `Status` field. Include PR links when transitioning to `Review`.
- **Safety Rails**: Do not alter `Workstream` values without human approval. Do not force-push or delete protected branches. Do not close issues without an associated merged PR.
- **Validation Hooks**: Before moving an item to `Review` or `Done`, update the issue with implementation notes, test evidence, and PR links.

## 9. Alternatives Considered
- **Single-field workflow using GitHub's default Status**: Rejected because the default field lacks the semantic granularity needed for AI-driven stage transitions and automation triggers.
- **Fully automated project board setup via CLI/API**: Rejected because GitHub Projects v2 does not yet expose automation management programmatically; manual setup is required.

## 10. Testing & Validation Plan
- **Unit / Integration**: N/A (process document).
- **Performance**: N/A (process document).
- **Tooling / A11y**: Monitor weekly summaries and board views to validate that automations fire correctly and stage transitions reflect actual work status.

## 11. Risks & Mitigations
- **Risk**: AI agents transition items to `Done` without merging a PR, bypassing the enforcement policy.
  - **Mitigation**: GitHub Action reopens any issue closed without a merged PR.
- **Risk**: Automation rules drift out of sync with the documented workflow.
  - **Mitigation**: Quarterly review of automation rules and update this document to reflect changes.
- **Risk**: New issues are added without `Workstream` or `Stage` values, breaking automation.
  - **Mitigation**: Document manual override policy requiring immediate field assignment for new issues.

## 12. Rollout Plan
- **Milestones**: The workflow is already operational for issues #1–30.
- **Migration Strategy**: N/A (process document).
- **Communication**: This document serves as the canonical reference for all AI agents and human maintainers.

## 13. Open Questions
None.

## 14. Follow-Up Work
- Automate project board field assignment for new issues when GitHub Projects v2 API supports it.
- Expand automation rules to flag items in `In Progress` or `Review` for more than 5 days automatically.

## 15. References
- `docs/implementation-plan.md` – Phase dependencies and milestone definitions.
- GitHub Projects v2 documentation: https://docs.github.com/en/issues/planning-and-tracking-with-projects
- GitHub REST API for issue events: https://docs.github.com/en/rest/issues/events

## Appendix A — Glossary
- **Stage**: The custom field representing the authoritative state machine for task progression (Backlog, In Progress, Review, Done).
- **Workstream**: The custom field categorizing tasks by functional area (Tooling & QA, Runtime Core, Content Pipeline, Presentation Shell, Social Services, Delivery & Ops).
- **Status**: GitHub's default field for issue state, mirrored from `Stage` for Insights compatibility.

## Appendix B — Change Log
| Date       | Author           | Change Summary                          |
|------------|------------------|-----------------------------------------|
| 2025-12-21 | Idle Engine Team | Migrated to design document template   |

---

## Appendix C — Manual Automation Setup Steps
GitHub Projects v2 does not yet expose automation management via the CLI/API, so set the workflows through the web UI:

1. Open the project board → **Project Settings** → **Workflows**.
2. Click **New workflow** → **Field update**.
   - Trigger: `Stage` **changes to** `In Progress`.
   - Action: set `Target date` to **7 days after** current date.
3. Duplicate the workflow:
   - Trigger: `Stage` **changes to** `Done`.
   - Action: **Clear** the `Target date` field.
4. Create a **Custom** workflow:
   - Trigger: `Stage` **changes to** `Review`.
   - Action: **Add comment** `Ready for verification – run checklist.`
5. Ensure **Auto-archive items** is enabled for the `Done` column (Project Settings → **Auto-archive**).

Record any additional automations in this document so AI agents stay in sync with the current rules.
