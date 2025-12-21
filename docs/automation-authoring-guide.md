---
title: Automation Content Authoring Guide
description: Step-by-step guide for authoring automation definitions in content packs
sidebar_position: 14
---

# Automation Content Authoring Guide

This guide teaches content authors how to define automations in Idle Engine content packs. Automations enable idle gameplay by automatically triggering generators, upgrades, and system commands without manual player intervention.

## Overview

Automations are defined in the `automations` array of your `pack.json` file. Each automation specifies:

1. **Trigger**: When the automation fires (interval, resource threshold, event, or queue empty)
2. **Target**: What command to execute (generator, upgrade, purchaseGenerator, collectResource, or system)
3. **Conditions**: When the automation is available (unlock and visibility conditions, enabled state)
4. **Constraints**: Rate limiting and costs (cooldowns, resource costs)

## Automation Schema

### Required Fields

```typescript
{
  "id": "pack-slug.automation-name",        // Unique identifier
  "name": { "default": "Display Name" },     // Localized name
  "description": { "default": "..." },       // Localized description
  "targetType": "generator" | "upgrade" | "purchaseGenerator" | "collectResource" | "system",  // What to trigger
  "targetId": "pack-slug.target-id",         // Target identifier (for generator/upgrade/purchaseGenerator/collectResource)
  "trigger": { /* trigger definition */ },   // When to fire
  "unlockCondition": { "kind": "always" }    // When available
}
```

### Optional Fields

```typescript
{
  "cooldown": 5000,                          // Milliseconds between fires
  "targetEnabled": false,                    // Generator enabled state (generator target only, default: true)
  "targetCount": { "kind": "constant", "value": 1 }, // Purchase count formula (purchaseGenerator target only)
  "targetAmount": { "kind": "constant", "value": 1 }, // Collect amount formula (collectResource target only)
  "resourceCost": {                          // Deduct resources when firing
    "resourceId": "pack.resource",
    "rate": { "kind": "constant", "value": 10 }
  },
  "visibilityCondition": { "kind": "always" }, // Optional visibility gate (UI only)
  "enabledByDefault": true,                  // Initial enabled state
  "order": 100,                              // Display order in UI
  "systemTargetId": "system:prestige"        // System command (for targetType: "system")
}
```

---

## Trigger Types

### 1. Interval Trigger

Fires periodically based on elapsed time.

**Schema:**
```json
{
  "trigger": {
    "kind": "interval",
    "interval": { "kind": "constant", "value": 1000 }
  }
}
```

**Behavior:**

- Fires immediately on first tick (when automation is enabled and unlocked)
- Subsequently fires when elapsed time ≥ interval duration
- Interval can be a numeric formula (constant, linear, exponential, etc.)

**Example: Auto-click generator every 5 seconds**

```json
{
  "id": "sample-pack.auto-clicker",
  "name": { "default": "Auto Clicker" },
  "description": { "default": "Automatically clicks the reactor every 5 seconds" },
  "targetType": "generator",
  "targetId": "sample-pack.reactor",
  "trigger": {
    "kind": "interval",
    "interval": { "kind": "constant", "value": 5000 }
  },
  "unlockCondition": { "kind": "always" },
  "enabledByDefault": true,
  "order": 1
}
```

**Use Cases:**

- Auto-clicking generators at fixed intervals
- Periodic resource collection
- Timed upgrade purchases
- Recurring prestige triggers

---

### 2. Resource Threshold Trigger

Fires when a resource amount crosses a threshold (transition from below to above, or vice versa).

**Schema:**
```json
{
  "trigger": {
    "kind": "resourceThreshold",
    "resourceId": "pack-slug.resource-id",
    "comparator": "gte" | "gt" | "lte" | "lt",
    "threshold": { "kind": "constant", "value": 100 }
  }
}
```

**Comparators:**

- `gte`: Greater than or equal to (≥)
- `gt`: Greater than (\>)
- `lte`: Less than or equal to (≤)
- `lt`: Less than (\<)

**Crossing Detection:**

The automation fires only on threshold **crossings** (transitions), not continuously while the condition is met. For example, with `comparator: "gte"` and `threshold: 100`:

- Resource goes from 99 → 100: **Fires** (crossing from below to above)
- Resource stays at 100+: **Does not fire** (no crossing)
- Resource goes from 100 → 99 → 105: **Fires** (crossed back above)

