---
title: Runtime Automation Execution System Design
sidebar_position: 12
---

# Runtime Automation Execution System Design

## Document Control
- **Title**: Runtime automation execution system
- **Authors**: Claude Code (AI Assistant)
- **Reviewers**: Engineering team, content designers
- **Status**: Draft
- **Last Updated**: 2025-11-03
- **Related Issues**: #319
- **Execution Mode**: AI-led

## 1. Summary

Automations are fully schematized in `@idle-engine/content-schema` but not executed by the runtime, creating a critical gap for idle game mechanics. This design specifies a new `AutomationSystem` that evaluates four trigger types (interval, resourceThreshold, commandQueueEmpty, event), manages automation state (enabled/disabled, cooldowns, last-fired timestamps), and enqueues commands at `CommandPriority.AUTOMATION` when triggers activate. The system integrates with the existing `IdleEngineRuntime` tick loop, `EventBus`, and `ProgressionCoordinator` to enable content-driven automated gameplay without manual player intervention.

## 2. Context & Problem Statement

### Background
The Idle Game Engine is a data-driven idle game framework where game mechanics are defined in content packs (JSON) and executed by a deterministic runtime. The content schema (`packages/content-schema/src/modules/automations.ts`) defines a complete automation DSL supporting:

- **4 trigger types**: `interval`, `resourceThreshold`, `commandQueueEmpty`, `event`
- **Target types**: `generator`, `upgrade`, `system`
- **Optional features**: cooldowns, resource costs, unlock conditions, toggle state
- **Supporting events**: `automation:toggled`, `resource:threshold-reached`

The runtime (`packages/core/src/index.ts`) provides:
- System registration via `IdleEngineRuntime.addSystem()`
- Fixed-step tick loop (default 100ms)
- Command queue with `CommandPriority.AUTOMATION` priority tier
- Event bus for inter-system communication

However, **no automation system implementation exists**. Content packs can define automations, but these definitions are validated and then ignored during gameplay.

### Problem
Without automation execution, the engine fails to deliver on the core promise of "idle" gameplay:

1. **Manual clicking required**: Players must manually trigger generators and upgrades, defeating idle mechanics
2. **Dead schema**: Automation definitions are validated but never executed, creating confusion
3. **Missing core loop**: Idle games require automation → offline progress → prestige, but only the first step is missing
4. **Wasted infrastructure**: Events (`automation:toggled`), priority tiers (`CommandPriority.AUTOMATION`), and trigger schemas exist but remain unused

### Forces
- **Performance budget**: Automation evaluation must complete within per-tick budget (&lt;2ms for trigger checks)
- **Determinism**: Trigger evaluation must be reproducible across replays and platforms
- **Content flexibility**: Content authors should define automation logic without code changes
- **State persistence**: Automation state (enabled, cooldown, last-fired) must survive saves/loads
- **Backward compatibility**: Existing saves without automation state must migrate cleanly

## 3. Goals & Non-Goals

### Goals
1. **Execute all four trigger types** (`interval`, `resourceThreshold`, `commandQueueEmpty`, `event`) as specified in schema
2. **Enqueue commands** at `CommandPriority.AUTOMATION` when triggers activate
3. **Persist automation state** (enabled/disabled, cooldown timers, last-fired step) in save files
4. **Respect unlock conditions** (automations unlock/lock dynamically based on progression)
5. **Honor cooldowns** (prevent rapid-fire triggers via cooldown enforcement)
6. **Support resource costs** (deduct resources when automation fires, skip if insufficient)
7. **Provide toggle API** (enable/disable automations via commands, publish `automation:toggled` events)
8. **Deterministic evaluation** (same step + same state = same trigger decisions)

