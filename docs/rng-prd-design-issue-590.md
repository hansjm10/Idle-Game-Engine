---
title: RNG PRD Design (Issue 590)
sidebar_position: 4
---

# RNG PRD Design (Issue 590)

## Document Control
- **Title**: Implement deterministic Pseudo-Random Distribution (PRD) for mission success rolls
- **Authors**: Runtime Core Team
- **Reviewers**: N/A
- **Status**: Draft
- **Last Updated**: 2026-01-05
- **Related Issues**: #590, #586, PR #741
- **Execution Mode**: AI-led

## 1. Summary

This design introduces Pseudo-Random Distribution (PRD) to the core RNG module and integrates it into mission-mode transforms to make repeated probability checks feel “fair” (fewer extreme streaks) while remaining deterministic. PRD state is persisted through save/load and state-sync workflows so that mission outcomes remain reproducible across offline catch-up, snapshot restore, and debugging comparisons.

## 2. Context & Problem Statement

### Background
Mission success (and similar chance-based mechanics) is currently modelled as repeated Bernoulli trials using deterministic RNG. While correct statistically, streaks are common and can feel unfair to players (e.g., multiple failures in a row at 50%).

### Problem
- Standard RNG produces streaks that feel unintuitive or “rigged” at small sample sizes, even when statistically valid.
- Without additional state, repeated checks cannot adapt based on recent outcomes.
- The runtime requires deterministic simulation (replayable from seed/state) and therefore cannot rely on external or non-deterministic entropy.
- PRD state must survive save/restore and snapshot synchronization to avoid changing outcomes after persistence boundaries.

### Forces
- **Determinism**: Outcomes must be reproducible across seeded runs, offline catch-up, and restore workflows.
- **Performance**: PRD constant calculation should avoid expensive loops at tiny probabilities.
- **Content-driven**: PRD must be opt-in per mechanic (default off) and safe for future extensions.
- **Observability**: State-sync tooling should be able to diff PRD state when debugging divergence.

## 3. Goals & Non-Goals

### Goals
- Provide a deterministic PRD implementation with stable, testable behaviour.
- Integrate PRD into mission success checks behind a content flag (`successRate.usePRD`).
- Persist PRD registry state via save formats and state-sync snapshots.
- Make divergence diagnosable via state-sync checksum and diff reporting.

### Non-Goals
- Replace the underlying seeded RNG algorithm.
- Redesign mission balance or player-facing UX messaging.
- Add UI surfacing for current PRD thresholds (engine-only; UI can query later if needed).
- Implement network authority/synchronization policies beyond existing snapshot/restore plumbing.

## 4. Stakeholders, Agents & Impacted Surfaces

### Primary Stakeholders
- Runtime Core Team: owns RNG, transforms, persistence, state-sync layers.
- Content authors: opt into PRD via transform definitions.

### Agent Roles
- Runtime Implementation Agent: PRD algorithm + registry.
- Integration Agent: mission/transform integration + runtime wiring.
- Persistence Agent: save format + snapshot/restore integration.
- Testing Agent: RNG and mission behavioural tests.
- Docs Agent: record design and reference code paths.

### Affected Packages/Services
- `packages/core`: `rng.ts`, `transform-system.ts`, save format, state-sync capture/compare/restore, wiring.
- `packages/content-schema`: transform schema adds `successRate.usePRD` with default `false`.

### Compatibility Considerations
- Save data and snapshots must tolerate missing PRD state (treat as empty registry).
- PRD registry state must remain JSON-serializable and deterministic under key ordering.
- Content that does not opt into PRD must preserve existing behaviour.

## 5. Current State

- The runtime uses a deterministic RNG (`seededRandom`) for simulation.
- Mission success checks use `seededRandom() < baseRate` with no memory between attempts.
- Save and snapshot systems persist RNG seed/state and transform/entity/resources state, but had no PRD registry state to carry adaptive probability behaviour.

## 6. Proposed Solution

### 6.1 Architecture Overview

- Add a PRD implementation (`PseudoRandomDistribution`) that maintains a per-mechanic attempt counter and a derived PRD constant `C`.
- Add a `PRDRegistry` keyed by a stable string ID (for missions: the transform ID) to store PRD state across ticks.
- Integrate PRD into mission-mode transform execution when `successRate.usePRD === true`.
- Persist registry state through:
  - game save format (`packages/core/src/game-state-save.ts`),
  - state-sync snapshot capture/checksum/compare/restore (`packages/core/src/state-sync/*`).

### 6.2 Detailed Design

