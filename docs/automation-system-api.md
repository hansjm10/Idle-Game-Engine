---
title: AutomationSystem API Reference
description: Complete API documentation for the Idle Engine automation system
sidebar_position: 13
---

# AutomationSystem API Reference

The `AutomationSystem` evaluates automation triggers and enqueues commands when triggers fire. It supports 4 trigger types: interval, resourceThreshold, commandQueueEmpty, and event. As of issue #348, automations may declare a `resourceCost` which is validated and deducted atomically at fire time.

## Core API

### createAutomationSystem(options)

Creates an AutomationSystem that evaluates triggers and enqueues commands.

**Type Signature:**
```typescript
function createAutomationSystem(
  options: AutomationSystemOptions
): System & { getState: () => ReadonlyMap<string, AutomationState> }
```

**Parameters:**

- `options.automations` (readonly AutomationDefinition[]): Array of automation definitions from content pack
- `options.stepDurationMs` (number): Duration of each runtime step in milliseconds (default: 100)
- `options.commandQueue` (CommandQueue): The runtime's command queue instance
- `options.resourceState` (ResourceStateAccessor): Resource state accessor used for threshold evaluation and optional spending when `resourceCost` is present
- `options.initialState` (Map\<string, AutomationState\>, optional): Restored automation state from save file

**Returns:** System object with additional `getState()` method for state extraction

**Example:**
```typescript
import { createAutomationSystem } from '@idle-engine/core';

const system = createAutomationSystem({
  automations: contentPack.automations,
  stepDurationMs: 100,
  commandQueue: runtime.getCommandQueue(),
  // Prefer the adapter to normalize indices and expose spend
  resourceState: createResourceStateAdapter(progressionCoordinator.resourceState),
  initialState: savedState?.automationState,
});

runtime.addSystem(system);
```

**Lifecycle:**

1. **Initialization**: Creates state for each automation (enabled/disabled, cooldowns, last-fired)
2. **Setup**: Subscribes to event triggers and automation toggle commands
3. **Tick**: Evaluates triggers each tick, enqueues commands when triggered

**State Persistence:**

Unlock state is persistent—once an automation is unlocked, it remains unlocked. The system only evaluates unlock conditions for automations that are not yet unlocked. Currently, only 'always' unlock conditions are evaluated; full condition evaluation requires integration with progression systems.

---

## Resource State Accessor

### ResourceStateAccessor (runtime input)

Minimal interface used by the automation system to read resource amounts, resolve IDs, and (optionally) spend when an automation declares a `resourceCost`.

```ts
export interface ResourceStateAccessor {
  getAmount(resourceIndex: number): number;
  getResourceIndex?(resourceId: string): number; // returns -1 if not found
  spendAmount?(
    resourceIndex: number,
    amount: number,
    context?: { systemId?: string; commandId?: string },
  ): boolean; // returns true on successful spend
}
```

- Spending is attempted during `tick()` after a trigger fires but before enqueueing the target command. If the spend fails, the automation does not enqueue or enter cooldown on that tick.
- For event triggers, failed spends retain the pending event so the automation can retry on a later tick.
- For resource threshold triggers, failed spends do not consume the false→true crossing so the automation retries while the condition remains satisfied.

Note: `ResourceStateReader` remains as a deprecated alias. Prefer `ResourceStateAccessor`.

### Adapter helper

Use the adapter to bridge from the core `ResourceState` API (which exposes `getIndex`) to the `ResourceStateAccessor` contract expected by the automation system:

```ts
import { createResourceStateAdapter } from '@idle-engine/core';

const system = createAutomationSystem({
  automations,
  commandQueue,
  stepDurationMs,
  resourceState: createResourceStateAdapter(progressionCoordinator.resourceState),
});
```

### getAutomationState(system)

Extracts the internal state from an AutomationSystem for serialization to save files.

**Type Signature:**
```typescript
function getAutomationState(
  system: ReturnType<typeof createAutomationSystem>
): ReadonlyMap<string, AutomationState>
```

**Parameters:**

- `system`: The AutomationSystem instance from which to extract state

