# AutomationSystem Core Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the AutomationSystem with state management and trigger evaluation logic for all 4 trigger types (interval, resourceThreshold, commandQueueEmpty, event).

**Architecture:** Factory function `createAutomationSystem()` returns a System conforming to the core runtime interface. The system subscribes to events during setup(), evaluates triggers in tick(), manages automation state (enabled/disabled, cooldowns, last-fired), and enqueues commands at AUTOMATION priority when triggers fire.

**Tech Stack:** TypeScript, Vitest, @idle-engine/core runtime, @idle-engine/content-schema

---

## Prerequisites

Before starting:
- Design document: `docs/automation-execution-system-design.md`
- Automation schema: `packages/content-schema/src/modules/automations.ts`
- System interface: `packages/core/src/index.ts:45-49`
- Command queue: `packages/core/src/command-queue.ts`
- Event catalog: `packages/core/src/events/runtime-event-catalog.ts`

## Task 1: Create automation system file structure

**Files:**
- Create: `packages/core/src/automation-system.ts`
- Create: `packages/core/src/automation-system.test.ts`

**Step 1: Create empty automation system file with types**

Create `packages/core/src/automation-system.ts`:

```typescript
/**
 * Automation System
 *
 * Evaluates automation triggers and enqueues commands when triggers fire.
 * Supports 4 trigger types: interval, resourceThreshold, commandQueueEmpty, event.
 */

import type { AutomationDefinition } from '@idle-engine/content-schema';
import type { System } from './index.js';

/**
 * Internal state for a single automation.
 */
export interface AutomationState {
  readonly id: string;
  enabled: boolean;
  lastFiredStep: number;
  cooldownExpiresStep: number;
  unlocked: boolean;
}

/**
 * Options for creating an AutomationSystem.
 */
export interface AutomationSystemOptions {
  readonly automations: readonly AutomationDefinition[];
  readonly stepDurationMs: number;
  readonly initialState?: Map<string, AutomationState>;
}

/**
 * Creates an AutomationSystem that evaluates triggers and enqueues commands.
 */
export function createAutomationSystem(
  options: AutomationSystemOptions,
): System {
  // Internal state
  const automationStates = new Map<string, AutomationState>();
  const pendingEventTriggers = new Set<string>();

  // Initialize automation states
  for (const automation of options.automations) {
    const existingState = options.initialState?.get(automation.id);
    automationStates.set(automation.id, existingState ?? {
      id: automation.id,
      enabled: automation.enabledByDefault,
      lastFiredStep: -Infinity,
      cooldownExpiresStep: 0,
      unlocked: false, // Will be evaluated on first tick
    });
  }

  return {
    id: 'automation-system',

    setup({ events }) {
      // TODO: Subscribe to events
    },

    tick({ step, deltaMs, events }) {
      // TODO: Evaluate triggers and enqueue commands
    },
  };
}

/**
 * Gets the current state of all automations.
 * Used for serialization to save files.
 */
export function getAutomationState(
  system: ReturnType<typeof createAutomationSystem>,
): ReadonlyMap<string, AutomationState> {
  // TODO: Implement state extraction
  return new Map();
}
```

**Step 2: Create test file with basic structure**

Create `packages/core/src/automation-system.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createAutomationSystem } from './automation-system.js';
import type { AutomationDefinition } from '@idle-engine/content-schema';

describe('AutomationSystem', () => {
  const stepDurationMs = 100;

  describe('initialization', () => {
    it('should create system with correct id', () => {
      const system = createAutomationSystem({
        automations: [],
        stepDurationMs,
      });

      expect(system.id).toBe('automation-system');
    });

    it('should initialize automation states with defaults', () => {
      // Test to be implemented
    });
  });

  describe('interval triggers', () => {
    // Tests to be added
  });

  describe('resourceThreshold triggers', () => {
    // Tests to be added
  });

  describe('commandQueueEmpty triggers', () => {
    // Tests to be added
  });

  describe('event triggers', () => {
    // Tests to be added
  });
});
```

**Step 3: Export from core index**

Edit `packages/core/src/index.ts`, add to exports:

```typescript
export {
  createAutomationSystem,
  getAutomationState,
  type AutomationSystemOptions,
  type AutomationState,
} from './automation-system.js';
```

**Step 4: Run tests to verify setup**

Run: `pnpm test --filter core automation-system`
Expected: All tests pass (minimal tests so far)

**Step 5: Commit**

```bash
git add packages/core/src/automation-system.ts packages/core/src/automation-system.test.ts packages/core/src/index.ts
git commit -m "feat(core): add automation system skeleton and types"
```

---

## Task 2: Implement state initialization

**Files:**
- Modify: `packages/core/src/automation-system.test.ts`
- Modify: `packages/core/src/automation-system.ts`

**Step 1: Write failing test for state initialization**

Add to `packages/core/src/automation-system.test.ts` in `describe('initialization')`:

```typescript
it('should initialize automation states with default values', () => {
  const automations: AutomationDefinition[] = [
    {
      id: 'auto:collector',
      name: { en: 'Auto Collector' },
      description: { en: 'Collects automatically' },
      targetType: 'generator',
      targetId: 'gen:clicks',
      trigger: { kind: 'interval', interval: { kind: 'constant', value: 1000 } },
      unlockCondition: { kind: 'always' },
      enabledByDefault: true,
      order: 0,
    },
  ];

  const system = createAutomationSystem({
    automations,
    stepDurationMs: 100,
  });

  // We need a way to inspect state - will add getter
  const state = getAutomationState(system);

  expect(state.size).toBe(1);
  const autoState = state.get('auto:collector');
  expect(autoState).toBeDefined();
  expect(autoState?.enabled).toBe(true);
  expect(autoState?.lastFiredStep).toBe(-Infinity);
  expect(autoState?.cooldownExpiresStep).toBe(0);
  expect(autoState?.unlocked).toBe(false);
});

it('should restore state from initialState', () => {
  const automations: AutomationDefinition[] = [
    {
      id: 'auto:collector',
      name: { en: 'Auto Collector' },
      description: { en: 'Collects automatically' },
      targetType: 'generator',
      targetId: 'gen:clicks',
      trigger: { kind: 'interval', interval: { kind: 'constant', value: 1000 } },
      unlockCondition: { kind: 'always' },
      enabledByDefault: true,
      order: 0,
    },
  ];

  const initialState = new Map([
    ['auto:collector', {
      id: 'auto:collector',
      enabled: false,
      lastFiredStep: 100,
      cooldownExpiresStep: 110,
      unlocked: true,
    }],
  ]);

  const system = createAutomationSystem({
    automations,
    stepDurationMs: 100,
    initialState,
  });

  const state = getAutomationState(system);
  const autoState = state.get('auto:collector');

  expect(autoState?.enabled).toBe(false);
  expect(autoState?.lastFiredStep).toBe(100);
  expect(autoState?.cooldownExpiresStep).toBe(110);
  expect(autoState?.unlocked).toBe(true);
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test --filter core automation-system`
Expected: FAIL - getAutomationState returns empty map