**Interaction with resourceCost:**

- When a `resourceCost` is configured, the cost is evaluated and charged at the moment the threshold crossing would fire.
- If the player cannot afford the cost at that moment, the automation does not enqueue and the crossing is **not consumed**. The automation will re-attempt on subsequent ticks while the threshold condition remains satisfied. Add a `cooldown` if you want to rate‑limit these retries.
- When the spend succeeds, the crossing is consumed (no immediate refire until the condition later falls below and crosses above again) and the command is enqueued.

**Example: Threshold with resourceCost (constant rate)**

```json
{
  "id": "sample-pack.auto-upgrade-threshold-costed",
  "name": { "default": "Auto Upgrade (Threshold + Cost)" },
  "description": { "default": "Purchases an upgrade when energy crosses 50, spending 10 tokens if available" },
  "targetType": "upgrade",
  "targetId": "sample-pack.upgrade-efficiency",
  "trigger": {
    "kind": "resourceThreshold",
    "resourceId": "sample-pack.energy",
    "comparator": "gte",
    "threshold": { "kind": "constant", "value": 50 }
  },
  "resourceCost": {
    "resourceId": "sample-pack.tokens",
    "rate": { "kind": "constant", "value": 10 }
  },
  "cooldown": 2000,
  "unlockCondition": { "kind": "always" },
  "enabledByDefault": false,
  "order": 2
}
```

**Example: Auto-purchase upgrade when resources reach 50**

```json
{
  "id": "sample-pack.auto-upgrade-efficiency",
  "name": { "default": "Auto Upgrade: Efficiency" },
  "description": { "default": "Automatically purchases Efficiency upgrade when you have 50+ energy" },
  "targetType": "upgrade",
  "targetId": "sample-pack.upgrade-efficiency",
  "trigger": {
    "kind": "resourceThreshold",
    "resourceId": "sample-pack.energy",
    "comparator": "gte",
    "threshold": { "kind": "constant", "value": 50 }
  },
  "cooldown": 2000,
  "unlockCondition": {
    "kind": "resourceThreshold",
    "resourceId": "sample-pack.energy",
    "comparator": "gte",
    "amount": { "kind": "constant", "value": 25 }
  },
  "enabledByDefault": false,
  "order": 2
}
```

**Use Cases:**

- Auto-purchase upgrades when affordable
- Trigger prestige at resource cap
- Enable generators when resources are sufficient
- Resource balancing (e.g., convert excess energy to crystals)

---

### 3. Command Queue Empty Trigger

Fires when the command queue is empty (no commands pending execution).

**Schema:**
```json
{
  "trigger": {
    "kind": "commandQueueEmpty"
  }
}
```

**Behavior:**

- Fires when `commandQueue.size === 0`
- Useful for low-priority automations that shouldn't interrupt other actions
- Re-fires every tick while queue remains empty (use cooldown to rate limit)

**Example: Auto-collect idle resources when queue is empty**

```json
{
  "id": "sample-pack.auto-idle-collector",
  "name": { "default": "Idle Collector" },
  "description": { "default": "Collects resources when no other actions are pending" },
  "targetType": "generator",
  "targetId": "sample-pack.reactor",
  "trigger": {
    "kind": "commandQueueEmpty"
  },
  "cooldown": 10000,
  "unlockCondition": { "kind": "always" },
  "enabledByDefault": true,
  "order": 3
}
```

**Use Cases:**

- Low-priority resource collection
- Background maintenance tasks
- Idle time optimization
- Queue-sensitive automation chains

**Important:** Without a cooldown, this fires every tick when queue is empty. Always add a cooldown for queue-empty triggers.

---

### 4. Event Trigger

Fires when a specific runtime event is published.

**Schema:**
```json
{
  "trigger": {
    "kind": "event",
    "eventId": "pack-slug.event-id"
  }
}
```

**Behavior:**

- Listens for events published to the runtime event bus
- Fires once per event occurrence
- Event must be defined in `eventDefinitions` or base runtime events
- When `resourceCost` is present: the cost is evaluated and charged at fire‑time. If the spend fails due to insufficient resources, the pending event is retained and retried on subsequent ticks; on successful spend, the event is consumed and cooldown/last‑fired are updated.

**Example: Auto-purchase upgrade when milestone reached**