**Returns:** ReadonlyMap of automation IDs to their current state

**Example:**
```typescript
const state = getAutomationState(automationSystem);
const autoState = state.get('auto:collector');
console.log(`Enabled: ${autoState?.enabled}, Last fired: ${autoState?.lastFiredStep}`);
```

---

### restoreState(state, options)

Restores automation state from serialized save data.

**Type Signature:**
```typescript
restoreState(
  state: readonly SerializedAutomationState[],
  options?: { savedWorkerStep?: number; currentStep?: number }
): void
```

**Parameters:**
- `state`: Array of serialized automation state entries
- `options.savedWorkerStep` (optional): Step number when snapshot was captured (for rebasing)
- `options.currentStep` (optional): Current runtime step (default: 0)

**Behavior:**
- Merges provided entries into existing automation definitions
- Normalizes `lastFiredStep: null` → `-Infinity` (never fired)
- Rebases step fields when `savedWorkerStep` is provided
- Ignores unknown automation IDs not in current definitions
- Preserves defaults for automations not in restore array

**Step Rebasing:**

When restoring from a snapshot captured at a non-zero worker step, `lastFiredStep` and `cooldownExpiresStep` are absolute to that timeline. The rebase adjusts them to the caller's current timeline so cooldown math remains consistent:

```typescript
rebaseDelta = currentStep - savedWorkerStep
rebasedLastFired = normalizedLastFired + rebaseDelta
rebasedCooldownExpires = cooldownExpiresStep + rebaseDelta
```

If `savedWorkerStep` is not provided or invalid, no rebasing occurs.

**Example:**
```typescript
// Restore automation state from save file
automationSystem.restoreState([
  {
    id: 'auto:collector',
    enabled: true,
    lastFiredStep: 100,
    cooldownExpiresStep: 110,
    unlocked: true,
  }
], { savedWorkerStep: 100, currentStep: 0 });

// After restore, lastFiredStep is rebased to 0, cooldownExpiresStep to 10
```

**Example with null (never fired):**
```typescript
// Restore automation that has never fired
automationSystem.restoreState([
  {
    id: 'auto:new',
    enabled: false,
    lastFiredStep: null, // null represents -Infinity (never fired)
    cooldownExpiresStep: 0,
    unlocked: false,
  }
]);
```

---

## State Types

### AutomationState

Internal state for a single automation.

**Type Definition:**
```typescript
interface AutomationState {
  readonly id: string;
  enabled: boolean;
  lastFiredStep: number;
  cooldownExpiresStep: number;
  unlocked: boolean;
  lastThresholdSatisfied?: boolean;
}
```

**Fields:**

- `id`: Automation identifier matching the content definition
- `enabled`: Whether the automation is currently enabled
- `lastFiredStep`: Step number when automation last fired (-Infinity if never)
- `cooldownExpiresStep`: Step number when cooldown expires (0 if no cooldown)
- `unlocked`: Whether the automation is currently unlocked
- `lastThresholdSatisfied`: Previous threshold state for crossing detection (undefined = never evaluated)

---

### SerializedAutomationState

Serialized representation of automation state for save files and persistence.

**Type Definition:**
```typescript
interface SerializedAutomationState {
  readonly id: string;
  readonly enabled: boolean;
  readonly lastFiredStep: number | null;  // null = never fired (-Infinity)
  readonly cooldownExpiresStep: number;
  readonly unlocked: boolean;
  readonly lastThresholdSatisfied?: boolean;
}
```

**Fields:**
- `id`: Automation identifier matching the content definition
- `enabled`: Whether the automation is currently enabled
- `lastFiredStep`: Step number when automation last fired (`null` if never fired)
- `cooldownExpiresStep`: Step number when cooldown expires (0 if no cooldown)
- `unlocked`: Whether the automation is currently unlocked
- `lastThresholdSatisfied`: Previous threshold state for crossing detection

**Differences from `AutomationState`:**
- `lastFiredStep` is `number | null` instead of `number` (for JSON compatibility)
- All fields are `readonly` (serialized data is immutable)
- Used in `SerializedResourceState.automationState` and `restoreState()`