**Step 3: Implement getAutomationState**

Modify `packages/core/src/automation-system.ts`:

```typescript
export function createAutomationSystem(
  options: AutomationSystemOptions,
): System & { getState: () => ReadonlyMap<string, AutomationState> } {
  // Internal state
  const automationStates = new Map<string, AutomationState>();
  const pendingEventTriggers = new Set<string>();

  // Initialize automation states
  for (const automation of options.automations) {
    const existingState = options.initialState?.get(automation.id);
    automationStates.set(automation.id, existingState ?? {
      id: automation.id,
      enabled: automation.enabledByDefault,
      lastFiredStep: -Infinity,
      cooldownExpiresStep: 0,
      unlocked: false,
    });
  }

  return {
    id: 'automation-system',

    getState() {
      return new Map(automationStates);
    },

    setup({ events }) {
      // TODO: Subscribe to events
    },

    tick({ step, deltaMs, events }) {
      // TODO: Evaluate triggers and enqueue commands
    },
  };
}

export function getAutomationState(
  system: ReturnType<typeof createAutomationSystem>,
): ReadonlyMap<string, AutomationState> {
  return system.getState();
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm test --filter core automation-system`
Expected: PASS - both initialization tests pass

**Step 5: Commit**

```bash
git add packages/core/src/automation-system.ts packages/core/src/automation-system.test.ts
git commit -m "feat(core): implement automation state initialization"
```

---

## Task 3: Implement cooldown evaluation

**Files:**
- Modify: `packages/core/src/automation-system.ts`
- Modify: `packages/core/src/automation-system.test.ts`

**Step 1: Write failing test for cooldown checking**

Add to `packages/core/src/automation-system.test.ts`:

```typescript
describe('cooldown management', () => {
  it('should return true when cooldown is active', () => {
    const state: AutomationState = {
      id: 'auto:test',
      enabled: true,
      lastFiredStep: 10,
      cooldownExpiresStep: 20,
      unlocked: true,
    };

    const isActive = isCooldownActive(state, 15);
    expect(isActive).toBe(true);
  });

  it('should return false when cooldown has expired', () => {
    const state: AutomationState = {
      id: 'auto:test',
      enabled: true,
      lastFiredStep: 10,
      cooldownExpiresStep: 20,
      unlocked: true,
    };

    const isActive = isCooldownActive(state, 20);
    expect(isActive).toBe(false);
  });

  it('should return false when no cooldown is set', () => {
    const state: AutomationState = {
      id: 'auto:test',
      enabled: true,
      lastFiredStep: 10,
      cooldownExpiresStep: 0,
      unlocked: true,
    };

    const isActive = isCooldownActive(state, 15);
    expect(isActive).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test --filter core automation-system`
Expected: FAIL - isCooldownActive is not defined

**Step 3: Implement cooldown functions**

Add to `packages/core/src/automation-system.ts`:

```typescript
/**
 * Checks if an automation is currently in cooldown.
 */
export function isCooldownActive(
  state: AutomationState,
  currentStep: number,
): boolean {
  return currentStep < state.cooldownExpiresStep;
}

/**
 * Updates the cooldown expiration step after an automation fires.
 */
export function updateCooldown(
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
```

**Step 4: Export from index**

Edit `packages/core/src/automation-system.test.ts`, add import:

```typescript
import {
  createAutomationSystem,
  getAutomationState,
  isCooldownActive,
} from './automation-system.js';
```

Export from `packages/core/src/index.ts`:

```typescript
export {
  createAutomationSystem,
  getAutomationState,
  isCooldownActive,
  type AutomationSystemOptions,
  type AutomationState,
} from './automation-system.js';
```

**Step 5: Run test to verify it passes**

Run: `pnpm test --filter core automation-system`
Expected: PASS - all cooldown tests pass

**Step 6: Commit**

```bash
git add packages/core/src/automation-system.ts packages/core/src/automation-system.test.ts packages/core/src/index.ts
git commit -m "feat(core): implement automation cooldown management"
```

---

## Task 4: Implement interval trigger evaluation

**Files:**
- Modify: `packages/core/src/automation-system.ts`
- Modify: `packages/core/src/automation-system.test.ts`

**Step 1: Write failing test for interval trigger**

Add to `packages/core/src/automation-system.test.ts` in `describe('interval triggers')`:

```typescript
describe('interval triggers', () => {
  it('should fire on first tick when lastFiredStep is -Infinity', () => {
    const automation: AutomationDefinition = {
      id: 'auto:test',
      name: { en: 'Test' },
      description: { en: 'Test' },
      targetType: 'generator',
      targetId: 'gen:test',
      trigger: { kind: 'interval', interval: { kind: 'constant', value: 1000 } },
      unlockCondition: { kind: 'always' },
      enabledByDefault: true,
      order: 0,
    };

    const state: AutomationState = {
      id: 'auto:test',
      enabled: true,
      lastFiredStep: -Infinity,
      cooldownExpiresStep: 0,
      unlocked: true,
    };

    const shouldFire = evaluateIntervalTrigger(automation, state, 0, 100);
    expect(shouldFire).toBe(true);
  });

  it('should fire when enough steps have elapsed', () => {
    const automation: AutomationDefinition = {
      id: 'auto:test',
      name: { en: 'Test' },
      description: { en: 'Test' },
      targetType: 'generator',
      targetId: 'gen:test',
      trigger: { kind: 'interval', interval: { kind: 'constant', value: 1000 } },
      unlockCondition: { kind: 'always' },
      enabledByDefault: true,
      order: 0,
    };

    const state: AutomationState = {
      id: 'auto:test',
      enabled: true,
      lastFiredStep: 0,
      cooldownExpiresStep: 0,
      unlocked: true,
    };

    // 1000ms interval / 100ms per step = 10 steps
    const shouldFire = evaluateIntervalTrigger(automation, state, 10, 100);
    expect(shouldFire).toBe(true);
  });

  it('should not fire when interval has not elapsed', () => {
    const automation: AutomationDefinition = {
      id: 'auto:test',
      name: { en: 'Test' },
      description: { en: 'Test' },
      targetType: 'generator',
      targetId: 'gen:test',
      trigger: { kind: 'interval', interval: { kind: 'constant', value: 1000 } },
      unlockCondition: { kind: 'always' },
      enabledByDefault: true,
      order: 0,
    };

    const state: AutomationState = {
      id: 'auto:test',
      enabled: true,
      lastFiredStep: 0,
      cooldownExpiresStep: 0,
      unlocked: true,
    };

    const shouldFire = evaluateIntervalTrigger(automation, state, 5, 100);
    expect(shouldFire).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test --filter core automation-system`
Expected: FAIL - evaluateIntervalTrigger is not defined

**Step 3: Implement interval trigger evaluator**

Add to `packages/core/src/automation-system.ts`:

```typescript
import { evaluateNumericFormula } from '@idle-engine/content-schema';

/**
 * Evaluates whether an interval trigger should fire.
 */
export function evaluateIntervalTrigger(
  automation: AutomationDefinition,
  state: AutomationState,
  currentStep: number,
  stepDurationMs: number,
): boolean {
  if (automation.trigger.kind !== 'interval') {
    throw new Error('Expected interval trigger');
  }

  // Fire immediately on first tick
  if (state.lastFiredStep === -Infinity) {
    return true;
  }

  // Calculate interval in steps
  const intervalMs = evaluateNumericFormula(automation.trigger.interval, {
    variables: { level: 0 }, // Static evaluation
  });
  const intervalSteps = Math.ceil(intervalMs / stepDurationMs);

  // Check if enough steps have elapsed
  const stepsSinceLastFired = currentStep - state.lastFiredStep;
  return stepsSinceLastFired >= intervalSteps;
}
```

**Step 4: Update test imports**

Edit `packages/core/src/automation-system.test.ts`:

```typescript
import {
  createAutomationSystem,
  getAutomationState,
  isCooldownActive,
  evaluateIntervalTrigger,
} from './automation-system.js';
```

**Step 5: Run test to verify it passes**

Run: `pnpm test --filter core automation-system`
Expected: PASS - all interval trigger tests pass

**Step 6: Export from index**

Edit `packages/core/src/index.ts`:

```typescript
export {
  createAutomationSystem,
  getAutomationState,
  isCooldownActive,
  evaluateIntervalTrigger,
  type AutomationSystemOptions,
  type AutomationState,
} from './automation-system.js';
```

**Step 7: Commit**

```bash
git add packages/core/src/automation-system.ts packages/core/src/automation-system.test.ts packages/core/src/index.ts
git commit -m "feat(core): implement interval trigger evaluation"
```

---

## Task 5: Implement command queue empty trigger evaluation

**Files:**
- Modify: `packages/core/src/automation-system.ts`
- Modify: `packages/core/src/automation-system.test.ts`

**Step 1: Write failing test for commandQueueEmpty trigger**

Add to `packages/core/src/automation-system.test.ts` in `describe('commandQueueEmpty triggers')`:

```typescript
import { CommandQueue } from './command-queue.js';

describe('commandQueueEmpty triggers', () => {
  it('should fire when command queue is empty', () => {
    const commandQueue = new CommandQueue();

    const shouldFire = evaluateCommandQueueEmptyTrigger(commandQueue);
    expect(shouldFire).toBe(true);
  });

  it('should not fire when command queue has commands', () => {
    const commandQueue = new CommandQueue();
    commandQueue.enqueue({
      type: 'TEST_COMMAND',
      priority: 1,
      payload: {},
      timestamp: 0,
      step: 0,
    });

    const shouldFire = evaluateCommandQueueEmptyTrigger(commandQueue);
    expect(shouldFire).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test --filter core automation-system`
Expected: FAIL - evaluateCommandQueueEmptyTrigger is not defined

**Step 3: Implement commandQueueEmpty trigger evaluator**

Add to `packages/core/src/automation-system.ts`:

```typescript
import type { CommandQueue } from './command-queue.js';

/**
 * Evaluates whether a commandQueueEmpty trigger should fire.
 */
export function evaluateCommandQueueEmptyTrigger(
  commandQueue: CommandQueue,
): boolean {
  return commandQueue.size === 0;
}
```

**Step 4: Update test imports**

Edit `packages/core/src/automation-system.test.ts`:

```typescript
import {
  createAutomationSystem,
  getAutomationState,
  isCooldownActive,
  evaluateIntervalTrigger,
  evaluateCommandQueueEmptyTrigger,
} from './automation-system.js';
```

**Step 5: Run test to verify it passes**

Run: `pnpm test --filter core automation-system`
Expected: PASS - all commandQueueEmpty trigger tests pass

**Step 6: Export from index**

Edit `packages/core/src/index.ts`:

```typescript
export {
  createAutomationSystem,
  getAutomationState,
  isCooldownActive,
  evaluateIntervalTrigger,
  evaluateCommandQueueEmptyTrigger,
  type AutomationSystemOptions,
  type AutomationState,
} from './automation-system.js';
```

**Step 7: Commit**

```bash
git add packages/core/src/automation-system.ts packages/core/src/automation-system.test.ts packages/core/src/index.ts
git commit -m "feat(core): implement commandQueueEmpty trigger evaluation"
```