```json
{
  "id": "sample-pack.auto-upgrade-on-milestone",
  "name": { "default": "Milestone Upgrade" },
  "description": { "default": "Automatically purchases next upgrade when a milestone is reached" },
  "targetType": "upgrade",
  "targetId": "sample-pack.upgrade-capacity",
  "trigger": {
    "kind": "event",
    "eventId": "sample-pack.milestone-reached"
  },
  "unlockCondition": { "kind": "always" },
  "enabledByDefault": false,
  "order": 4
}
```

**Use Cases:**

- Reactive automation chains (one automation triggers another)
- Milestone-based progression
- Achievement-triggered rewards
- Dynamic gameplay responses

**Available Runtime Events:**

- `automation:toggled`: Automation enabled/disabled
- `resource:threshold-reached`: Resource crossed threshold
- Custom events defined in content pack's `eventDefinitions`

---

## Target Types

### Generator Target

Triggers a generator to start producing resources.

**Schema:**
```json
{
  "targetType": "generator",
  "targetId": "pack-slug.generator-id",
  "targetEnabled": true
}
```

**Generated Command:** `TOGGLE_GENERATOR` with `enabled: targetEnabled ?? true`

**Behavior:**

- Enables the generator (starts production) by default
- Set `"targetEnabled": false` to disable a generator via automation
- Generator must be unlocked for command to succeed

**Example:**
```json
{
  "id": "sample-pack.auto-reactor",
  "targetType": "generator",
  "targetId": "sample-pack.reactor",
  "trigger": { "kind": "interval", "interval": { "kind": "constant", "value": 3000 } },
  "unlockCondition": { "kind": "always" }
}
```

---

### Purchase Generator Target

Purchases one or more generator levels.

**Schema:**
```json
{
  "targetType": "purchaseGenerator",
  "targetId": "pack-slug.generator-id",
  "targetCount": { "kind": "constant", "value": 1 }
}
```

**Generated Command:** `PURCHASE_GENERATOR` with `{ generatorId: targetId, count: floor(targetCount ?? 1) (min 1) }`

**Behavior:**

- Defaults to buying 1 generator level when `targetCount` is omitted
- Floors non-integer counts and clamps to a minimum of 1 before enqueueing
- Purchase can fail if the generator is locked or the player cannot afford the quote

**Example:**
```json
{
  "id": "sample-pack.auto-buy-reactor",
  "targetType": "purchaseGenerator",
  "targetId": "sample-pack.reactor",
  "targetCount": { "kind": "constant", "value": 1 },
  "trigger": {
    "kind": "resourceThreshold",
    "resourceId": "sample-pack.energy",
    "comparator": "gte",
    "threshold": { "kind": "constant", "value": 25 }
  },
  "unlockCondition": { "kind": "always" }
}
```

---

### Collect Resource Target

Collects (adds) a resource amount via the shared `COLLECT_RESOURCE` command path.

**Schema:**
```json
{
  "targetType": "collectResource",
  "targetId": "pack-slug.resource-id",
  "targetAmount": { "kind": "constant", "value": 1 }
}
```

**Generated Command:** `COLLECT_RESOURCE` with `{ resourceId: targetId, amount: max(targetAmount ?? 1, 0) }`

**Behavior:**

- Defaults to collecting 1 when `targetAmount` is omitted
- Non-positive or non-finite amounts are treated as 0 before enqueueing

**Example:**
```json
{
  "id": "sample-pack.auto-collect-energy",
  "targetType": "collectResource",
  "targetId": "sample-pack.energy",
  "targetAmount": { "kind": "constant", "value": 1 },
  "trigger": { "kind": "interval", "interval": { "kind": "constant", "value": 1000 } },
  "unlockCondition": { "kind": "always" }
}
```

---

### Upgrade Target

Purchases an upgrade.

**Schema:**
```json
{
  "targetType": "upgrade",
  "targetId": "pack-slug.upgrade-id"
}
```

**Generated Command:** `PURCHASE_UPGRADE` with `{ upgradeId: targetId }`

**Behavior:**

- Attempts to purchase one instance of the upgrade
- Fails if upgrade is locked or player cannot afford it
- Upgrade cost deducted automatically by command handler

