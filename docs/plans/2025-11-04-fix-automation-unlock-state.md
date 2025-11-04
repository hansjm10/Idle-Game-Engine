# Fix Automation Unlock State Persistence Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the automation unlock state bug where the tick loop unconditionally resets `state.unlocked`, wiping out persisted state and preventing non-'always' automations from ever firing.

**Architecture:** The current implementation unconditionally sets `state.unlocked = automation.unlockCondition.kind === 'always'` on every tick. This overwrites any previously persisted unlock information (including values from `initialState`). The fix will respect existing state and only recalculate unlock status when the automation is not yet unlocked.

**Tech Stack:** TypeScript, Vitest

**Problem Details:**
- Location: `packages/core/src/automation-system.ts:133`
- Current code: `state.unlocked = automation.unlockCondition.kind === 'always';`
- This runs on EVERY tick for EVERY automation
- Wipes out persisted state for automations with non-'always' unlock conditions
- Makes it impossible for players to use automations that were previously unlocked

**Solution:**
- Only update `state.unlocked` when the automation is not yet unlocked
- For 'always' unlock conditions, set to `true` once
- For other unlock conditions, preserve existing state (full evaluation deferred to integration)

---

### Task 1: Write failing test for unlock state persistence

**Files:**
- Modify: `packages/core/src/automation-system.test.ts`

**Step 1: Write the failing test**

Add this test after the existing "should restore state from initialState" test (around line 108):

```typescript
it('should preserve unlocked state across ticks for non-always unlock conditions', () => {
  const automations: AutomationDefinition[] = [
    {
      id: 'auto:advanced' as any,
      name: { default: 'Advanced Auto', variants: {} },
      description: { default: 'Unlocked by resource threshold', variants: {} },
      targetType: 'generator',
      targetId: 'gen:clicks' as any,
      trigger: { kind: 'interval', interval: { kind: 'constant', value: 1000 } },
      unlockCondition: {
        kind: 'resourceThreshold',
        resourceId: 'res:gold' as any,
        comparator: 'gte',
        amount: { kind: 'constant', value: 100 },
      },
      enabledByDefault: true,
      order: 0,
    },
  ];

  const initialState = new Map([
    ['auto:advanced', {
      id: 'auto:advanced',
      enabled: true,
      lastFiredStep: 0,
      cooldownExpiresStep: 0,
      unlocked: true, // Player has already unlocked this
    }],
  ]);

  const commandQueue = new CommandQueue();
  const system = createAutomationSystem({
    automations,
    stepDurationMs: 100,
    commandQueue,
    resourceState: { getAmount: () => 50 }, // Below threshold
    initialState,
  });

  // Simulate runtime setup and first tick
  system.setup({
    events: {
      on: () => {},
      off: () => {},
      emit: () => {},
    } as any,
  });
  system.tick({ step: 0 });

  // Check that unlocked state is preserved despite resource being below threshold
  const state = getAutomationState(system);
  const autoState = state.get('auto:advanced');
  expect(autoState?.unlocked).toBe(true);
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @idle-engine/core test automation-system.test.ts -t "should preserve unlocked state"`

Expected: FAIL with assertion error - `unlocked` is `false` but should be `true`

**Step 3: Commit the failing test**

```bash
git add packages/core/src/automation-system.test.ts
git commit -m "test(core): add failing test for automation unlock state persistence

Test verifies that unlocked state is preserved across ticks even when
unlock conditions are no longer met. This reproduces the bug where the
tick loop unconditionally resets state.unlocked to false for non-always
unlock conditions.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Fix unlock state logic to respect existing state

**Files:**
- Modify: `packages/core/src/automation-system.ts:130-133`

**Step 1: Update unlock evaluation logic**

Replace lines 130-133:

```typescript
// Update unlock status
// For MVP, we'll assume all automations with 'always' condition are unlocked
// Full unlock evaluation requires condition context (deferred to integration)
state.unlocked = automation.unlockCondition.kind === 'always';
```

With:

```typescript
// Update unlock status (only if not already unlocked)
// Once unlocked, automations stay unlocked (unlock state is persistent)
// For MVP, only 'always' condition is evaluated; full unlock evaluation
// requires condition context (deferred to integration)
if (!state.unlocked && automation.unlockCondition.kind === 'always') {
  state.unlocked = true;
}
```

**Step 2: Run the new test to verify it passes**

Run: `pnpm --filter @idle-engine/core test automation-system.test.ts -t "should preserve unlocked state"`

Expected: PASS

**Step 3: Run all automation tests to verify no regressions**

Run: `pnpm --filter @idle-engine/core test automation-system.test.ts`

Expected: All tests PASS

**Step 4: Commit the fix**

```bash
git add packages/core/src/automation-system.ts
git commit -m "fix(core): preserve automation unlock state across ticks

The tick loop was unconditionally resetting state.unlocked based on
unlockCondition.kind === 'always', which wiped out persisted unlock
information for automations with other unlock conditions.

This prevented automations from firing even after players unlocked them,
as the state would be reset to false on every tick.

Now the system only updates unlock status when not already unlocked,
respecting persisted state from initialState and previous unlock checks.

Fixes issue reported in PR #329 code review.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Add test for 'always' unlock condition evaluation

**Files:**
- Modify: `packages/core/src/automation-system.test.ts`

**Step 1: Write test for 'always' unlock**

Add this test after the previous test:

```typescript
it('should unlock automations with always unlock condition on first tick', () => {
  const automations: AutomationDefinition[] = [
    {
      id: 'auto:basic' as any,
      name: { default: 'Basic Auto', variants: {} },
      description: { default: 'Always available', variants: {} },
      targetType: 'generator',
      targetId: 'gen:clicks' as any,
      trigger: { kind: 'interval', interval: { kind: 'constant', value: 1000 } },
      unlockCondition: { kind: 'always' },
      enabledByDefault: true,
      order: 0,
    },
  ];

  const commandQueue = new CommandQueue();
  const system = createAutomationSystem({
    automations,
    stepDurationMs: 100,
    commandQueue,
    resourceState: { getAmount: () => 0 },
  });

  // Initial state should have unlocked=false
  const initialState = getAutomationState(system);
  expect(initialState.get('auto:basic')?.unlocked).toBe(false);

  // After setup and first tick, should be unlocked
  system.setup({
    events: {
      on: () => {},
      off: () => {},
      emit: () => {},
    } as any,
  });
  system.tick({ step: 0 });

  const stateAfterTick = getAutomationState(system);
  expect(stateAfterTick.get('auto:basic')?.unlocked).toBe(true);

  // Should remain unlocked on subsequent ticks
  system.tick({ step: 1 });
  const stateAfterSecondTick = getAutomationState(system);
  expect(stateAfterSecondTick.get('auto:basic')?.unlocked).toBe(true);
});
```

**Step 2: Run test to verify it passes**

Run: `pnpm --filter @idle-engine/core test automation-system.test.ts -t "should unlock automations with always"`

Expected: PASS (implementation already supports this)

**Step 3: Run full test suite**

Run: `pnpm --filter @idle-engine/core test automation-system.test.ts`

Expected: All tests PASS

**Step 4: Commit the test**

```bash
git add packages/core/src/automation-system.test.ts
git commit -m "test(core): add test for 'always' unlock condition evaluation

Verifies that automations with 'always' unlock conditions are unlocked
on the first tick and remain unlocked on subsequent ticks.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Verify full test suite and typecheck

**Files:**
- None (verification only)

**Step 1: Run full core test suite**

Run: `pnpm --filter @idle-engine/core test:ci`

Expected: All tests PASS

**Step 2: Run typecheck**

Run: `pnpm --filter @idle-engine/core typecheck`

Expected: No errors

**Step 3: Run lint**

Run: `pnpm --filter @idle-engine/core lint`

Expected: No errors

**Step 4: Verify all pre-commit hooks pass**

Run: `git add -A && git commit --amend --no-edit`

Expected: All hooks pass (test-core, typecheck, lint, build)

---

### Task 5: Update JSDoc comment for clarity

**Files:**
- Modify: `packages/core/src/automation-system.ts:78-77` (createAutomationSystem JSDoc)

**Step 1: Update the JSDoc to document unlock behavior**

Add a note about unlock state persistence to the JSDoc comment for `createAutomationSystem`. Update line 60-77:

```typescript
/**
 * Creates an AutomationSystem that evaluates triggers and enqueues commands.
 *
 * The system initializes automation states from the provided definitions,
 * subscribes to relevant events during setup(), and evaluates triggers
 * during each tick() call to enqueue commands at AUTOMATION priority.
 *
 * Unlock state is persistent: once an automation is unlocked (either via
 * initialState or unlock condition evaluation), it remains unlocked. The
 * system only evaluates unlock conditions for automations that are not yet
 * unlocked. Currently, only 'always' unlock conditions are evaluated; full
 * condition evaluation requires integration with progression systems.
 *
 * @param options - Configuration options including automations, step duration,
 *                  command queue, resource state, and optional initial state.
 * @returns A System object with an additional getState() method for state extraction.
 *
 * @example
 * ```typescript
 * const system = createAutomationSystem({
 *   automations: contentPack.automations,
 *   stepDurationMs: 100,
 *   commandQueue: runtime.getCommandQueue(),
 *   resourceState: progressionCoordinator.resourceState,
 * });
 * ```
 */
```

**Step 2: Update the initialization comment at line 93**

Update the comment at line 93 from:

```typescript
unlocked: false, // Will be evaluated on first tick
```

To:

```typescript
unlocked: false, // Evaluated on first tick for 'always' condition; persists once unlocked
```

**Step 3: Run typecheck to verify documentation**

Run: `pnpm --filter @idle-engine/core typecheck`

Expected: No errors

**Step 4: Commit the documentation updates**

```bash
git add packages/core/src/automation-system.ts
git commit -m "docs(core): clarify automation unlock state persistence behavior

Update JSDoc comments to document that unlock state is persistent and
only evaluated when not already unlocked. This clarifies the fix for
the unlock state bug.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Verification Checklist

After completing all tasks, verify:

- [ ] New test for unlock state persistence passes
- [ ] New test for 'always' unlock condition passes
- [ ] All existing automation tests still pass
- [ ] Full test suite passes (`pnpm --filter @idle-engine/core test:ci`)
- [ ] Typecheck passes (`pnpm --filter @idle-engine/core typecheck`)
- [ ] Lint passes (`pnpm --filter @idle-engine/core lint`)
- [ ] Pre-commit hooks pass
- [ ] JSDoc comments accurately describe unlock behavior

## Notes

**Why this fix works:**
- Respects persisted state from `initialState` (fixes the reported bug)
- Prevents resetting unlock state on every tick
- Maintains MVP behavior for 'always' unlock conditions
- Doesn't block future full unlock condition evaluation
- Follows principle: "Once unlocked, always unlocked" (consistent with typical game design)

**Future work (out of scope):**
- Full unlock condition evaluation for non-'always' conditions
- Integration with progression systems to evaluate complex unlock conditions
- Potential unlock system that can re-lock automations (if game design requires it)