---

## Task 6: Implement event trigger evaluation

**Files:**
- Modify: `packages/core/src/automation-system.ts`
- Modify: `packages/core/src/automation-system.test.ts`

**Step 1: Write failing test for event trigger**

Add to `packages/core/src/automation-system.test.ts` in `describe('event triggers')`:

```typescript
describe('event triggers', () => {
  it('should fire when event is pending', () => {
    const pendingEventTriggers = new Set(['auto:test']);

    const shouldFire = evaluateEventTrigger('auto:test', pendingEventTriggers);
    expect(shouldFire).toBe(true);
  });

  it('should not fire when event is not pending', () => {
    const pendingEventTriggers = new Set<string>();

    const shouldFire = evaluateEventTrigger('auto:test', pendingEventTriggers);
    expect(shouldFire).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test --filter core automation-system`
Expected: FAIL - evaluateEventTrigger is not defined

**Step 3: Implement event trigger evaluator**

Add to `packages/core/src/automation-system.ts`:

```typescript
/**
 * Evaluates whether an event trigger should fire.
 *
 * Event triggers fire when the automation ID is in the pendingEventTriggers set.
 * The set is populated by event handlers during setup() and cleared after each tick.
 */
export function evaluateEventTrigger(
  automationId: string,
  pendingEventTriggers: ReadonlySet<string>,
): boolean {
  return pendingEventTriggers.has(automationId);
}
```

**Step 4: Update test imports**

Edit `packages/core/src/automation-system.test.ts`:

```typescript
import {
  createAutomationSystem,
  getAutomationState,
  isCooldownActive,
  evaluateIntervalTrigger,
  evaluateCommandQueueEmptyTrigger,
  evaluateEventTrigger,
} from './automation-system.js';
```

**Step 5: Run test to verify it passes**

Run: `pnpm test --filter core automation-system`
Expected: PASS - all event trigger tests pass

**Step 6: Export from index**

Edit `packages/core/src/index.ts`:

```typescript
export {
  createAutomationSystem,
  getAutomationState,
  isCooldownActive,
  evaluateIntervalTrigger,
  evaluateCommandQueueEmptyTrigger,
  evaluateEventTrigger,
  type AutomationSystemOptions,
  type AutomationState,
} from './automation-system.js';
```

**Step 7: Commit**

```bash
git add packages/core/src/automation-system.ts packages/core/src/automation-system.test.ts packages/core/src/index.ts
git commit -m "feat(core): implement event trigger evaluation"
```

---

## Task 7: Implement resource threshold trigger evaluation (requires ResourceState interface)

**Files:**
- Modify: `packages/core/src/automation-system.ts`
- Modify: `packages/core/src/automation-system.test.ts`

**Step 1: Write failing test for resourceThreshold trigger**

Add to `packages/core/src/automation-system.test.ts` in `describe('resourceThreshold triggers')`:

```typescript
describe('resourceThreshold triggers', () => {
  const createMockResourceState = (amount: number) => ({
    getAmount: () => amount,
  });

  it('should fire when resource meets gte threshold', () => {
    const automation: AutomationDefinition = {
      id: 'auto:test',
      name: { en: 'Test' },
      description: { en: 'Test' },
      targetType: 'generator',
      targetId: 'gen:test',
      trigger: {
        kind: 'resourceThreshold',
        resourceId: 'res:gold',
        comparator: 'gte',
        threshold: { kind: 'constant', value: 100 },
      },
      unlockCondition: { kind: 'always' },
      enabledByDefault: true,
      order: 0,
    };

    const resourceState = createMockResourceState(100);
    const shouldFire = evaluateResourceThresholdTrigger(automation, resourceState);
    expect(shouldFire).toBe(true);
  });

  it('should not fire when resource below gte threshold', () => {
    const automation: AutomationDefinition = {
      id: 'auto:test',
      name: { en: 'Test' },
      description: { en: 'Test' },
      targetType: 'generator',
      targetId: 'gen:test',
      trigger: {
        kind: 'resourceThreshold',
        resourceId: 'res:gold',
        comparator: 'gte',
        threshold: { kind: 'constant', value: 100 },
      },
      unlockCondition: { kind: 'always' },
      enabledByDefault: true,
      order: 0,
    };

    const resourceState = createMockResourceState(99);
    const shouldFire = evaluateResourceThresholdTrigger(automation, resourceState);
    expect(shouldFire).toBe(false);
  });

  it('should fire when resource meets gt threshold', () => {
    const automation: AutomationDefinition = {
      id: 'auto:test',
      name: { en: 'Test' },
      description: { en: 'Test' },
      targetType: 'generator',
      targetId: 'gen:test',
      trigger: {
        kind: 'resourceThreshold',
        resourceId: 'res:gold',
        comparator: 'gt',
        threshold: { kind: 'constant', value: 100 },
      },
      unlockCondition: { kind: 'always' },
      enabledByDefault: true,
      order: 0,
    };

    const resourceState = createMockResourceState(101);
    const shouldFire = evaluateResourceThresholdTrigger(automation, resourceState);
    expect(shouldFire).toBe(true);
  });

  it('should fire when resource meets lte threshold', () => {
    const automation: AutomationDefinition = {
      id: 'auto:test',
      name: { en: 'Test' },
      description: { en: 'Test' },
      targetType: 'generator',
      targetId: 'gen:test',
      trigger: {
        kind: 'resourceThreshold',
        resourceId: 'res:gold',
        comparator: 'lte',
        threshold: { kind: 'constant', value: 100 },
      },
      unlockCondition: { kind: 'always' },
      enabledByDefault: true,
      order: 0,
    };

    const resourceState = createMockResourceState(100);
    const shouldFire = evaluateResourceThresholdTrigger(automation, resourceState);
    expect(shouldFire).toBe(true);
  });

  it('should fire when resource meets lt threshold', () => {
    const automation: AutomationDefinition = {
      id: 'auto:test',
      name: { en: 'Test' },
      description: { en: 'Test' },
      targetType: 'generator',
      targetId: 'gen:test',
      trigger: {
        kind: 'resourceThreshold',
        resourceId: 'res:gold',
        comparator: 'lt',
        threshold: { kind: 'constant', value: 100 },
      },
      unlockCondition: { kind: 'always' },
      enabledByDefault: true,
      order: 0,
    };

    const resourceState = createMockResourceState(99);
    const shouldFire = evaluateResourceThresholdTrigger(automation, resourceState);
    expect(shouldFire).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test --filter core automation-system`
