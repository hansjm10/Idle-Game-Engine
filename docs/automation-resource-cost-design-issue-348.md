---
title: Automation System — Enforce and Deduct Automation resourceCost (issue-348)
sidebar_position: 4
---

## Document Control
- Title: Enforce and deduct automation resourceCost at trigger time (issue-348)
- Authors: Design-Authoring Agent (AI)
- Reviewers: Jordan Hans (hansjm10), Core Runtime Maintainers
- Status: Draft
- Last Updated: 2025-11-09
- Related Issues: https://github.com/hansjm10/Idle-Game-Engine/issues/348
- Execution Mode: AI-led

## 1. Summary
issue-348 addresses a gap in the automation system: automations that declare a resourceCost currently fire regardless of player resources and never deduct the cost. This design introduces deterministic, atomic cost validation and deduction at automation fire-time. When a trigger evaluates true, the runtime will compute the cost (supporting constant numeric formulas initially), check affordability, and either spend and schedule the command (success) or skip without cooldown (insufficient funds). For event-triggered automations, a failed spend preserves the pending event (it is not cleared), so the automation can retry automatically on the next tick once resources exist. For resource-threshold automations, a failed spend must not consume the false→true crossing; the runtime defers or reverts the `lastThresholdSatisfied` update on failure so these automations retrigger automatically while the threshold remains satisfied. The change restores content-author intent, prevents misleading UX, and enables sample content to reintroduce automation costs.

## 2. Context & Problem Statement
- Background:
  - The automation system supports interval, resourceThreshold, commandQueueEmpty, and event triggers with deterministic step-based evaluation. See packages/core/src/automation-system.ts.
  - A TODO exists to implement resourceCost in the fire path: packages/core/src/automation-system.ts:302.
  - Content schema already defines resourceCost: resourceId + rate (NumericFormula). See packages/content-schema/src/modules/automations.ts:95–110.
  - ResourceState supports atomic spending with guards: packages/core/src/resource-state.ts:136–160.
- Problem:
  - Automations ignore resourceCost; triggers enqueue regardless of resources and never deduct. This breaks author expectations and misleads players. Sample pack removed costed automations to avoid confusion; e.g., sample-pack.auto-reactor-burst (no resourceCost present) in packages/content-sample/content/pack.json:366–380.
- Forces:
  - Determinism: spend + enqueue must be atomic within a tick.
  - Back-compat: existing content without resourceCost must be unaffected.
  - Performance: negligible overhead on tick paths.
  - Scope: issue-348 asks for constant numeric formula evaluation initially; defer advanced formulas and multi-resource costs.

## 3. Goals & Non-Goals
- Goals:
  - Enforce resourceCost semantics for automations (evaluate, afford check, deduct) per issue-348.
  - Maintain deterministic replays: spend and enqueue occur in the same step and are recorded consistently.
  - Skip cooldown on failed spend; update state only on success.
  - Event triggers: preserve pending event on failed spend so it can retry.
  - Unit tests covering success, failure, cooldown, and interaction with existing triggers.
  - Reintroduce resourceCost to sample content once support lands and update authoring docs.
- Non-Goals:
  - Multi-resource or conditional costs (out of scope).
  - Transactional command queue semantics or a generic SPEND_RESOURCE command (deferred).
  - UI changes beyond reflecting behavior through existing runtime state.
  - Extending beyond constant numeric formulas for this iteration.

## 4. Stakeholders, Agents & Impacted Surfaces
- Primary Stakeholders:
  - Core Runtime Team (packages/core)
  - Content Authors (packages/content-sample)
  - Docs/Developer Experience
- Agent Roles:
  - Runtime Implementation Agent: Implement cost-check/deduct and tests in packages/core.
  - Content Agent: Reintroduce resourceCost to sample automations and validate.
  - Docs Agent: Update docs/automation-authoring-guide.md and references.
  - QA/Test Agent: Ensure deterministic tests and coverage stability.
  - Release/CI Agent: Ensure lint/test/build/coverage pipelines pass and docs coverage regenerate.
- Affected Packages/Services:
  - packages/core (automation system, resource state, adapters)
  - packages/content-sample (restore costed automations)
  - packages/content-schema (already defines resourceCost; no schema change expected)
  - docs (authoring guide; coverage page regen)
- Compatibility Considerations:
  - No breaking changes for content without resourceCost.
  - New optional write access from automation to ResourceState must not leak outside controlled paths.
  - Generated dist/ outputs are not edited directly; build maintains them.

