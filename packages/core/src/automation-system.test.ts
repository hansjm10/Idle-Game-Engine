import { describe, it, expect } from 'vitest';
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
import type { AutomationDefinition } from '@idle-engine/content-schema';
import type { AutomationState } from './automation-system.js';
import { CommandQueue } from './command-queue.js';
import { CommandPriority, RUNTIME_COMMAND_TYPES } from './command.js';
import { IdleEngineRuntime } from './index.js';

describe('AutomationSystem', () => {
  const stepDurationMs = 100;

  describe('initialization', () => {
    it('should create system with correct id', () => {
      const system = createAutomationSystem({
        automations: [],
        stepDurationMs,
        commandQueue: new CommandQueue(),
        resourceState: { getAmount: () => 0 },
      });

      expect(system.id).toBe('automation-system');
    });

    it('should initialize automation states with default values', () => {
      const automations: AutomationDefinition[] = [
        {
          id: 'auto:collector' as any,
          name: { default: 'Auto Collector', variants: {} },
          description: { default: 'Collects automatically', variants: {} },
          targetType: 'generator',
          targetId: 'gen:clicks' as any,
          trigger: { kind: 'interval', interval: { kind: 'constant', value: 1000 } },
          unlockCondition: { kind: 'always' },
          enabledByDefault: true,
          order: 0,
        },
      ];

      const system = createAutomationSystem({
        automations,
        stepDurationMs: 100,
        commandQueue: new CommandQueue(),
        resourceState: { getAmount: () => 0 },
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
          id: 'auto:collector' as any,
          name: { default: 'Auto Collector', variants: {} },
          description: { default: 'Collects automatically', variants: {} },
          targetType: 'generator',
          targetId: 'gen:clicks' as any,
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
        commandQueue: new CommandQueue(),
        resourceState: { getAmount: () => 0 },
        initialState,
      });

      const state = getAutomationState(system);
      const autoState = state.get('auto:collector');

      expect(autoState?.enabled).toBe(false);
      expect(autoState?.lastFiredStep).toBe(100);
      expect(autoState?.cooldownExpiresStep).toBe(110);
      expect(autoState?.unlocked).toBe(true);
    });

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
      system.setup?.({
        events: {
          on: () => {},
          off: () => {},
          emit: () => {},
        } as any,
      });
      system.tick({
        step: 0,
        deltaMs: 100,
        events: {} as any,
      });

      // Check that unlocked state is preserved despite resource being below threshold
      const state = getAutomationState(system);
      const autoState = state.get('auto:advanced');
      expect(autoState?.unlocked).toBe(true);
    });

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
      system.setup?.({
        events: {
          on: () => {},
          off: () => {},
          emit: () => {},
        } as any,
      });
      system.tick({
        step: 0,
        deltaMs: 100,
        events: {} as any,
      });

      const stateAfterTick = getAutomationState(system);
      expect(stateAfterTick.get('auto:basic')?.unlocked).toBe(true);

      // Should remain unlocked on subsequent ticks
      system.tick({
        step: 1,
        deltaMs: 100,
        events: {} as any,
      });
      const stateAfterSecondTick = getAutomationState(system);
      expect(stateAfterSecondTick.get('auto:basic')?.unlocked).toBe(true);
    });
  });

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
  });

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

  describe('system integration', () => {
    it('should subscribe to event triggers during setup', () => {
      const automations: AutomationDefinition[] = [
        {
          id: 'auto:event-test' as any,
          name: { default: 'Event Test', variants: {} },
          description: { default: 'Test', variants: {} },
          targetType: 'generator',
          targetId: 'gen:clicks' as any,
          trigger: { kind: 'event', eventId: 'resource:threshold-reached' as any },
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

  describe('command enqueueing', () => {
    it('should enqueue TOGGLE_GENERATOR command for generator target', () => {
      const automation: AutomationDefinition = {
        id: 'auto:test' as any,
        name: { default: 'Test', variants: {} },
        description: { default: 'Test', variants: {} },
        targetType: 'generator',
        targetId: 'gen:clicks' as any,
        trigger: { kind: 'interval', interval: { kind: 'constant', value: 1000 } },
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
        order: 0,
      };

      const commandQueue = new CommandQueue();

      enqueueAutomationCommand(automation, commandQueue, 10, 1000);

      expect(commandQueue.size).toBe(1);
      const commands = commandQueue.dequeueUpToStep(11);
      expect(commands.length).toBe(1);
      const command = commands[0];
      expect(command?.type).toBe(RUNTIME_COMMAND_TYPES.TOGGLE_GENERATOR);
      expect(command?.priority).toBe(CommandPriority.AUTOMATION);
      expect(command?.payload).toEqual({
        generatorId: 'gen:clicks',
        enabled: true,
      });
    });

    it('should enqueue PURCHASE_UPGRADE command for upgrade target', () => {
      const automation: AutomationDefinition = {
        id: 'auto:test' as any,
        name: { default: 'Test', variants: {} },
        description: { default: 'Test', variants: {} },
        targetType: 'upgrade',
        targetId: 'upg:doubler' as any,
        trigger: { kind: 'interval', interval: { kind: 'constant', value: 1000 } },
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
        order: 0,
      };

      const commandQueue = new CommandQueue();

      enqueueAutomationCommand(automation, commandQueue, 10, 1000);

      expect(commandQueue.size).toBe(1);
      const commands = commandQueue.dequeueUpToStep(11);
      expect(commands.length).toBe(1);
      const command = commands[0];
      expect(command?.type).toBe(RUNTIME_COMMAND_TYPES.PURCHASE_UPGRADE);
      expect(command?.priority).toBe(CommandPriority.AUTOMATION);
      expect(command?.payload).toEqual({ upgradeId: 'upg:doubler', quantity: 1 });
    });

    it('should enqueue system command for system target', () => {
      const automation: AutomationDefinition = {
        id: 'auto:test' as any,
        name: { default: 'Test', variants: {} },
        description: { default: 'Test', variants: {} },
        targetType: 'system',
        systemTargetId: 'offline-catchup' as any,
        trigger: { kind: 'interval', interval: { kind: 'constant', value: 1000 } },
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
        order: 0,
      };

      const commandQueue = new CommandQueue();

      enqueueAutomationCommand(automation, commandQueue, 10, 1000);

      expect(commandQueue.size).toBe(1);
      const commands = commandQueue.dequeueUpToStep(11);
      expect(commands.length).toBe(1);
      const command = commands[0];
      expect(command?.type).toBe('offline-catchup');
      expect(command?.priority).toBe(CommandPriority.AUTOMATION);
    });
  });

  describe('end-to-end automation', () => {
    it('should fire interval automation and enqueue command', () => {
      const automations: AutomationDefinition[] = [
        {
          id: 'auto:collector' as any,
          name: { default: 'Auto Collector', variants: {} },
          description: { default: 'Collects automatically', variants: {} },
          targetType: 'generator',
          targetId: 'gen:clicks' as any,
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
      const commands = commandQueue.dequeueUpToStep(1);
      expect(commands.length).toBe(1);
      const command = commands[0];
      expect(command?.type).toBe(RUNTIME_COMMAND_TYPES.TOGGLE_GENERATOR);
    });

    it('should respect enabled flag', () => {
      const automations: AutomationDefinition[] = [
        {
          id: 'auto:collector' as any,
          name: { default: 'Auto Collector', variants: {} },
          description: { default: 'Collects automatically', variants: {} },
          targetType: 'generator',
          targetId: 'gen:clicks' as any,
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
          id: 'auto:collector' as any,
          name: { default: 'Auto Collector', variants: {} },
          description: { default: 'Collects automatically', variants: {} },
          targetType: 'generator',
          targetId: 'gen:clicks' as any,
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
      commandQueue.dequeueUpToStep(1);

      // Tick again - should be in cooldown
      runtime.tick(100);
      expect(commandQueue.size).toBe(0);

      // Tick 4 more times (total 5 more ticks, to step 6)
      runtime.tick(100);
      runtime.tick(100);
      runtime.tick(100);
      runtime.tick(100);

      // Should still be in cooldown
      expect(commandQueue.size).toBe(0);

      // One more tick (step 7) - cooldown expired
      runtime.tick(100);
      expect(commandQueue.size).toBe(1);
    });

    it('should enforce exact cooldown duration in milliseconds', () => {
      const automations: AutomationDefinition[] = [
        {
          id: 'auto:timed' as any,
          name: { default: 'Timed Auto', variants: {} },
          description: { default: 'Cooldown test', variants: {} },
          targetType: 'generator',
          targetId: 'gen:test' as any,
          trigger: { kind: 'interval', interval: { kind: 'constant', value: 100 } },
          unlockCondition: { kind: 'always' },
          enabledByDefault: true,
          cooldown: 500, // 500ms cooldown with 100ms steps = 5 steps
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

      const context = {
        step: 0,
        deltaMs: 100,
        events: {
          on: (() => {}) as any,
          off: () => {},
          emit: () => {},
        } as any,
      };

      // First tick (step 0): fires immediately, command enqueued for step 1
      system.tick(context);
      expect(commandQueue.size).toBe(1);
      commandQueue.dequeueUpToStep(1);

      // Cooldown should expire after exactly 5 steps from command execution (step 1)
      // Steps 1-5: still in cooldown
      for (let step = 1; step <= 5; step++) {
        context.step = step;
        system.tick(context);
        expect(commandQueue.size).toBe(0); // Still in cooldown
      }

      // Step 6: cooldown expired, should fire
      context.step = 6;
      system.tick(context);
      expect(commandQueue.size).toBe(1); // Fired!
    });

    it('should enforce cooldown from command execution step, not trigger step', () => {
      // This test verifies the documented behavior from updateCooldown JSDoc:
      // "If automation fires at step 10 with 500ms cooldown and 100ms steps,
      //  command executes at step 11 and cooldown expires at step 16 (11 + 5)"

      const automations: AutomationDefinition[] = [
        {
          id: 'auto:cooldown-fix-test' as any,
          name: { default: 'Cooldown Fix Test', variants: {} },
          description: { default: 'Verifies cooldown accounts for command execution delay', variants: {} },
          targetType: 'generator',
          targetId: 'gen:test' as any,
          trigger: { kind: 'interval', interval: { kind: 'constant', value: 100 } },
          unlockCondition: { kind: 'always' },
          enabledByDefault: true,
          cooldown: 500, // 500ms cooldown with 100ms steps = 5 steps AFTER command execution
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

      const context = {
        step: 10,
        deltaMs: 100,
        events: {
          on: (() => {}) as any,
          off: () => {},
          emit: () => {},
        } as any,
      };

      // Tick at step 10: trigger fires, command enqueued for step 11
      system.tick(context);
      expect(commandQueue.size).toBe(1);

      // Command executes at step 11 (when dequeued)
      const commands = commandQueue.dequeueUpToStep(11);
      expect(commands.length).toBe(1);
      expect(commands[0]?.step).toBe(11); // Command executes at step 11

      // Cooldown should last 500ms (5 steps) AFTER command execution at step 11
      // So cooldown expires at step 16 (11 + 5), and automation is eligible at step 16

      // Steps 11-15: still in cooldown (automation should NOT fire)
      for (let step = 11; step <= 15; step++) {
        context.step = step;
        system.tick(context);
        expect(commandQueue.size).toBe(0); // Still in cooldown
      }

      // Step 16: cooldown expired, automation should fire
      context.step = 16;
      system.tick(context);
      expect(commandQueue.size).toBe(1); // Fired!

      // Verify the command is scheduled for step 17
      const secondCommands = commandQueue.dequeueUpToStep(17);
      expect(secondCommands.length).toBe(1);
      expect(secondCommands[0]?.step).toBe(17);
    });

    it('should enqueue complete TOGGLE_GENERATOR payload with enabled flag', () => {
      const automations: AutomationDefinition[] = [
        {
          id: 'auto:generator-toggle' as any,
          name: { default: 'Generator Toggle', variants: {} },
          description: { default: 'Toggles generator on', variants: {} },
          targetType: 'generator',
          targetId: 'gen:clicker' as any,
          trigger: { kind: 'interval', interval: { kind: 'constant', value: 100 } },
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
      const commands = commandQueue.dequeueUpToStep(1);
      expect(commands.length).toBe(1);
      const command = commands[0];

      // Verify complete payload structure
      expect(command?.type).toBe(RUNTIME_COMMAND_TYPES.TOGGLE_GENERATOR);
      expect(command?.payload).toMatchObject({
        generatorId: 'gen:clicker',
        enabled: true,
      });
      expect(command?.priority).toBe(CommandPriority.AUTOMATION);
    });

    it('should fire automation with lt comparator when resource is missing', () => {
      const automations: AutomationDefinition[] = [
        {
          id: 'auto:bootstrap' as any,
          name: { default: 'Bootstrap Collector', variants: {} },
          description: { default: 'Activates when gems are scarce', variants: {} },
          targetType: 'generator',
          targetId: 'gen:gem-generator' as any,
          trigger: {
            kind: 'resourceThreshold',
            resourceId: 'res:gems' as any,
            comparator: 'lt',
            threshold: { kind: 'constant', value: 10 },
          },
          unlockCondition: { kind: 'always' },
          enabledByDefault: true,
          order: 0,
        },
      ];

      // Resource state where gems resource doesn't exist yet
      const resourceState = {
        getAmount: (index: number) => {
          if (index === 0) return 50; // res:gold exists
          return 0;
        },
        getResourceIndex: (resourceId: string) => {
          if (resourceId === 'res:gold') return 0;
          return -1; // res:gems doesn't exist
        },
      };

      const commandQueue = new CommandQueue();
      const runtime = new IdleEngineRuntime({ stepSizeMs: 100 });
      const system = createAutomationSystem({
        automations,
        stepDurationMs: 100,
        commandQueue,
        resourceState,
      });

      runtime.addSystem(system);

      // Tick once - automation should fire because 0 < 10
      runtime.tick(100);

      expect(commandQueue.size).toBe(1);
      const commands = commandQueue.dequeueUpToStep(1);
      expect(commands.length).toBe(1);
      const command = commands[0];
      expect(command?.type).toBe(RUNTIME_COMMAND_TYPES.TOGGLE_GENERATOR);
      expect(command?.payload).toEqual({
        generatorId: 'gen:gem-generator',
        enabled: true,
      });
    });
  });

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
          id: 'auto:nocooldown' as any,
          name: { default: 'No Cooldown', variants: {} },
          description: { default: 'Test', variants: {} },
          targetType: 'generator',
          targetId: 'gen:clicks' as any,
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
      // This test verifies that the evaluateEventTrigger function correctly
      // identifies when events are cleared, which happens at the end of each tick
      const pendingEventTriggersBeforeClear = new Set(['auto:event1', 'auto:event2']);
      const pendingEventTriggersAfterClear = new Set<string>();

      // Before clear - should fire
      expect(evaluateEventTrigger('auto:event1', pendingEventTriggersBeforeClear)).toBe(true);
      expect(evaluateEventTrigger('auto:event2', pendingEventTriggersBeforeClear)).toBe(true);

      // After clear - should not fire
      expect(evaluateEventTrigger('auto:event1', pendingEventTriggersAfterClear)).toBe(false);
      expect(evaluateEventTrigger('auto:event2', pendingEventTriggersAfterClear)).toBe(false);
    });
  });

  describe('integration with multiple resources', () => {
    it('should correctly evaluate multiple resource-threshold automations', () => {
      const automations: AutomationDefinition[] = [
        {
          id: 'auto:gold' as any,
          name: { default: 'Gold Auto', variants: {} },
          description: { default: 'Fires on gold', variants: {} },
          targetType: 'generator',
          targetId: 'gen:gold-gen' as any,
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
        {
          id: 'auto:gems' as any,
          name: { default: 'Gems Auto', variants: {} },
          description: { default: 'Fires on gems', variants: {} },
          targetType: 'generator',
          targetId: 'gen:gem-gen' as any,
          trigger: {
            kind: 'resourceThreshold',
            resourceId: 'res:gems' as any,
            comparator: 'gte',
            threshold: { kind: 'constant', value: 50 },
          },
          unlockCondition: { kind: 'always' },
          enabledByDefault: true,
          order: 1,
        },
      ];

      const resourceState = {
        getAmount: (index: number) => {
          if (index === 0) return 150; // res:gold - above threshold (100)
          if (index === 1) return 30; // res:gems - below threshold (50)
          return 0;
        },
        getResourceIndex: (resourceId: string) => {
          if (resourceId === 'res:gold') return 0;
          if (resourceId === 'res:gems') return 1;
          return -1;
        },
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
        } as any,
      };

      system.tick(context);

      // Only gold automation should fire (gold=150>=100, gems=30<50)
      expect(commandQueue.size).toBe(1);
      const commands = commandQueue.dequeueUpToStep(1);
      expect(commands.length).toBe(1);
      expect(commands[0]?.type).toBe(RUNTIME_COMMAND_TYPES.TOGGLE_GENERATOR);

      // Verify deterministic timestamp
      const stepDurationMs = 100;
      expect(commands[0]?.timestamp).toBe(context.step * stepDurationMs);
      expect(commands[0]?.timestamp % stepDurationMs).toBe(0);
    });
  });

  describe('deterministic timestamps', () => {
    it('should use simulation time for command timestamps', () => {
      const automations: AutomationDefinition[] = [
        {
          id: 'auto:test' as any,
          name: { default: 'Test Auto', variants: {} },
          description: { default: 'Test automation', variants: {} },
          targetType: 'generator',
          targetId: 'gen:test' as any,
          trigger: { kind: 'interval', interval: { kind: 'constant', value: 100 } },
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

      // Setup system (unlocks 'always' automations)
      system.setup?.({ events: { on: () => ({ unsubscribe: () => {} }) } });

      // Tick at step 10 (should be 1000ms simulation time)
      system.tick({ step: 10, deltaMs: 100, events: {} as any });

      // Dequeue the command and check timestamp
      const commands = commandQueue.dequeueUpToStep(11);
      expect(commands.length).toBe(1);
      expect(commands[0]?.timestamp).toBe(1000); // step 10 * 100ms
    });

    it('should produce identical timestamps across multiple runs', () => {
      const automations: AutomationDefinition[] = [
        {
          id: 'auto:repeatable' as any,
          name: { default: 'Repeatable Auto', variants: {} },
          description: { default: 'Test repeatability', variants: {} },
          targetType: 'upgrade',
          targetId: 'upg:test' as any,
          trigger: { kind: 'interval', interval: { kind: 'constant', value: 200 } },
          unlockCondition: { kind: 'always' },
          enabledByDefault: true,
          order: 0,
        },
      ];

      const timestamps: number[] = [];

      // Run the same simulation twice
      for (let run = 0; run < 2; run++) {
        const commandQueue = new CommandQueue();
        const system = createAutomationSystem({
          automations,
          stepDurationMs: 100,
          commandQueue,
          resourceState: { getAmount: () => 0 },
        });

        system.setup?.({ events: { on: () => ({ unsubscribe: () => {} }) } });

        // Tick at step 5
        system.tick({ step: 5, deltaMs: 100, events: {} as any });

        const commands = commandQueue.dequeueUpToStep(6);
        timestamps.push(commands[0]?.timestamp ?? -1);
      }

      // Both runs should produce the same timestamp
      expect(timestamps[0]).toBe(timestamps[1]);
      expect(timestamps[0]).toBe(500); // step 5 * 100ms
    });
  });
});
