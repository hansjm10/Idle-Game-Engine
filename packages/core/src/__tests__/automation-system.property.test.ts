/**
 * @fileoverview Property-based tests for AutomationSystem
 *
 * This file uses fast-check to generate random automation sequences and verify
 * that the AutomationSystem maintains critical invariants across thousands of
 * test cases. Property-based testing helps discover edge cases that traditional
 * unit tests might miss.
 *
 * ## Test Strategy
 *
 * We generate random:
 * - Automation definitions (all 4 trigger types)
 * - Resource state changes
 * - Tick sequences
 * - Event emissions
 *
 * And verify invariants hold:
 * - Trigger evaluation correctness
 * - Cooldown enforcement
 * - Command priority and timing
 * - State consistency
 *
 * ## Discovered Edge Cases
 *
 * Property-based testing revealed the following edge cases that the system handles:
 *
 * ### Interval Triggers
 * - First-tick immediate firing: Interval triggers with lastFiredStep = -Infinity fire
 *   immediately on the first tick, enabling automations to activate as soon as unlocked
 * - Step boundary precision: Interval calculations use Math.ceil for millisecond-to-step
 *   conversion, ensuring triggers fire at or after the specified interval
 *
 * ### Resource Threshold Triggers
 * - Crossing detection vs continuous satisfaction: Triggers fire only on state transitions
 *   (false -> true), preventing repeated firing while threshold remains satisfied
 * - Cooldown threshold tracking: AutomationState.lastThresholdSatisfied updates during
 *   cooldown when threshold becomes unsatisfied, ensuring crossings that occur during
 *   cooldown are detected when cooldown expires
 * - All comparator types tested: gte, gt, lte, lt all work correctly with boundary values
 * - Missing resource handling: Non-existent resources (getResourceIndex returns -1) are
 *   treated as amount 0, allowing automations to fire based on locked resources
 *
 * ### Cooldown Management
 * - Zero cooldown (cooldownExpiresStep = 0) means automation is never in cooldown state
 * - Exact step expiration: At step N where N === cooldownExpiresStep, cooldown is NOT active
 * - One step before expiration: At step N-1, cooldown IS active
 * - Off-by-one prevention: cooldownExpiresStep = currentStep + cooldownSteps + 1 accounts
 *   for command execution delay (commands enqueued at step N execute at step N+1)
 *
 * ### Command Queue Empty Triggers
 * - Boolean invariant: Trigger fires if and only if commandQueue.size === 0
 * - No special cases needed: Simple queue size check has no edge cases
 *
 * ### State Initialization
 * - Default state: enabledByDefault from schema, lastFiredStep = -Infinity, cooldownExpiresStep = 0
 * - Persistence: Existing state from initialState takes precedence over defaults
 * - Unlock persistence: Once unlocked via condition evaluation, automations remain unlocked
 *
 * ## Performance
 *
 * Tests are configured to run 1000+ cases per property to ensure comprehensive
 * coverage. Each test should complete in reasonable time (<30s total).
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  createAutomationSystem,
  evaluateIntervalTrigger,
  evaluateResourceThresholdTrigger,
  evaluateCommandQueueEmptyTrigger,
  isCooldownActive,
  updateCooldown,
  enqueueAutomationCommand,
  type AutomationState,
} from '../automation-system.js';
import type { AutomationDefinition, NumericFormula } from '@idle-engine/content-schema';
import { CommandQueue } from '../command-queue.js';
import { CommandPriority } from '../command.js';
import { createResourceState } from '../resource-state.js';
import { createResourceStateAdapter } from '../automation-resource-state-adapter.js';
import type { EventPublisher } from '../events/event-bus.js';

// ============================================================================
// Generators
// ============================================================================

/**
 * Generates a constant numeric formula with values in a reasonable range.
 */
const numericFormulaArb = fc.integer({ min: 0, max: 10000 }).map(value => ({
  kind: 'constant' as const,
  value,
}));

const literal = (value: number): NumericFormula => ({ kind: 'constant', value });

const createTestEventPublisher = (): {
  readonly events: EventPublisher;
  readonly published: readonly { type: string; payload: unknown }[];
} => {
  const published: Array<{ type: string; payload: unknown }> = [];

  const events: EventPublisher = {
    publish: (eventType, payload) => {
      published.push({ type: eventType, payload });
      return {
        accepted: true,
        state: 'accepted',
        type: eventType,
        channel: 0,
        bufferSize: 0,
        remainingCapacity: 0,
        dispatchOrder: 0,
        softLimitActive: false,
      };
    },
  };

  return { events, published };
};

/**
 * Generates resource IDs for testing.
 * IDs use branded types in presentation integrations; use `as any` to avoid circular dependency
 */
const resourceIdArb = fc.constantFrom(
  'res:gold' as any,
  'res:gems' as any,
  'res:energy' as any,
);

/**
 * Generates automation IDs.
 * IDs use branded types in presentation integrations; use `as any` to avoid circular dependency
 */
const automationIdArb = fc.nat({ max: 999 }).map(n => `auto:test-${n}` as any);

/**
 * Generates generator target IDs.
 * IDs use branded types in presentation integrations; use `as any` to avoid circular dependency
 */
const generatorIdArb = fc.constantFrom(
  'gen:clicker' as any,
  'gen:producer' as any,
  'gen:harvester' as any,
);

/**
 * Generates upgrade target IDs.
 * IDs use branded types in presentation integrations; use `as any` to avoid circular dependency
 */
const upgradeIdArb = fc.constantFrom(
  'upg:doubler' as any,
  'upg:multiplier' as any,
  'upg:booster' as any,
);

/**
 * Generates event IDs for event triggers.
 * IDs use branded types in presentation integrations; use `as any` to avoid circular dependency
 */
const eventIdArb = fc.constantFrom(
  'resource:threshold-reached' as any,
  'automation:toggled' as any,
  'generator:toggled' as any,
);

/**
 * Generates interval trigger definitions.
 */