**Serialization Notes:**
- `-Infinity` values are converted to `null` during serialization (`exportForSave`)
- `null` values are converted back to `-Infinity` during restoration (`restoreState`)
- This ensures JSON compatibility while preserving semantic meaning

---

### AutomationSystemOptions

Configuration options for creating an AutomationSystem.

**Type Definition:**
```typescript
interface AutomationSystemOptions {
  readonly automations: readonly AutomationDefinition[];
  readonly stepDurationMs: number;
  readonly commandQueue: CommandQueue;
  readonly resourceState: ResourceStateReader;
  readonly initialState?: Map<string, AutomationState>;
}
```

---

### ResourceStateReader

Minimal interface for resource state access during automation evaluation.

**Type Definition:**
```typescript
interface ResourceStateReader {
  getAmount(resourceIndex: number): number;
  getResourceIndex?(resourceId: string): number;
  spendAmount?(
    resourceIndex: number,
    amount: number,
    context?: { systemId?: string; commandId?: string },
  ): boolean;
}
```

**Methods:**

- `getAmount(resourceIndex)`: Returns the current amount of the resource at the given index
- `getResourceIndex(resourceId)`: Resolves a resource ID to its internal index (-1 if not found)
- `spendAmount(index, amount, context?)`: Optionally spend from a resource. If unavailable, automations with `resourceCost` will treat spending as failed (skip enqueue and cooldown).

---

### ResourceState Adapter

When integrating `AutomationSystem` with `ProgressionCoordinator`, use `createResourceStateAdapter` to bridge the interface gap:

```typescript
import { createResourceStateAdapter } from '@idle-engine/core';

const automationSystem = createAutomationSystem({
  automations: sampleContent.automations,
  commandQueue: runtime.getCommandQueue(),
  resourceState: createResourceStateAdapter(progressionCoordinator.resourceState),
  stepDurationMs,
});
```

**Why the adapter is needed:**

- `ResourceState.getIndex(id)` returns `number | undefined`
- `ResourceStateReader.getResourceIndex(id)` expects `number` (with -1 for "not found")
- The adapter forwards `spendAmount` when available so automations can enforce resource costs
- The adapter converts `undefined → -1` for proper automation evaluation

**Without the adapter:**
- `resourceState` would lack `getResourceIndex` entirely
- Automations would fall back to reading index 0 for all resources
- Resource-threshold automations for non-first resources would be inert

---

## Trigger Evaluators

### evaluateIntervalTrigger(automation, state, currentStep, stepDurationMs)

Evaluates whether an interval trigger should fire.

**Type Signature:**
```typescript
function evaluateIntervalTrigger(
  automation: AutomationDefinition,
  state: AutomationState,
  currentStep: number,
  stepDurationMs: number
): boolean
```

**Behavior:**

- Fires immediately on first tick (when `lastFiredStep === -Infinity`)
- Fires when elapsed steps since last fire ≥ interval duration in steps
- Interval is calculated as `Math.ceil(intervalMs / stepDurationMs)`

**Example:**
```typescript
// Automation with 1000ms interval, 100ms step duration
// Interval = 10 steps (1000ms / 100ms)
const shouldFire = evaluateIntervalTrigger(automation, state, 10, 100);
// Returns true if currentStep - lastFiredStep >= 10
```

**Throws:** Error if automation trigger is not of kind 'interval'

---

### evaluateResourceThresholdTrigger(automation, resourceState)

Evaluates whether a resourceThreshold condition is currently satisfied.

**Type Signature:**
```typescript
function evaluateResourceThresholdTrigger(
  automation: AutomationDefinition,
  resourceState: ResourceStateReader
): boolean
```

**Behavior:**

- Returns current state of the condition (not crossing detection)
- Caller must track previous state to detect crossings
- Resource IDs resolved to indices via `resourceState.getResourceIndex()`
- Missing resources (index -1) treated as amount 0
- Supports four comparators: `gte`, `gt`, `lte`, `lt`

