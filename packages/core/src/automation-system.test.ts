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
        initialState,
      });

      const state = getAutomationState(system);
      const autoState = state.get('auto:collector');

      expect(autoState?.enabled).toBe(false);
      expect(autoState?.lastFiredStep).toBe(100);
      expect(autoState?.cooldownExpiresStep).toBe(110);
      expect(autoState?.unlocked).toBe(true);
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
});