**Example:**
```json
{
  "id": "sample-pack.auto-upgrade-efficiency",
  "targetType": "upgrade",
  "targetId": "sample-pack.upgrade-efficiency",
  "trigger": {
    "kind": "resourceThreshold",
    "resourceId": "sample-pack.energy",
    "comparator": "gte",
    "threshold": { "kind": "constant", "value": 50 }
  },
  "unlockCondition": { "kind": "always" }
}
```

---

### System Target

Triggers a system command (e.g., prestige, save, reset).

**Schema:**
```json
{
  "targetType": "system",
  "systemTargetId": "system:prestige" | "system:save" | "system:reset"
}
```

**Generated Command:** System-specific command type

**Behavior:**

- Executes system-level operations
- System commands defined by runtime, not content pack
- Use sparingly; most automation should target generators/upgrades

**Example:**
```json
{
  "id": "sample-pack.auto-prestige",
  "targetType": "system",
  "systemTargetId": "system:prestige",
  "trigger": {
    "kind": "resourceThreshold",
    "resourceId": "sample-pack.energy",
    "comparator": "gte",
    "threshold": { "kind": "constant", "value": 1000 }
  },
  "unlockCondition": {
    "kind": "resourceThreshold",
    "resourceId": "sample-pack.prestige-currency",
    "comparator": "gte",
    "amount": { "kind": "constant", "value": 1 }
  },
  "enabledByDefault": false,
  "order": 10
}
```

**Available System Targets:**

- `system:prestige`: Trigger prestige reset
- `system:save`: Force save game state
- `system:reset`: Hard reset (rarely used in automations)

---

## Cooldowns

Cooldowns prevent automations from firing too frequently.

**Schema:**
```json
{
  "cooldown": 5000  // Milliseconds
}
```

**Behavior:**

- After firing, automation enters cooldown period
- Cannot fire again until cooldown expires
- Cooldown timer based on simulation steps (deterministic)
- Cooldown expiry: `cooldownExpiresStep = currentStep + cooldownSteps + 1`

**When to Use:**

- **Interval triggers**: Usually don't need cooldown (interval provides rate limiting)
- **Threshold triggers**: Recommended to prevent rapid re-fires on threshold fluctuations
- **Queue empty triggers**: **Required** to prevent firing every tick
- **Event triggers**: Optional, depends on event frequency

**Example: Threshold with cooldown**

```json
{
  "id": "sample-pack.auto-upgrade",
  "targetType": "upgrade",
  "targetId": "sample-pack.upgrade-capacity",
  "trigger": {
    "kind": "resourceThreshold",
    "resourceId": "sample-pack.energy",
    "comparator": "gte",
    "threshold": { "kind": "constant", "value": 100 }
  },
  "cooldown": 5000,
  "unlockCondition": { "kind": "always" }
}
```

**Without cooldown:** If energy fluctuates around 100, automation fires repeatedly
**With cooldown:** After firing once, waits 5 seconds before checking again

---

## Resource Costs

Resource costs are deducted when an automation fires.

**Schema:**
```json
{
  "resourceCost": {
    "resourceId": "pack-slug.resource-id",
    "rate": { "kind": "constant", "value": 10 }
  }
}
```

**Behavior:**

- Evaluation timing: cost `rate` (a NumericFormula) is evaluated at **fire‑time** using current state.
- Affordability: the engine checks if the player can afford the computed amount.
- Deduction: on success, the cost is deducted **before** the command is enqueued; on failure, the automation does not enqueue.
- Cooldown/consumption on failure: failed spends do not update `lastFired` or start cooldown. For event triggers, the pending event is retained; for resource‑threshold triggers, the false→true crossing is not consumed and will retry while the condition holds (use `cooldown` to rate‑limit).
- Formula support: constant formulas are supported; more advanced/multi‑resource costs are currently out of scope.

**Example: Auto-prestige with resource cost**

```json
{
  "id": "sample-pack.auto-prestige-expensive",
  "targetType": "system",
  "systemTargetId": "system:prestige",
  "trigger": {
    "kind": "interval",
    "interval": { "kind": "constant", "value": 30000 }
  },
  "resourceCost": {
    "resourceId": "sample-pack.prestige-tokens",
    "rate": { "kind": "constant", "value": 1 }
  },
  "unlockCondition": { "kind": "always" },
  "enabledByDefault": false,
  "order": 20
}
```

**Use Cases:**

- Premium automations (players "pay" for convenience)
- Resource sinks (balance economy)
- Gated automation (requires resource generation first)