## 5. Current State
- Automation evaluation:
  - Triggers and enqueue path implemented with deterministic steps and cooldowns. See packages/core/src/automation-system.ts:250–315 and 620–920.
  - Event trigger plumbing and threshold-crossing logic are implemented; threshold state updates occur during cooldown to avoid missed crossings. Today, threshold state is also updated immediately on detection of a crossing, before any cost deduction.
- Missing cost enforcement:
  - Explicit TODO: packages/core/src/automation-system.ts:302.
  - ResourceStateReader is read-only: packages/core/src/automation-system.ts:504–507.
  - Adapter bridges read-only access: packages/core/src/automation-resource-state-adapter.ts:1–45.
- Schema and docs:
  - resourceCost present in schema (rate: NumericFormula): packages/content-schema/src/modules/automations.ts:95–110, 183.
  - Authoring guide includes resourceCost examples: docs/automation-authoring-guide.md:41–49.
- Sample content gap:
  - Costed automations removed pending engine support: packages/content-sample/content/pack.json:366–399.

## 6. Proposed Solution
### 6.1 Architecture Overview
- Narrative:
  - Extend automation’s tick path to evaluate automation.resourceCost.rate when a trigger fires. Resolve resourceId → index; if the index is unknown (-1), bail out and treat as unaffordable without attempting to spend. Otherwise, check affordability and attempt an atomic spend via ResourceState. If spend succeeds, enqueue the target command and advance cooldown/lastFired. If spend fails, do not enqueue and do not start cooldown.
- Diagram:
  - Trigger true → Resolve index → [unknown] skip (no cooldown) | [known] Evaluate cost → trySpend (atomic) → [success] enqueue + set lastFired + cooldown | [fail] skip without cooldown.