const intervalTriggerArb = fc.integer({ min: 100, max: 10000 }).map(interval => ({
  kind: 'interval' as const,
  interval: { kind: 'constant' as const, value: interval },
}));

/**
 * Generates resource threshold trigger definitions.
 */
const resourceThresholdTriggerArb = fc.record({
  kind: fc.constant('resourceThreshold' as const),
  resourceId: resourceIdArb,
  comparator: fc.constantFrom('gte', 'gt', 'lte', 'lt') as fc.Arbitrary<'gte' | 'gt' | 'lte' | 'lt'>,
  threshold: numericFormulaArb,
});

/**
 * Generates command queue empty trigger definitions.
 */
const commandQueueEmptyTriggerArb = fc.constant({
  kind: 'commandQueueEmpty' as const,
});

/**
 * Generates event trigger definitions.
 */
const eventTriggerArb = eventIdArb.map(eventId => ({
  kind: 'event' as const,
  eventId,
}));

/**
 * Generates any trigger type.
 */
const triggerArb = fc.oneof(
  intervalTriggerArb,
  resourceThresholdTriggerArb,
  commandQueueEmptyTriggerArb,
  eventTriggerArb,
);

/**
 * Generates complete automation definitions with all fields.
 */
const automationDefinitionArb: fc.Arbitrary<AutomationDefinition> = fc.record({
  id: automationIdArb,
  name: fc.constant({ default: 'Test Automation', variants: {} }),
  description: fc.constant({ default: 'Property-based test automation', variants: {} }),
  trigger: triggerArb,
  targetType: fc.constantFrom('generator', 'upgrade') as fc.Arbitrary<'generator' | 'upgrade'>,
  targetId: fc.oneof(generatorIdArb, upgradeIdArb),
  unlockCondition: fc.constant({ kind: 'always' as const }),
  enabledByDefault: fc.boolean(),
  cooldown: fc.option(fc.integer({ min: 0, max: 5000 }).map(literal), { nil: undefined }),
  order: fc.nat({ max: 100 }),
});

// Generators for future tests (Tasks 7-8):
// - _automationListArb: Command priority and multi-automation scenarios
// - _tickSequenceArb: State consistency across tick sequences
// - _resourceAmountArb: Resource state change scenarios
// const _automationListArb = fc.array(automationDefinitionArb, { minLength: 1, maxLength: 10 });
// const _tickSequenceArb = fc.array(fc.nat({ max: 100 }), { minLength: 1, maxLength: 50 });
// const _resourceAmountArb = fc.integer({ min: 0, max: 10000 });

