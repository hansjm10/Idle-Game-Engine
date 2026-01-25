---
title: Test Game Content Pack Design
sidebar_position: 99
---

# Test Game Content Pack Design

## Document Control
- **Title**: Create comprehensive test game to validate engine features
- **Authors**: Idle Engine Team
- **Reviewers**: Project maintainers
- **Status**: Draft
- **Last Updated**: 2026-01-25
- **Related Issues**: [#841](https://github.com/hansjm10/Idle-Game-Engine/issues/841)
- **Execution Mode**: AI-led

## 1. Summary

This design document outlines the creation of a comprehensive test game content pack (`content-test-game`) that stress-tests the Idle-Game-Engine during development. The pack will exercise all content types, formulas, conditions, and shell integrations to discover edge cases, integration issues, and performance bottlenecks. This is an internal validation tool, not intended for merging into main or production use.

## 2. Context & Problem Statement

- **Background**: The Idle-Game-Engine has grown to include numerous subsystems: resources, generators, upgrades, achievements, automations, transforms, entities, prestige layers, metrics, and runtime events. The existing `@idle-engine/content-sample` provides reference implementations but is designed for documentation rather than exhaustive edge-case testing.

- **Problem**: There is no systematic way to validate that all engine features work correctly together in a real game context. Integration issues between core systems, edge cases in formulas and conditions, and performance bottlenecks with many active systems may go undetected until they surface in actual game development.

- **Forces**:
  - The test pack must exercise every content type defined in `@idle-engine/content-schema`
  - Must integrate with WebGPU/Electron shell (`@idle-engine/shell-desktop`)
  - Must test state management: save/load, offline catch-up, deterministic replay
  - Should use exaggerated values to stress-test edge cases
  - Not intended for polish, balance, or production readiness

## 3. Goals & Non-Goals

### Goals
1. Validate all content types compile and run correctly with `pnpm generate` and `pnpm test`
2. Exercise all formula kinds (constant, linear, exponential, polynomial, piecewise, expression)
3. Exercise all condition kinds (resource thresholds, generator levels, upgrade ownership, prestige states, flags, logical operators)
4. Test all automation trigger types (interval, resource threshold, command queue empty, event-based)
5. Test all achievement track kinds (resource, generator-level, generator-count, upgrade-owned, flag, custom-metric)
6. Validate prestige layer mechanics with proper reset and retention
7. Test entity system with instance tracking, stats, leveling, and mission deployment
8. Validate transform/mission system including multi-stage missions with decisions
9. Test shell integration: WebGPU rendering, Electron IPC, controls input binding
10. Verify save/load cycle with RNG preservation and offline catch-up

### Non-Goals
- Polished UI/UX
- Balanced gameplay
- Production-ready assets
- Performance optimization (beyond identifying issues)
- Localization
- Merging into main branch

## 4. Stakeholders, Agents & Impacted Surfaces

### Primary Stakeholders
- Engine development team

### Agent Roles
- **Content Implementation Agent**: Creates the content pack JSON with all content types
- **Test Validation Agent**: Ensures all tests pass and documents discovered issues
- **Shell Integration Agent**: Tests WebGPU/Electron integration

### Affected Packages/Services
- `packages/content-test-game` (new package)
- `@idle-engine/core` (runtime being validated)
- `@idle-engine/content-schema` (schema types to exercise)
- `@idle-engine/content-compiler` (compilation validation)
- `@idle-engine/shell-desktop` (WebGPU/Electron shell)
- `@idle-engine/controls` (input binding)

### Compatibility Considerations
- Must target engine version `>=0.5.0` to use all features including entities
- Content pack will not be published to npm
- No backward compatibility requirements as this is internal tooling

## 5. Current State

### Existing Content Infrastructure
- `packages/content-sample/` provides reference content pack with space theme
  - Located at `packages/content-sample/content/pack.json` (~34KB)
  - Includes resources, generators, upgrades, prestige layer, automations
  - Generated artifacts in `content/compiled/` and `src/generated/`
- Content compilation via `tools/content-schema-cli/src/generate.js`
- TypeScript configuration requirements documented in `docs/content-dsl-usage-guidelines.md`

### Shell Architecture
- `packages/shell-desktop/` provides Electron + WebGPU integration
  - Main process: `src/main.ts` (12KB)
  - Simulation worker: `src/sim-worker.ts` (3KB)
  - Preload script: `src/preload.cts` (1.6KB)
  - Renderer components in `src/renderer/`
- IPC channels: `ping`, `onFrame`, `onSimStatus`, `sendControlEvent`

### Controls System
- `packages/controls/src/index.ts` (12KB)
- Keyboard/mouse input bindings
- Control event phases: start, repeat, end
- Modifier key handling (alt, ctrl, meta, shift)

## 6. Proposed Solution

### 6.1 Architecture Overview

Create a new workspace package `packages/content-test-game/` that mirrors the structure of `packages/content-sample/` but focuses on comprehensive feature coverage rather than documentation clarity.

```
packages/content-test-game/
├── content/
│   ├── pack.json           # Main content definition
│   ├── event-types.json    # Custom runtime event declarations
│   ├── events/             # Event schema files
│   │   └── *.json          # Zod/JSON Schema definitions
│   ├── schemas/            # Additional validation schemas
│   └── compiled/           # Generated artifacts
├── src/
│   ├── index.ts            # Re-exports
│   ├── generated/          # Compiler output
│   └── *.test.ts           # Validation tests
├── package.json
├── tsconfig.json
├── eslint.config.js
└── vitest.config.ts
```

### 6.2 Detailed Design

#### 6.2.1 Resources (8-10 resources)

| Resource ID | Category | Tier | Purpose |
|-------------|----------|------|---------|
| `test-game.gold` | primary | 0 | Base soft currency, starts at 100 |
| `test-game.gems` | currency | 1 | Hard currency (premium simulation) |
| `test-game.mana` | primary | 1 | Resource with capacity constraint (cap: 1000) |
| `test-game.essence` | primary | 2 | Tier 2, unlocks via gold threshold |
| `test-game.dark-matter` | primary | 2 | Resource with dirty tolerance edge case (0.001) |
| `test-game.auto-tokens` | automation | 1 | Consumed by automations |
| `test-game.prestige-points` | prestige | 3 | Primary prestige currency, retained |
| `test-game.omega-points` | prestige | 4 | Secondary prestige currency |
| `test-game.prestige-count` | misc | 3 | Counter for first prestige layer |
| `test-game.omega-count` | misc | 4 | Counter for second prestige layer |

#### 6.2.2 Generators (6-8 generators)

| Generator ID | Production | Consumption | Purchase Model | Notes |
|--------------|------------|-------------|----------------|-------|
| `test-game.gold-mine` | gold | none | Single currency, exponential (growth: 1.15) | Basic generator, maxLevel: 50 |
| `test-game.gem-extractor` | gems | gold | Multi-currency, linear | Drains gold to produce gems |
| `test-game.mana-well` | mana | none | Single currency, polynomial | Tests polynomial cost curves |
| `test-game.essence-refinery` | essence | gold, mana | Multi-currency, piecewise | Complex unlock: allOf conditions |
| `test-game.auto-factory` | auto-tokens | gems | Single currency, exponential | maxBulk: 25 |
| `test-game.prestige-reactor` | prestige-points | dark-matter | Single currency | Visible only after prestige |
| `test-game.omega-forge` | omega-points | prestige-points | Multi-currency | Secondary prestige generator |

#### 6.2.3 Upgrades (10-15 upgrades)

| Upgrade ID | Target Type | Category | Notes |
|------------|-------------|----------|-------|
| `test-game.gold-boost` | resource | global | +25% gold production |
| `test-game.gem-efficiency` | generator | generator | -10% gem-extractor cost |
| `test-game.auto-speed` | automation | automation | -15% automation cooldowns |
| `test-game.prestige-multiplier` | prestigeLayer | prestige | +50% prestige rewards |
| `test-game.global-multiplier` | global | global | +10% all production |
| `test-game.mana-capacity` | resource | resource | +500 mana capacity |
| `test-game.essence-rate-1` | resource | resource | One-time essence boost |
| `test-game.essence-rate-2` | resource | resource | Repeatable (max: 10), prerequisite chain |
| `test-game.multi-currency-upgrade` | generator | generator | Costs gold + gems + mana |
| `test-game.dark-matter-unlock` | resource | resource | Unlocks dark-matter production |
| `test-game.expression-upgrade` | resource | resource | Uses expression formula for effect |

#### 6.2.4 Achievements (8-12 achievements)

| Achievement ID | Track Kind | Tier | Progress Mode | Notes |
|----------------|------------|------|---------------|-------|
| `test-game.first-gold` | resource | bronze | oneShot | gold >= 1 |
| `test-game.gold-hoarder` | resource | silver | incremental | gold >= 10000 |
| `test-game.mine-master` | generator-level | gold | oneShot | gold-mine level >= 25 |
| `test-game.generator-collector` | generator-count | bronze | oneShot | 5 total generators |
| `test-game.upgrade-collector` | upgrade-owned | silver | incremental | 10 upgrades owned |
| `test-game.auto-enabled` | flag | bronze | oneShot | automation-enabled flag |
| `test-game.custom-tracker` | custom-metric | gold | repeatable | Custom metric threshold |
| `test-game.prestige-pioneer` | resource | platinum | oneShot | First prestige points |
| `test-game.all-tiers` | resource | platinum | oneShot | Tests allOf with all resource tiers |

#### 6.2.5 Automations (4-6 automations)

| Automation ID | Trigger | Target Type | Notes |
|---------------|---------|-------------|-------|
| `test-game.auto-gold-mine` | interval (5000ms) | purchaseGenerator | Auto-buy gold mines |
| `test-game.auto-collect-gems` | resourceThreshold (gold >= 1000) | collectResource | Collect gems when gold high |
| `test-game.auto-upgrade` | commandQueueEmpty | upgrade | Purchase next available upgrade |
| `test-game.auto-prestige` | event (prestige-ready) | system | System target: execute prestige |
| `test-game.auto-generator-toggle` | resourceThreshold (mana <= 100) | generator | Toggle generator off when mana low |
| `test-game.formula-cooldown-auto` | interval | purchaseGenerator | Formula-based cooldown |

#### 6.2.6 Entities (2-3 entity types)

| Entity ID | Stats | Progression | Notes |
|-----------|-------|-------------|-------|
| `test-game.hero` | power, speed, luck | XP-based, max level 50 | trackInstances: true, max 5 |
| `test-game.worker` | efficiency, stamina | Level formula: linear | trackInstances: true, max 10 |
| `test-game.artifact` | bonus | No progression | trackInstances: false, count-based |

#### 6.2.7 Transforms/Missions (2-3 transforms)

| Transform ID | Mode | Notes |
|--------------|------|-------|
| `test-game.refine-essence` | instant | Basic transform: gold -> essence |
| `test-game.batch-production` | batch | 30s duration, tests outstanding batches |
| `test-game.expedition` | mission | Multi-stage with decision point |

Mission `test-game.expedition` stages:
1. **travel** (30s): Checkpoint outputs small reward
2. **explore** (60s): Decision: safe path vs risky shortcut
3. **return** (30s): Final resolution with success rate based on hero stats

#### 6.2.8 Prestige Layers (2 layers)

| Layer ID | Unlocks When | Resets | Rewards |
|----------|--------------|--------|---------|
| `test-game.ascension` | essence >= 10000 AND gold-mine >= 20 | Tier 0-1 resources, generators, upgrades | prestige-points (formula-based) |
| `test-game.omega` | prestige-points >= 1000 AND ascension count >= 5 | Tier 0-2 + first prestige | omega-points |

#### 6.2.9 Metrics (3-5 custom metrics)

| Metric ID | Kind | Source | Notes |
|-----------|------|--------|-------|
| `test-game.total-gold-earned` | counter | runtime | Cumulative gold |
| `test-game.current-dps` | gauge | content | Damage per second |
| `test-game.mission-duration` | histogram | content | Distribution of mission times |

#### 6.2.10 Runtime Events (2-3 custom events)

| Event ID | Payload Schema | Notes |
|----------|----------------|-------|
| `test-game.milestone-reached` | Zod schema | Emitted when achievements unlock |
| `test-game.prestige-ready` | JSON Schema | Triggers auto-prestige automation |
| `test-game.mission-complete` | Zod schema | Mission outcome event |

#### 6.2.11 Formula Coverage

The pack will include examples of all formula kinds:

- **Constant**: Base costs, fixed values
- **Linear**: Generator rates (`base + level * slope`)
- **Exponential**: Cost curves (`base * growth^level + offset`)
- **Polynomial**: Complex scaling curves
- **Piecewise**: Level-dependent formula switching
- **Expression**: Custom calculations with:
  - Resource/generator/upgrade references
  - Binary operators: +, -, *, /, %, ^, min, max
  - Unary operators: abs, ceil, floor, round, sqrt, ln
  - Conditionals: if-then-else
  - Clamp and bounds

#### 6.2.12 Condition Coverage

All condition kinds will be tested:

- `always` / `never`: Unconditional gates
- `resourceThreshold`: All comparators (gte, gt, lte, lt)
- `generatorLevel`: Generator level checks
- `upgradeOwned`: Upgrade ownership checks
- `prestigeCountThreshold`: Prestige count comparisons
- `prestigeCompleted`: Post-prestige gates
- `prestigeUnlocked`: Available prestige gates
- `flag`: Flag-based conditions
- Logical operators: `allOf`, `anyOf`, `not`
- Nested conditions: Depth 3+ nesting

### 6.3 Operational Considerations

#### Deployment
- Package will be created as `packages/content-test-game/`
- Not published to npm (`"private": true`)
- Not intended for main branch merge

#### Telemetry & Observability
- Custom metrics will exercise the metrics system
- Runtime event emission will be logged
- Performance metrics can be collected during stress testing

#### Security & Compliance
- No external dependencies beyond workspace packages
- No PII or sensitive data

## 7. Work Breakdown & Delivery Plan

### 7.1 Issue Map

| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| Create package scaffold | Package structure, configs | Content Implementation Agent | None | `pnpm build` succeeds |
| Implement resources | 8-10 resources with all categories | Content Implementation Agent | Scaffold | Resources compile |
| Implement generators | 6-8 generators with various purchase models | Content Implementation Agent | Resources | Generators compile |
| Implement upgrades | 10-15 upgrades covering all target types | Content Implementation Agent | Generators | Upgrades compile |
| Implement achievements | 8-12 achievements with all track kinds | Content Implementation Agent | Upgrades | Achievements compile |
| Implement automations | 4-6 automations with all trigger types | Content Implementation Agent | Achievements | Automations compile |
| Implement entities | 2-3 entity types with progression | Content Implementation Agent | Automations | Entities compile |
| Implement transforms | 2-3 transforms including mission | Content Implementation Agent | Entities | Transforms compile |
| Implement prestige layers | 2 prestige layers | Content Implementation Agent | Transforms | Prestige compiles |
| Implement metrics & events | Custom metrics and runtime events | Content Implementation Agent | Prestige | All content compiles |
| Add validation tests | Test suites for content validation | Test Validation Agent | All content | Tests pass |
| Shell integration testing | Manual testing with shell-desktop | Shell Integration Agent | All content | Shell runs test game |

### 7.2 Milestones

**Phase 1: Content Pack Foundation**
- Package scaffold with proper configuration
- Resources and generators implementation
- Upgrades and achievements implementation
- Gating: `pnpm generate` succeeds, basic tests pass

**Phase 2: Advanced Systems**
- Automations implementation
- Entities and transforms/missions implementation
- Prestige layers implementation
- Metrics and runtime events
- Gating: All content types compile, tests pass

**Phase 3: Integration Validation**
- Shell integration testing
- Save/load cycle verification
- Offline catch-up testing
- Issue discovery and documentation
- Gating: Full feature coverage validated

### 7.3 Coordination Notes

**Hand-off Package**:
- Content DSL documentation: `docs/content-dsl-usage-guidelines.md`
- Schema reference: `packages/content-schema/src/`
- Sample pack reference: `packages/content-sample/`

**Communication Cadence**:
- Issues discovered during testing should be filed as separate GitHub issues
- Progress updates in `ralph/progress.txt`

## 8. Agent Guidance & Guardrails

### Context Packets
- Read `docs/content-dsl-usage-guidelines.md` for authoring patterns
- Read `docs/content-quick-reference.md` for condensed cheatsheet
- Reference `packages/content-sample/content/pack.json` for structure
- Reference `packages/content-sample/tsconfig.json` for TypeScript config
- Reference `packages/content-sample/eslint.config.js` for ESLint config

### Prompting & Constraints
- Use Conventional Commits: `feat(test-game): description`
- Content IDs must be prefixed with `test-game.`
- All JSON must pass `pnpm generate` validation
- TypeScript must pass `pnpm typecheck`

### Safety Rails
- Do not modify existing packages beyond adding workspace dependency
- Do not commit broken content that fails `pnpm generate`
- Do not add production dependencies
- Do not push to main branch

### Validation Hooks
Before marking tasks complete:
```bash
pnpm generate                    # Content compiles
pnpm lint:fast                   # Linting passes
pnpm typecheck                   # Types check
pnpm --filter @idle-engine/content-test-game test  # Tests pass
```

## 9. Alternatives Considered

### Alternative 1: Extend content-sample
**Rejected**: The sample pack is designed for documentation clarity and should remain a clean reference. Mixing edge-case testing would compromise its pedagogical value.

### Alternative 2: Multiple small test packs
**Rejected**: A single comprehensive pack better tests integration between systems. Multiple packs would miss cross-system interaction issues.

### Alternative 3: Procedurally generated content
**Rejected**: Hand-crafted content allows targeted testing of specific edge cases. Generated content might miss important scenarios.

## 10. Testing & Validation Plan

### Unit / Integration
- Vitest test suites for content validation
- Snapshot tests for progression views
- Formula evaluation tests for edge cases
- Condition evaluation tests for all comparators

### Performance
- Tick simulation with 1000+ ticks: `pnpm core:tick-sim --ticks 1000`
- Economy verification: `pnpm core:economy-verify`
- Profile with many active generators and automations

### Shell Testing
- Manual testing with Electron shell
- WebGPU render command buffer consumption
- Canvas resize handling
- Device lost recovery
- IPC channel communication

### State Management
- Save/load cycle with RNG preservation
- Offline catch-up: 1h, 6h, 12h gaps
- Deterministic replay validation

## 11. Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Schema changes during development | High | Medium | Track content-schema version, update pack as needed |
| Shell integration issues | Medium | Medium | Document issues, create separate bug reports |
| Test pack becomes outdated | Medium | High | Keep pack in sync with schema evolution |
| Edge cases cause runtime crashes | High | Low | Catch errors, document for fixing |

## 12. Rollout Plan

### Milestones
1. Package scaffold and configuration
2. Core content types (resources, generators, upgrades)
3. Advanced content types (achievements, automations, entities)
4. System content types (transforms, prestige, metrics, events)
5. Integration testing and issue documentation

### Migration Strategy
Not applicable - this is a new package for internal testing.

### Communication
- Progress tracked in `ralph/progress.txt`
- Issues discovered filed as GitHub issues with `discovered-by: test-game` label

## 13. Open Questions

1. Should the test game use a specific theme or remain abstract/generic?
2. What exaggerated values are appropriate for stress testing without causing overflow?
3. Should the pack include intentionally broken content to test error handling?
4. How should discovered issues be prioritized relative to other work?

## 14. Follow-Up Work

- Performance benchmarking tooling based on test game results
- Automated regression testing using test game as baseline
- Documentation of discovered edge cases and resolutions
- Potential extraction of reusable test patterns

## 15. References

- Issue: [#841 - feat(test-game): Create comprehensive test game to validate engine features](https://github.com/hansjm10/Idle-Game-Engine/issues/841)
- Content DSL Guide: `docs/content-dsl-usage-guidelines.md`
- Content Quick Reference: `docs/content-quick-reference.md`
- Schema Design: `docs/content-dsl-schema-design.md`
- Sample Pack: `packages/content-sample/`
- Shell Desktop: `packages/shell-desktop/`
- Controls: `packages/controls/`

## Appendix A - Glossary

| Term | Definition |
|------|------------|
| Content Pack | A collection of game content definitions (resources, generators, etc.) validated by `@idle-engine/content-schema` |
| PRD | Pseudo-Random Distribution - deterministic RNG algorithm that reduces streakiness |
| Track | Achievement progress source (resource, generator-level, upgrade-owned, etc.) |
| Transform | Conversion recipe that converts inputs to outputs |
| Mission | Special transform mode that deploys entities with success/failure outcomes |

## Appendix B - Change Log

| Date | Author | Change Summary |
|------|--------|----------------|
| 2026-01-25 | Idle Engine Team | Initial draft |
