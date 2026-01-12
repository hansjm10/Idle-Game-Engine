import { describe, expect, it, vi } from 'vitest';
import type { AutomationDefinition } from '@idle-engine/content-schema';

import type { AutomationState } from '../../automation-system.js';
import {
  createAutomationSystem,
  evaluateCommandQueueEmptyTrigger,
  evaluateEventTrigger,
  evaluateIntervalTrigger,
  evaluateResourceThresholdTrigger,
} from '../../automation-system.js';
import { CommandQueue } from '../../command-queue.js';
import { noopEventPublisher } from '../helpers/event-fixtures.js';
import { literal } from '../helpers/formula-fixtures.js';

describe('AutomationSystem', () => {
  const stepDurationMs = 100;

  describe('interval triggers', () => {
    it('should fire on first tick when lastFiredStep is -Infinity', () => {
      const automation: AutomationDefinition = {
        id: 'auto:test' as any,
        name: { default: 'Test', variants: {} },
        description: { default: 'Test', variants: {} },
        targetType: 'generator',
        targetId: 'gen:test' as any,
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
        id: 'auto:test' as any,
        name: { default: 'Test', variants: {} },
        description: { default: 'Test', variants: {} },
        targetType: 'generator',
        targetId: 'gen:test' as any,
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
        id: 'auto:test' as any,
        name: { default: 'Test', variants: {} },
        description: { default: 'Test', variants: {} },
        targetType: 'generator',
        targetId: 'gen:test' as any,
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

  describe('resourceThreshold triggers', () => {
    const createMockResourceState = (amount: number) => ({
      getAmount: () => amount,
    });

    it('should fire when resource meets gte threshold', () => {
      const automation: AutomationDefinition = {
        id: 'auto:test' as any,
        name: { default: 'Test', variants: {} },
        description: { default: 'Test', variants: {} },
        targetType: 'generator',
        targetId: 'gen:test' as any,
        trigger: {
          kind: 'resourceThreshold',
          resourceId: 'res:gold' as any,
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
        id: 'auto:test' as any,
        name: { default: 'Test', variants: {} },
        description: { default: 'Test', variants: {} },
        targetType: 'generator',
        targetId: 'gen:test' as any,
        trigger: {
          kind: 'resourceThreshold',
          resourceId: 'res:gold' as any,
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
        id: 'auto:test' as any,
        name: { default: 'Test', variants: {} },
        description: { default: 'Test', variants: {} },
        targetType: 'generator',
        targetId: 'gen:test' as any,
        trigger: {
          kind: 'resourceThreshold',
          resourceId: 'res:gold' as any,
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
        id: 'auto:test' as any,
        name: { default: 'Test', variants: {} },
        description: { default: 'Test', variants: {} },
        targetType: 'generator',
        targetId: 'gen:test' as any,
        trigger: {
          kind: 'resourceThreshold',
          resourceId: 'res:gold' as any,
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
        id: 'auto:test' as any,
        name: { default: 'Test', variants: {} },
        description: { default: 'Test', variants: {} },
        targetType: 'generator',
        targetId: 'gen:test' as any,
        trigger: {
          kind: 'resourceThreshold',
          resourceId: 'res:gold' as any,
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

    it('should read correct resource when multiple resources exist', () => {
      // Mock resource state with multiple resources
      const resourceState = {
        getAmount: (index: number) => {
          if (index === 0) return 50; // res:gold
          if (index === 1) return 200; // res:gems
          return 0;
        },
        getResourceIndex: (resourceId: string) => {
          if (resourceId === 'res:gold') return 0;
          if (resourceId === 'res:gems') return 1;
          return -1;
        },
      };

      const goldAutomation: AutomationDefinition = {
        id: 'auto:gold-spender' as any,
        name: { default: 'Gold Spender', variants: {} },
        description: { default: 'Triggers on gold', variants: {} },
        targetType: 'generator',
        targetId: 'gen:test' as any,
        trigger: {
          kind: 'resourceThreshold',
          resourceId: 'res:gold' as any,
          comparator: 'gte',
          threshold: { kind: 'constant', value: 100 },
        },
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
        order: 0,
      };

      const gemsAutomation: AutomationDefinition = {
        id: 'auto:gem-spender' as any,
        name: { default: 'Gem Spender', variants: {} },
        description: { default: 'Triggers on gems', variants: {} },
        targetType: 'generator',
        targetId: 'gen:test' as any,
        trigger: {
          kind: 'resourceThreshold',
          resourceId: 'res:gems' as any,
          comparator: 'gte',
          threshold: { kind: 'constant', value: 100 },
        },
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
        order: 0,
      };

      // Gold is 50 (below 100 threshold) - should NOT fire
      const goldShouldFire = evaluateResourceThresholdTrigger(goldAutomation, resourceState);
      expect(goldShouldFire).toBe(false);

      // Gems is 200 (above 100 threshold) - SHOULD fire
      const gemsShouldFire = evaluateResourceThresholdTrigger(gemsAutomation, resourceState);
      expect(gemsShouldFire).toBe(true);
    });

    it('should fire lt/lte threshold when resource does not exist (missing resource treated as 0)', () => {
      const resourceState = {
        getAmount: (index: number) => {
          if (index === 0) return 100; // res:gold exists
          return 0; // Fallback (should never be called for missing resources)
        },
        getResourceIndex: (resourceId: string) => {
          if (resourceId === 'res:gold') return 0;
          return -1; // res:gems does not exist
        },
      };

      // Automation that fires when gems < 50
      // Since gems doesn't exist (treated as 0), 0 < 50 should be true
      const ltAutomation: AutomationDefinition = {
        id: 'auto:bootstrap' as any,
        name: { default: 'Bootstrap Auto', variants: {} },
        description: { default: 'Triggers on missing resource', variants: {} },
        targetType: 'generator',
        targetId: 'gen:test' as any,
        trigger: {
          kind: 'resourceThreshold',
          resourceId: 'res:gems' as any,
          comparator: 'lt',
          threshold: { kind: 'constant', value: 50 },
        },
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
        order: 0,
      };

      // 0 < 50 = true
      const ltShouldFire = evaluateResourceThresholdTrigger(ltAutomation, resourceState);
      expect(ltShouldFire).toBe(true);

      // Test lte as well: 0 <= 50 = true
      const lteAutomation: AutomationDefinition = {
        ...ltAutomation,
        trigger: {
          kind: 'resourceThreshold',
          resourceId: 'res:gems' as any,
          comparator: 'lte',
          threshold: { kind: 'constant', value: 50 },
        },
      };

      const lteShouldFire = evaluateResourceThresholdTrigger(lteAutomation, resourceState);
      expect(lteShouldFire).toBe(true);
    });

    it('should not fire gte/gt threshold when resource does not exist (missing resource treated as 0)', () => {
      const resourceState = {
        getAmount: (index: number) => {
          if (index === 0) return 100; // res:gold exists
          return 0;
        },
        getResourceIndex: (resourceId: string) => {
          if (resourceId === 'res:gold') return 0;
          return -1; // res:gems does not exist
        },
      };

      // Automation that fires when gems >= 50
      // Since gems doesn't exist (treated as 0), 0 >= 50 should be false
      const gteAutomation: AutomationDefinition = {
        id: 'auto:spender' as any,
        name: { default: 'Gem Spender', variants: {} },
        description: { default: 'Triggers when gems available', variants: {} },
        targetType: 'generator',
        targetId: 'gen:test' as any,
        trigger: {
          kind: 'resourceThreshold',
          resourceId: 'res:gems' as any,
          comparator: 'gte',
          threshold: { kind: 'constant', value: 50 },
        },
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
        order: 0,
      };

      // 0 >= 50 = false
      const gteShouldFire = evaluateResourceThresholdTrigger(gteAutomation, resourceState);
      expect(gteShouldFire).toBe(false);

      // Test gt as well: 0 > 50 = false
      const gtAutomation: AutomationDefinition = {
        ...gteAutomation,
        trigger: {
          kind: 'resourceThreshold',
          resourceId: 'res:gems' as any,
          comparator: 'gt',
          threshold: { kind: 'constant', value: 50 },
        },
      };

      const gtShouldFire = evaluateResourceThresholdTrigger(gtAutomation, resourceState);
      expect(gtShouldFire).toBe(false);
    });

    it('should correctly evaluate missing resource with threshold of 0', () => {
      const resourceState = {
        getAmount: () => 100,
        getResourceIndex: (resourceId: string) => {
          if (resourceId === 'res:locked') return -1;
          return 0;
        },
      };

      // Missing resource (0) >= 0 should be true
      const gteZeroAutomation: AutomationDefinition = {
        id: 'auto:gte-zero' as any,
        name: { default: 'GTE Zero', variants: {} },
        description: { default: 'Test', variants: {} },
        targetType: 'generator',
        targetId: 'gen:test' as any,
        trigger: {
          kind: 'resourceThreshold',
          resourceId: 'res:locked' as any,
          comparator: 'gte',
          threshold: { kind: 'constant', value: 0 },
        },
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
        order: 0,
      };

      const gteShouldFire = evaluateResourceThresholdTrigger(gteZeroAutomation, resourceState);
      expect(gteShouldFire).toBe(true); // 0 >= 0 = true

      // Missing resource (0) > 0 should be false
      const gtZeroAutomation: AutomationDefinition = {
        ...gteZeroAutomation,
        trigger: {
          kind: 'resourceThreshold',
          resourceId: 'res:locked' as any,
          comparator: 'gt',
          threshold: { kind: 'constant', value: 0 },
        },
      };

      const gtShouldFire = evaluateResourceThresholdTrigger(gtZeroAutomation, resourceState);
      expect(gtShouldFire).toBe(false); // 0 > 0 = false

      // Missing resource (0) <= 0 should be true
      const lteZeroAutomation: AutomationDefinition = {
        ...gteZeroAutomation,
        trigger: {
          kind: 'resourceThreshold',
          resourceId: 'res:locked' as any,
          comparator: 'lte',
          threshold: { kind: 'constant', value: 0 },
        },
      };

      const lteShouldFire = evaluateResourceThresholdTrigger(lteZeroAutomation, resourceState);
      expect(lteShouldFire).toBe(true); // 0 <= 0 = true

      // Missing resource (0) < 0 should be false
      const ltZeroAutomation: AutomationDefinition = {
        ...gteZeroAutomation,
        trigger: {
          kind: 'resourceThreshold',
          resourceId: 'res:locked' as any,
          comparator: 'lt',
          threshold: { kind: 'constant', value: 0 },
        },
      };

      const ltShouldFire = evaluateResourceThresholdTrigger(ltZeroAutomation, resourceState);
      expect(ltShouldFire).toBe(false); // 0 < 0 = false
    });
  });

  it('should fire resourceThreshold only when threshold is crossed, not continuously', () => {
    const automations: AutomationDefinition[] = [
      {
        id: 'auto:threshold-crosser' as any,
        name: { default: 'Threshold Crosser', variants: {} },
        description: { default: 'Fires when gold crosses 100', variants: {} },
        targetType: 'generator',
        targetId: 'gen:test' as any,
        trigger: {
          kind: 'resourceThreshold',
          resourceId: 'res:gold' as any,
          comparator: 'gte',
          threshold: { kind: 'constant', value: 100 },
        },
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
        order: 0,
      },
    ];

    let currentAmount = 50; // Start below threshold
    const resourceState = {
      getAmount: () => currentAmount,
      getResourceIndex: (id: string) => (id === 'res:gold' ? 0 : -1),
    };

    const commandQueue = new CommandQueue();
    const system = createAutomationSystem({
      automations,
      stepDurationMs: 100,
      commandQueue,
      resourceState,
    });

    const context = {
      step: 0,
      deltaMs: 100,
      events: {
        on: (() => {}) as any,
        off: () => {},
        emit: () => {},
        publish: noopEventPublisher.publish,
      } as any,
    };

    system.setup?.(context);

    // Tick 1: Below threshold (50 < 100) - should NOT fire
    system.tick(context);
    expect(commandQueue.size).toBe(0);

    // Tick 2: Cross threshold (50 -> 150) - SHOULD fire (crossing event)
    context.step = 1;
    currentAmount = 150;
    system.tick(context);
    expect(commandQueue.size).toBe(1);
    commandQueue.dequeueUpToStep(2); // Clear queue

    // Tick 3: Still above threshold (150 >= 100) - should NOT fire (already crossed)
    context.step = 2;
    system.tick(context);
    expect(commandQueue.size).toBe(0); // BUG: Currently fires again here

    // Tick 4: Drop below threshold (150 -> 50) - should NOT fire (crossing in wrong direction)
    context.step = 3;
    currentAmount = 50;
    system.tick(context);
    expect(commandQueue.size).toBe(0);

    // Tick 5: Cross threshold again (50 -> 200) - SHOULD fire (new crossing event)
    context.step = 4;
    currentAmount = 200;
    system.tick(context);
    expect(commandQueue.size).toBe(1);
  });

  describe('resourceThreshold crossing detection', () => {
    it('should detect gte crossing (below -> above)', () => {
      const automations: AutomationDefinition[] = [
        {
          id: 'auto:gte' as any,
          name: { default: 'GTE Crosser', variants: {} },
          description: { default: 'Test', variants: {} },
          targetType: 'generator',
          targetId: 'gen:test' as any,
          trigger: {
            kind: 'resourceThreshold',
            resourceId: 'res:gold' as any,
            comparator: 'gte',
            threshold: { kind: 'constant', value: 100 },
          },
          unlockCondition: { kind: 'always' },
          enabledByDefault: true,
          order: 0,
        },
      ];

      let amount = 50;
      const resourceState = {
        getAmount: () => amount,
        getResourceIndex: (_id: string) => 0,
      };

      const commandQueue = new CommandQueue();
      const system = createAutomationSystem({
        automations,
        stepDurationMs: 100,
        commandQueue,
        resourceState,
      });

      const context = {
        step: 0,
        deltaMs: 100,
        events: {
          on: (() => {}) as any,
          off: () => {},
          emit: () => {},
          publish: noopEventPublisher.publish,
        } as any,
      };

      system.setup?.(context);

      // Below threshold
      system.tick(context);
      expect(commandQueue.size).toBe(0);

      // Cross upward (50 -> 100)
      context.step = 1;
      amount = 100;
      system.tick(context);
      expect(commandQueue.size).toBe(1); // Should fire
      commandQueue.dequeueUpToStep(2);

      // Stay above
      context.step = 2;
      amount = 150;
      system.tick(context);
      expect(commandQueue.size).toBe(0); // Should NOT fire

      // Drop below
      context.step = 3;
      amount = 50;
      system.tick(context);
      expect(commandQueue.size).toBe(0); // Should NOT fire (wrong direction)

      // Cross upward again
      context.step = 4;
      amount = 200;
      system.tick(context);
      expect(commandQueue.size).toBe(1); // Should fire again
    });

    it('should detect lt crossing (above -> below)', () => {
      const automations: AutomationDefinition[] = [
        {
          id: 'auto:lt' as any,
          name: { default: 'LT Crosser', variants: {} },
          description: { default: 'Test', variants: {} },
          targetType: 'generator',
          targetId: 'gen:test' as any,
          trigger: {
            kind: 'resourceThreshold',
            resourceId: 'res:gold' as any,
            comparator: 'lt',
            threshold: { kind: 'constant', value: 100 },
          },
          unlockCondition: { kind: 'always' },
          enabledByDefault: true,
          order: 0,
        },
      ];

      let amount = 150;
      const resourceState = {
        getAmount: () => amount,
        getResourceIndex: (_id: string) => 0,
      };

      const commandQueue = new CommandQueue();
      const system = createAutomationSystem({
        automations,
        stepDurationMs: 100,
        commandQueue,
        resourceState,
      });

      const context = {
        step: 0,
        deltaMs: 100,
        events: {
          on: (() => {}) as any,
          off: () => {},
          emit: () => {},
          publish: noopEventPublisher.publish,
        } as any,
      };

      system.setup?.(context);

      // Above threshold
      system.tick(context);
      expect(commandQueue.size).toBe(0);

      // Cross downward (150 -> 50)
      context.step = 1;
      amount = 50;
      system.tick(context);
      expect(commandQueue.size).toBe(1); // Should fire
      commandQueue.dequeueUpToStep(2);

      // Stay below
      context.step = 2;
      amount = 20;
      system.tick(context);
      expect(commandQueue.size).toBe(0); // Should NOT fire

      // Go above
      context.step = 3;
      amount = 150;
      system.tick(context);
      expect(commandQueue.size).toBe(0); // Should NOT fire (wrong direction)

      // Cross downward again
      context.step = 4;
      amount = 10;
      system.tick(context);
      expect(commandQueue.size).toBe(1); // Should fire again
    });

    it('should fire on first tick if threshold already crossed at startup', () => {
      const automations: AutomationDefinition[] = [
        {
          id: 'auto:startup' as any,
          name: { default: 'Startup Fire', variants: {} },
          description: { default: 'Test', variants: {} },
          targetType: 'generator',
          targetId: 'gen:test' as any,
          trigger: {
            kind: 'resourceThreshold',
            resourceId: 'res:gold' as any,
            comparator: 'gte',
            threshold: { kind: 'constant', value: 100 },
          },
          unlockCondition: { kind: 'always' },
          enabledByDefault: true,
          order: 0,
        },
      ];

      const resourceState = {
        getAmount: () => 200, // Already above threshold at startup
        getResourceIndex: (_id: string) => 0,
      };

      const commandQueue = new CommandQueue();
      const system = createAutomationSystem({
        automations,
        stepDurationMs: 100,
        commandQueue,
        resourceState,
      });

      const context = {
        step: 0,
        deltaMs: 100,
        events: {
          on: (() => {}) as any,
          off: () => {},
          emit: () => {},
          publish: noopEventPublisher.publish,
        } as any,
      };

      system.setup?.(context);

      // First tick: lastThresholdSatisfied is undefined, current is true
      // undefined -> true is a crossing, should fire
      system.tick(context);
      expect(commandQueue.size).toBe(1);
    });

    it('should respect cooldown after crossing fires, then fire on next crossing', () => {
      const automations: AutomationDefinition[] = [
        {
          id: 'auto:cooldown-crosser' as any,
          name: { default: 'Cooldown Crosser', variants: {} },
          description: { default: 'Test', variants: {} },
          targetType: 'generator',
          targetId: 'gen:test' as any,
          trigger: {
            kind: 'resourceThreshold',
            resourceId: 'res:gold' as any,
            comparator: 'gte',
            threshold: { kind: 'constant', value: 100 },
          },
          cooldown: literal(300), // 3 steps
          unlockCondition: { kind: 'always' },
          enabledByDefault: true,
          order: 0,
        },
      ];

      let amount = 50;
      const resourceState = {
        getAmount: () => amount,
        getResourceIndex: (_id: string) => 0,
      };

      const commandQueue = new CommandQueue();
      const system = createAutomationSystem({
        automations,
        stepDurationMs: 100,
        commandQueue,
        resourceState,
      });

      const context = {
        step: 0,
        deltaMs: 100,
        events: {
          on: (() => {}) as any,
          off: () => {},
          emit: () => {},
          publish: noopEventPublisher.publish,
        } as any,
      };

      system.setup?.(context);

      // Step 0: Below threshold
      system.tick(context);
      expect(commandQueue.size).toBe(0);

      // Step 1: Cross upward - should fire
      context.step = 1;
      amount = 150;
      system.tick(context);
      expect(commandQueue.size).toBe(1);
      commandQueue.dequeueUpToStep(2);

      // Step 2: Drop below and cross upward again - cooldown still active, should NOT fire
      context.step = 2;
      amount = 50;
      system.tick(context);
      context.step = 3;
      amount = 150;
      system.tick(context);
      expect(commandQueue.size).toBe(0); // Cooldown blocks firing

      // Step 4: Still in cooldown
      context.step = 4;
      system.tick(context);
      expect(commandQueue.size).toBe(0);

      // Step 5: Cooldown expired - should fire due to crossing that occurred at step 3
      // Even though resource has been above threshold since step 3, the threshold state
      // was updated to false at step 2 (during cooldown), so the crossing from false
      // (step 2) to true (step 3+) is detected when cooldown expires.
      context.step = 5;
      system.tick(context);
      expect(commandQueue.size).toBe(1); // Fires on crossing detected after cooldown
      commandQueue.dequeueUpToStep(6);

      // Step 6: Drop below (cooldown still active)
      context.step = 6;
      amount = 50;
      system.tick(context);
      expect(commandQueue.size).toBe(0);

      // Steps 7-8: Cooldown still active (expires at step 9: 5 + 3 + 1)
      context.step = 7;
      amount = 50;
      system.tick(context);
      expect(commandQueue.size).toBe(0);
      context.step = 8;
      system.tick(context);
      expect(commandQueue.size).toBe(0);

      // Step 9: Cross upward - cooldown expired, should fire on new crossing
      context.step = 9;
      amount = 200;
      system.tick(context);
      expect(commandQueue.size).toBe(1);
    });

    it('updates threshold state during cooldown to detect crossings after cooldown expires', () => {
      // SETUP: Automation with threshold trigger and cooldown
      const automation: AutomationDefinition = {
        id: 'auto:cooldown-threshold-test' as any,
        name: { default: 'Cooldown Threshold Test', variants: {} },
        description: { default: 'Test', variants: {} },
        trigger: {
          kind: 'resourceThreshold',
          resourceId: 'res:gold' as any,
          comparator: 'gte',
          threshold: { kind: 'constant', value: 100 },
        },
        targetType: 'generator',
        targetId: 'gen:collector' as any,
        cooldown: literal(500), // 5 steps @ 100ms/step
        enabledByDefault: true,
        unlockCondition: { kind: 'always' },
        order: 0,
      };

      let currentStep = 0;

      const resourceState = {
        getAmount: (index: number) => {
          if (index !== 0) return 0;
          // Return amounts based on step count
          const step = currentStep;
          if (step === 0) return 150; // Initial: above threshold (fires)
          if (step >= 1 && step <= 3) return 50; // During cooldown: drops below threshold
          if (step >= 4 && step <= 6) return 150; // Still in cooldown: rises above threshold again
          if (step >= 7) return 150; // After cooldown: still above threshold
          return 0;
        },
        getResourceIndex: (id: string) => (id === 'res:gold' ? 0 : -1),
      };

      const commandQueue = new CommandQueue();
      const system = createAutomationSystem({
        automations: [automation],
        stepDurationMs: 100,
        commandQueue,
        resourceState,
      });

      const context = {
        step: 0,
        deltaMs: 100,
        events: {
          on: (() => {}) as any,
          off: () => {},
          emit: () => {},
          publish: noopEventPublisher.publish,
        } as any,
      };

      system.setup?.(context);

      // Tick 0: Resource at 150 (above threshold), should fire
      currentStep = 0;
      context.step = currentStep;
      system.tick(context);
      expect(commandQueue.size).toBe(1); // First fire
      commandQueue.dequeueUpToStep(1); // Clear queue

      // Ticks 1-3: Resource drops to 50 (below threshold), cooldown active
      // State should update to false even during cooldown
      for (let i = 1; i <= 3; i++) {
        currentStep = i;
        context.step = currentStep;
        system.tick(context);
        expect(commandQueue.size).toBe(0); // Cooldown prevents firing
      }

      // Ticks 4-5: Resource rises to 150 (above threshold), cooldown still active
      // BUG: If state isn't updated during cooldown, lastThresholdSatisfied stays true
      // and the false->true transition is missed
      for (let i = 4; i <= 5; i++) {
        currentStep = i;
        context.step = currentStep;
        system.tick(context);
        expect(commandQueue.size).toBe(0); // Cooldown prevents firing
      }

      // Tick 6: Cooldown expired (fires at step 0, cooldown lasts 5 steps: 1-5), resource still at 150
      // EXPECTED: Should fire because we saw false->true transition during cooldown (step 3->4)
      // With fix: lastThresholdSatisfied was set to false during cooldown, so crossing is detected
      // Without fix: lastThresholdSatisfied stayed true, so no crossing detected
      currentStep = 6;
      context.step = currentStep;
      system.tick(context);
      expect(commandQueue.size).toBe(1); // Should fire on new crossing
    });

    it('handles multiple threshold crossings during single cooldown period', () => {
      const automation: AutomationDefinition = {
        id: 'auto:multi-crossing' as any,
        name: { default: 'Multi Crossing Test', variants: {} },
        description: { default: 'Test', variants: {} },
        trigger: {
          kind: 'resourceThreshold',
          resourceId: 'res:gold' as any,
          comparator: 'gte',
          threshold: { kind: 'constant', value: 100 },
        },
        targetType: 'generator',
        targetId: 'gen:collector' as any,
        cooldown: literal(800), // 8 steps @ 100ms/step
        enabledByDefault: true,
        unlockCondition: { kind: 'always' },
        order: 0,
      };

      let currentStep = 0;
      const resourceState = {
        getAmount: (index: number) => {
          if (index !== 0) return 0;
          const step = currentStep;
          // Pattern: 150 -> 50 -> 150 -> 50 -> 150 (oscillates during cooldown)
          if (step === 0) return 150; // Above (fire)
          if (step === 1) return 50;  // Below (cooldown)
          if (step === 2) return 150; // Above (cooldown)
          if (step === 3) return 50;  // Below (cooldown)
          if (step === 4) return 150; // Above (cooldown)
          if (step === 5) return 50;  // Below (cooldown)
          if (step === 6) return 150; // Above (cooldown)
          if (step === 7) return 50;  // Below (cooldown)
          if (step === 8) return 150; // Above (cooldown)
          if (step === 9) return 150; // Above (cooldown expired - should fire)
          return 0;
        },
        getResourceIndex: (id: string) => (id === 'res:gold' ? 0 : -1),
      };

      const commandQueue = new CommandQueue();
      const system = createAutomationSystem({
        automations: [automation],
        stepDurationMs: 100,
        commandQueue,
        resourceState,
      });

      const context = {
        step: 0,
        deltaMs: 100,
        events: {
          on: (() => {}) as any,
          off: () => {},
          emit: () => {},
          publish: noopEventPublisher.publish,
        } as any,
      };

      system.setup?.(context);

      // Tick 0: Fire initial trigger
      currentStep = 0;
      context.step = currentStep;
      system.tick(context);
      expect(commandQueue.size).toBe(1);
      commandQueue.dequeueUpToStep(1);

      // Ticks 1-8: Cooldown active, resource oscillates
      for (let i = 1; i <= 8; i++) {
        currentStep = i;
        context.step = currentStep;
        system.tick(context);
        expect(commandQueue.size).toBe(0); // Cooldown prevents all fires
      }

      // Tick 9: Cooldown expired, resource above threshold
      // Should fire because last crossing was from below (step 8: 50) to above (step 9: 150)
      currentStep = 9;
      context.step = currentStep;
      system.tick(context);
      expect(commandQueue.size).toBe(1); // Should fire on latest crossing
    });
  });

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

    it('consumes event without resourceCost (no retention)', () => {
      const automations: AutomationDefinition[] = [
        {
          id: 'auto:event-no-cost' as any,
          name: { default: 'Event No Cost', variants: {} },
          description: { default: 'Event trigger without cost', variants: {} },
          targetType: 'generator',
          targetId: 'gen:test' as any,
          trigger: { kind: 'event', eventId: 'evt:once' as any },
          unlockCondition: { kind: 'always' },
          enabledByDefault: true,
          order: 0,
        },
      ];

      let handler: (() => void) | undefined;
      const events = {
        on: (id: string, cb: () => void) => {
          if (id === 'evt:once') handler = cb;
        },
        off: () => {},
        emit: () => {},
      } as any;

      const commandQueue = new CommandQueue();
      const system = createAutomationSystem({
        automations,
        stepDurationMs: 100,
        commandQueue,
        resourceState: { getAmount: () => 0 },
      });

      system.setup?.({ events });

      // Emit event once
      handler?.();

      // Tick: should enqueue exactly once
      system.tick({ step: 0, deltaMs: 100, events: noopEventPublisher });
      expect(commandQueue.size).toBe(1);
      commandQueue.dequeueUpToStep(1);

      // Without re-emitting the event, a subsequent tick should NOT fire again
      system.tick({ step: 1, deltaMs: 100, events: noopEventPublisher });
      expect(commandQueue.size).toBe(0);
    });
  });

  describe('automation:fired event', () => {
    it('publishes triggerKind and step for successful automation fires', () => {
      const automations: AutomationDefinition[] = [
        {
          id: 'auto:collector' as any,
          name: { default: 'Auto Collector', variants: {} },
          description: { default: 'Collects automatically', variants: {} },
          targetType: 'collectResource',
          targetId: 'res:gold' as any,
          trigger: { kind: 'interval', interval: { kind: 'constant', value: 100 } },
          unlockCondition: { kind: 'always' },
          enabledByDefault: true,
          order: 0,
        },
      ];

      const commandQueue = new CommandQueue();
      const system = createAutomationSystem({
        automations,
        stepDurationMs,
        commandQueue,
        resourceState: { getAmount: () => 0 },
      });

      const publish = vi.fn(() => ({ accepted: true } as any));
      const events = { publish } as any;

      system.tick({ step: 42, deltaMs: stepDurationMs, events });

      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledWith('automation:fired', {
        automationId: 'auto:collector',
        triggerKind: 'interval',
        step: 42,
      });
    });
  });

});