### 6.2 Detailed Design
- Runtime Changes:
  - Introduce a write-capable accessor for automation:
    - Add an optional method to ResourceStateReader or define a new ResourceStateAccessor with:
      - `getAmount(index: number): number`
      - `getResourceIndex?(id: string): number`
      - `spendAmount(index: number, amount: number, context?: { systemId?: string; commandId?: string }): boolean`
    - Preferred: define ResourceStateAccessor and update AutomationSystemOptions.resourceState type to it. Adapter updated to forward spendAmount to ResourceState.spendAmount.
  - Tick path modifications in createAutomationSystem():
    - After trigger evaluation and before enqueue (packages/core/src/automation-system.ts:298–309), implement:
      - If automation.resourceCost defined:
        - Resolve `index = getResourceIndex(resourceId)`.
        - If `index === -1` (unknown resource ID or not yet unlocked/initialized): treat as unaffordable and bail out before any spend attempt. Do not call `spendAmount` with an invalid index.
        - Evaluate `amount = evaluateNumericFormula(resourceCost.rate, { variables: { level: 0 } })`.
        - Clamp negatives to 0 (safety) and reject NaN/Infinity.
        - Attempt `spendAmount(index, amount, { systemId: 'automation', commandId: automation.id })`.
        - On `false`: continue without enqueue and without updating cooldown/lastFired.
    - Retry semantics for event and resource-threshold triggers:
      - Today, `pendingEventTriggers.clear()` at end of tick (packages/core/src/automation-system.ts:313) makes event triggers single-shot even if an automation skips due to unaffordable cost. To align with “skip without cooldown (retry when resources exist)”, preserve events that failed to spend.
      - Implementation approach:
        - Introduce a local `nextPendingEventTriggers = new Set<string>()` at the start of `tick`.
        - When evaluating an `event` trigger:
          - If it triggers and the cost spend succeeds → do not add the ID to `nextPendingEventTriggers` (event consumed).
          - If it triggers but the cost spend fails (or resource index unknown) → add `automation.id` to `nextPendingEventTriggers` (event retained).
          - If it does not trigger → do nothing.
        - Replace the end-of-tick clear with a swap: `pendingEventTriggers.clear(); for (const id of nextPendingEventTriggers) pendingEventTriggers.add(id);`
      - Determinism: The set replacement is deterministic. Because IDs are unique, duplicates are not a concern.
      - Resource-threshold crossing semantics on cost failure:
        - Current engine behavior (`packages/core/src/automation-system.ts:275–288`) updates `state.lastThresholdSatisfied = currentlySatisfied` before any spend. If spend then fails, the crossing has been consumed and the automation will not fire again until the resource drops below and crosses back above the threshold.
        - Required change: when a crossing is detected (false→true), attempt the cost spend first and only set `state.lastThresholdSatisfied = true` if the spend succeeds. If the spend fails (or the resource index is unknown), keep `state.lastThresholdSatisfied = false` so the crossing remains pending and the automation retriggers automatically on subsequent ticks while the threshold remains satisfied. Do not start cooldown on failure.
      - Scope: Interval and queue-empty triggers already naturally retrip; they require no special state handling beyond “skip without cooldown” on cost failure.
      - Else: proceed as today.
    - Rationale:
      - `ResourceState.spendAmount` asserts a valid index and will throw on invalid input (see packages/core/src/resource-state.ts:666–706). The guard ensures invalid content cannot crash automation processing and fulfills the “fail-safe” intent by skipping gracefully.
    - Reference pseudocode (cost + retries):
      ```ts
      // Apply to all triggers with a resourceCost
      if (automation.resourceCost) {
        const idx = resourceState.getResourceIndex?.(automation.resourceCost.resourceId) ?? -1;
        if (idx === -1) {
          // Unknown resource → unaffordable; skip without cooldown
          // If this was an event trigger, retain the event for next tick
          if (automation.trigger.kind === 'event') {
            nextPendingEventTriggers.add(automation.id);
          }
          return;
        }
        const amount = evaluateNumericFormula(automation.resourceCost.rate, ctx);
        if (!Number.isFinite(amount)) return; // reject NaN/Infinity
        const spendOk = resourceState.spendAmount?.(idx, Math.max(0, amount), { systemId: 'automation', commandId: automation.id });
        if (!spendOk) {
          // unaffordable → skip; retain event if applicable
          if (automation.trigger.kind === 'event') {
            nextPendingEventTriggers.add(automation.id);
          }
          return;
        }
        // success → enqueue + update cooldown/lastFired
      }
      ```
      - Resource-threshold state handling (two-phase update around cost):
      ```ts
      // Before: engine updates lastThresholdSatisfied immediately (consumes crossing)
      // After: defer update until after spend
      if (automation.trigger.kind === 'resourceThreshold') {
        const currently = evaluateResourceThresholdTrigger(automation, resourceState);
        const previously = state.lastThresholdSatisfied ?? false;
        const crossing = currently && !previously; // false → true

        if (!crossing) {
          // Not a crossing → track current truth value for future crossings
          state.lastThresholdSatisfied = currently;
          return; // no fire
        }

        // Crossing detected → attempt cost first
        const idx = resourceState.getResourceIndex?.(automation.resourceCost?.resourceId ?? '') ?? -1;
        const amount = automation.resourceCost ? evaluateNumericFormula(automation.resourceCost.rate, ctx) : 0;
        const ok = automation.resourceCost && idx !== -1 && Number.isFinite(amount)
          ? resourceState.spendAmount?.(idx, Math.max(0, amount), { systemId: 'automation', commandId: automation.id }) === true
          : true; // no cost → treat as ok

        if (!ok) {
          // Cost failure → do not consume the crossing
          // Keep lastThresholdSatisfied = false so it retriggers next tick while condition holds
          state.lastThresholdSatisfied = false;
          // If you also support event retention logic separately, that remains unchanged
          return;
        }

        // Spend succeeded → consume the crossing and fire
        state.lastThresholdSatisfied = true;
        // enqueue + start cooldown...
      }
      ```
  - Determinism:
    - Use currentStep-derived timestamp (unchanged) and ensure spend + enqueue run within the same tick. No additional randomness or wall-clock interactions.
- Data & Schemas:
  - No schema changes. Use existing `resourceCost: { resourceId, rate: NumericFormula }`. Initial scope supports constant formulas.
  - Authoring doc clarifies that `rate` is interpreted as the per-fire spend amount.
- APIs & Contracts:
  - Expose a new helper to build the accessor from a ResourceState:
    - Update packages/core/src/automation-resource-state-adapter.ts to include spendAmount pass-through when available.
  - Backward compatibility: if spendAmount is unavailable (legacy wiring), automations with resourceCost act as if spend fails (skip) to avoid mischarging.
- Tooling & Automation:
  - No CLI changes. Ensure lint and tests updated. Add targeted unit tests in packages/core next to implementation.
  - Tests must add/verify:
    - Event triggers are preserved when spend fails and consumed when spend succeeds.
    - Resource-threshold automations: on a false→true crossing with insufficient funds, the crossing is not consumed (retries every tick); once funds are available, the spend succeeds, action enqueues, cooldown starts, and `lastThresholdSatisfied` becomes true.