#### Runtime Changes
- `packages/core/src/rng.ts`
  - `calculatePRDAverageProbability(constant)`: computes average success probability implied by a PRD constant.
    - Uses expected-attempts accumulation up to the “guaranteed success” attempt (`ceil(1/C)`).
    - For extremely small constants (where `ceil(1/C)` would be too large), uses a continuous approximation (`sqrt((2C)/pi)`) to avoid huge loops.
  - `calculatePRDConstant(probability)`: binary searches for a constant `C` whose implied average probability matches the desired base rate.
  - `PseudoRandomDistribution`:
    - `roll()` increments attempts, computes `threshold = min(1, C * attempts)`, and resets attempts on success.
    - `getState()` returns `{ attempts, constant }` for persistence.
    - `restore(state)` normalizes non-finite values and derives `baseProbability` from the restored constant.
    - `updateBaseProbability(baseProbability)` recalculates `C` when the base rate meaningfully changes; tiny deltas (including near zero) are ignored via mixed relative/absolute tolerances. Attempt counters are preserved across significant base-rate changes, except when crossing edge probabilities (0 or 1), where attempts reset to avoid “banking” pity across impossible/guaranteed configurations.
  - `PRDRegistry`:
    - `getOrCreate(id, baseProbability)` returns a stable PRD instance per ID and updates the base probability if re-requested.
    - `captureState()` and `restoreState(states | undefined)` serialize/restore a JSON record keyed by ID.

#### Data & Schemas
- `packages/core`
  - Save format adds optional `prd?: SerializedPRDRegistryState` where each entry stores `attempts` and `constant`.
  - State-sync snapshot (`GameStateSnapshot`) includes `prd: SerializedPRDRegistryState` as an authoritative snapshot field (empty `{}` when no PRD state exists).
- `packages/content-schema/src/modules/transforms.ts`
  - `successRate.usePRD: boolean` (default `false`) allows content to opt into PRD for mission success rolls.

#### APIs & Contracts
- `SerializedPRDRegistryState` is a plain JSON object (`Record<string, PRDState>`) and must remain deterministic under key sort for checksum/diff tooling.
- PRD IDs must be stable across runs for persistence and synchronization; for missions, the transform ID is used.

#### Tooling & Automation
- State-sync:
  - `packages/core/src/state-sync/checksum.ts` includes PRD state in deterministic checksum (excluding `capturedAt`).
  - `packages/core/src/state-sync/compare.ts` reports PRD diffs per ID (`attempts`, `constant`) to help diagnose divergence.
  - `packages/core/src/state-sync/restore-runtime.ts` restores PRD registry state into the wired runtime.

### 6.3 Operational Considerations

#### Deployment
- PRD behaviour is content-gated; default behaviour remains unchanged for content that does not set `usePRD: true`.

#### Telemetry & Observability
- State-sync diff output includes PRD deltas to identify whether RNG divergence is due to PRD attempt counters/constants or other state.

#### Security & Compliance
- No PII involved. PRD state is numeric and content-keyed only.

## 7. Work Breakdown & Delivery Plan

### 7.1 Issue Map

| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| `feat(core): implement PRD algorithm + registry` | Add constant calculation, PRD state machine, registry capture/restore | Runtime Implementation Agent | #590 | Unit tests cover determinism, streak bounds, tiny-probability behaviour |
| `feat(core): integrate PRD into mission transforms` | Use PRD on mission success checks behind `successRate.usePRD` | Integration Agent | Transform mission execution | PRD drives outcomes deterministically when enabled; unchanged behaviour when disabled |
| `feat(core): persist PRD through save + state-sync` | Save/hydrate + snapshot/checksum/compare/restore include PRD state | Persistence Agent | PRD registry exists | Save/load and snapshot restore preserve PRD attempt counters/constants |
| `test(core): expand PRD + mission coverage` | Add targeted tests for PRD registry and mission integration | Testing Agent | Above slices | `pnpm --filter @idle-engine/core test` passes |
| `docs: add PRD design document` | Document structure and code references | Docs Agent | Implementation ready | Design doc added using template headings |

### 7.2 Milestones
- **Phase 1**: Implement PRD + registry and unit tests.
- **Phase 2**: Integrate into mission transforms behind `usePRD`.
- **Phase 3**: Persist PRD state through save + state-sync and add diff/restore validation.

### 7.3 Coordination Notes
- **Hand-off Package**: `packages/core/src/rng.ts`, `packages/core/src/transform-system.ts`, `packages/core/src/game-state-save.ts`, `packages/core/src/state-sync/*`, `packages/content-schema/src/modules/transforms.ts`.
- **Communication Cadence**: PR review checkpoints at each phase boundary; treat state-sync checksum changes as a gating signal for correctness.