**Crossing Detection Pattern:**
```typescript
const currentlySatisfied = evaluateResourceThresholdTrigger(automation, resourceState);
const previouslySatisfied = state.lastThresholdSatisfied ?? false;

// Fire only on transition from false -> true (crossing event)
const triggered = currentlySatisfied && !previouslySatisfied;

// Update state for next tick
state.lastThresholdSatisfied = currentlySatisfied;
```

**Cooldown Interaction:**

This function is called during cooldown checks to update `AutomationState.lastThresholdSatisfied`. This ensures crossing detection remains accurate when the cooldown expires, even if the resource crossed the threshold multiple times during the cooldown period.

**Throws:** Error if automation trigger is not of kind 'resourceThreshold'

---

### evaluateCommandQueueEmptyTrigger(commandQueue)

Evaluates whether a commandQueueEmpty trigger should fire.

**Type Signature:**
```typescript
function evaluateCommandQueueEmptyTrigger(
  commandQueue: CommandQueue
): boolean
```

**Behavior:**

- Returns true if command queue size is 0
- Allows automations to fire when no other commands are pending

**Example:**
```typescript
const commandQueue = new CommandQueue();
const shouldFire = evaluateCommandQueueEmptyTrigger(commandQueue); // true

commandQueue.enqueue({ type: 'PURCHASE_UPGRADE', ... });
const shouldNotFire = evaluateCommandQueueEmptyTrigger(commandQueue); // false
```

---

### evaluateEventTrigger(automationId, pendingEventTriggers)

Evaluates whether an event trigger should fire.

**Type Signature:**
```typescript
function evaluateEventTrigger(
  automationId: string,
  pendingEventTriggers: ReadonlySet<string>
): boolean
```

**Behavior:**

- Returns true if automation ID is in the pending triggers set
- Set is populated by event handlers during `setup()`
- Set is cleared after each tick

**Example:**
```typescript
const pendingEventTriggers = new Set(['auto:collector', 'auto:upgrader']);
const shouldFire = evaluateEventTrigger('auto:collector', pendingEventTriggers); // true
const shouldNotFire = evaluateEventTrigger('auto:other', pendingEventTriggers); // false
```

---

## Cooldown Management

### isCooldownActive(state, currentStep)

Checks if an automation is currently in cooldown.

**Type Signature:**
```typescript
function isCooldownActive(
  state: AutomationState,
  currentStep: number
): boolean
```

**Behavior:**

- Returns true if `currentStep < state.cooldownExpiresStep`
- Returns false if cooldown has expired or no cooldown is active

**Example:**
```typescript
const state = {
  id: 'auto:test',
  enabled: true,
  lastFiredStep: 10,
  cooldownExpiresStep: 20,
  unlocked: true
};
const isActive = isCooldownActive(state, 15); // true
const isExpired = isCooldownActive(state, 20); // false
```

---

### updateCooldown(automation, state, currentStep, stepDurationMs, formulaContext?)

Updates the cooldown expiration step after an automation fires.

**Type Signature:**
```typescript
function updateCooldown(
  automation: AutomationDefinition,
  state: AutomationState,
  currentStep: number,
  stepDurationMs: number,
  formulaContext?: FormulaEvaluationContext
): void
```

**Behavior:**

- Evaluates cooldown as a numeric formula using the provided context
- Converts cooldown duration (ms) to steps: `Math.ceil(cooldown / stepDurationMs)`
- Sets `cooldownExpiresStep = currentStep + cooldownSteps + 1`
- The +1 accounts for command execution delay (commands execute at currentStep + 1)
- If no cooldown defined or evaluation is non-finite/≤0, sets `cooldownExpiresStep = 0`

**Example:**
```typescript
const automation = { cooldown: { kind: 'constant', value: 500 }, ... };
const state = { cooldownExpiresStep: 0, ... };
updateCooldown(automation, state, 10, 100); // stepDurationMs = 100ms
// state.cooldownExpiresStep will be 16 (10 + ceil(500/100) + 1)
```

---

## Command Enqueueing

### enqueueAutomationCommand(automation, commandQueue, currentStep, stepDurationMs)

Enqueues a command for an automation trigger.