### 6.3 Operational Considerations
- Deployment:
  - Regular release; no flags needed. Validate via CI. Generated dist/ checked in by build pipeline only (not manual).
- Telemetry & Observability:
  - Optional: emit runtime events for spend success/failure in a future iteration. For now, rely on unit tests and state inspection.
- Security & Compliance:
  - No PII. The change operates within simulation state. Maintain determinism and guard against negative/NaN costs.

## 7. Work Breakdown & Delivery Plan
### 7.1 Issue Map

| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| feat(core): automation resourceCost enforcement (issue-348) | Add cost evaluate+spend in tick before enqueue | Runtime Implementation Agent | None | Automations with insufficient funds do not enqueue; cooldown not started; with funds they spend and enqueue; resource-threshold crossings are not consumed on cost failure; tests pass |
| fix(core): retain event triggers on failed spend | Preserve event IDs across ticks when unaffordable | Runtime Implementation Agent | Core feature PR | Event-triggered automations reattempt once resources exist; tests cover retain/consume paths |
| refactor(core): ResourceState accessor + adapter | Introduce ResourceStateAccessor and update adapter to pass spendAmount | Runtime Implementation Agent | Core feature PR | Accessor wired; legacy read-only paths preserved; types exported; lint passes |
| test(core): automation cost unit tests | Add tests for success/failure, cooldown interaction, upgrade target fee | QA/Test Agent | Core feature PR | New tests in packages/core pass deterministically; coverage stable |
| docs: update automation authoring guide | Clarify resourceCost semantics and examples | Docs Agent | Core feature PR | docs/automation-authoring-guide.md updated; no broken links; a11y docs not impacted |
| content: reintroduce resourceCost in sample automations | Add costs to sample-pack.auto-reactor-burst and autobuy-reactor-insulation | Content Agent | Core feature PR | pack.json validates; tests unaffected; manual sanity via dev shell ok |
| chore(docs): regenerate coverage page | Update docs/coverage/index.md | Release/CI Agent | Tests merged | docs/coverage/index.md regenerated via pnpm coverage:md and committed |

### 7.2 Milestones
- Phase 1: Core runtime change + tests (1–2 days)
  - Implement accessor + enforcement; add unit tests; CI green.
- Phase 2: Docs + content updates (0.5–1 day)
  - Update authoring guide; reintroduce sample costs; validate sample pack.
- Phase 3: Post-merge polish (future)
  - Consider telemetry events, multi-resource costs, and transactional SPEND_RESOURCE command.

### 7.3 Coordination Notes
- Hand-off Package:
  - Source: packages/core/src/automation-system.ts:250–315, 490–560, 620–920; packages/core/src/automation-resource-state-adapter.ts; packages/core/src/resource-state.ts:136–160.
  - Content: packages/content-sample/content/pack.json:366–399.
  - Docs: docs/automation-authoring-guide.md:41–49.
- Communication Cadence:
  - Daily async status update; PR review within 24 hours; escalate blockers in issue-348 thread.

## 8. Agent Guidance & Guardrails
- Context Packets:
  - docs/design-document-template.md, docs/automation-authoring-guide.md, packages/core/src/automation-system.ts, packages/core/src/resource-state.ts, packages/core/src/automation-resource-state-adapter.ts, packages/content-schema/src/modules/automations.ts, packages/content-sample/content/pack.json, pnpm-workspace.yaml.
- Prompting & Constraints:
  - Use Conventional Commits; TypeScript, ES modules, two-space indentation; camelCase; co-locate tests.
  - Follow AGENTS.md: do not edit generated dist/ by hand; keep changes minimal and focused.
- Safety Rails:
  - Do not reset git history or force-push over reviewed changes.
  - Preserve determinism; avoid console noise that could corrupt vitest JSON reporter output.
  - Validate schema invariants; clamp/guard negative, NaN, Infinity costs.
- Validation Hooks:
  - pnpm install
  - pnpm lint
  - pnpm test --filter @idle-engine/core
  - pnpm test
  - pnpm coverage:md (commit docs/coverage/index.md only)

## 9. Alternatives Considered
- Option B: Pre-enqueue SPEND_RESOURCE command at AUTOMATION priority
  - Pros: Centralizes spending semantics; reuse for other systems.
  - Cons: Requires transactional semantics to avoid race conditions; more invasive changes to command execution order and failure handling.
