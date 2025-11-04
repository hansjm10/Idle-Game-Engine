/**
 * Unit tests for the automation system
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AutomationDefinition } from '@idle-engine/content-schema';
import {
  createAutomationSystem,
  type AutomationSystemOptions,
  type ConditionContext,
} from './automation-system.js';
import { CommandQueue } from './command-queue.js';
import { createResourceState, type ResourceState } from './resource-state.js';
import { CommandPriority, RUNTIME_COMMAND_TYPES } from './command.js';
import type { SystemRegistrationContext, TickContext } from './index.js';

// Helper to create test automation definitions without type issues
const createTestAutomation = (overrides: Partial<AutomationDefinition> & { id: string }): AutomationDefinition => ({
  name: { default: 'Test', variants: {} },
  description: { default: 'Test automation', variants: {} },
  targetType: 'generator',
  targetId: 'gen-1' as any,
  trigger: {
    kind: 'interval',
    interval: { kind: 'constant', value: 1000 },
  },
  unlockCondition: { kind: 'always' },
  enabledByDefault: true,
  ...overrides,
} as any);

describe('AutomationSystem', () => {
  let commandQueue: CommandQueue;
  let resourceState: ResourceState;
  let getGeneratorLevel: (id: string) => number;
  let getUpgradePurchases: (id: string) => number;
  let evaluateCondition: (
    condition: any,
    context: ConditionContext,
  ) => boolean;

  beforeEach(() => {
    commandQueue = new CommandQueue();
    resourceState = createResourceState([
      { id: 'energy', startAmount: 100, capacity: 1000 },
      { id: 'coins', startAmount: 50, capacity: 500 },
    ]);
    getGeneratorLevel = vi.fn(() => 1);
    getUpgradePurchases = vi.fn(() => 0);
    evaluateCondition = vi.fn(() => true);
  });

  const createOptions = (
    automations: readonly AutomationDefinition[],
    overrides?: Partial<AutomationSystemOptions>,
  ): AutomationSystemOptions => ({
    automations,
    commandQueue,
    resourceState,
    stepDurationMs: 100,
    evaluateCondition,
    getGeneratorLevel,
    getUpgradePurchases,
    ...overrides,
  });

  const createMockContext = (step: number = 0): TickContext => ({
    deltaMs: 100,
    step,
    events: {
      publish: vi.fn(),
    },
  });

  const createMockRegistrationContext = (): SystemRegistrationContext => {
    const handlers = new Map<string, ((payload: any) => void)[]>();
    return {
      events: {
        on: vi.fn((eventType: string, handler: any) => {
          if (!handlers.has(eventType)) {
            handlers.set(eventType, []);
          }
          handlers.get(eventType)!.push(handler);
          return {
            unsubscribe: vi.fn(),
          };
        }),
      },
    };
  };

  describe('Interval Trigger', () => {
    it('should fire immediately on first tick', () => {
      const automation = createTestAutomation({
        id: 'auto-1' as any,
      });

      const system = createAutomationSystem(createOptions([automation]));
      system.tick(createMockContext(0));

      expect(commandQueue.size).toBe(1);
      const commands = commandQueue.dequeueUpToStep(1);
      expect(commands[0]?.type).toBe(RUNTIME_COMMAND_TYPES.TOGGLE_GENERATOR);
      expect(commands[0]?.priority).toBe(CommandPriority.AUTOMATION);
    });

    it('should fire after interval has elapsed', () => {
      const automation = {
        id: 'auto-1',
        name: { en: 'Auto 1' },
        description: { en: 'Test automation' },
        targetType: 'generator',
        targetId: 'gen-1',
        trigger: {
          kind: 'interval',
          interval: { kind: 'constant', value: 500 }, // 5 steps at 100ms each
        },
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
      } as any;

      const system = createAutomationSystem(createOptions([automation]));

      // First tick - fires immediately
      system.tick(createMockContext(0));
      commandQueue.dequeueUpToStep(1);

      // Ticks 1-4 - should not fire
      for (let i = 1; i <= 4; i++) {
        system.tick(createMockContext(i));
        expect(commandQueue.size).toBe(0);
      }

      // Tick 5 - should fire (500ms have elapsed)
      system.tick(createMockContext(5));
      expect(commandQueue.size).toBe(1);
    });

    it('should not fire before interval has elapsed', () => {
      const automation = {
        id: 'auto-1',
        name: { en: 'Auto 1' },
        description: { en: 'Test automation' },
        targetType: 'generator',
        targetId: 'gen-1',
        trigger: {
          kind: 'interval',
          interval: { kind: 'constant', value: 1000 }, // 10 steps
        },
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
      } as any;

      const system = createAutomationSystem(createOptions([automation]));

      // First tick - fires immediately
      system.tick(createMockContext(0));
      commandQueue.dequeueUpToStep(1);

      // Tick 5 - should not fire yet (only 500ms)
      system.tick(createMockContext(5));
      expect(commandQueue.size).toBe(0);
    });
  });

  describe('Resource Threshold Trigger', () => {
    it('should fire when resource meets threshold (gte)', () => {
      const automation = {
        id: 'auto-1',
        name: { en: 'Auto 1' },
        description: { en: 'Test automation' },
        targetType: 'generator',
        targetId: 'gen-1',
        trigger: {
          kind: 'resourceThreshold',
          resourceId: 'energy',
          comparator: 'gte',
          threshold: { kind: 'constant', value: 100 },
        },
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
      } as any;

      const system = createAutomationSystem(createOptions([automation]));
      system.tick(createMockContext(0));

      expect(commandQueue.size).toBe(1);
    });

    it('should not fire when resource is below threshold (gte)', () => {
      const automation = {
        id: 'auto-1',
        name: { en: 'Auto 1' },
        description: { en: 'Test automation' },
        targetType: 'generator',
        targetId: 'gen-1',
        trigger: {
          kind: 'resourceThreshold',
          resourceId: 'energy',
          comparator: 'gte',
          threshold: { kind: 'constant', value: 200 },
        },
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
      } as any;

      const system = createAutomationSystem(createOptions([automation]));
      system.tick(createMockContext(0));

      expect(commandQueue.size).toBe(0);
    });

    it('should handle all comparators correctly', () => {
      const testCases: Array<{
        comparator: 'gte' | 'gt' | 'lte' | 'lt';
        threshold: number;
        resourceAmount: number;
        shouldFire: boolean;
      }> = [
        { comparator: 'gte', threshold: 100, resourceAmount: 100, shouldFire: true },
        { comparator: 'gte', threshold: 100, resourceAmount: 99, shouldFire: false },
        { comparator: 'gt', threshold: 100, resourceAmount: 101, shouldFire: true },
        { comparator: 'gt', threshold: 100, resourceAmount: 100, shouldFire: false },
        { comparator: 'lte', threshold: 100, resourceAmount: 100, shouldFire: true },
        { comparator: 'lte', threshold: 100, resourceAmount: 101, shouldFire: false },
        { comparator: 'lt', threshold: 100, resourceAmount: 99, shouldFire: true },
        { comparator: 'lt', threshold: 100, resourceAmount: 100, shouldFire: false },
      ];

      for (const testCase of testCases) {
        const state = createResourceState([
          { id: 'energy', startAmount: testCase.resourceAmount, capacity: 1000 },
        ]);

        const automation = {
          id: 'auto-1',
          name: { en: 'Auto 1' },
          description: { en: 'Test automation' },
          targetType: 'generator',
          targetId: 'gen-1',
          trigger: {
            kind: 'resourceThreshold',
            resourceId: 'energy',
            comparator: testCase.comparator,
            threshold: { kind: 'constant', value: testCase.threshold },
          },
          unlockCondition: { kind: 'always' },
          enabledByDefault: true,
      } as any;

        const queue = new CommandQueue();
        const system = createAutomationSystem(createOptions([automation], {
          commandQueue: queue,
          resourceState: state,
        }));
        system.tick(createMockContext(0));

        expect(queue.size).toBe(testCase.shouldFire ? 1 : 0);
      }
    });
  });

  describe('Command Queue Empty Trigger', () => {
    it('should fire when command queue is empty', () => {
      const automation = {
        id: 'auto-1',
        name: { en: 'Auto 1' },
        description: { en: 'Test automation' },
        targetType: 'generator',
        targetId: 'gen-1',
        trigger: {
          kind: 'commandQueueEmpty',
        },
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
      } as any;

      const system = createAutomationSystem(createOptions([automation]));
      system.tick(createMockContext(0));

      expect(commandQueue.size).toBe(1);
    });

    it('should not fire when command queue has commands', () => {
      // Add a command to the queue first
      commandQueue.enqueue({
        type: 'TEST_COMMAND',
        payload: {},
        priority: CommandPriority.PLAYER,
        timestamp: Date.now(),
        step: 0,
      });

      const automation = {
        id: 'auto-1',
        name: { en: 'Auto 1' },
        description: { en: 'Test automation' },
        targetType: 'generator',
        targetId: 'gen-1',
        trigger: {
          kind: 'commandQueueEmpty',
        },
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
      } as any;

      const system = createAutomationSystem(createOptions([automation]));
      system.tick(createMockContext(0));

      // Should still have only the original command
      expect(commandQueue.size).toBe(1);
    });
  });

  describe('Event Trigger', () => {
    it('should fire when event is received', () => {
      const automation = {
        id: 'auto-1',
        name: { en: 'Auto 1' },
        description: { en: 'Test automation' },
        targetType: 'generator',
        targetId: 'gen-1',
        trigger: {
          kind: 'event',
          eventId: 'test:event',
        },
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
      } as any;

      const system = createAutomationSystem(createOptions([automation]));
      const registrationContext = createMockRegistrationContext();
      system.setup?.(registrationContext);

      // Simulate event firing
      const eventHandler = (registrationContext.events.on as any).mock.calls.find(
        (call: any[]) => call[0] === 'test:event'
      )?.[1];
      eventHandler?.({});

      system.tick(createMockContext(0));

      expect(commandQueue.size).toBe(1);
    });

    it('should not fire when event is not received', () => {
      const automation = {
        id: 'auto-1',
        name: { en: 'Auto 1' },
        description: { en: 'Test automation' },
        targetType: 'generator',
        targetId: 'gen-1',
        trigger: {
          kind: 'event',
          eventId: 'test:event',
        },
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
      } as any;

      const system = createAutomationSystem(createOptions([automation]));
      const registrationContext = createMockRegistrationContext();
      system.setup?.(registrationContext);

      system.tick(createMockContext(0));

      expect(commandQueue.size).toBe(0);
    });

    it('should clear event triggers after tick', () => {
      const automation = {
        id: 'auto-1',
        name: { en: 'Auto 1' },
        description: { en: 'Test automation' },
        targetType: 'generator',
        targetId: 'gen-1',
        trigger: {
          kind: 'event',
          eventId: 'test:event',
        },
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
      } as any;

      const system = createAutomationSystem(createOptions([automation]));
      const registrationContext = createMockRegistrationContext();
      system.setup?.(registrationContext);

      // Simulate event firing
      const eventHandler = (registrationContext.events.on as any).mock.calls.find(
        (call: any[]) => call[0] === 'test:event'
      )?.[1];
      eventHandler?.({});

      // First tick - should fire
      system.tick(createMockContext(0));
      expect(commandQueue.size).toBe(1);
      commandQueue.dequeueUpToStep(1);

      // Second tick without event - should not fire
      system.tick(createMockContext(1));
      expect(commandQueue.size).toBe(0);
    });
  });

  describe('Cooldown Management', () => {
    it('should respect cooldown period', () => {
      const automation = {
        id: 'auto-1',
        name: { en: 'Auto 1' },
        description: { en: 'Test automation' },
        targetType: 'generator',
        targetId: 'gen-1',
        trigger: {
          kind: 'interval',
          interval: { kind: 'constant', value: 100 },
        },
        cooldown: 500, // 5 steps
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
      } as any;

      const system = createAutomationSystem(createOptions([automation]));

      // First tick - fires immediately
      system.tick(createMockContext(0));
      expect(commandQueue.size).toBe(1);
      commandQueue.dequeueUpToStep(1);

      // Ticks 1-4 - cooldown active
      for (let i = 1; i <= 4; i++) {
        system.tick(createMockContext(i));
        expect(commandQueue.size).toBe(0);
      }

      // Tick 5 - cooldown expired, should fire
      system.tick(createMockContext(5));
      expect(commandQueue.size).toBe(1);
    });
  });

  describe('Resource Cost', () => {
    it('should deduct resource cost when automation fires', () => {
      const automation = {
        id: 'auto-1',
        name: { en: 'Auto 1' },
        description: { en: 'Test automation' },
        targetType: 'generator',
        targetId: 'gen-1',
        trigger: {
          kind: 'interval',
          interval: { kind: 'constant', value: 100 },
        },
        resourceCost: {
          resourceId: 'energy',
          rate: { kind: 'constant', value: 10 },
        },
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
      } as any;

      const system = createAutomationSystem(createOptions([automation]));
      const energyIndex = resourceState.requireIndex('energy');
      const initialAmount = resourceState.getAmount(energyIndex);

      system.tick(createMockContext(0));

      const finalAmount = resourceState.getAmount(energyIndex);
      expect(finalAmount).toBe(initialAmount - 10);
      expect(commandQueue.size).toBe(1);
    });

    it('should not fire when insufficient resources', () => {
      const automation = {
        id: 'auto-1',
        name: { en: 'Auto 1' },
        description: { en: 'Test automation' },
        targetType: 'generator',
        targetId: 'gen-1',
        trigger: {
          kind: 'interval',
          interval: { kind: 'constant', value: 100 },
        },
        resourceCost: {
          resourceId: 'energy',
          rate: { kind: 'constant', value: 200 }, // More than available
        },
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
      } as any;

      const system = createAutomationSystem(createOptions([automation]));
      system.tick(createMockContext(0));

      expect(commandQueue.size).toBe(0);
    });
  });

  describe('Unlock Conditions', () => {
    it('should not fire when automation is locked', () => {
      evaluateCondition = vi.fn(() => false);

      const automation = {
        id: 'auto-1',
        name: { en: 'Auto 1' },
        description: { en: 'Test automation' },
        targetType: 'generator',
        targetId: 'gen-1',
        trigger: {
          kind: 'interval',
          interval: { kind: 'constant', value: 100 },
        },
        unlockCondition: { kind: 'resourceThreshold', resourceId: 'energy', comparator: 'gte', threshold: { kind: 'constant', value: 1000 } },
        enabledByDefault: true,
      } as any;

      const system = createAutomationSystem(createOptions([automation]));
      system.tick(createMockContext(0));

      expect(commandQueue.size).toBe(0);
    });

    it('should fire when automation unlocks', () => {
      let isUnlocked = false;
      evaluateCondition = vi.fn(() => isUnlocked);

      const automation = {
        id: 'auto-1',
        name: { en: 'Auto 1' },
        description: { en: 'Test automation' },
        targetType: 'generator',
        targetId: 'gen-1',
        trigger: {
          kind: 'interval',
          interval: { kind: 'constant', value: 100 },
        },
        unlockCondition: { kind: 'resourceThreshold', resourceId: 'energy', comparator: 'gte', threshold: { kind: 'constant', value: 1000 } },
        enabledByDefault: true,
      } as any;

      const system = createAutomationSystem(createOptions([automation]));

      // First tick - locked
      system.tick(createMockContext(0));
      expect(commandQueue.size).toBe(0);

      // Unlock
      isUnlocked = true;

      // Second tick - unlocked, should fire
      system.tick(createMockContext(1));
      expect(commandQueue.size).toBe(1);
    });
  });

  describe('Enable/Disable State', () => {
    it('should not fire when automation is disabled', () => {
      const automation = {
        id: 'auto-1',
        name: { en: 'Auto 1' },
        description: { en: 'Test automation' },
        targetType: 'generator',
        targetId: 'gen-1',
        trigger: {
          kind: 'interval',
          interval: { kind: 'constant', value: 100 },
        },
        unlockCondition: { kind: 'always' },
        enabledByDefault: false,
      } as any;

      const system = createAutomationSystem(createOptions([automation]));
      system.tick(createMockContext(0));

      expect(commandQueue.size).toBe(0);
    });

    it('should respond to automation:toggled events', () => {
      const automation = {
        id: 'auto-1',
        name: { en: 'Auto 1' },
        description: { en: 'Test automation' },
        targetType: 'generator',
        targetId: 'gen-1',
        trigger: {
          kind: 'interval',
          interval: { kind: 'constant', value: 100 },
        },
        unlockCondition: { kind: 'always' },
        enabledByDefault: false,
      } as any;

      const system = createAutomationSystem(createOptions([automation]));
      const registrationContext = createMockRegistrationContext();
      system.setup?.(registrationContext);

      // Should not fire when disabled
      system.tick(createMockContext(0));
      expect(commandQueue.size).toBe(0);

      // Enable via event
      const eventHandler = (registrationContext.events.on as any).mock.calls.find(
        (call: any[]) => call[0] === 'automation:toggled'
      )?.[1];
      eventHandler?.({ automationId: 'auto-1', enabled: true });

      // Should fire when enabled
      system.tick(createMockContext(1));
      expect(commandQueue.size).toBe(1);
    });
  });

  describe('Command Enqueueing', () => {
    it('should enqueue TOGGLE_GENERATOR command for generator targets', () => {
      const automation = {
        id: 'auto-1',
        name: { en: 'Auto 1' },
        description: { en: 'Test automation' },
        targetType: 'generator',
        targetId: 'gen-1',
        trigger: {
          kind: 'interval',
          interval: { kind: 'constant', value: 100 },
        },
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
      } as any;

      const system = createAutomationSystem(createOptions([automation]));
      system.tick(createMockContext(0));

      const commands = commandQueue.dequeueUpToStep(1);
      expect(commands[0]?.type).toBe(RUNTIME_COMMAND_TYPES.TOGGLE_GENERATOR);
      expect((commands[0]?.payload as any).generatorId).toBe('gen-1');
    });

    it('should enqueue PURCHASE_UPGRADE command for upgrade targets', () => {
      const automation = {
        id: 'auto-1',
        name: { en: 'Auto 1' },
        description: { en: 'Test automation' },
        targetType: 'upgrade',
        targetId: 'upgrade-1',
        trigger: {
          kind: 'interval',
          interval: { kind: 'constant', value: 100 },
        },
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
      } as any;

      const system = createAutomationSystem(createOptions([automation]));
      system.tick(createMockContext(0));

      const commands = commandQueue.dequeueUpToStep(1);
      expect(commands[0]?.type).toBe(RUNTIME_COMMAND_TYPES.PURCHASE_UPGRADE);
      expect((commands[0]?.payload as any).upgradeId).toBe('upgrade-1');
    });

    it('should enqueue commands with AUTOMATION priority', () => {
      const automation = {
        id: 'auto-1',
        name: { en: 'Auto 1' },
        description: { en: 'Test automation' },
        targetType: 'generator',
        targetId: 'gen-1',
        trigger: {
          kind: 'interval',
          interval: { kind: 'constant', value: 100 },
        },
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
      } as any;

      const system = createAutomationSystem(createOptions([automation]));
      system.tick(createMockContext(0));

      const commands = commandQueue.dequeueUpToStep(1);
      expect(commands[0]?.priority).toBe(CommandPriority.AUTOMATION);
    });

    it('should enqueue commands for next step', () => {
      const automation = {
        id: 'auto-1',
        name: { en: 'Auto 1' },
        description: { en: 'Test automation' },
        targetType: 'generator',
        targetId: 'gen-1',
        trigger: {
          kind: 'interval',
          interval: { kind: 'constant', value: 100 },
        },
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
      } as any;

      const system = createAutomationSystem(createOptions([automation]));
      system.tick(createMockContext(5));

      const commands = commandQueue.dequeueUpToStep(6);
      expect(commands[0]?.step).toBe(6);
    });
  });

  describe('State Persistence', () => {
    it('should restore automation state from initialState', () => {
      const automation = {
        id: 'auto-1',
        name: { en: 'Auto 1' },
        description: { en: 'Test automation' },
        targetType: 'generator',
        targetId: 'gen-1',
        trigger: {
          kind: 'interval',
          interval: { kind: 'constant', value: 100 },
        },
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
      } as any;

      const initialState = {
        automations: {
          'auto-1': {
            id: 'auto-1',
            enabled: false,
            lastFiredStep: 10,
            cooldownExpiresStep: 15,
            unlocked: true,
          },
        },
      };

      const system = createAutomationSystem(createOptions([automation], { initialState }));

      // Should not fire because it's disabled
      system.tick(createMockContext(0));
      expect(commandQueue.size).toBe(0);
    });
  });
});