**Note:** The upgrade's own cost is deducted automatically by the `PURCHASE_UPGRADE` command handler. The `resourceCost` field is for an *additional* cost specific to the automation itself.

### Limitations (current iteration)

- `resourceCost` supports a single resource with a `rate` that is typically a constant NumericFormula. Complex formulas and multi‑resource/conditional costs are not yet supported.
- Non‑finite cost evaluations (e.g., NaN/Infinity) are treated as invalid and the automation does not enqueue.

---

## Unlock Conditions

Unlock conditions control when an automation becomes available.

**Schema:**
```json
{
  "unlockCondition": {
    "kind": "always" | "resourceThreshold" | "and" | "or" | "not"
  }
}
```

**Condition Types:**

### Always

Automation is always unlocked.

```json
{ "kind": "always" }
```

### Resource Threshold

Unlocks when a resource reaches a threshold.

```json
{
  "kind": "resourceThreshold",
  "resourceId": "sample-pack.energy",
  "comparator": "gte",
  "amount": { "kind": "constant", "value": 50 }
}
```

### Compound Conditions

Combine conditions with `and`, `or`, `not`:

```json
{
  "kind": "and",
  "conditions": [
    {
      "kind": "resourceThreshold",
      "resourceId": "sample-pack.energy",
      "comparator": "gte",
      "amount": { "kind": "constant", "value": 100 }
    },
    {
      "kind": "resourceThreshold",
      "resourceId": "sample-pack.crystal",
      "comparator": "gte",
      "amount": { "kind": "constant", "value": 10 }
    }
  ]
}
```

**Unlock Behavior:**

- Automations are **disabled** until unlocked
- Once unlocked, automations remain unlocked (persistent unlock state)
- Unlock state persists in save files

**Runtime Note:** Unlock conditions are evaluated when a condition context is provided (e.g., the standard runtime wiring). Without context, only `kind: "always"` is auto-unlocked.

---

## Visibility Conditions

Visibility conditions control when an automation is shown in UI. They do **not**
affect whether the automation can unlock or fire.

**Schema:**
```json
{
  "visibilityCondition": {
    "kind": "always" | "resourceThreshold" | "and" | "or" | "not"
  }
}
```

**Behavior:**

- If omitted, visibility follows unlock state (legacy default).
- When provided, visibility can be true even while locked (useful for teasers).
- Evaluated against the same condition context as unlock conditions.

**Example: Show only after 20 energy**

```json
{
  "visibilityCondition": {
    "kind": "resourceThreshold",
    "resourceId": "sample-pack.energy",
    "comparator": "gte",
    "amount": { "kind": "constant", "value": 20 }
  }
}
```

---

## Enabled State

Automations can be toggled on/off by players (or other automations).

**Schema:**
```json
{
  "enabledByDefault": true  // Initial state when unlocked
}
```

**Behavior:**

- `enabledByDefault: true`: Automation starts enabled when unlocked
- `enabledByDefault: false`: Automation starts disabled, player must enable
- Players toggle via `automation:toggled` command (UI-driven)
- Enabled state persists in save files

**Example: Disabled by default (opt-in)**

```json
{
  "id": "sample-pack.auto-prestige",
  "targetType": "system",
  "systemTargetId": "system:prestige",
  "trigger": { /* ... */ },
  "unlockCondition": { "kind": "always" },
  "enabledByDefault": false,  // Player must manually enable
  "order": 100
}
```

**When to Disable by Default:**

- Destructive actions (prestige, reset)
- High-cost automations
- Advanced/optional features
- Automations requiring player strategy

---

## Complete Examples

### Example 1: Basic Auto-Clicker

```json
{
  "id": "sample-pack.auto-reactor",
  "name": {
    "default": "Reactor Auto-Clicker",
    "variants": {}
  },
  "description": {
    "default": "Automatically enables the reactor every 3 seconds",
    "variants": {}
  },
  "targetType": "generator",
  "targetId": "sample-pack.reactor",
  "trigger": {
    "kind": "interval",
    "interval": { "kind": "constant", "value": 3000 }
  },
  "unlockCondition": { "kind": "always" },
  "enabledByDefault": true,
  "order": 1
}
```

### Example 2: Smart Upgrade Buyer

