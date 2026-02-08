# Design: Generic Save/Load and Offline Catch-Up Tooling

**Issue**: #854
**Status**: Draft - Classification Complete
**Feature Types**: Primary: Workflow, Secondary: API, UI

---

## 1. Scope

### Problem
Desktop shell dev tooling for Save/Load and offline catch-up is tied to a specific game mode instead of runtime capabilities, so it cannot be reliably reused across packs. Save writes are also non-atomic, which risks corrupted or truncated save files on crash.

### Goals
- [ ] Enable Save/Load based on runtime support for serialize/hydrate capabilities, not hard-coded game mode checks.
- [ ] Write save files atomically to prevent partial/corrupt save artifacts on interruption.
- [ ] Enable offline catch-up tooling based on command support (for `OFFLINE_CATCHUP`) instead of game mode.

### Non-Goals
- Add a new save schema or migration framework in this issue (including mandatory metadata/version migration behavior).
- Redesign renderer UX or gameplay systems unrelated to shell dev-tooling enablement and persistence safety.

### Boundaries
- **In scope**: `packages/shell-desktop` menu/tooling gating, worker/main capability signaling or feature detection needed for gating, and atomic save-file write behavior for desktop shell tooling.
- **Out of scope**: core gameplay balance/content behavior changes, broad infrastructure/build pipeline changes, and non-desktop shell implementations.

---

## 2. Workflow
[To be completed in design_workflow phase]

## 3. Interfaces
[To be completed in design_api phase]

## 4. Data
[To be completed in design_data phase]

## 5. Tasks
[To be completed in design_plan phase]

## 6. Validation
[To be completed in design_plan phase]