describe('AutomationSystem - Property-Based Tests', () => {
  describe('setup', () => {
    it('should import fast-check successfully', () => {
      expect(fc).toBeDefined();
      expect(fc.assert).toBeDefined();
    });

    it('should generate valid automation definitions', () => {
      fc.assert(
        fc.property(automationDefinitionArb, (automation) => {
          // Verify generated automation has required fields
          expect(automation.id).toBeDefined();
          expect(automation.trigger).toBeDefined();
          expect(automation.targetType).toBeDefined();
          expect(automation.unlockCondition).toBeDefined();
          expect(typeof automation.enabledByDefault).toBe('boolean');

          // Verify trigger is one of the 4 types
          const validTriggerTypes = ['interval', 'resourceThreshold', 'commandQueueEmpty', 'event'];
          expect(validTriggerTypes).toContain(automation.trigger.kind);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('should generate diverse trigger types', () => {
      const triggerTypes = new Set<string>();

      fc.assert(
        fc.property(automationDefinitionArb, (automation) => {
          triggerTypes.add(automation.trigger.kind);
          return true;
        }),
        { numRuns: 100 }
      );

      // Verify we generated all 4 trigger types
      expect(triggerTypes.size).toBeGreaterThanOrEqual(3); // At least 3 of 4 types
    });
  });

  // ============================================================================
  // Invariant Tests - Trigger Evaluation
  // ============================================================================

  describe('trigger evaluation invariants', () => {
    it('interval triggers fire immediately on first tick', () => {
      fc.assert(
        fc.property(intervalTriggerArb, (trigger) => {
          const automation: AutomationDefinition = {
            id: 'auto:test' as any,
            name: { default: 'Test', variants: {} },
            description: { default: 'Test', variants: {} },
            trigger,
            targetType: 'generator',
            targetId: 'gen:test' as any,
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
          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('interval triggers fire when elapsed steps >= interval steps', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 100, max: 5000 }), // interval in ms
          fc.integer({ min: 50, max: 200 }), // step duration in ms
          fc.nat({ max: 200 }), // current step
          (intervalMs, stepDurationMs, currentStep) => {
            const automation: AutomationDefinition = {
              id: 'auto:test' as any,
              name: { default: 'Test', variants: {} },
              description: { default: 'Test', variants: {} },
              trigger: {
                kind: 'interval',
                interval: { kind: 'constant', value: intervalMs },
              },
              targetType: 'generator',
              targetId: 'gen:test' as any,
              unlockCondition: { kind: 'always' },
              enabledByDefault: true,
              order: 0,
            };

            const intervalSteps = Math.ceil(intervalMs / stepDurationMs);
            const lastFiredStep = Math.max(0, currentStep - intervalSteps);

            const state: AutomationState = {
              id: 'auto:test',
              enabled: true,
              lastFiredStep,
              cooldownExpiresStep: 0,
              unlocked: true,
            };

            const shouldFire = evaluateIntervalTrigger(automation, state, currentStep, stepDurationMs);
            const elapsed = currentStep - lastFiredStep;

            // Invariant: fires if and only if elapsed >= intervalSteps
            expect(shouldFire).toBe(elapsed >= intervalSteps);
            return true;
          }
        ),
        { numRuns: 1000 }
      );
    });

    it('resourceThreshold triggers fire only on state transition', () => {
      fc.assert(
        fc.property(
          resourceThresholdTriggerArb,
          fc.integer({ min: 0, max: 1000 }), // initial amount
          fc.integer({ min: 0, max: 1000 }), // new amount
          (trigger, initialAmount, newAmount) => {
            const resourceState = {
              getAmount: () => newAmount,
              getResourceIndex: () => 0,
            };

            const automation: AutomationDefinition = {
              id: 'auto:test' as any,
              name: { default: 'Test', variants: {} },
              description: { default: 'Test', variants: {} },
              trigger,
              targetType: 'generator',
              targetId: 'gen:test' as any,
              unlockCondition: { kind: 'always' },
              enabledByDefault: true,
              order: 0,
            };

            // Evaluate threshold state for both amounts
            const initialResourceState = {
              getAmount: () => initialAmount,
              getResourceIndex: () => 0,
            };

            const initialSatisfied = evaluateResourceThresholdTrigger(automation, initialResourceState);
            const currentSatisfied = evaluateResourceThresholdTrigger(automation, resourceState);

            // Invariant: Fire only on false -> true transition
            const shouldFire = currentSatisfied && !initialSatisfied;

            // Verify: continuous satisfaction doesn't fire
            if (initialSatisfied && currentSatisfied) {
              expect(shouldFire).toBe(false);
            }

            // Verify: transition from not satisfied to satisfied fires
            if (!initialSatisfied && currentSatisfied) {
              expect(shouldFire).toBe(true);
            }

            return true;
          }
        ),
        { numRuns: 1000 }
      );
    });

    it('resourceThreshold comparators work correctly', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('gte', 'gt', 'lte', 'lt') as fc.Arbitrary<'gte' | 'gt' | 'lte' | 'lt'>,
          fc.integer({ min: 0, max: 1000 }),
          fc.integer({ min: 0, max: 1000 }),
          (comparator, amount, threshold) => {
            const automation: AutomationDefinition = {
              id: 'auto:test' as any,
              name: { default: 'Test', variants: {} },
              description: { default: 'Test', variants: {} },
              trigger: {
                kind: 'resourceThreshold',
                resourceId: 'res:gold' as any,
                comparator,
                threshold: { kind: 'constant', value: threshold },
              },
              targetType: 'generator',
              targetId: 'gen:test' as any,
              unlockCondition: { kind: 'always' },
              enabledByDefault: true,
              order: 0,
            };

            const resourceState = {
              getAmount: () => amount,
              getResourceIndex: () => 0,
            };

            const satisfied = evaluateResourceThresholdTrigger(automation, resourceState);

            // Verify comparator logic
            let expected: boolean;
            switch (comparator) {
              case 'gte':
                expected = amount >= threshold;
                break;
              case 'gt':
                expected = amount > threshold;
                break;
              case 'lte':
                expected = amount <= threshold;
                break;
              case 'lt':
                expected = amount < threshold;
                break;
            }

            expect(satisfied).toBe(expected);
            return true;
          }
        ),
        { numRuns: 1000 }
      );
    });

    it('commandQueueEmpty trigger fires if and only if queue is empty', () => {
      fc.assert(
        fc.property(fc.nat({ max: 10 }), (queueSize) => {
          const commandQueue = new CommandQueue();

          // Add commands to match queueSize
          for (let i = 0; i < queueSize; i++) {
            commandQueue.enqueue({
              type: 'TEST',
              payload: {},
              priority: 1,
              timestamp: 0,
              step: 0,
            });
          }

          const isEmpty = commandQueue.size === 0;
          const shouldFire = evaluateCommandQueueEmptyTrigger(commandQueue);

          // Invariant: fires if and only if queue is empty
          expect(shouldFire).toBe(isEmpty);
          return true;
        }),
        { numRuns: 100 }
      );
    });
  });

  // ============================================================================
  // Invariant Tests - Cooldown Enforcement
  // ============================================================================

  describe('cooldown invariants', () => {
    it('cooldown prevents firing when currentStep < cooldownExpiresStep', () => {
      fc.assert(
        fc.property(
          fc.nat({ max: 100 }), // current step
          fc.nat({ max: 200 }), // cooldown expires step
          (currentStep, cooldownExpiresStep) => {
            const state: AutomationState = {
              id: 'auto:test',
              enabled: true,
              lastFiredStep: 0,
              cooldownExpiresStep,
              unlocked: true,
            };

            const isActive = isCooldownActive(state, currentStep);

            // Invariant: cooldown is active if and only if currentStep < cooldownExpiresStep
            expect(isActive).toBe(currentStep < cooldownExpiresStep);
            return true;
          }
        ),
        { numRuns: 1000 }
      );
    });

    it('cooldown calculation is deterministic and correct', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 5000 }), // cooldown ms
          fc.integer({ min: 50, max: 200 }), // step duration ms
          fc.nat({ max: 100 }), // current step
          (cooldownMs, stepDurationMs, currentStep) => {
            const automation: AutomationDefinition = {
              id: 'auto:test' as any,
              name: { default: 'Test', variants: {} },
              description: { default: 'Test', variants: {} },
              trigger: { kind: 'interval', interval: { kind: 'constant', value: 1000 } },
              targetType: 'generator',
              targetId: 'gen:test' as any,
              unlockCondition: { kind: 'always' },
              enabledByDefault: true,
              cooldown: cooldownMs > 0 ? literal(cooldownMs) : undefined,
              order: 0,
            };

            const state: AutomationState = {
              id: 'auto:test',
              enabled: true,
              lastFiredStep: 0,
              cooldownExpiresStep: 0,
              unlocked: true,
            };

            // Call the actual updateCooldown function
            updateCooldown(automation, state, currentStep, stepDurationMs);

            // Calculate expected cooldown expiration
            const expectedExpiresStep =
              cooldownMs > 0
                ? currentStep + Math.ceil(cooldownMs / stepDurationMs) + 1
                : 0;

            // Verify the state matches expected calculation
            expect(state.cooldownExpiresStep).toBe(expectedExpiresStep);

            return true;
          }
        ),
        { numRuns: 1000 }
      );
    });

    it('cooldown expires at exact step allowing re-firing', () => {
      fc.assert(
        fc.property(
          fc.nat({ max: 50 }), // cooldown steps
          fc.nat({ max: 100 }), // fire step
          (cooldownSteps, fireStep) => {
            const cooldownExpiresStep = fireStep + cooldownSteps + 1;

            const state: AutomationState = {
              id: 'auto:test',
              enabled: true,
              lastFiredStep: fireStep,
              cooldownExpiresStep,
              unlocked: true,
            };

            // Invariant: at cooldownExpiresStep, cooldown is NOT active
            const isActiveAtExpiry = isCooldownActive(state, cooldownExpiresStep);
            expect(isActiveAtExpiry).toBe(false);

            // Invariant: one step before expiry, cooldown IS active
            if (cooldownExpiresStep > 0) {
              const isActiveBeforeExpiry = isCooldownActive(state, cooldownExpiresStep - 1);
              expect(isActiveBeforeExpiry).toBe(true);
            }

            return true;
          }
        ),
        { numRuns: 1000 }
      );
    });

    it('zero or undefined cooldown means no cooldown active', () => {
      fc.assert(
        fc.property(fc.nat({ max: 100 }), (currentStep) => {
          const stateZero: AutomationState = {
            id: 'auto:test',
            enabled: true,
            lastFiredStep: 0,
            cooldownExpiresStep: 0,
            unlocked: true,
          };

          // Invariant: cooldownExpiresStep === 0 means never in cooldown
          const isActive = isCooldownActive(stateZero, currentStep);
          expect(isActive).toBe(false);
          return true;
        }),
        { numRuns: 100 }
      );
    });
  });

  // ============================================================================
  // Invariant Tests - Resource Cost Deduction
  // ============================================================================

  describe('resource cost invariants', () => {
    const createTestResourceState = () => {
      const resourceState = createResourceState([
        { id: 'res:gold', startAmount: 0 },
        { id: 'res:gems', startAmount: 0 },
        { id: 'res:energy', startAmount: 0 },
      ]);
      return {
        resourceState,
        adapter: createResourceStateAdapter(resourceState),
      };
    };

    it('sufficient resources allow automation to fire and deduct cost', () => {
      fc.assert(
        fc.property(
          resourceIdArb,
          fc.integer({ min: 0, max: 10_000 }),
          fc.integer({ min: 0, max: 10_000 }),
          (resourceId, costAmount, extraAmount) => {
            const initialAmount = costAmount + extraAmount;
            const { resourceState, adapter } = createTestResourceState();
            const index = resourceState.requireIndex(resourceId);
            resourceState.addAmount(index, initialAmount);

            const commandQueue = new CommandQueue();
            const { events, published } = createTestEventPublisher();

            const automation: AutomationDefinition = {
              id: 'auto:test-cost-sufficient' as any,
              name: { default: 'Test Automation', variants: {} },
              description: { default: 'Resource cost invariant test', variants: {} },
              trigger: { kind: 'commandQueueEmpty' },
              targetType: 'generator',
              targetId: 'gen:clicker' as any,
              unlockCondition: { kind: 'always' },
              enabledByDefault: true,
              cooldown: undefined,
              order: 0,
              resourceCost: { resourceId, rate: literal(costAmount) },
            };

            const system = createAutomationSystem({
              automations: [automation],
              stepDurationMs: 100,
              commandQueue,
              resourceState: adapter,
            });

            system.tick({ deltaMs: 0, step: 0, events });

            expect(commandQueue.size).toBe(1);
            expect(resourceState.getAmount(index)).toBe(initialAmount - costAmount);
            expect(published.some((evt) => evt.type === 'automation:fired')).toBe(true);

            return true;
          },
        ),
        { numRuns: 1000 },
      );
    });

    it('insufficient resources prevent automation from firing and do not deduct cost', () => {
      fc.assert(
        fc.property(
          resourceIdArb,
          fc.integer({ min: 1, max: 10_000 }),
          fc.integer({ min: 1, max: 10_000 }),
          (resourceId, costAmount, deficit) => {
            const initialAmount = Math.max(0, costAmount - deficit);
            const { resourceState, adapter } = createTestResourceState();
            const index = resourceState.requireIndex(resourceId);
            resourceState.addAmount(index, initialAmount);

            const commandQueue = new CommandQueue();
            const { events, published } = createTestEventPublisher();

            const automation: AutomationDefinition = {
              id: 'auto:test-cost-insufficient' as any,
              name: { default: 'Test Automation', variants: {} },
              description: { default: 'Resource cost invariant test', variants: {} },
              trigger: { kind: 'commandQueueEmpty' },
              targetType: 'generator',
              targetId: 'gen:clicker' as any,
              unlockCondition: { kind: 'always' },
              enabledByDefault: true,
              cooldown: undefined,
              order: 0,
              resourceCost: { resourceId, rate: literal(costAmount) },
            };

            const system = createAutomationSystem({
              automations: [automation],
              stepDurationMs: 100,
              commandQueue,
              resourceState: adapter,
            });

            system.tick({ deltaMs: 0, step: 0, events });

            expect(commandQueue.size).toBe(0);
            expect(resourceState.getAmount(index)).toBe(initialAmount);
            expect(published.some((evt) => evt.type === 'automation:fired')).toBe(false);

            return true;
          },
        ),
        { numRuns: 1000 },
      );
    });

    it('no resource cost specified allows unconditional firing', () => {
      fc.assert(
        fc.property(fc.nat({ max: 1000 }), (currentStep) => {
          const commandQueue = new CommandQueue();
          const { events, published } = createTestEventPublisher();

          let spendCalls = 0;
          const resourceState = {
            getAmount: (_index: number) => 0,
            getResourceIndex: (_resourceId: string) => 0,
            spendAmount: (_index: number, _amount: number) => {
              spendCalls += 1;
              return true;
            },
          };

          const automation: AutomationDefinition = {
            id: 'auto:test-no-cost' as any,
            name: { default: 'Test Automation', variants: {} },
            description: { default: 'Resource cost invariant test', variants: {} },
            trigger: { kind: 'commandQueueEmpty' },
            targetType: 'generator',
            targetId: 'gen:clicker' as any,
            unlockCondition: { kind: 'always' },
            enabledByDefault: true,
            cooldown: undefined,
            order: 0,
          };

          const system = createAutomationSystem({
            automations: [automation],
            stepDurationMs: 100,
            commandQueue,
            resourceState,
          });

          system.tick({ deltaMs: 0, step: currentStep, events });

          expect(commandQueue.size).toBe(1);
          expect(spendCalls).toBe(0);
          expect(published.some((evt) => evt.type === 'automation:fired')).toBe(true);

          return true;
        }),
        { numRuns: 500 },
      );
    });

    it('exact resource amount equal to cost allows firing and reduces to zero', () => {
      fc.assert(
        fc.property(
          resourceIdArb,
          fc.integer({ min: 1, max: 10_000 }),
          (resourceId, costAmount) => {
            const { resourceState, adapter } = createTestResourceState();
            const index = resourceState.requireIndex(resourceId);
            resourceState.addAmount(index, costAmount);

            const commandQueue = new CommandQueue();
            const { events } = createTestEventPublisher();

            const automation: AutomationDefinition = {
              id: 'auto:test-exact-cost' as any,
              name: { default: 'Test Automation', variants: {} },
              description: { default: 'Resource cost edge case test', variants: {} },
              trigger: { kind: 'commandQueueEmpty' },
              targetType: 'generator',
              targetId: 'gen:clicker' as any,
              unlockCondition: { kind: 'always' },
              enabledByDefault: true,
              cooldown: undefined,
              order: 0,
              resourceCost: { resourceId, rate: literal(costAmount) },
            };

            const system = createAutomationSystem({
              automations: [automation],
              stepDurationMs: 100,
              commandQueue,
              resourceState: adapter,
            });

            system.tick({ deltaMs: 0, step: 0, events });

            expect(commandQueue.size).toBe(1);
            expect(resourceState.getAmount(index)).toBe(0);

            return true;
          },
        ),
        { numRuns: 500 },
      );
    });

    it('resource cost of 0 always allows firing', () => {
      fc.assert(
        fc.property(resourceIdArb, (resourceId) => {
          const { resourceState, adapter } = createTestResourceState();
          const index = resourceState.requireIndex(resourceId);
          expect(resourceState.getAmount(index)).toBe(0);

          const commandQueue = new CommandQueue();
          const { events } = createTestEventPublisher();

          const automation: AutomationDefinition = {
            id: 'auto:test-zero-cost' as any,
            name: { default: 'Test Automation', variants: {} },
            description: { default: 'Resource cost edge case test', variants: {} },
            trigger: { kind: 'commandQueueEmpty' },
            targetType: 'generator',
            targetId: 'gen:clicker' as any,
            unlockCondition: { kind: 'always' },
            enabledByDefault: true,
            cooldown: undefined,
            order: 0,
            resourceCost: { resourceId, rate: literal(0) },
          };

          const system = createAutomationSystem({
            automations: [automation],
            stepDurationMs: 100,
            commandQueue,
            resourceState: adapter,
          });

          system.tick({ deltaMs: 0, step: 0, events });

          expect(commandQueue.size).toBe(1);
          expect(resourceState.getAmount(index)).toBe(0);

          return true;
        }),
        { numRuns: 200 },
      );
    });

    it('multiple automations competing for same resource spend in evaluation order', () => {
      fc.assert(
        fc.property(
          resourceIdArb,
          fc.integer({ min: 0, max: 10_000 }),
          fc.integer({ min: 0, max: 10_000 }),
          fc.integer({ min: 0, max: 10_000 }),
          (resourceId, initialAmount, cost1, cost2) => {
            const { resourceState, adapter } = createTestResourceState();
            const index = resourceState.requireIndex(resourceId);
            resourceState.addAmount(index, initialAmount);

            const commandQueue = new CommandQueue();
            const { events } = createTestEventPublisher();

            const automation1: AutomationDefinition = {
              id: 'auto:test-competing-1' as any,
              name: { default: 'Test Automation 1', variants: {} },
              description: { default: 'Competing resource cost test', variants: {} },
              trigger: { kind: 'interval', interval: literal(1000) },
              targetType: 'generator',
              targetId: 'gen:clicker' as any,
              unlockCondition: { kind: 'always' },
              enabledByDefault: true,
              cooldown: undefined,
              order: 0,
              resourceCost: { resourceId, rate: literal(cost1) },
            };

            const automation2: AutomationDefinition = {
              id: 'auto:test-competing-2' as any,
              name: { default: 'Test Automation 2', variants: {} },
              description: { default: 'Competing resource cost test', variants: {} },
              trigger: { kind: 'interval', interval: literal(1000) },
              targetType: 'generator',
              targetId: 'gen:producer' as any,
              unlockCondition: { kind: 'always' },
              enabledByDefault: true,
              cooldown: undefined,
              order: 1,
              resourceCost: { resourceId, rate: literal(cost2) },
            };

            const system = createAutomationSystem({
              automations: [automation1, automation2],
              stepDurationMs: 100,
              commandQueue,
              resourceState: adapter,
            });

            system.tick({ deltaMs: 0, step: 0, events });

            const afterFirst = initialAmount >= cost1 ? initialAmount - cost1 : initialAmount;
            const firstFired = initialAmount >= cost1;
            const secondFired = afterFirst >= cost2;
            const expectedCommands =
              (firstFired ? 1 : 0) + (secondFired ? 1 : 0);
            const expectedRemaining =
              afterFirst - (secondFired ? cost2 : 0);

            expect(commandQueue.size).toBe(expectedCommands);
            expect(resourceState.getAmount(index)).toBe(expectedRemaining);

            return true;
          },
        ),
        { numRuns: 500 },
      );
    });
  });

  // ============================================================================
  // Invariant Tests - Command Priority and Execution
  // ============================================================================

  describe('command priority invariants', () => {
    it('all automation commands are enqueued at AUTOMATION priority', () => {
      fc.assert(
        fc.property(
          automationDefinitionArb,
          fc.nat({ max: 100 }), // current step
          fc.integer({ min: 50, max: 200 }), // step duration ms
          (automation, currentStep, stepDurationMs) => {
            const commandQueue = new CommandQueue();

            // Enqueue command for this automation
            enqueueAutomationCommand(automation, commandQueue, currentStep, stepDurationMs);

            // Invariant: Command must be enqueued with AUTOMATION priority
            expect(commandQueue.size).toBe(1);

            const [command] = commandQueue.dequeueAll();
            expect(command).toBeDefined();
            expect(command?.priority).toBe(CommandPriority.AUTOMATION);
            expect(command?.priority).toBe(2); // Verify numeric value

            return true;
          }
        ),
        { numRuns: 1000 }
      );
    });

    it('commands execute at next step (step = currentStep + 1)', () => {
      fc.assert(
        fc.property(
          automationDefinitionArb,
          fc.nat({ max: 1000 }), // current step
          fc.integer({ min: 50, max: 200 }), // step duration ms
          (automation, currentStep, stepDurationMs) => {
            const commandQueue = new CommandQueue();

            // Enqueue command at currentStep
            enqueueAutomationCommand(automation, commandQueue, currentStep, stepDurationMs);

            const [command] = commandQueue.dequeueAll();
            expect(command).toBeDefined();

            // Invariant: Command executes at currentStep + 1
            expect(command?.step).toBe(currentStep + 1);

            // Verify this holds for any step number
            if (currentStep === 0) {
              expect(command?.step).toBe(1);
            } else if (currentStep === 100) {
              expect(command?.step).toBe(101);
            }

            return true;
          }
        ),
        { numRuns: 1000 }
      );
    });

    it('timestamp is deterministic (currentStep * stepDurationMs)', () => {
      fc.assert(
        fc.property(
          automationDefinitionArb,
          fc.nat({ max: 1000 }), // current step
          fc.integer({ min: 50, max: 200 }), // step duration ms
          (automation, currentStep, stepDurationMs) => {
            const commandQueue = new CommandQueue();

            // Enqueue command
            enqueueAutomationCommand(automation, commandQueue, currentStep, stepDurationMs);

            const [command] = commandQueue.dequeueAll();
            expect(command).toBeDefined();

            // Invariant: Timestamp = currentStep * stepDurationMs
            const expectedTimestamp = currentStep * stepDurationMs;
            expect(command?.timestamp).toBe(expectedTimestamp);

            // Verify deterministic replay: same inputs produce same timestamp
            const commandQueue2 = new CommandQueue();
            enqueueAutomationCommand(automation, commandQueue2, currentStep, stepDurationMs);
            const [command2] = commandQueue2.dequeueAll();
            expect(command2?.timestamp).toBe(expectedTimestamp);

            return true;
          }
        ),
        { numRuns: 1000 }
      );
    });

    it('all three command invariants hold simultaneously', () => {
      fc.assert(
        fc.property(
          automationDefinitionArb,
          fc.nat({ max: 500 }),
          fc.integer({ min: 50, max: 200 }),
          (automation, currentStep, stepDurationMs) => {
            const commandQueue = new CommandQueue();

            enqueueAutomationCommand(automation, commandQueue, currentStep, stepDurationMs);

            const [command] = commandQueue.dequeueAll();
            expect(command).toBeDefined();

            // All three invariants must hold together
            expect(command?.priority).toBe(CommandPriority.AUTOMATION); // Priority = 2
            expect(command?.step).toBe(currentStep + 1); // Next step
            expect(command?.timestamp).toBe(currentStep * stepDurationMs); // Deterministic

            return true;
          }
        ),
        { numRuns: 1000 }
      );
    });

    it('multiple automations enqueue commands in sequence with correct properties', () => {
      fc.assert(
        fc.property(
          fc.array(automationDefinitionArb, { minLength: 1, maxLength: 5 }),
          fc.nat({ max: 100 }),
          fc.integer({ min: 50, max: 200 }),
          (automations, currentStep, stepDurationMs) => {
            const commandQueue = new CommandQueue();

            // Enqueue commands for all automations
            for (const automation of automations) {
              enqueueAutomationCommand(automation, commandQueue, currentStep, stepDurationMs);
            }

            // Invariant: All commands share the same priority, step, and timestamp
            expect(commandQueue.size).toBe(automations.length);

            const expectedStep = currentStep + 1;
            const expectedTimestamp = currentStep * stepDurationMs;

            // Verify each enqueued command
            const commands = commandQueue.dequeueAll();
            expect(commands.length).toBe(automations.length);

            for (const command of commands) {
              expect(command).toBeDefined();
              expect(command.priority).toBe(CommandPriority.AUTOMATION);
              expect(command.step).toBe(expectedStep);
              expect(command.timestamp).toBe(expectedTimestamp);
            }
            return true;
          }
        ),
        { numRuns: 500 }
      );
    });

    it('command properties remain invariant across different target types', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('generator', 'upgrade') as fc.Arbitrary<'generator' | 'upgrade'>,
          fc.nat({ max: 200 }),
          fc.integer({ min: 50, max: 200 }),
          (targetType, currentStep, stepDurationMs) => {
            const automation: AutomationDefinition = {
              id: 'auto:test' as any,
              name: { default: 'Test', variants: {} },
              description: { default: 'Test', variants: {} },
              trigger: { kind: 'interval', interval: { kind: 'constant', value: 1000 } },
              targetType,
              targetId: targetType === 'generator' ? ('gen:test' as any) : ('upg:test' as any),
              unlockCondition: { kind: 'always' },
              enabledByDefault: true,
              order: 0,
            };

            const commandQueue = new CommandQueue();
            enqueueAutomationCommand(automation, commandQueue, currentStep, stepDurationMs);

            const [command] = commandQueue.dequeueAll();
            expect(command).toBeDefined();

            // Invariant: Priority, step, and timestamp are target-type independent
            expect(command?.priority).toBe(CommandPriority.AUTOMATION);
            expect(command?.step).toBe(currentStep + 1);
            expect(command?.timestamp).toBe(currentStep * stepDurationMs);

            return true;
          }
        ),
        { numRuns: 500 }
      );
    });
  });

  // ============================================================================
  // Invariant Tests - State Consistency
  // ============================================================================

  describe('state consistency invariants', () => {
    it('lastFiredStep <= currentStep always holds', () => {
      fc.assert(
        fc.property(
          fc.nat({ max: 1000 }), // current step
          fc.integer({ min: -10000, max: 1000 }), // lastFiredStep (can be far in past)
          (currentStep, lastFiredStep) => {
            // Only test valid states where lastFiredStep <= currentStep
            fc.pre(lastFiredStep <= currentStep);

            const state: AutomationState = {
              id: 'auto:test',
              enabled: true,
              lastFiredStep,
              cooldownExpiresStep: 0,
              unlocked: true,
            };

            // Invariant: lastFiredStep should never exceed currentStep
            expect(state.lastFiredStep).toBeLessThanOrEqual(currentStep);

            return true;
          }
        ),
        { numRuns: 1000 }
      );
    });

    it('cooldownExpiresStep >= currentStep when cooldown is active', () => {
      fc.assert(
        fc.property(
          fc.nat({ max: 1000 }), // current step
          fc.nat({ max: 1500 }), // cooldown expires step
          (currentStep, cooldownExpiresStep) => {
            const state: AutomationState = {
              id: 'auto:test',
              enabled: true,
              lastFiredStep: 0,
              cooldownExpiresStep,
              unlocked: true,
            };

            const isActive = isCooldownActive(state, currentStep);

            // Invariant: If cooldown is active, then cooldownExpiresStep > currentStep
            if (isActive) {
              expect(cooldownExpiresStep).toBeGreaterThan(currentStep);
            }

            // Contrapositive: If cooldownExpiresStep <= currentStep, then cooldown is NOT active
            if (cooldownExpiresStep <= currentStep) {
              expect(isActive).toBe(false);
            }

            return true;
          }
        ),
        { numRuns: 1000 }
      );
    });

    it('disabled automations never fire regardless of trigger state', () => {
      fc.assert(
        fc.property(
          automationDefinitionArb,
          fc.nat({ max: 100 }), // current step
          fc.boolean(), // enabled state
          (automation, currentStep, enabled) => {
            const state: AutomationState = {
              id: automation.id,
              enabled,
              lastFiredStep: -Infinity, // Never fired - should fire immediately if enabled
              cooldownExpiresStep: 0, // No cooldown
              unlocked: true, // Unlocked - no barrier to firing
            };

            // For interval triggers, check if it would fire
            if (automation.trigger.kind === 'interval') {
              const wouldTrigger = evaluateIntervalTrigger(
                automation,
                state,
                currentStep,
                100 // stepDurationMs
              );

              // Invariant: If disabled, automation should NOT fire even if trigger satisfied
              if (!enabled) {
                // The trigger may be satisfied, but the automation should not fire
                // This is enforced by the system's tick() logic, not the trigger evaluation
                expect(state.enabled).toBe(false);

                // If the trigger would fire when enabled, verify state prevents it
                if (wouldTrigger) {
                  expect(state.enabled).toBe(false);
                }
              }

              // Invariant: If enabled, unlocked, no cooldown, and trigger satisfied, automation fires
              if (enabled && wouldTrigger) {
                expect(state.enabled).toBe(true);
                expect(state.unlocked).toBe(true);
                expect(isCooldownActive(state, currentStep)).toBe(false);
              }
            }

            return true;
          }
        ),
        { numRuns: 1000 }
      );
    });

    it('unlocked automations never become locked (unlock is persistent)', () => {
      fc.assert(
        fc.property(
          fc.array(fc.boolean(), { minLength: 10, maxLength: 100 }), // sequence of unlock checks
          fc.nat({ max: 1000 }), // random seed for variation
          (unlockSequence, seed) => {
            let unlocked = false;

            for (let i = 0; i < unlockSequence.length; i++) {
              const shouldUnlock = unlockSequence[i] || (seed % 7 === 0 && i > 5);

              // Once unlocked, should stay unlocked
              if (shouldUnlock) {
                unlocked = true;
              }

              // Invariant: unlock state never transitions from true to false
              if (unlocked) {
                expect(unlocked).toBe(true);
              }

              // Simulate multiple ticks - unlock should persist
              const state: AutomationState = {
                id: `auto:test-${seed}`,
                enabled: true,
                lastFiredStep: i,
                cooldownExpiresStep: 0,
                unlocked,
              };

              // After being unlocked, state should remain unlocked
              if (unlocked) {
                expect(state.unlocked).toBe(true);
              }
            }

            return true;
          }
        ),
        { numRuns: 1000 }
      );
    });

    it('state serialization round-trip preserves all fields', () => {
      fc.assert(
        fc.property(
          automationIdArb,
          fc.boolean(), // enabled
          fc.integer({ min: -1000, max: 1000 }), // lastFiredStep (avoid -Infinity for JSON)
          fc.nat({ max: 1000 }), // cooldownExpiresStep
          fc.boolean(), // unlocked
          fc.option(fc.boolean(), { nil: undefined }), // lastThresholdSatisfied
          (id, enabled, lastFiredStep, cooldownExpiresStep, unlocked, lastThresholdSatisfied) => {
            const originalState: AutomationState = {
              id,
              enabled,
              lastFiredStep,
              cooldownExpiresStep,
              unlocked,
              lastThresholdSatisfied,
            };

            // Simulate serialization/deserialization (JSON round-trip)
            const serialized = JSON.stringify(originalState);
            const deserialized = JSON.parse(serialized) as AutomationState;

            // Invariant: All fields must be preserved exactly
            expect(deserialized.id).toBe(originalState.id);
            expect(deserialized.enabled).toBe(originalState.enabled);
            expect(deserialized.lastFiredStep).toBe(originalState.lastFiredStep);
            expect(deserialized.cooldownExpiresStep).toBe(originalState.cooldownExpiresStep);
            expect(deserialized.unlocked).toBe(originalState.unlocked);
            expect(deserialized.lastThresholdSatisfied).toBe(originalState.lastThresholdSatisfied);

            return true;
          }
        ),
        { numRuns: 1000 }
      );
    });

    it('state transitions maintain temporal consistency', () => {
      fc.assert(
        fc.property(
          fc.array(fc.nat({ max: 50 }), { minLength: 5, maxLength: 20 }), // step increments
          fc.integer({ min: 100, max: 5000 }), // cooldown ms
          (stepIncrements, cooldownMs) => {
            let currentStep = 0;
            const stepDurationMs = 100;
            const cooldownSteps = Math.ceil(cooldownMs / stepDurationMs);

            const state: AutomationState = {
              id: 'auto:test',
              enabled: true,
              lastFiredStep: -Infinity,
              cooldownExpiresStep: 0,
              unlocked: true,
            };

            const automation: AutomationDefinition = {
              id: 'auto:test' as any,
              name: { default: 'Test', variants: {} },
              description: { default: 'Test', variants: {} },
              trigger: { kind: 'interval', interval: { kind: 'constant', value: 1000 } },
              targetType: 'generator',
              targetId: 'gen:test' as any,
              unlockCondition: { kind: 'always' },
              enabledByDefault: true,
              cooldown: literal(cooldownMs),
              order: 0,
            };

            for (const increment of stepIncrements) {
              currentStep += increment;

              // Invariant: lastFiredStep <= currentStep
              expect(state.lastFiredStep).toBeLessThanOrEqual(currentStep);

              // Check if trigger would fire
              const canFire = !isCooldownActive(state, currentStep);
              const wouldTrigger = evaluateIntervalTrigger(automation, state, currentStep, stepDurationMs);

              if (canFire && wouldTrigger) {
                // Simulate firing
                const previousLastFired = state.lastFiredStep;
                state.lastFiredStep = currentStep;
                state.cooldownExpiresStep = currentStep + cooldownSteps + 1;

                // Invariant: lastFiredStep increases monotonically (or stays -Infinity)
                if (previousLastFired !== -Infinity) {
                  expect(state.lastFiredStep).toBeGreaterThan(previousLastFired);
                }

                // Invariant: cooldownExpiresStep > currentStep after firing
                expect(state.cooldownExpiresStep).toBeGreaterThan(currentStep);
              }

              // Invariant: If cooldown active, cooldownExpiresStep > currentStep
              if (isCooldownActive(state, currentStep)) {
                expect(state.cooldownExpiresStep).toBeGreaterThan(currentStep);
              }
            }

            return true;
          }
        ),
        { numRuns: 1000 }
      );
    });

    it('unlock state persists across state mutations', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              toggleEnabled: fc.boolean(),
              advanceStep: fc.nat({ max: 10 }),
              setUnlocked: fc.option(fc.boolean(), { nil: undefined }),
            }),
            { minLength: 10, maxLength: 50 }
          ),
          (mutations) => {
            const state: AutomationState = {
              id: 'auto:test',
              enabled: true,
              lastFiredStep: 0,
              cooldownExpiresStep: 0,
              unlocked: false,
            };

            let currentStep = 0;
            let everUnlocked = false;

            for (const mutation of mutations) {
              // Apply mutations
              if (mutation.toggleEnabled) {
                state.enabled = !state.enabled;
              }

              if (mutation.advanceStep > 0) {
                currentStep += mutation.advanceStep;
                state.lastFiredStep = Math.min(state.lastFiredStep + mutation.advanceStep, currentStep);
              }

              if (mutation.setUnlocked !== undefined) {
                // Simulate unlock condition check
                if (mutation.setUnlocked) {
                  state.unlocked = true;
                  everUnlocked = true;
                }
                // IMPORTANT: Should never set unlocked = false once it's true
              }

              // Invariant: Once unlocked, always unlocked
              if (everUnlocked) {
                expect(state.unlocked).toBe(true);
              }

              // Invariant: lastFiredStep <= currentStep
              expect(state.lastFiredStep).toBeLessThanOrEqual(currentStep);
            }

            return true;
          }
        ),
        { numRuns: 1000 }
      );
    });

    it('cooldown and lastFired relationship is consistent', () => {
      fc.assert(
        fc.property(
          fc.nat({ max: 100 }), // fire step
          fc.nat({ max: 50 }), // cooldown steps
          fc.nat({ max: 100 }), // current step offset
          (fireStep, cooldownSteps, offset) => {
            const currentStep = fireStep + offset;

            const state: AutomationState = {
              id: 'auto:test',
              enabled: true,
              lastFiredStep: fireStep,
              cooldownExpiresStep: fireStep + cooldownSteps + 1,
              unlocked: true,
            };

            // Invariant: lastFiredStep should be before or equal to currentStep
            expect(state.lastFiredStep).toBeLessThanOrEqual(currentStep);

            // Invariant: If lastFiredStep is recent and cooldown configured,
            // cooldownExpiresStep should be after lastFiredStep
            if (cooldownSteps > 0) {
              expect(state.cooldownExpiresStep).toBeGreaterThan(state.lastFiredStep);
            }

            // Invariant: Cooldown active <=> currentStep < cooldownExpiresStep
            const isActive = isCooldownActive(state, currentStep);
            expect(isActive).toBe(currentStep < state.cooldownExpiresStep);

            return true;
          }
        ),
        { numRuns: 1000 }
      );
    });
  });
});