```json
{
  "id": "sample-pack.auto-upgrade-efficiency",
  "name": {
    "default": "Smart Efficiency Buyer",
    "variants": {}
  },
  "description": {
    "default": "Purchases Efficiency upgrade when you reach 50 energy (max once per 5 seconds)",
    "variants": {}
  },
  "targetType": "upgrade",
  "targetId": "sample-pack.upgrade-efficiency",
  "trigger": {
    "kind": "resourceThreshold",
    "resourceId": "sample-pack.energy",
    "comparator": "gte",
    "threshold": { "kind": "constant", "value": 50 }
  },
  "cooldown": 5000,
  "unlockCondition": {
    "kind": "resourceThreshold",
    "resourceId": "sample-pack.energy",
    "comparator": "gte",
    "amount": { "kind": "constant", "value": 25 }
  },
  "enabledByDefault": false,
  "order": 2
}
```

### Example 3: Idle Resource Collector

```json
{
  "id": "sample-pack.idle-collector",
  "name": {
    "default": "Idle Resource Collector",
    "variants": {}
  },
  "description": {
    "default": "Collects resources when you're not actively playing (triggers when queue is empty)",
    "variants": {}
  },
  "targetType": "generator",
  "targetId": "sample-pack.reactor",
  "trigger": {
    "kind": "commandQueueEmpty"
  },
  "cooldown": 10000,
  "unlockCondition": { "kind": "always" },
  "enabledByDefault": true,
  "order": 3
}
```

### Example 4: Event-Driven Prestige

```json
{
  "id": "sample-pack.auto-prestige-milestone",
  "name": {
    "default": "Milestone Prestige",
    "variants": {}
  },
  "description": {
    "default": "Automatically prestiges when you reach a major milestone (disabled by default for safety)",
    "variants": {}
  },
  "targetType": "system",
  "systemTargetId": "system:prestige",
  "trigger": {
    "kind": "event",
    "eventId": "sample-pack.major-milestone-reached"
  },
  "unlockCondition": {
    "kind": "resourceThreshold",
    "resourceId": "sample-pack.prestige-currency",
    "comparator": "gte",
    "amount": { "kind": "constant", "value": 1 }
  },
  "enabledByDefault": false,
  "order": 10
}
```

---

## Validation Workflow

### Step 1: Add automation to pack.json

Edit your `content/pack.json`:

```json
{
  "metadata": { /* ... */ },
  "resources": [ /* ... */ ],
  "generators": [ /* ... */ ],
  "upgrades": [ /* ... */ ],
  "automations": [
    {
      "id": "my-pack.my-automation",
      "name": { "default": "My Automation" },
      "description": { "default": "Does something cool" },
      "targetType": "generator",
      "targetId": "my-pack.my-generator",
      "trigger": {
        "kind": "interval",
        "interval": { "kind": "constant", "value": 5000 }
      },
      "unlockCondition": { "kind": "always" }
    }
  ]
}
```

### Step 2: Validate schema

Run the content compiler:

```bash
pnpm generate
```

**Expected output:**
```
✓ Validated content pack: @my-pack (0 warnings)
✓ Compiled content pack: @my-pack
```

**If errors:**
```
✗ Validation failed for @my-pack/content/pack.json
  - automations[0].trigger.interval: Required
  - automations[0].targetId: Resource 'my-pack.my-generator' not found
```

Fix errors and re-run `pnpm generate`.

### Step 3: Test in runtime

Create an integration test to verify the automation fires:

```typescript
import { describe, it, expect } from 'vitest';
import { createAutomationSystem } from '@idle-engine/core';
import contentPack from './content/compiled/@my-pack.normalized.json';

describe('My Automation', () => {
  it('fires after interval elapses', () => {
    const commandQueue = new MockCommandQueue();
    const system = createAutomationSystem({
      automations: contentPack.automations,
      stepDurationMs: 100,
      commandQueue,
      resourceState: mockResourceState,
    });

    // Setup
    system.setup({ events: mockEventBus });

    // Tick 1: Automation fires immediately (first tick)
    system.tick({ step: 1, events: mockEventBus });
    expect(commandQueue.size).toBe(1);
    expect(commandQueue.peek().type).toBe('TOGGLE_GENERATOR');

    // Tick 2-49: No fire (cooldown/interval)
    for (let step = 2; step <= 49; step++) {
      system.tick({ step, events: mockEventBus });
    }
    expect(commandQueue.size).toBe(1); // Still just the first command

    // Tick 50: Fires again (5000ms / 100ms = 50 steps)
    system.tick({ step: 51, events: mockEventBus });
    expect(commandQueue.size).toBe(2);
  });
});
```