**Type Signature:**
```typescript
function enqueueAutomationCommand(
  automation: AutomationDefinition,
  commandQueue: CommandQueue,
  currentStep: number,
  stepDurationMs: number
): void
```

**Behavior:**

- Converts automation target into appropriate command type
- Enqueues command at `CommandPriority.AUTOMATION`
- Commands scheduled to execute on next step (`currentStep + 1`)
- Timestamps derived from simulation clock (`step * stepDurationMs`)

**Target Type Mapping:**

| Target Type | Command Type | Payload |
|-------------|--------------|---------|
| `generator` | `TOGGLE_GENERATOR` | `{ generatorId: targetId, enabled: targetEnabled ?? true }` |
| `upgrade` | `PURCHASE_UPGRADE` | `{ upgradeId: targetId }` |
| `purchaseGenerator` | `PURCHASE_GENERATOR` | `{ generatorId: targetId, count: floor(targetCount ?? 1) (min 1) }` |
| `collectResource` | `COLLECT_RESOURCE` | `{ resourceId: targetId, amount: max(targetAmount ?? 1, 0) }` |
| `system` | System-specific | Mapped via `mapSystemTargetToCommandType()` |

**Generator Behavior:**

Generator automations default to enabling generators (`targetEnabled` omitted → `enabled: true`). To disable generators via automation, set `targetEnabled: false`.

**PurchaseGenerator Behavior:**

PurchaseGenerator automations enqueue `PURCHASE_GENERATOR` with a deterministic `count`. When `targetCount` is omitted the runtime defaults to `1`. Non-integer values are floored and counts are clamped to a minimum of `1` before enqueueing.

**CollectResource Behavior:**

CollectResource automations enqueue `COLLECT_RESOURCE` with a deterministic `amount`. When `targetAmount` is omitted the runtime defaults to `1`. Non-positive or non-finite amounts are treated as `0` before enqueueing.

**Example:**
```typescript
const automation = {
  targetType: 'generator',
  targetId: 'gen:clicks',
  ...
};
enqueueAutomationCommand(automation, commandQueue, 10, 100);
// Command enqueued to execute at step 11 with timestamp 1000ms
```

**Throws:** Error if target type is unknown

---

## Integration Example

Complete integration with IdleEngineRuntime:

```typescript
import {
  createAutomationSystem,
  getAutomationState,
  IdleEngineRuntime,
} from '@idle-engine/core';

// Load content pack
const contentPack = await import('@idle-engine/sample-pack');

// Create runtime
const runtime = new IdleEngineRuntime({
  stepDurationMs: 100,
  contentPack,
});

// Create automation system
const automationSystem = createAutomationSystem({
  automations: contentPack.automations,
  stepDurationMs: 100,
  commandQueue: runtime.getCommandQueue(),
  resourceState: progressionCoordinator.resourceState,
  initialState: loadedState?.automationState,
});

// Register system
runtime.addSystem(automationSystem);

// Start runtime
runtime.start();

// Later: Extract state for save file
const automationState = getAutomationState(automationSystem);
const saveData = {
  progression: progressionCoordinator.getState(),
  automationState: Array.from(automationState.entries()).reduce(
    (acc, [id, state]) => ({ ...acc, [id]: state }),
    {}
  ),
};
```

---

## Performance Considerations

**Tick Budget:**

- Automation evaluation must complete within per-tick budget (\<2ms for 100 automations)
- Use lazy evaluation: skip locked/disabled automations early
- Prefer Map lookups over array scans for O(1) performance

**Memory:**

- Automation state memory usage \<1KB per automation
- State is compact: booleans, numbers, no deep nesting

**Determinism:**

- Trigger evaluation must be pure (same inputs → same outputs)
- No `Date.now()` or `Math.random()` in trigger logic
- Use `context.step` and `context.timestamp` for timing

---

## References

- Design Document: `docs/automation-execution-system-design.md`
- Content Schema: `packages/content-schema/src/modules/automations.ts`
- Implementation: `packages/core/src/automation-system.ts`
- Tests: `packages/core/src/__tests__/automation-system/`