Expected: FAIL - evaluateResourceThresholdTrigger is not defined

**Step 3: Implement resourceThreshold trigger evaluator**

Add to `packages/core/src/automation-system.ts`:

```typescript
/**
 * Minimal ResourceState interface for automation evaluation.
 * The full ResourceState is defined in shell-web package.
 */
export interface ResourceStateReader {
  getAmount(resourceIndex: number): number;
}

/**
 * Evaluates whether a resourceThreshold trigger should fire.
 */
export function evaluateResourceThresholdTrigger(
  automation: AutomationDefinition,
  resourceState: ResourceStateReader,
): boolean {
  if (automation.trigger.kind !== 'resourceThreshold') {
    throw new Error('Expected resourceThreshold trigger');
  }

  const { comparator, threshold } = automation.trigger;

  // Get resource amount
  // Note: resourceId is a ContentId (string), but ResourceState uses indices
  // In the real implementation, we'll need to resolve the ID to an index
  // For now, we'll accept a ResourceStateReader that handles this
  const amount = resourceState.getAmount(0); // Index will be resolved in integration

  // Evaluate threshold formula
  const thresholdValue = evaluateNumericFormula(threshold, {
    variables: { level: 0 }, // Static evaluation
  });

  // Compare resource amount to threshold
  switch (comparator) {
    case 'gte':
      return amount >= thresholdValue;
    case 'gt':
      return amount > thresholdValue;
    case 'lte':
      return amount <= thresholdValue;
    case 'lt':
      return amount < thresholdValue;
  }
}
```

**Step 4: Update test imports**

Edit `packages/core/src/automation-system.test.ts`:

```typescript
import {
  createAutomationSystem,
  getAutomationState,
  isCooldownActive,
  evaluateIntervalTrigger,
  evaluateCommandQueueEmptyTrigger,
  evaluateEventTrigger,
  evaluateResourceThresholdTrigger,
} from './automation-system.js';
```

**Step 5: Run test to verify it passes**

Run: `pnpm test --filter core automation-system`
Expected: PASS - all resourceThreshold trigger tests pass

**Step 6: Export from index**

Edit `packages/core/src/index.ts`:

```typescript
export {
  createAutomationSystem,
  getAutomationState,
  isCooldownActive,
  evaluateIntervalTrigger,
  evaluateCommandQueueEmptyTrigger,
  evaluateEventTrigger,
  evaluateResourceThresholdTrigger,
  type AutomationSystemOptions,
  type AutomationState,
  type ResourceStateReader,
} from './automation-system.js';
```

**Step 7: Commit**

```bash
git add packages/core/src/automation-system.ts packages/core/src/automation-system.test.ts packages/core/src/index.ts
git commit -m "feat(core): implement resourceThreshold trigger evaluation"
```

---

## Task 8: Implement command enqueueing logic

**Files:**
- Modify: `packages/core/src/automation-system.ts`
- Modify: `packages/core/src/automation-system.test.ts`

**Step 1: Write failing test for command enqueueing**

Add to `packages/core/src/automation-system.test.ts`:

```typescript
import { CommandPriority, RUNTIME_COMMAND_TYPES } from './command.js';

describe('command enqueueing', () => {
  it('should enqueue TOGGLE_GENERATOR command for generator target', () => {
    const automation: AutomationDefinition = {
      id: 'auto:test',
      name: { en: 'Test' },
      description: { en: 'Test' },
      targetType: 'generator',
      targetId: 'gen:clicks',
      trigger: { kind: 'interval', interval: { kind: 'constant', value: 1000 } },
      unlockCondition: { kind: 'always' },
      enabledByDefault: true,
      order: 0,
    };

    const commandQueue = new CommandQueue();

    enqueueAutomationCommand(automation, commandQueue, 10, 1000);

    expect(commandQueue.size).toBe(1);
    const command = commandQueue.dequeue(10);
    expect(command?.type).toBe(RUNTIME_COMMAND_TYPES.TOGGLE_GENERATOR);
    expect(command?.priority).toBe(CommandPriority.AUTOMATION);
    expect(command?.payload).toEqual({ generatorId: 'gen:clicks' });
  });

  it('should enqueue PURCHASE_UPGRADE command for upgrade target', () => {
    const automation: AutomationDefinition = {
      id: 'auto:test',
      name: { en: 'Test' },
      description: { en: 'Test' },
      targetType: 'upgrade',
      targetId: 'upg:doubler',
      trigger: { kind: 'interval', interval: { kind: 'constant', value: 1000 } },
      unlockCondition: { kind: 'always' },
      enabledByDefault: true,
      order: 0,
    };

    const commandQueue = new CommandQueue();

    enqueueAutomationCommand(automation, commandQueue, 10, 1000);

    expect(commandQueue.size).toBe(1);
    const command = commandQueue.dequeue(10);
    expect(command?.type).toBe(RUNTIME_COMMAND_TYPES.PURCHASE_UPGRADE);
    expect(command?.priority).toBe(CommandPriority.AUTOMATION);
    expect(command?.payload).toEqual({ upgradeId: 'upg:doubler', quantity: 1 });
  });

  it('should enqueue system command for system target', () => {
    const automation: AutomationDefinition = {
      id: 'auto:test',
      name: { en: 'Test' },
      description: { en: 'Test' },
      targetType: 'system',
      systemTargetId: 'system:prestige',
      trigger: { kind: 'interval', interval: { kind: 'constant', value: 1000 } },
      unlockCondition: { kind: 'always' },
      enabledByDefault: true,
      order: 0,
    };

    const commandQueue = new CommandQueue();

    enqueueAutomationCommand(automation, commandQueue, 10, 1000);

    expect(commandQueue.size).toBe(1);
    const command = commandQueue.dequeue(10);
    expect(command?.type).toBe('system:prestige');
    expect(command?.priority).toBe(CommandPriority.AUTOMATION);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test --filter core automation-system`
