# Project Board Workflow (Idle Engine Prototype)

This document describes the current configuration of https://github.com/users/hansjm10/projects/1 and the conventions AI agents must follow when managing work.

## 1. Board Configuration
- **Layout**: Board (Project v2)
- **Columns**: mapped from the custom `Stage` field
  - `Backlog`
  - `In Progress`
  - `Review`
  - `Done` (auto-archive after 14 days)
- **Default Status field**: retains GitHub defaults (`Todo`, `In Progress`, `Done`) for reporting. The AI workflow treats `Stage` as the authoritative state machine.

## 2. Custom Fields
- `Stage` (single-select): `Backlog`, `In Progress`, `Review`, `Done`
- `Workstream` (single-select): `Tooling & QA`, `Runtime Core`, `Content Pipeline`, `Presentation Shell`, `Social Services`, `Delivery & Ops`
- `Target date` (optional GitHub field): set automatically when Stage → `In Progress`.

All existing items (issues #1–30) have `Workstream` and `Stage` preset to match the implementation plan backlog (`Backlog` + relevant workstream).

## 3. AI Execution Rules
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

## 4. Automation & Monitoring
- **Target dates**: configure a field-update workflow so that when `Stage` transitions to `In Progress`, the `Target date` field is set to 7 days in the future, and when `Stage` transitions to `Done`, the field is cleared.
- **Review notifications**: configure an automation rule that posts a canned comment (e.g., "Ready for verification – run checklist") when `Stage` becomes `Review`. AI agents monitor these comments and run the verification checklist.
- **Weekly summary**: the automation in Section 6 triggers the AI agent to post a weekly summary (items moved by stage and blockers discovered).
- **Views**: maintain saved views grouped by `Workstream` and filtered by each `Stage` for retrospectives.

## 5. Manual Overrides
- Major scope or dependency changes require human approval before altering `Workstream` values.
- If new issues are added, assign the correct `Workstream` and set `Stage` to `Backlog` immediately so automations pick them up.

## 6. Maintenance Checklist
- **Weekly**: ensure no item remains in `In Progress` or `Review` for more than 5 days without an update.
- **Phase completion**: archive or close completed issues and snapshot board metrics for the milestone retrospective.
- **Quarterly**: review automation rules and adjust target-date windows if throughput changes.

## 7. Repository Enforcement
- Enable branch protection on `main`/`master`: require pull requests, block direct pushes, and disallow force pushes/deletions (GitHub → Settings → Branches → Branch protection rules).
- Require status checks (`pnpm lint`, `pnpm test`) and at least one approving review before merge so each task ships via its own PR.
- Add a GitHub Action that listens to `issues: closed` and reopens any issue without an associated merged PR (verify with the REST `issues/{issue_number}/events` API) to enforce "issues close via PR" policy.
- Encourage PRs to reference issues with closing keywords (`Fixes #123`) so automation links artifacts automatically.
Following these conventions keeps the project board aligned with the design plan and enables autonomous AI execution without manual triage.

---

### Appendix: Manual Automation Setup Steps
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