## 8. Agent Guidance & Guardrails

### Context Packets
- Related design docs: `docs/runtime-command-queue-design.md`, `docs/state-synchronization-protocol-design.md`, `docs/progression-coordinator-design.md`.
- Issue context: #590 (PRD), #586 (entity/mission system parent).

### Prompting & Constraints
- Keep simulation deterministic; avoid sources of entropy beyond `seededRandom`/captured RNG state.
- Prefer pure functions in PRD computation and stable key ordering for serialized shapes.

### Safety Rails
- Do not edit checked-in `dist/` outputs by hand.
- Do not add logging that could pollute deterministic test reporters.

### Validation Hooks
- `pnpm lint`
- `pnpm --filter @idle-engine/core test`
- `pnpm typecheck`

## 9. Alternatives Considered

- **Pure uniform RNG**: simplest, but produces streaks that feel unfair and offers no adaptive behaviour.
- **Hard streak caps / forced success after N failures**: easy to implement but distorts average probability and is more exploitable/visible.
- **Weighted history window / pity timer curves**: flexible, but harder to reason about, harder to serialize compatibly, and less standardized than PRD.

## 10. Testing & Validation Plan

- **Unit / Integration**
  - `packages/core/src/rng-prd.test.ts`: constant calculation, determinism, streak bounds, restore normalization, registry capture/restore.
  - `packages/core/src/__tests__/transform-system/mission-mode.test.ts`: mission execution uses PRD when enabled and preserves determinism.
  - `packages/core/src/game-state-save.test.ts`: roundtrips PRD registry through save/load.
  - `packages/core/src/state-sync/*.test.ts`: checksum and compare include PRD state and restore-runtime applies it.
- **Performance**
  - Ensure constant calculation avoids pathological loops for tiny probabilities (continuous approximation path).

## 11. Risks & Mitigations

- **Risk: PRD constant calculation cost at tiny probabilities**  
  Mitigation: cap attempt loops and use continuous approximation for large `ceil(1/C)`.
- **Risk: Base-rate jitter resets attempt counters unexpectedly**  
  Mitigation: apply mixed relative/absolute epsilon threshold before recalculating constant and resetting attempts.
- **Risk: PRD key scoping too coarse or too fine**  
  Mitigation: start with transform ID; if future mechanics require separate PRD streams per entity/instance, extend ID scheme explicitly and migrate save state.
- **Risk: Missing PRD state on restore changes outcomes**  
  Mitigation: treat missing state as empty registry; content can accept reset-on-restore semantics for first-run or legacy saves.

## 12. Rollout Plan

- **Milestones**: Land PRD + integration + persistence behind `successRate.usePRD` (default off).
- **Migration Strategy**: Save and snapshot formats treat missing `prd` as empty; no schema version bump required for opt-in behaviour.
- **Communication**: Document the flag in transform schema and call out determinism implications in mission system docs when added.

## 13. Open Questions

- Should mission PRD IDs incorporate additional scoping (e.g., content pack version, mission difficulty tier) to avoid unintentionally sharing state between logically distinct rolls?
- Do we want to expose PRD “current probability” via runtime APIs for UI display/debug tooling?

## 14. Follow-Up Work

- Add a dedicated “Mission & PRD” section to content authoring docs with examples once the mission system stabilizes.
- Consider adding a small debug hook to export PRD registry state through diagnostics timelines when investigating divergence.

## 15. References

- Issue: https://github.com/hansjm10/Idle-Game-Engine/issues/590
- PR: https://github.com/hansjm10/Idle-Game-Engine/pull/741
- Core implementation: `packages/core/src/rng.ts`, `packages/core/src/transform-system.ts`
- Persistence: `packages/core/src/game-state-save.ts`
- State sync: `packages/core/src/state-sync/capture.ts`, `packages/core/src/state-sync/checksum.ts`, `packages/core/src/state-sync/compare.ts`, `packages/core/src/state-sync/restore-runtime.ts`
- Content schema flag: `packages/content-schema/src/modules/transforms.ts`
- External background: https://liquipedia.net/dota2/Pseudo_Random_Distribution

## Appendix A — Glossary

- **PRD**: Pseudo-Random Distribution; a stateful probability scheme that increases success chance after failures to reduce streakiness while matching the desired average rate.
- **Base Rate**: The intended long-run success probability authored in content.
- **Constant (`C`)**: The derived PRD step constant used to compute per-attempt thresholds.

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2026-01-05 | Runtime Core Team | Initial draft for PRD implementation (Issue #590) |