Expected: FAIL - enqueueAutomationCommand is not defined

**Step 3: Implement command enqueueing**

Add to `packages/core/src/automation-system.ts`:

```typescript
import { CommandPriority, RUNTIME_COMMAND_TYPES } from './command.js';

/**
 * Enqueues a command for an automation trigger.
 */
export function enqueueAutomationCommand(
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
    commandType = systemTargetId ?? 'system:unknown';
    payload = {};
  } else {
    throw new Error(`Unknown target type: ${targetType}`);
  }

  commandQueue.enqueue({
    type: commandType,
    payload,
    priority: CommandPriority.AUTOMATION,
    timestamp,
    step: currentStep + 1, // Execute on next step
  });
}
```

**Step 4: Update test imports**

Edit `packages/core/src/automation-system.test.ts`:

```typescript
import {
  createAutomationSystem,
  getAutomationState,
  isCooldownActive,
  evaluateIntervalTrigger,
  evaluateCommandQueueEmptyTrigger,
  evaluateEventTrigger,
  evaluateResourceThresholdTrigger,
  enqueueAutomationCommand,
} from './automation-system.js';
```

**Step 5: Run test to verify it passes**

Run: `pnpm test --filter core automation-system`
Expected: PASS - all command enqueueing tests pass

**Step 6: Export from index**

Edit `packages/core/src/index.ts`:

```typescript
export {
  createAutomationSystem,
  getAutomationState,
  isCooldownActive,
  evaluateIntervalTrigger,
  evaluateCommandQueueEmptyTrigger,
  evaluateEventTrigger,
  evaluateResourceThresholdTrigger,
  enqueueAutomationCommand,
  type AutomationSystemOptions,
  type AutomationState,
  type ResourceStateReader,
} from './automation-system.js';
```

**Step 7: Commit**

```bash
git add packages/core/src/automation-system.ts packages/core/src/automation-system.test.ts packages/core/src/index.ts
git commit -m "feat(core): implement automation command enqueueing"
```

---

## Task 9: Implement setup() for event subscriptions

**Files:**
- Modify: `packages/core/src/automation-system.ts`
- Modify: `packages/core/src/automation-system.test.ts`

**Step 1: Write failing integration test for event subscription**

Add to `packages/core/src/automation-system.test.ts`:

```typescript
import { IdleEngineRuntime } from './index.js';

describe('system integration', () => {
  it('should subscribe to event triggers during setup', () => {
    const automations: AutomationDefinition[] = [
      {
        id: 'auto:event-test',
        name: { en: 'Event Test' },
        description: { en: 'Test' },
        targetType: 'generator',
        targetId: 'gen:clicks',
        trigger: { kind: 'event', eventId: 'resource:threshold-reached' },
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
        order: 0,
      },
    ];

    const commandQueue = new CommandQueue();
    const runtime = new IdleEngineRuntime({ stepSizeMs: 100 });
    const system = createAutomationSystem({
      automations,
      stepDurationMs: 100,
      commandQueue,
      resourceState: { getAmount: () => 0 },
    });

    runtime.addSystem(system);

    // Verify system was registered
    expect(system.id).toBe('automation-system');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test --filter core automation-system`
Expected: FAIL - commandQueue and resourceState not in options

**Step 3: Update AutomationSystemOptions to include dependencies**

Modify `packages/core/src/automation-system.ts`:

```typescript
export interface AutomationSystemOptions {
  readonly automations: readonly AutomationDefinition[];
  readonly stepDurationMs: number;
  readonly commandQueue: CommandQueue;
  readonly resourceState: ResourceStateReader;
  readonly initialState?: Map<string, AutomationState>;
}
```

**Step 4: Implement setup() with event subscriptions**

Modify `packages/core/src/automation-system.ts` in `createAutomationSystem()`:

```typescript
export function createAutomationSystem(
  options: AutomationSystemOptions,
): System & { getState: () => ReadonlyMap<string, AutomationState> } {
  const { automations, stepDurationMs, commandQueue, resourceState } = options;
  const automationStates = new Map<string, AutomationState>();
  const pendingEventTriggers = new Set<string>();

  // Initialize automation states
  for (const automation of automations) {
    const existingState = options.initialState?.get(automation.id);
    automationStates.set(automation.id, existingState ?? {
      id: automation.id,
      enabled: automation.enabledByDefault,
      lastFiredStep: -Infinity,
      cooldownExpiresStep: 0,
      unlocked: false,
    });
  }

  return {
    id: 'automation-system',

    getState() {
      return new Map(automationStates);
    },

    setup({ events }) {
      // Subscribe to event triggers
      for (const automation of automations) {
        if (automation.trigger.kind === 'event') {
          events.on(automation.trigger.eventId as any, () => {
            pendingEventTriggers.add(automation.id);
          });
        }
      }

      // Subscribe to automation toggle events
      events.on('automation:toggled' as any, (event: any) => {
        const { automationId, enabled } = event.payload;
        const state = automationStates.get(automationId);
        if (state) {
          state.enabled = enabled;
        }
      });
    },

    tick({ step, deltaMs, events }) {
      // TODO: Implement tick logic
    },
  };
}
```

**Step 5: Run test to verify it passes**

Run: `pnpm test --filter core automation-system`
Expected: PASS - system integrates with runtime

**Step 6: Commit**

```bash
git add packages/core/src/automation-system.ts packages/core/src/automation-system.test.ts packages/core/src/index.ts
git commit -m "feat(core): implement automation event subscriptions in setup"
```

---

## Task 10: Implement tick() logic with trigger evaluation

**Files:**
- Modify: `packages/core/src/automation-system.ts`
- Modify: `packages/core/src/automation-system.test.ts`

**Step 1: Write failing end-to-end integration test**

Add to `packages/core/src/automation-system.test.ts`:

```typescript
describe('end-to-end automation', () => {
  it('should fire interval automation and enqueue command', () => {
    const automations: AutomationDefinition[] = [
      {
        id: 'auto:collector',
        name: { en: 'Auto Collector' },
        description: { en: 'Collects automatically' },
        targetType: 'generator',
        targetId: 'gen:clicks',
        trigger: { kind: 'interval', interval: { kind: 'constant', value: 1000 } },
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
        order: 0,
      },
    ];

    const commandQueue = new CommandQueue();
    const runtime = new IdleEngineRuntime({ stepSizeMs: 100 });
    const system = createAutomationSystem({
      automations,
      stepDurationMs: 100,
      commandQueue,
      resourceState: { getAmount: () => 0 },
    });

    runtime.addSystem(system);

    // Tick once - should fire immediately
    runtime.tick(100);

    expect(commandQueue.size).toBe(1);
    const command = commandQueue.dequeue(1);
    expect(command?.type).toBe(RUNTIME_COMMAND_TYPES.TOGGLE_GENERATOR);
  });

  it('should respect enabled flag', () => {
    const automations: AutomationDefinition[] = [
      {
        id: 'auto:collector',
        name: { en: 'Auto Collector' },
        description: { en: 'Collects automatically' },
        targetType: 'generator',
        targetId: 'gen:clicks',
        trigger: { kind: 'interval', interval: { kind: 'constant', value: 1000 } },
        unlockCondition: { kind: 'always' },
        enabledByDefault: false, // Disabled
        order: 0,
      },
    ];

    const commandQueue = new CommandQueue();
    const runtime = new IdleEngineRuntime({ stepSizeMs: 100 });
    const system = createAutomationSystem({
      automations,
      stepDurationMs: 100,
      commandQueue,
      resourceState: { getAmount: () => 0 },
    });

    runtime.addSystem(system);
    runtime.tick(100);

    expect(commandQueue.size).toBe(0);
  });

  it('should respect cooldown', () => {
    const automations: AutomationDefinition[] = [
      {
        id: 'auto:collector',
        name: { en: 'Auto Collector' },
        description: { en: 'Collects automatically' },
        targetType: 'generator',
        targetId: 'gen:clicks',
        trigger: { kind: 'interval', interval: { kind: 'constant', value: 100 } },
        cooldown: 500, // 5 steps
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
        order: 0,
      },
    ];

    const commandQueue = new CommandQueue();
    const runtime = new IdleEngineRuntime({ stepSizeMs: 100 });
    const system = createAutomationSystem({
      automations,
      stepDurationMs: 100,
      commandQueue,
      resourceState: { getAmount: () => 0 },
    });

    runtime.addSystem(system);

    // First tick - should fire
    runtime.tick(100);
    expect(commandQueue.size).toBe(1);
    commandQueue.dequeue(1);

    // Tick again - should be in cooldown
    runtime.tick(100);
    expect(commandQueue.size).toBe(0);

    // Tick 4 more times (total 5 more ticks)
    runtime.tick(100);
    runtime.tick(100);
    runtime.tick(100);
    runtime.tick(100);

    // Should still be in cooldown
    expect(commandQueue.size).toBe(0);

    // One more tick - cooldown expired
    runtime.tick(100);
    expect(commandQueue.size).toBe(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test --filter core automation-system`
Expected: FAIL - tick() not implemented

**Step 3: Implement tick() logic**

Modify `packages/core/src/automation-system.ts` in `createAutomationSystem()`:

```typescript
tick({ step, deltaMs, events }) {
  // Evaluate each automation
  for (const automation of automations) {
    const state = automationStates.get(automation.id);
    if (!state) continue;

    // Update unlock status
    // For MVP, we'll assume all automations with 'always' condition are unlocked
    // Full unlock evaluation requires condition context (deferred to integration)
    state.unlocked = automation.unlockCondition.kind === 'always';

    // Skip if not unlocked or not enabled
    if (!state.unlocked || !state.enabled) {
      continue;
    }

    // Skip if cooldown is active
    if (isCooldownActive(state, step)) {
      continue;
    }

    // Evaluate trigger
    let triggered = false;
    switch (automation.trigger.kind) {
      case 'interval':
        triggered = evaluateIntervalTrigger(automation, state, step, stepDurationMs);
        break;
      case 'resourceThreshold':
        triggered = evaluateResourceThresholdTrigger(automation, resourceState);
        break;
      case 'commandQueueEmpty':
        triggered = evaluateCommandQueueEmptyTrigger(commandQueue);
        break;
      case 'event':
        triggered = evaluateEventTrigger(automation.id, pendingEventTriggers);
        break;
    }

    if (!triggered) {
      continue;
    }

    // TODO: Check resource cost (deferred - requires resource deduction API)

    // Enqueue command
    enqueueAutomationCommand(automation, commandQueue, step, Date.now());

    // Update state
    state.lastFiredStep = step;
    updateCooldown(automation, state, step, stepDurationMs);
  }

  // Clear pending event triggers
  pendingEventTriggers.clear();
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm test --filter core automation-system`
Expected: PASS - all end-to-end tests pass

**Step 5: Commit**

```bash
git add packages/core/src/automation-system.ts packages/core/src/automation-system.test.ts
git commit -m "feat(core): implement automation tick logic with trigger evaluation"
```

---

## Task 11: Run full test suite and fix any issues

**Files:**
- Modify: `packages/core/src/automation-system.ts`
- Modify: `packages/core/src/automation-system.test.ts`

**Step 1: Run full core test suite**

Run: `pnpm test --filter core`
Expected: All tests pass, or identify failures to fix

**Step 2: Fix any TypeScript compilation errors**

Run: `pnpm build --filter core`
Expected: TypeScript compilation succeeds

**Step 3: Run linter**

Run: `pnpm lint --filter core`
Expected: No lint errors

**Step 4: Fix any issues found**

If there are issues:
- Fix TypeScript errors (missing imports, type mismatches)
- Fix lint errors (formatting, unused variables)
- Fix test failures (update tests or implementation)

**Step 5: Commit fixes**