### Non-Goals
- **Custom scripting**: No Lua/JS execution for custom trigger logic (use existing schema only)
- **UI implementation**: Dashboard for automation management (deferred to #320+)
- **Priority configuration**: Automation execution order within AUTOMATION priority tier (FIFO for MVP)
- **A/B testing hooks**: Telemetry for automation effectiveness (deferred to analytics milestone)
- **Cross-automation dependencies**: Triggers based on other automation states (future work)

## 4. Stakeholders, Agents & Impacted Surfaces

### Primary Stakeholders
- **Runtime engineering team**: Implementation and integration
- **Content designers**: Defining automations in content packs
- **QA engineers**: Testing automation behavior and edge cases

### Agent Roles
- **Runtime Implementation Agent**: Core automation system, trigger evaluators, state management
- **Testing Agent**: Unit tests, integration tests, property-based tests for trigger logic
- **Migration Agent**: Schema migration for save file compatibility
- **Documentation Agent**: API docs, content authoring guide for automations

### Affected Packages/Services
- `packages/core`: New `AutomationSystem`, state types, command handlers
- `packages/shell-web`: Integration into `runtime.worker.ts`, save migrations
- `packages/content-schema`: No changes (schema already complete)
- `packages/content-sample`: Example automations for testing and reference

### Compatibility Considerations
- **Save migration**: Add automation state to existing saves (default: all automations disabled)
- **Content versioning**: Automations are optional; packs without them function unchanged
- **Event compatibility**: `automation:toggled` and `resource:threshold-reached` events already defined

## 5. Current State

### Existing Infrastructure

**Automation Schema** (`packages/content-schema/src/modules/automations.ts:1-184`):
- Fully defined with Zod validation
- Supports 4 trigger types via discriminated union
- Includes cooldown, resource cost, unlock condition, enabled-by-default fields
- Validates target types (generator/upgrade/system)

**Event System** (`packages/core/src/events/runtime-event-catalog.ts:1-70`):
- `automation:toggled` event (id, enabled)
- `resource:threshold-reached` event (resourceId, threshold)
- Event channels registered in `RUNTIME_EVENT_CHANNELS`

**Command Queue** (`packages/core/src/command-queue.ts:34-37`):
- Three priority lanes: SYSTEM (0), PLAYER (1), AUTOMATION (2)
- Priority-based dequeuing via `COMMAND_PRIORITY_ORDER`

**Runtime Architecture** (`packages/core/src/index.ts:82-156`):
- `IdleEngineRuntime.addSystem()` for system registration
- System lifecycle: `setup(context)` for event subscriptions, `tick(context)` for per-step execution
- Fixed-step tick loop with deterministic command dispatch

**Progression Coordinator** (`packages/shell-web/src/modules/progression-coordinator.ts:1-100`):
- Manages resource, generator, upgrade state
- Provides purchase evaluators for cost calculations
- Hydrates state from serialized saves

### Gaps
- ❌ No `AutomationSystem` implementation
- ❌ No trigger evaluation logic (interval timers, threshold checks, event listeners)
- ❌ No automation state tracking (enabled/disabled, cooldown, last-fired)
- ❌ No command enqueueing when triggers fire
- ❌ No system registered in `runtime.worker.ts`
- ❌ No save migration for automation state

## 6. Proposed Solution

### 6.1 Architecture Overview

The `AutomationSystem` is a runtime system registered with `IdleEngineRuntime` that:

1. **Loads automations** from content pack during initialization
2. **Subscribes to events** during `setup()` (for event-based and threshold triggers)
3. **Evaluates triggers** on every `tick()` (interval, threshold, queue-empty checks)
4. **Enqueues commands** when triggers activate and conditions are met
5. **Manages state** (enabled flags, cooldown timers, last-fired steps) in `ProgressionAuthoritativeState`

```
Content Pack (automations.json)
        ↓
AutomationSystem.loadAutomations()
        ↓
setup(context) → Subscribe to events
        ↓
tick(context) → Evaluate triggers
        ↓
   [Trigger fires?]
        ↓ yes
   [Check cooldown, unlock, resources]
        ↓ pass
   Enqueue command @ AUTOMATION priority
        ↓
CommandQueue → CommandDispatcher → Handler
```

**Trigger Evaluation Flow**:
```
Every tick:
  For each unlocked automation:
    If cooldown active → skip
    If not enabled → skip
    Evaluate trigger:
      interval → elapsed >= interval?
      resourceThreshold → resource comparator threshold?
      commandQueueEmpty → queue.size === 0?
      event → received event this tick?
    If triggered:
      Check resource cost
      Deduct resources (if cost specified)
      Enqueue command
      Update last-fired step
      Start cooldown timer
```

### 6.2 Detailed Design

#### 6.2.1 State Management

**Automation State Schema** (added to `ProgressionAuthoritativeState`):

```typescript
interface AutomationState {
  readonly id: string;
  enabled: boolean;
  lastFiredStep: number;
  cooldownExpiresStep: number;
  unlocked: boolean;
}

interface ProgressionAutomationState {
  readonly automations: Record<string, AutomationState>;
}

// Extended ProgressionAuthoritativeState
interface ProgressionAuthoritativeState {
  // ... existing fields
  automationState?: ProgressionAutomationState;
}
```

**Initialization**:
- Automations default to `enabledByDefault` from schema
- `lastFiredStep = -Infinity` (never fired)
- `cooldownExpiresStep = 0` (no cooldown)
- `unlocked` evaluated from `unlockCondition`

**Persistence**:
- Automation state serialized in save file
- Migration adds default state for old saves

#### 6.2.2 Trigger Evaluation Algorithms

**Interval Trigger**:
```typescript
function evaluateIntervalTrigger(
  automation: AutomationDefinition,
  state: AutomationState,
  currentStep: number,
  stepDurationMs: number,
): boolean {
  if (state.lastFiredStep === -Infinity) {
    return true; // Fire immediately on first tick
  }

  const intervalMs = evaluateNumericFormula(
    automation.trigger.interval,
    context,
  );
  const intervalSteps = Math.ceil(intervalMs / stepDurationMs);
  const stepsSinceLastFired = currentStep - state.lastFiredStep;

  return stepsSinceLastFired >= intervalSteps;
}
```

**Resource Threshold Trigger**:
```typescript
function evaluateResourceThresholdTrigger(
  automation: AutomationDefinition,
  resourceState: ResourceState,
  context: FormulaContext,
): boolean {
  const { resourceId, comparator, threshold } = automation.trigger;
  const resource = resourceState.getResource(resourceId);
  const thresholdValue = evaluateNumericFormula(threshold, context);

  switch (comparator) {
    case 'gte': return resource.amount >= thresholdValue;
    case 'gt': return resource.amount > thresholdValue;
    case 'lte': return resource.amount <= thresholdValue;
    case 'lt': return resource.amount < thresholdValue;
  }
}
```

**Command Queue Empty Trigger**:
```typescript
function evaluateCommandQueueEmptyTrigger(
  commandQueue: CommandQueue,
): boolean {
  return commandQueue.size === 0;
}
```

**Event Trigger**:
```typescript
// During setup():
if (automation.trigger.kind === 'event') {
  context.events.on(automation.trigger.eventId, (payload) => {
    pendingEventTriggers.add(automation.id);
  });
}

// During tick():
function evaluateEventTrigger(
  automation: AutomationDefinition,
  pendingEventTriggers: Set<string>,
): boolean {
  return pendingEventTriggers.has(automation.id);
}

// After processing:
pendingEventTriggers.clear();
```

#### 6.2.3 Command Enqueueing

When a trigger fires:

```typescript
function enqueueAutomationCommand(
  automation: AutomationDefinition,
  commandQueue: CommandQueue,
  currentStep: number,
  timestamp: number,
): void {
  const { targetType, targetId, systemTargetId } = automation;

  let commandType: string;
  let payload: unknown;

  if (targetType === 'generator') {
    commandType = RUNTIME_COMMAND_TYPES.TOGGLE_GENERATOR;
    payload = { generatorId: targetId };
  } else if (targetType === 'upgrade') {
    commandType = RUNTIME_COMMAND_TYPES.PURCHASE_UPGRADE;
    payload = { upgradeId: targetId, quantity: 1 };
  } else if (targetType === 'system') {
    // System automations require custom handling
    commandType = systemTargetId; // e.g., 'system:prestige'
    payload = {};
  }

  commandQueue.enqueue({
    type: commandType,
    payload,
    priority: CommandPriority.AUTOMATION,
    timestamp,
    step: currentStep + 1, // Execute next step
  });
}
```

#### 6.2.4 Resource Cost Handling

Before enqueueing:

```typescript
function canAffordAutomation(
  automation: AutomationDefinition,
  resourceState: ResourceState,
  context: FormulaContext,
): boolean {
  if (!automation.resourceCost) {
    return true;
  }

  const { resourceId, rate } = automation.resourceCost;
  const cost = evaluateNumericFormula(rate, context);
  const resource = resourceState.getResource(resourceId);

  return resource.amount >= cost;
}

function deductAutomationCost(
  automation: AutomationDefinition,
  resourceState: ResourceState,
  context: FormulaContext,
): void {
  if (!automation.resourceCost) {
    return;
  }

  const { resourceId, rate } = automation.resourceCost;
  const cost = evaluateNumericFormula(rate, context);
  resourceState.spend(resourceId, cost);
}
```

#### 6.2.5 Cooldown Management

```typescript
function updateCooldown(
  automation: AutomationDefinition,
  state: AutomationState,
  currentStep: number,
  stepDurationMs: number,
): void {
  if (!automation.cooldown) {
    state.cooldownExpiresStep = 0;
    return;
  }

  const cooldownSteps = Math.ceil(automation.cooldown / stepDurationMs);
  state.cooldownExpiresStep = currentStep + cooldownSteps;
}

function isCooldownActive(
  state: AutomationState,
  currentStep: number,
): boolean {
  return currentStep < state.cooldownExpiresStep;
}
```

#### 6.2.6 System Implementation

**File**: `packages/core/src/automation-system.ts`

```typescript
export interface AutomationSystemOptions {
  readonly automations: readonly AutomationDefinition[];
  readonly commandQueue: CommandQueue;
  readonly resourceState: ResourceState;
  readonly stepDurationMs: number;
  readonly initialState?: ProgressionAutomationState;
}

export function createAutomationSystem(
  options: AutomationSystemOptions,
): System {
  const automationStates = new Map<string, AutomationState>();
  const pendingEventTriggers = new Set<string>();

  // Initialize states
  for (const automation of options.automations) {
    const existingState = options.initialState?.automations[automation.id];
    automationStates.set(automation.id, existingState ?? {
      id: automation.id,
      enabled: automation.enabledByDefault,
      lastFiredStep: -Infinity,
      cooldownExpiresStep: 0,
      unlocked: false, // Evaluated during first tick
    });
  }

  return {
    id: 'automation',

    setup(context) {
      // Subscribe to event triggers
      for (const automation of options.automations) {
        if (automation.trigger.kind === 'event') {
          context.events.on(automation.trigger.eventId, () => {
            pendingEventTriggers.add(automation.id);
          });
        }
      }

      // Subscribe to automation toggle commands
      context.events.on('automation:toggled', (payload) => {
        const state = automationStates.get(payload.automationId);
        if (state) {
          state.enabled = payload.enabled;
        }
      });
    },

    tick(context) {
      for (const automation of options.automations) {
        const state = automationStates.get(automation.id);
        if (!state) continue;

        // Update unlock status
        state.unlocked = evaluateCondition(
          automation.unlockCondition,
          conditionContext,
        );

        if (!state.unlocked || !state.enabled) {
          continue;
        }

        if (isCooldownActive(state, context.step)) {
          continue;
        }

        // Evaluate trigger
        let triggered = false;
        switch (automation.trigger.kind) {
          case 'interval':
            triggered = evaluateIntervalTrigger(
              automation,
              state,
              context.step,
              options.stepDurationMs,
            );
            break;
          case 'resourceThreshold':
            triggered = evaluateResourceThresholdTrigger(
              automation,
              options.resourceState,
              formulaContext,
            );
            break;
          case 'commandQueueEmpty':
            triggered = evaluateCommandQueueEmptyTrigger(
              options.commandQueue,
            );
            break;
          case 'event':
            triggered = evaluateEventTrigger(
              automation,
              pendingEventTriggers,
            );
            break;
        }

        if (!triggered) {
          continue;
        }

        // Check resource cost
        if (!canAffordAutomation(automation, options.resourceState, formulaContext)) {
          continue;
        }

        // Deduct cost and enqueue command
        deductAutomationCost(automation, options.resourceState, formulaContext);
        enqueueAutomationCommand(
          automation,
          options.commandQueue,
          context.step,
          context.events.timestamp,
        );

        // Update state
        state.lastFiredStep = context.step;
        updateCooldown(automation, state, context.step, options.stepDurationMs);
      }

      // Clear event triggers for next tick
      pendingEventTriggers.clear();
    },
  };
}
```

#### 6.2.7 Integration with Runtime Worker

**File**: `packages/shell-web/src/runtime.worker.ts`

Add after line 166 (after `registerResourceCommandHandlers`):

```typescript
import { createAutomationSystem } from '@idle-engine/core';

// ... existing code ...

const automationSystem = createAutomationSystem({
  automations: sampleContent.automations,
  commandQueue: runtime.getCommandQueue(),
  resourceState: progressionCoordinator.resourceState,
  stepDurationMs,
  initialState: initialProgression?.automationState,
});

runtime.addSystem(automationSystem);
```

### 6.3 Operational Considerations

#### Deployment
- **Feature flag**: None required; automations gracefully no-op if content pack has empty `automations` array
- **Rollout**: Deploy to all environments simultaneously (no content changes required)
- **Rollback**: Safe to rollback; automation state ignored by older runtime versions

#### Telemetry & Observability
- **Metrics**: Automation trigger counts, skipped triggers (cooldown/cost), average triggers per tick
- **Logging**: Automation fires logged at debug level with automation ID and target
- **Diagnostics**: Automation state exposed in diagnostic timeline for debugging

#### Security & Compliance
- **Threat model**: No new attack surface; automations use existing command system
- **PII handling**: No PII in automation state
- **Permissions**: Automations execute at AUTOMATION priority (lower than PLAYER)

## 7. Work Breakdown & Delivery Plan

### 7.1 Issue Map

| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| feat(core): implement AutomationSystem core | Create `AutomationSystem` class with state management and trigger evaluation logic | Runtime Implementation Agent | Doc approval | Unit tests pass; all 4 trigger types evaluated correctly; state persisted |
| feat(core): integrate AutomationSystem into runtime | Register AutomationSystem in `runtime.worker.ts` and wire to ProgressionCoordinator | Runtime Implementation Agent | AutomationSystem core | Integration tests pass; automations fire in worker context |
| feat(core): add automation toggle command handler | Implement `TOGGLE_AUTOMATION` command and emit `automation:toggled` events | Runtime Implementation Agent | AutomationSystem core | Command toggles automation state; event published |
| test(core): property-based automation tests | Generate random automation sequences and verify trigger invariants | Testing Agent | AutomationSystem core | 1000+ test cases pass; edge cases documented |
| feat(shell-web): automation state migration | Add migration for saves without automation state | Migration Agent | AutomationSystem integration | Old saves load with default automation state; tests verify |
| feat(content-sample): add example automations | Create sample automations for each trigger type in sample pack | Runtime Implementation Agent | None | Sample pack includes 4+ automations; validated against schema |
| docs(core): automation system API docs | Document AutomationSystem API and content authoring guide | Documentation Agent | AutomationSystem core | API docs published; authoring guide includes examples |

### 7.2 Milestones

**Phase 1: Core Implementation** (3-5 days)
- Deliverables: AutomationSystem implementation, trigger evaluators, state management
- Gating criteria: Unit tests pass with 100% coverage

**Phase 2: Integration** (2-3 days)
- Deliverables: Runtime worker integration, command handlers, event subscriptions
- Gating criteria: Integration tests pass; automations fire in worker context

**Phase 3: Testing & Polish** (2 days)
- Deliverables: Property-based tests, migration tests, sample automations
- Gating criteria: All tests pass; example automations validated

**Phase 4: Documentation** (1 day)
- Deliverables: API docs, authoring guide, migration notes
- Gating criteria: Docs reviewed and merged

### 7.3 Coordination Notes

**Hand-off Package**:
- This design document (all sections)
- `packages/content-schema/src/modules/automations.ts` (schema reference)
- `packages/core/src/index.ts` (system registration pattern)
- `packages/shell-web/src/modules/progression-coordinator.ts` (state management pattern)

**Communication Cadence**:
- Daily status updates in #319 (GitHub issue)
- Review checkpoint after Phase 1 completion
- Escalation path: Tag engineering lead if blocked >1 day

## 8. Agent Guidance & Guardrails

### Context Packets
Agents must load before execution:
- `packages/content-schema/src/modules/automations.ts` (automation schema)
- `packages/core/src/index.ts` (runtime architecture)
- `packages/core/src/command.ts` (command priority definitions)
- `packages/core/src/events/runtime-event-catalog.ts` (event definitions)
- `packages/shell-web/src/modules/progression-coordinator.ts` (state management patterns)
- `docs/runtime-command-queue-design.md` (command queue design)

### Prompting & Constraints

**Canonical Instructions**:
- Use imperative commit messages: `feat(core): add AutomationSystem` not `Added AutomationSystem`
- Follow existing naming: `evaluateTrigger()` not `checkTrigger()` (match `evaluateCondition()` pattern)
- Maintain 100% test coverage for public APIs (use Vitest)
- Export all new types from `packages/core/src/index.ts`

**Performance Requirements**:
- Automation evaluation must complete in &lt;2ms per tick for 100 automations
- Use memoization for expensive formula evaluations
- Avoid O(n²) loops; prefer Map lookups over array scans

**Determinism Requirements**:
- Trigger evaluation must be pure (same inputs → same outputs)
- No `Date.now()` or `Math.random()` in trigger logic
- Use `context.step` and `context.timestamp` for timing

### Safety Rails

**Forbidden Actions**:
- NEVER reset git history or force push to main
- DO NOT modify existing command priority values
- DO NOT skip validation of automation schema
- NEVER use `any` type; use proper TypeScript types

**Data Privacy**:
- Automation state contains no PII
- Telemetry must not log resource IDs containing user data

**Rollback Procedures**:
- If automation system crashes runtime, disable via feature flag
- Revert automation state migration if save corruption detected

### Validation Hooks

Agents must run before marking tasks complete:
- `pnpm test --filter core` (all core tests pass)
- `pnpm test --filter shell-web` (all shell-web tests pass)
- `pnpm lint --filter core` (no lint errors)
- `pnpm build` (TypeScript compilation succeeds)
- Verify automation fires in worker context (integration test)

## 9. Alternatives Considered

### Alternative 1: Poll-Based Trigger Evaluation
**Approach**: Evaluate all triggers on every tick, regardless of type.

**Rejected because**:
- Wasteful for event-based triggers (polling vs. subscription)
- Poor performance for large automation counts (O(n) every tick)
- Misses event-based triggers between ticks

**Trade-offs**: Simpler implementation but unacceptable performance characteristics.

### Alternative 2: Separate Automation Worker
**Approach**: Run automation evaluation in dedicated web worker.

**Rejected because**:
- Adds complexity (message passing, state synchronization)
- No performance benefit (automation evaluation is cheap)
- Increases latency (cross-worker communication overhead)

**Trade-offs**: Better isolation but unjustified complexity for current scale.

### Alternative 3: Lua/JS Scripting for Custom Triggers
**Approach**: Allow content authors to write custom trigger logic in scripts.

**Rejected because**:
- Security risk (arbitrary code execution)
- Non-deterministic (hard to validate reproducibility)
- Complexity (requires sandboxing, API design)
- Out of scope for MVP

**Trade-offs**: Maximum flexibility but unacceptable security/determinism trade-offs.

## 10. Testing & Validation Plan

### Unit Tests
- **Trigger Evaluators**: Test each trigger type with edge cases
  - Interval: First tick, exact interval, sub-interval deltas
  - Resource threshold: All comparators (gte/gt/lte/lt), boundary values
  - Command queue empty: Empty queue, non-empty queue
  - Event: Event received, event not received, multiple events
- **State Management**: Enable/disable, cooldowns, last-fired tracking
- **Resource Costs**: Sufficient resources, insufficient resources, no cost
- **Unlock Conditions**: Locked automations skipped, unlock transitions

### Integration Tests
- **End-to-End Automation**: Define automation in content pack → trigger fires → command executed
- **Multiple Automations**: 10+ automations with different triggers fire correctly
- **Priority Ordering**: Automation commands execute after PLAYER commands
- **Event Integration**: Event triggers subscribe and fire correctly
- **Save/Load Cycle**: Automation state persists and restores correctly

### Performance Tests
- **Benchmark**: 100 automations evaluated in &lt;2ms per tick (target: &lt;1ms)
- **Memory**: Automation state memory usage &lt;1KB per automation
- **Stress Test**: 1000 automations do not degrade tick performance below 60 FPS

### Property-Based Tests
- **Random Automation Sequences**: Generate random automation definitions and verify:
  - No crashes or exceptions
  - Cooldowns always enforced
  - Resource costs always deducted
  - Commands always enqueued at AUTOMATION priority
- **Invariants**:
  - `lastFiredStep <= currentStep` always true
  - `cooldownExpiresStep >= currentStep` when cooldown active
  - Disabled automations never fire

### Accessibility Tests
- Not applicable (no UI in this milestone)

## 11. Risks & Mitigations

### Risk: Performance Degradation with Large Automation Counts
**Impact**: High (>100 automations could exceed tick budget)
**Likelihood**: Medium (power users may create many automations)
**Mitigation**:
- Benchmark with 100+ automations during development
- Implement lazy evaluation (skip locked/disabled automations early)
- Document performance limits in content authoring guide

### Risk: Infinite Trigger Loops
**Impact**: High (automation triggers itself → infinite commands)
**Likelihood**: Low (requires specific content misconfiguration)
**Mitigation**:
- Cooldowns prevent rapid re-triggers
- Document anti-patterns in authoring guide
- Add telemetry to detect high-frequency triggers

### Risk: Determinism Violations
**Impact**: Critical (non-deterministic triggers break replays)
**Likelihood**: Low (strict testing enforces determinism)
**Mitigation**:
- Property-based tests verify reproducibility
- Code review checklist includes determinism verification
- Reject any use of `Date.now()` or `Math.random()`

### Risk: Save Migration Failures
**Impact**: High (players lose automation state)
**Likelihood**: Low (migration adds default state, no data loss)
**Mitigation**:
- Migration tests verify old saves load correctly
- Default state (disabled) is safe fallback
- Rollback plan: revert migration, automation state optional

## 12. Rollout Plan

### Milestones
- **M1: Core Implementation** (Week 1): AutomationSystem and trigger evaluators
- **M2: Integration** (Week 2): Runtime worker integration and command handlers
- **M3: Testing** (Week 2): Property-based tests and migration validation
- **M4: Documentation** (Week 3): API docs and content authoring guide

### Migration Strategy
- **Save Format**: Add `automationState` field to `ProgressionAuthoritativeState`
- **Migration Logic**: If `automationState` missing, initialize with defaults (all disabled)
- **Backward Compatibility**: Old runtime ignores `automationState` field
- **Forward Compatibility**: New runtime handles missing field gracefully

### Communication
- **Release Notes**: "Automation system now executes automation definitions from content packs. Existing saves will have all automations disabled by default."
- **Content Authors**: "Automations are now functional! See docs/automation-authoring-guide.md for examples."
- **Players**: No user-facing message (feature enabled by content packs)

## 13. Open Questions

1. **Q**: Should automations fire during offline catch-up?
   **A**: Deferred to offline progression design (#350+). For MVP, automations only fire during active ticks.

2. **Q**: How should automation state be exposed to UI?
   **A**: Deferred to automation UI design (#320+). For MVP, state exists but no dashboard.

3. **Q**: Should resource threshold triggers fire every tick while threshold is met?
   **A**: Requires decision. **Recommendation**: Fire once per threshold crossing (track `lastThresholdMet` state).

4. **Q**: What happens if automation target (generator/upgrade) is locked?
   **A**: Command is enqueued but authorization fails. **Recommendation**: Check unlock status before enqueueing.

## 14. Follow-Up Work

| Task | Description | Owner | Timing |
|------|-------------|-------|--------|
| #320 | Automation dashboard UI | Shell-web team | After core implementation |
| #321 | Automation telemetry and A/B testing | Analytics team | Q2 2025 |
| #322 | Cross-automation dependencies | Runtime team | Future milestone |
| #323 | Offline automation catch-up | Runtime team | After offline progression design |
| #324 | Automation priority ordering | Content team | If requested by users |

## 15. References

- Issue #319: Design: Runtime automation execution system
- Issue #298: feat(shell-web): resource dashboard UI (related work)
- `packages/content-schema/src/modules/automations.ts` (schema)
- `packages/core/src/index.ts:116-156` (system registration)
- `packages/core/src/events/runtime-event-catalog.ts:7-22` (automation events)
- `packages/core/src/command.ts:76-90` (command priorities)
- `docs/runtime-command-queue-design.md` (command queue design)
- `docs/content-dsl-schema-design.md` (content authoring)

## Appendix A — Glossary

- **Automation**: A content-defined rule that triggers commands without player interaction
- **Trigger**: Condition that causes an automation to fire (interval, threshold, event, queue-empty)
- **Cooldown**: Minimum time between automation firings
- **Resource Cost**: Optional resource deduction when automation fires
- **Unlock Condition**: Condition that determines if automation is available
- **Event Trigger**: Automation that fires when a specific runtime event is published
- **Interval Trigger**: Automation that fires periodically based on elapsed time
- **Resource Threshold Trigger**: Automation that fires when resource amount crosses threshold
- **Command Queue Empty Trigger**: Automation that fires when no commands are pending

## Appendix B — Change Log

| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2025-11-03 | Claude Code | Initial draft based on issue #319 requirements |