- Evaluate cost at command-execution time
  - Pros: Reuses existing command handlers.
  - Cons: Breaks the author expectation that automation “fires” only when affordable; complicates cooldown semantics and determinism of “did it fire?”.
- Keep ResourceStateReader read-only and perform “preflight” only
  - Pros: Minimal code changes.
  - Cons: Non-atomic; may enqueue while affordability changes between trigger and execution; undermines determinism.

## 10. Testing & Validation Plan
- Unit / Integration:
  - Automation with resourceCost and 0 balance: no enqueue; no cooldown; state unchanged.
  - With sufficient balance: spend recorded; enqueue scheduled; lastFired and cooldown updated.
  - Upgrade target: resourceCost treated as additional fee; PURCHASE_UPGRADE still validates upgrade cost separately.
  - resourceThreshold interplay: on cost failure, do not consume the crossing (keep `lastThresholdSatisfied = false`); no cooldown on failed spend; when cost later succeeds while condition still holds, the automation fires and updates `lastThresholdSatisfied = true`.
  - Legacy automations (no resourceCost): behavior unchanged.
- Performance:
  - Micro-benchmark: negligible overhead for “no resourceCost” path; cost path 1–2 numeric formula evaluations and 1 spendAmount call.
- Tooling / A11y:
  - No UI changes; a11y tests unaffected. Run pnpm test:a11y if any shell-web changes occur (N/A here).

## 11. Risks & Mitigations
- Risk: Atomicity violations if accessor not wired correctly.
  - Mitigation: Spend synchronously inside tick before enqueue; unit tests enforce order.
- Risk: Determinism drift from time-based calculations.
  - Mitigation: Reuse current step timestamping; no wall-clock usage.
- Risk: Back-compat regressions in content without resourceCost.
  - Mitigation: Guard logic branches; existing tests must pass unchanged.
- Risk: Formula misuse (NaN/negative/Infinity).
  - Mitigation: Sanitize and clamp; log telemetry warning on invalid inputs (follow-up).

## 12. Rollout Plan
- Milestones:
  - Phase 1 PR (core): merged after approval by Jordan Hans and runtime maintainer.
  - Phase 2 PRs (docs, content): land after core available on main.
- Migration Strategy:
  - No data migration; save/export unaffected.
  - Sample pack updated to include resourceCost.
- Communication:
  - Release notes: “Automations now enforce and deduct resourceCost.”
  - Update docs and point content authors to new semantics.

## 13. Open Questions
- Should resourceCost.rate support non-constant formulas in this iteration? Owner: Runtime Implementation Agent. Status: TODO.
- Should we reject negative/NaN/Infinity with validation or clamp to 0? Owner: Runtime Implementation Agent. Status: TODO.
- Do we need telemetry events for spend success/failure now? Owner: Core Runtime Team. Status: TODO.
- Is a future SPEND_RESOURCE command desirable for cross-system parity? Owner: Core Runtime Team. Status: TODO.

## 14. Follow-Up Work
- Multi-resource costs and conditional cost expressions. Owner: Core Runtime Team.
- Telemetry events for automation cost attempts. Owner: Core Runtime Team.
- Authoring guide improvements (examples for complex formulas). Owner: Docs Agent.
- Consider transactional command queue patterns for broader atomic sequences. Owner: Core Runtime Team.

## 15. References
- Issue scope: https://github.com/hansjm10/Idle-Game-Engine/issues/348
- TODO in code: packages/core/src/automation-system.ts:302
- ResourceStateReader interface: packages/core/src/automation-system.ts:504
- Threshold evaluation: packages/core/src/automation-system.ts:547
- Enqueue path: packages/core/src/automation-system.ts:620
- ResourceState API (spendAmount): packages/core/src/resource-state.ts:148 (interface); implementation with index assertion: 666–716
- Adapter: packages/core/src/automation-resource-state-adapter.ts:1
- Sample content automations (cost removed): packages/content-sample/content/pack.json:366
- Authoring guide (resourceCost examples): docs/automation-authoring-guide.md:41
- Content schema (resourceCost): packages/content-schema/src/modules/automations.ts:95

## Appendix A — Glossary
- Automation: A content-defined rule that automatically schedules a runtime command based on a trigger.
- resourceCost: Optional automation property defining a resource and a formula (rate) to deduct when the automation fires.
- Determinism: Property ensuring identical inputs produce identical outputs across runs.

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2025-11-09 | Design-Authoring Agent (AI) | Initial draft aligning to issue-348 and repo state |