```bash
git add packages/core/src/automation-system.ts packages/core/src/automation-system.test.ts packages/core/src/index.ts
git commit -m "fix(core): resolve test failures and lint issues"
```

---

## Task 12: Add additional edge case tests

**Files:**
- Modify: `packages/core/src/automation-system.test.ts`

**Step 1: Write tests for edge cases**

Add to `packages/core/src/automation-system.test.ts`:

```typescript
describe('edge cases', () => {
  it('should handle empty automation list', () => {
    const system = createAutomationSystem({
      automations: [],
      stepDurationMs: 100,
      commandQueue: new CommandQueue(),
      resourceState: { getAmount: () => 0 },
    });

    expect(system.id).toBe('automation-system');
    expect(system.getState().size).toBe(0);
  });

  it('should handle automation with no cooldown', () => {
    const automations: AutomationDefinition[] = [
      {
        id: 'auto:nocooldown',
        name: { en: 'No Cooldown' },
        description: { en: 'Test' },
        targetType: 'generator',
        targetId: 'gen:clicks',
        trigger: { kind: 'interval', interval: { kind: 'constant', value: 100 } },
        // No cooldown field
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
        order: 0,
      },
    ];

    const commandQueue = new CommandQueue();
    const runtime = new IdleEngineRuntime({ stepSizeMs: 100 });
    const system = createAutomationSystem({
      automations,
      stepDurationMs: 100,
      commandQueue,
      resourceState: { getAmount: () => 0 },
    });

    runtime.addSystem(system);
    runtime.tick(100); // Fire once
    runtime.tick(100); // Fire again (no cooldown)

    expect(commandQueue.size).toBe(2);
  });

  it('should clear pending event triggers after tick', () => {
    const automations: AutomationDefinition[] = [
      {
        id: 'auto:event',
        name: { en: 'Event' },
        description: { en: 'Test' },
        targetType: 'generator',
        targetId: 'gen:clicks',
        trigger: { kind: 'event', eventId: 'test:event' },
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
        order: 0,
      },
    ];

    const commandQueue = new CommandQueue();
    const runtime = new IdleEngineRuntime({ stepSizeMs: 100 });
    const system = createAutomationSystem({
      automations,
      stepDurationMs: 100,
      commandQueue,
      resourceState: { getAmount: () => 0 },
    });

    runtime.addSystem(system);

    // Publish event
    runtime.getEventBus().publish('test:event' as any, {});
    runtime.tick(100); // Should fire

    expect(commandQueue.size).toBe(1);
    commandQueue.dequeue(1);

    // Tick again without event
    runtime.tick(100);
    expect(commandQueue.size).toBe(0); // Event triggers cleared
  });
});
```

**Step 2: Run tests to verify they pass**

Run: `pnpm test --filter core automation-system`
Expected: PASS - all edge case tests pass

**Step 3: Commit**

```bash
git add packages/core/src/automation-system.test.ts
git commit -m "test(core): add edge case tests for automation system"
```

---

## Task 13: Document the AutomationSystem API

**Files:**
- Create: `packages/core/src/automation-system.md` (inline documentation)

**Step 1: Add comprehensive JSDoc comments**

Ensure all exported functions have JSDoc in `packages/core/src/automation-system.ts`:

```typescript
/**
 * @fileoverview Automation System
 *
 * The AutomationSystem evaluates automation triggers and enqueues commands
 * when triggers fire. It supports 4 trigger types:
 * - interval: Fires periodically based on elapsed time
 * - resourceThreshold: Fires when resource amount crosses threshold
 * - commandQueueEmpty: Fires when command queue is empty
 * - event: Fires when a specific event is published
 *
 * The system manages automation state (enabled/disabled, cooldowns, last-fired)
 * and integrates with the IdleEngineRuntime tick loop.
 *
 * @example
 * ```typescript
 * const system = createAutomationSystem({
 *   automations: contentPack.automations,
 *   stepDurationMs: 100,
 *   commandQueue: runtime.getCommandQueue(),
 *   resourceState: progressionCoordinator.resourceState,
 * });
 *
 * runtime.addSystem(system);
 * ```
 */
```

**Step 2: Commit documentation**

```bash
git add packages/core/src/automation-system.ts
git commit -m "docs(core): add JSDoc comments to automation system"
```

---

## Completion Checklist

Before marking this issue complete, verify:

- ✅ All trigger types evaluate correctly (interval, resourceThreshold, commandQueueEmpty, event)
- ✅ Automation state is managed (enabled/disabled, cooldowns, last-fired)
- ✅ Commands are enqueued at AUTOMATION priority
- ✅ Unit tests pass with good coverage
- ✅ TypeScript compilation succeeds
- ✅ Linter passes with no errors
- ✅ State can be serialized (getAutomationState() works)
- ✅ System integrates with IdleEngineRuntime

---

## Notes

### Deferred to Integration (Issue #323)

The following features require integration with shell-web and are deferred:

1. **Resource cost handling**: Requires ResourceState.spend() API
2. **Full unlock condition evaluation**: Requires ConditionContext from ProgressionCoordinator
3. **Resource ID to index mapping**: Requires ContentRegistry from shell-web
4. **Monotonic timestamps**: Currently using Date.now(), should use runtime timestamp

These will be addressed in the integration issue.

### Testing Strategy

- **Unit tests**: Test individual functions in isolation
- **Integration tests**: Test system with IdleEngineRuntime
- **Edge cases**: Empty automations, no cooldown, event clearing
- **Property-based tests**: Deferred to separate testing issue

### Performance Considerations

- Automation evaluation is O(n) where n = number of automations
- Early exits for disabled/locked/cooldown automations
- Event triggers use Set for O(1) lookup
- No expensive operations in hot path

---

## Related Skills

- **@superpowers:test-driven-development**: Follow TDD cycle for each task
- **@superpowers:verification-before-completion**: Run all tests before marking complete
- **@superpowers:systematic-debugging**: If tests fail, investigate root cause before fixing

---

## Execution Options

Plan saved to `docs/plans/2025-11-04-automation-system-core.md`.

**1. Subagent-Driven (this session)** - Dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

Which approach would you like?
