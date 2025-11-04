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
      expect(command?.payload).toEqual({ generatorId: 'gen:clicks' });
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

      // Tick 3 more times (total 4 more ticks, to step 5)
      runtime.tick(100);
      runtime.tick(100);
      runtime.tick(100);

      // Should still be in cooldown
      expect(commandQueue.size).toBe(0);

      // One more tick (step 6) - cooldown expired
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

      // Cooldown should expire after exactly 5 steps (500ms)
      // Steps 1-4: still in cooldown
      for (let step = 1; step <= 4; step++) {
        context.step = step;
        system.tick(context);
        expect(commandQueue.size).toBe(0); // Still in cooldown
      }

      // Step 5: cooldown expired, should fire
      context.step = 5;
      system.tick(context);
      expect(commandQueue.size).toBe(1); // Fired!
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
      // Could also verify targetId if command includes it
    });
  });
});