### Step 4: Commit validated automation

```bash
git add packages/my-pack/content/pack.json
git add packages/my-pack/content/compiled/
git commit -m "feat(content): add auto-clicker automation"
```

---

## Best Practices

### 1. Start Simple

Begin with interval triggers before moving to complex threshold/event triggers.

**Good:**
```json
{
  "trigger": { "kind": "interval", "interval": { "kind": "constant", "value": 5000 } }
}
```

**Avoid (initially):**
```json
{
  "trigger": {
    "kind": "resourceThreshold",
    "resourceId": "pack.res1",
    "comparator": "gte",
    "threshold": { "kind": "linear", "base": 50, "rate": { "variable": "level" } }
  }
}
```

### 2. Always Use Cooldowns for Threshold/Queue-Empty Triggers

**Bad:**
```json
{
  "trigger": { "kind": "commandQueueEmpty" }
  // No cooldown - fires every tick when queue is empty!
}
```

**Good:**
```json
{
  "trigger": { "kind": "commandQueueEmpty" },
  "cooldown": 10000  // Fires max once per 10 seconds
}
```

### 3. Disable Destructive Automations by Default

**Bad:**
```json
{
  "targetType": "system",
  "systemTargetId": "system:prestige",
  "enabledByDefault": true  // Auto-prestige enabled by default = bad UX
}
```

**Good:**
```json
{
  "targetType": "system",
  "systemTargetId": "system:prestige",
  "enabledByDefault": false  // Player opts in
}
```

### 4. Use Unlock Conditions to Gate Advanced Automations

```json
{
  "id": "pack.advanced-auto",
  "unlockCondition": {
    "kind": "resourceThreshold",
    "resourceId": "pack.prestige-currency",
    "comparator": "gte",
    "amount": { "kind": "constant", "value": 10 }
  }
}
```

This prevents early-game players from being overwhelmed by automation options.

### 5. Test All Four Trigger Types

Create at least one automation for each trigger type in your content pack:

- ✓ Interval (auto-clicker)
- ✓ Resource threshold (auto-upgrader)
- ✓ Command queue empty (idle collector)
- ✓ Event (milestone responder)

This ensures your content exercises all runtime behaviors.

---

## Troubleshooting

### Automation Not Firing

**Check:**
1. Is automation unlocked? (`unlockCondition` met?)
2. Is automation enabled? (`enabledByDefault` or manually toggled?)
3. Is cooldown active? (Recently fired?)
4. For threshold triggers: Did resource actually **cross** threshold (transition)?
5. For event triggers: Is event being published?

**Debug:**
```typescript
const state = getAutomationState(automationSystem);
const autoState = state.get('my-pack.my-automation');
console.log('Enabled:', autoState?.enabled);
console.log('Unlocked:', autoState?.unlocked);
console.log('Last fired:', autoState?.lastFiredStep);
console.log('Cooldown expires:', autoState?.cooldownExpiresStep);
```

### Automation Fires Too Frequently

**Solution:** Add or increase cooldown:

```json
{
  "cooldown": 10000  // Minimum 10 seconds between fires
}
```

### Automation Fires on Every Tick (Queue Empty Trigger)

**Problem:** Queue empty triggers fire every tick when queue is empty.

**Solution:** Add cooldown:

```json
{
  "trigger": { "kind": "commandQueueEmpty" },
  "cooldown": 5000  // Required!
}
```

### Threshold Trigger Not Detecting Crossing

**Problem:** Resource fluctuates around threshold, but automation doesn't fire.

**Cause:** Crossing detection requires transition from `false → true`. If resource was already above threshold when automation was enabled, no crossing occurred.

**Solution:** Ensure resource starts below threshold, or use interval trigger instead for periodic checks.

---

## References

- **API Documentation**: `docs/automation-system-api.md`
- **Design Document**: `docs/automation-execution-system-design.md`
- **Content Schema**: `packages/content-schema/src/modules/automations.ts`
- **Sample Pack**: `packages/content-sample/content/pack.json`
- **Runtime Implementation**: `packages/core/src/automation-system.ts`
