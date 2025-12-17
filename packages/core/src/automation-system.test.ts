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
import type { AutomationState, SerializedAutomationState } from './automation-system.js';
import { CommandQueue } from './command-queue.js';
import { CommandPriority, RUNTIME_COMMAND_TYPES } from './command.js';
import { IdleEngineRuntime } from './index.js';
import { CommandDispatcher } from './command-dispatcher.js';
import {
  registerResourceCommandHandlers,
  type UpgradePurchaseEvaluator,
  type UpgradePurchaseQuote,
} from './resource-command-handlers.js';
import { createResourceState } from './resource-state.js';
import { createResourceStateAdapter } from './automation-resource-state-adapter.js';

describe('AutomationSystem', () => {
  const stepDurationMs = 100;
  const noopEventPublisher = {
    publish: () => ({ accepted: true } as any),
  } as any;

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
          trigger: { kind: 'interval', interval: { kind: 'constant', value: 100 } },
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
        events: noopEventPublisher,
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
        events: noopEventPublisher,
      });

      const stateAfterTick = getAutomationState(system);
      expect(stateAfterTick.get('auto:basic')?.unlocked).toBe(true);

      // Should remain unlocked on subsequent ticks
      system.tick({
        step: 1,
        deltaMs: 100,
        events: noopEventPublisher,
      });
      const stateAfterSecondTick = getAutomationState(system);
      expect(stateAfterSecondTick.get('auto:basic')?.unlocked).toBe(true);
    });

    it('should evaluate unlockCondition using conditionContext (monotonic)', () => {
      let gold = 0;
      let clicksLevel = 0;
      let autoUpgradePurchases = 0;
      let blockerUpgradePurchases = 0;
      let prestigeLayerUnlocked = false;

      const conditionContext = {
        getResourceAmount: (resourceId: string) => (resourceId === 'res:gold' ? gold : 0),
        getGeneratorLevel: (generatorId: string) =>
          generatorId === 'gen:clicks' ? clicksLevel : 0,
        getUpgradePurchases: (upgradeId: string) => {
          if (upgradeId === 'upg:auto') return autoUpgradePurchases;
          if (upgradeId === 'upg:blocker') return blockerUpgradePurchases;
          return 0;
        },
        hasPrestigeLayerUnlocked: (prestigeLayerId: string) =>
          prestigeLayerId === 'prestige:layer-1' ? prestigeLayerUnlocked : false,
      };

      const automations: AutomationDefinition[] = [
        {
          id: 'auto:gold' as any,
          name: { default: 'Auto Gold', variants: {} },
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
          enabledByDefault: false,
          order: 0,
        },
        {
          id: 'auto:gen' as any,
          name: { default: 'Auto Gen', variants: {} },
          description: { default: 'Unlocked by generator level', variants: {} },
          targetType: 'generator',
          targetId: 'gen:clicks' as any,
          trigger: { kind: 'interval', interval: { kind: 'constant', value: 1000 } },
          unlockCondition: {
            kind: 'generatorLevel',
            generatorId: 'gen:clicks' as any,
            comparator: 'gte',
            level: { kind: 'constant', value: 10 },
          },
          enabledByDefault: false,
          order: 0,
        },
        {
          id: 'auto:upgrade' as any,
          name: { default: 'Auto Upgrade', variants: {} },
          description: { default: 'Unlocked by upgrade purchases', variants: {} },
          targetType: 'upgrade',
          targetId: 'upg:auto' as any,
          trigger: { kind: 'interval', interval: { kind: 'constant', value: 1000 } },
          unlockCondition: {
            kind: 'upgradeOwned',
            upgradeId: 'upg:auto' as any,
            requiredPurchases: 2,
          },
          enabledByDefault: false,
          order: 0,
        },
        {
          id: 'auto:prestige' as any,
          name: { default: 'Auto Prestige', variants: {} },
          description: { default: 'Unlocked by prestige', variants: {} },
          targetType: 'system',
          targetId: 'sys:noop' as any,
          systemTargetId: 'sys:noop' as any,
          trigger: { kind: 'interval', interval: { kind: 'constant', value: 1000 } },
          unlockCondition: {
            kind: 'prestigeUnlocked',
            prestigeLayerId: 'prestige:layer-1' as any,
          },
          enabledByDefault: false,
          order: 0,
        },
        {
          id: 'auto:nested' as any,
          name: { default: 'Auto Nested', variants: {} },
          description: { default: 'Unlocked by nested conditions', variants: {} },
          targetType: 'system',
          targetId: 'sys:noop' as any,
          systemTargetId: 'sys:noop' as any,
          trigger: { kind: 'interval', interval: { kind: 'constant', value: 1000 } },
          unlockCondition: {
            kind: 'allOf',
            conditions: [
              {
                kind: 'resourceThreshold',
                resourceId: 'res:gold' as any,
                comparator: 'gte',
                amount: { kind: 'constant', value: 100 },
              },
              {
                kind: 'anyOf',
                conditions: [
                  {
                    kind: 'generatorLevel',
                    generatorId: 'gen:clicks' as any,
                    comparator: 'gte',
                    level: { kind: 'constant', value: 10 },
                  },
                  {
                    kind: 'prestigeUnlocked',
                    prestigeLayerId: 'prestige:layer-1' as any,
                  },
                ],
              },
              {
                kind: 'not',
                condition: {
                  kind: 'upgradeOwned',
                  upgradeId: 'upg:blocker' as any,
                  requiredPurchases: 1,
                },
              },
            ],
          },
          enabledByDefault: false,
          order: 0,
        },
      ];

      const system = createAutomationSystem({
        automations,
        stepDurationMs,
        commandQueue: new CommandQueue(),
        resourceState: { getAmount: () => 0 },
        conditionContext,
      });

      system.tick({
        step: 0,
        deltaMs: 100,
        events: noopEventPublisher,
      });

      expect(getAutomationState(system).get('auto:gold')?.unlocked).toBe(false);
      expect(getAutomationState(system).get('auto:gen')?.unlocked).toBe(false);
      expect(getAutomationState(system).get('auto:upgrade')?.unlocked).toBe(false);
      expect(getAutomationState(system).get('auto:prestige')?.unlocked).toBe(false);
      expect(getAutomationState(system).get('auto:nested')?.unlocked).toBe(false);

      gold = 100;
      system.tick({
        step: 1,
        deltaMs: 100,
        events: noopEventPublisher,
      });
      expect(getAutomationState(system).get('auto:gold')?.unlocked).toBe(true);
      expect(getAutomationState(system).get('auto:nested')?.unlocked).toBe(false);

      clicksLevel = 10;
      system.tick({
        step: 2,
        deltaMs: 100,
        events: noopEventPublisher,
      });
      expect(getAutomationState(system).get('auto:gen')?.unlocked).toBe(true);
      expect(getAutomationState(system).get('auto:nested')?.unlocked).toBe(true);

      blockerUpgradePurchases = 1;
      autoUpgradePurchases = 2;
      system.tick({
        step: 3,
        deltaMs: 100,
        events: noopEventPublisher,
      });
      expect(getAutomationState(system).get('auto:nested')?.unlocked).toBe(true);
      expect(getAutomationState(system).get('auto:upgrade')?.unlocked).toBe(true);

      prestigeLayerUnlocked = true;
      system.tick({
        step: 4,
        deltaMs: 100,
        events: noopEventPublisher,
      });
      expect(getAutomationState(system).get('auto:prestige')?.unlocked).toBe(true);

      gold = 0;
      clicksLevel = 0;
      autoUpgradePurchases = 0;
      prestigeLayerUnlocked = false;
      system.tick({
        step: 5,
        deltaMs: 100,
        events: noopEventPublisher,
      });
      expect(getAutomationState(system).get('auto:gold')?.unlocked).toBe(true);
      expect(getAutomationState(system).get('auto:gen')?.unlocked).toBe(true);
      expect(getAutomationState(system).get('auto:upgrade')?.unlocked).toBe(true);
      expect(getAutomationState(system).get('auto:prestige')?.unlocked).toBe(true);
      expect(getAutomationState(system).get('auto:nested')?.unlocked).toBe(true);
    });
  });

  describe('restoreState behavior', () => {
    it('merges provided entries and preserves defaults for others', () => {
      const automations: AutomationDefinition[] = [
        {
          id: 'auto:a' as any,
          name: { default: 'A', variants: {} },
          description: { default: 'A desc', variants: {} },
          targetType: 'generator',
          targetId: 'gen:a' as any,
          trigger: { kind: 'interval', interval: { kind: 'constant', value: 1000 } },
          unlockCondition: { kind: 'always' },
          enabledByDefault: true,
          order: 0,
        },
        {
          id: 'auto:b' as any,
          name: { default: 'B', variants: {} },
          description: { default: 'B desc', variants: {} },
          targetType: 'generator',
          targetId: 'gen:b' as any,
          trigger: { kind: 'interval', interval: { kind: 'constant', value: 1000 } },
          unlockCondition: { kind: 'always' },
          enabledByDefault: true,
          order: 1,
        },
      ];

      const system = createAutomationSystem({
        automations,
        stepDurationMs,
        commandQueue: new CommandQueue(),
        resourceState: { getAmount: () => 0 },
      });

      // Merge a partial restore for only auto:a
      system.restoreState([{
        id: 'auto:a',
        enabled: false,
        lastFiredStep: 5,
        cooldownExpiresStep: 0,
        unlocked: true,
      }]);

      const state = getAutomationState(system);
      const a = state.get('auto:a');
      const b = state.get('auto:b');

      expect(a).toBeDefined();
      expect(a?.enabled).toBe(false);
      expect(a?.lastFiredStep).toBe(5);
      expect(a?.unlocked).toBe(true);

      // auto:b should still exist with default values (not cleared)
      expect(b).toBeDefined();
      expect(b?.enabled).toBe(true);
      expect(b?.lastFiredStep).toBe(-Infinity);
      expect(b?.unlocked).toBe(false);
    });

    it('skips restoration when provided array is empty', () => {
      const automations: AutomationDefinition[] = [
        {
          id: 'auto:only' as any,
          name: { default: 'Only', variants: {} },
          description: { default: 'Only desc', variants: {} },
          targetType: 'generator',
          targetId: 'gen:only' as any,
          trigger: { kind: 'interval', interval: { kind: 'constant', value: 1000 } },
          unlockCondition: { kind: 'always' },
          enabledByDefault: true,
          order: 0,
        },
      ];

      const system = createAutomationSystem({
        automations,
        stepDurationMs,
        commandQueue: new CommandQueue(),
        resourceState: { getAmount: () => 0 },
      });

      const before = getAutomationState(system).get('auto:only');
      expect(before).toBeDefined();

      system.restoreState([]);

      const after = getAutomationState(system).get('auto:only');
      expect(after).toBeDefined();
      // Ensure nothing toggled off due to empty restore
      expect(after?.enabled).toBe(before?.enabled);
      expect(after?.lastFiredStep).toBe(before?.lastFiredStep);
      expect(after?.unlocked).toBe(before?.unlocked);
    });

    it('normalizes non-finite lastFiredStep to -Infinity on restore', () => {
      const automations: AutomationDefinition[] = [
        {
          id: 'auto:only' as any,
          name: { default: 'Only', variants: {} },
          description: { default: 'Only desc', variants: {} },
          targetType: 'generator',
          targetId: 'gen:only' as any,
          trigger: { kind: 'interval', interval: { kind: 'constant', value: 1000 } },
          unlockCondition: { kind: 'always' },
          enabledByDefault: true,
          order: 0,
        },
      ];

      const system = createAutomationSystem({
        automations,
        stepDurationMs,
        commandQueue: new CommandQueue(),
        resourceState: { getAmount: () => 0 },
      });

      // Simulate a JSON round-trip where -Infinity becomes null
      system.restoreState([
        {
          id: 'auto:only',
          enabled: true,
          lastFiredStep: null,
          cooldownExpiresStep: 0,
          unlocked: false,
        } satisfies SerializedAutomationState,
      ]);

      const after = getAutomationState(system).get('auto:only');
      expect(after?.lastFiredStep).toBe(-Infinity);
    });

    it('rebases step fields when savedWorkerStep is provided', () => {
      const automations: AutomationDefinition[] = [
        {
          id: 'auto:interval' as any,
          name: { default: 'Interval', variants: {} },
          description: { default: 'Interval desc', variants: {} },
          targetType: 'generator',
          targetId: 'gen:x' as any,
          trigger: { kind: 'interval', interval: { kind: 'constant', value: 1000 } },
          unlockCondition: { kind: 'always' },
          enabledByDefault: true,
          order: 0,
        },
      ];

      const system = createAutomationSystem({
        automations,
        stepDurationMs,
        commandQueue: new CommandQueue(),
        resourceState: { getAmount: () => 0 },
      });

      // Simulate a snapshot captured at workerStep=100
      system.restoreState([
        {
          id: 'auto:interval',
          enabled: true,
          lastFiredStep: 100,
          cooldownExpiresStep: 115,
          unlocked: true,
        },
      ], { savedWorkerStep: 100, currentStep: 0 });

      const rebased = getAutomationState(system).get('auto:interval');
      expect(rebased).toBeDefined();
      // lastFiredStep rebased to 0, cooldownExpiresStep rebased to 15
      expect(rebased?.lastFiredStep).toBe(0);
      expect(rebased?.cooldownExpiresStep).toBe(15);

      // Ensure -Infinity remains -Infinity when rebased
      // Use null to represent -Infinity in serialized format
      system.restoreState([
        {
          id: 'auto:interval',
          enabled: true,
          lastFiredStep: null,
          cooldownExpiresStep: 50,
          unlocked: true,
        } satisfies SerializedAutomationState,
      ], { savedWorkerStep: 25, currentStep: 0 });

      const rebased2 = getAutomationState(system).get('auto:interval');
      expect(rebased2?.lastFiredStep).toBe(-Infinity);
      // 50 - 25 => 25
      expect(rebased2?.cooldownExpiresStep).toBe(25);
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
          cooldown: 300, // 3 steps
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
        cooldown: 500, // 5 steps @ 100ms/step
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
        cooldown: 800, // 8 steps @ 100ms/step
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

    it('should enqueue TOGGLE_GENERATOR command with enabled false when targetEnabled is false', () => {
      const automation: AutomationDefinition = {
        id: 'auto:test' as any,
        name: { default: 'Test', variants: {} },
        description: { default: 'Test', variants: {} },
        targetType: 'generator',
        targetId: 'gen:clicks' as any,
        targetEnabled: false,
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
        enabled: false,
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
      expect(command?.payload).toEqual({ upgradeId: 'upg:doubler' });
    });

    it('should enqueue PURCHASE_GENERATOR command for purchaseGenerator target', () => {
      const automation: AutomationDefinition = {
        id: 'auto:test' as any,
        name: { default: 'Test', variants: {} },
        description: { default: 'Test', variants: {} },
        targetType: 'purchaseGenerator',
        targetId: 'gen:clicks' as any,
        targetCount: { kind: 'constant', value: 3 },
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
      expect(command?.type).toBe(RUNTIME_COMMAND_TYPES.PURCHASE_GENERATOR);
      expect(command?.priority).toBe(CommandPriority.AUTOMATION);
      expect(command?.payload).toEqual({
        generatorId: 'gen:clicks',
        count: 3,
      });
    });

    it('should enqueue COLLECT_RESOURCE command for collectResource target', () => {
      const automation: AutomationDefinition = {
        id: 'auto:test' as any,
        name: { default: 'Test', variants: {} },
        description: { default: 'Test', variants: {} },
        targetType: 'collectResource',
        targetId: 'res:gold' as any,
        targetAmount: { kind: 'constant', value: 2 },
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
      expect(command?.type).toBe(RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE);
      expect(command?.priority).toBe(CommandPriority.AUTOMATION);
      expect(command?.payload).toEqual({
        resourceId: 'res:gold',
        amount: 2,
      });
    });

    it('should enqueue system command with mapped command type', () => {
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
      // Updated expectation: should be OFFLINE_CATCHUP not offline-catchup
      expect(command?.type).toBe(RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP);
      expect(command?.priority).toBe(CommandPriority.AUTOMATION);
      expect(command?.payload).toEqual({});
    });

    it('should throw when system target is not in mapping', () => {
      const automation: AutomationDefinition = {
        id: 'auto:bad' as any,
        name: { default: 'Bad', variants: {} },
        description: { default: 'Bad', variants: {} },
        targetType: 'system',
        systemTargetId: 'nonexistent-target' as any,
        trigger: { kind: 'interval', interval: { kind: 'constant', value: 1000 } },
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
        order: 0,
      };

      const commandQueue = new CommandQueue();

      expect(() =>
        enqueueAutomationCommand(automation, commandQueue, 10, 1000),
      ).toThrow(/unknown system automation target/i);
      expect(() =>
        enqueueAutomationCommand(automation, commandQueue, 10, 1000),
      ).toThrow('nonexistent-target');
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

    it('should evaluate targetCount formulas against entities when enqueuing commands', () => {
      const gold = 2.2;
      const clicksLevel = 3;
      const upgradePurchases = 4;

      const conditionContext = {
        getResourceAmount: (resourceId: string) =>
          resourceId === 'res:gold' ? gold : 0,
        getGeneratorLevel: (generatorId: string) =>
          generatorId === 'gen:clicks' ? clicksLevel : 0,
        getUpgradePurchases: (upgradeId: string) =>
          upgradeId === 'upg:auto' ? upgradePurchases : 0,
      };

      const automations: AutomationDefinition[] = [
        {
          id: 'auto:buyer' as any,
          name: { default: 'Auto Buyer', variants: {} },
          description: { default: 'Buys based on formulas', variants: {} },
          targetType: 'purchaseGenerator',
          targetId: 'gen:clicks' as any,
          targetCount: {
            kind: 'expression',
            expression: {
              kind: 'binary',
              op: 'add',
              left: {
                kind: 'binary',
                op: 'add',
                left: { kind: 'ref', target: { type: 'resource', id: 'res:gold' as any } },
                right: { kind: 'ref', target: { type: 'generator', id: 'gen:clicks' as any } },
              },
              right: {
                kind: 'binary',
                op: 'add',
                left: { kind: 'ref', target: { type: 'upgrade', id: 'upg:auto' as any } },
                right: { kind: 'ref', target: { type: 'automation', id: 'auto:buyer' as any } },
              },
            },
          },
          trigger: { kind: 'interval', interval: { kind: 'constant', value: 1000 } },
          unlockCondition: { kind: 'always' },
          enabledByDefault: true,
          order: 0,
        },
      ];

      const commandQueue = new CommandQueue();
      const runtime = new IdleEngineRuntime({ stepSizeMs: stepDurationMs });
      const system = createAutomationSystem({
        automations,
        stepDurationMs,
        commandQueue,
        resourceState: { getAmount: () => 0 },
        conditionContext,
      });

      runtime.addSystem(system);
      runtime.tick(stepDurationMs);

      const commands = commandQueue.dequeueUpToStep(1);
      expect(commands.length).toBe(1);
      expect(commands[0]?.type).toBe(RUNTIME_COMMAND_TYPES.PURCHASE_GENERATOR);
      expect(commands[0]?.payload).toEqual({
        generatorId: 'gen:clicks',
        count: 9, // floor(2.2 + 3 + 4 + 0)
      });
    });

    it('should floor targetCount to 1 when formula evaluates to 0.5', () => {
      const automations: AutomationDefinition[] = [
        {
          id: 'auto:buyer' as any,
          name: { default: 'Auto Buyer', variants: {} },
          description: { default: 'Buys fractional', variants: {} },
          targetType: 'purchaseGenerator',
          targetId: 'gen:clicks' as any,
          targetCount: { kind: 'constant', value: 0.5 },
          trigger: { kind: 'interval', interval: { kind: 'constant', value: 1000 } },
          unlockCondition: { kind: 'always' },
          enabledByDefault: true,
          order: 0,
        },
      ];

      const commandQueue = new CommandQueue();
      const runtime = new IdleEngineRuntime({ stepSizeMs: stepDurationMs });
      const system = createAutomationSystem({
        automations,
        stepDurationMs,
        commandQueue,
        resourceState: { getAmount: () => 0 },
      });

      runtime.addSystem(system);
      runtime.tick(stepDurationMs);

      const commands = commandQueue.dequeueUpToStep(1);
      expect(commands.length).toBe(1);
      expect(commands[0]?.type).toBe(RUNTIME_COMMAND_TYPES.PURCHASE_GENERATOR);
      expect(commands[0]?.payload).toEqual({
        generatorId: 'gen:clicks',
        count: 1, // floor(0.5) = 0, clamped to min 1
      });
    });

    it('should clamp targetAmount to 0 when formula evaluates to -5', () => {
      const automations: AutomationDefinition[] = [
        {
          id: 'auto:collector' as any,
          name: { default: 'Auto Collector', variants: {} },
          description: { default: 'Collects negative', variants: {} },
          targetType: 'collectResource',
          targetId: 'res:gold' as any,
          targetAmount: { kind: 'constant', value: -5 },
          trigger: { kind: 'interval', interval: { kind: 'constant', value: 1000 } },
          unlockCondition: { kind: 'always' },
          enabledByDefault: true,
          order: 0,
        },
      ];

      const commandQueue = new CommandQueue();
      const runtime = new IdleEngineRuntime({ stepSizeMs: stepDurationMs });
      const system = createAutomationSystem({
        automations,
        stepDurationMs,
        commandQueue,
        resourceState: { getAmount: () => 0 },
      });

      runtime.addSystem(system);
      runtime.tick(stepDurationMs);

      const commands = commandQueue.dequeueUpToStep(1);
      expect(commands.length).toBe(1);
      expect(commands[0]?.type).toBe(RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE);
      expect(commands[0]?.payload).toEqual({
        resourceId: 'res:gold',
        amount: 0, // negative clamped to 0
      });
    });

    it('should evaluate targetAmount formulas against entities', () => {
      const gold = 1.5;
      const clicksLevel = 2;
      const upgradePurchases = 3;

      const conditionContext = {
        getResourceAmount: (resourceId: string) =>
          resourceId === 'res:gold' ? gold : 0,
        getGeneratorLevel: (generatorId: string) =>
          generatorId === 'gen:clicks' ? clicksLevel : 0,
        getUpgradePurchases: (upgradeId: string) =>
          upgradeId === 'upg:auto' ? upgradePurchases : 0,
      };

      const automations: AutomationDefinition[] = [
        {
          id: 'auto:collector' as any,
          name: { default: 'Auto Collector', variants: {} },
          description: { default: 'Collects based on formulas', variants: {} },
          targetType: 'collectResource',
          targetId: 'res:gold' as any,
          targetAmount: {
            kind: 'expression',
            expression: {
              kind: 'binary',
              op: 'add',
              left: {
                kind: 'binary',
                op: 'add',
                left: { kind: 'ref', target: { type: 'resource', id: 'res:gold' as any } },
                right: { kind: 'ref', target: { type: 'generator', id: 'gen:clicks' as any } },
              },
              right: { kind: 'ref', target: { type: 'upgrade', id: 'upg:auto' as any } },
            },
          },
          trigger: { kind: 'interval', interval: { kind: 'constant', value: 1000 } },
          unlockCondition: { kind: 'always' },
          enabledByDefault: true,
          order: 0,
        },
      ];

      const commandQueue = new CommandQueue();
      const runtime = new IdleEngineRuntime({ stepSizeMs: stepDurationMs });
      const system = createAutomationSystem({
        automations,
        stepDurationMs,
        commandQueue,
        resourceState: { getAmount: () => 0 },
        conditionContext,
      });

      runtime.addSystem(system);
      runtime.tick(stepDurationMs);

      const commands = commandQueue.dequeueUpToStep(1);
      expect(commands.length).toBe(1);
      expect(commands[0]?.type).toBe(RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE);
      expect(commands[0]?.payload).toEqual({
        resourceId: 'res:gold',
        amount: 6.5, // 1.5 + 2 + 3
      });
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
          publish: noopEventPublisher.publish,
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
          publish: noopEventPublisher.publish,
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

  describe('resourceCost enforcement', () => {
    it('skips enqueue and cooldown when funds are insufficient (interval)', () => {
      const automations: AutomationDefinition[] = [
        {
          id: 'auto:cost-int' as any,
          name: { default: 'Cost Interval', variants: {} },
          description: { default: 'Tests cost on interval', variants: {} },
          targetType: 'generator',
          targetId: 'gen:test' as any,
          trigger: { kind: 'interval', interval: { kind: 'constant', value: 100 } },
          resourceCost: {
            resourceId: 'res:coins' as any,
            rate: { kind: 'constant', value: 10 },
          },
          unlockCondition: { kind: 'always' },
          enabledByDefault: true,
          order: 0,
        },
      ];

      let coins = 5; // insufficient for cost=10
      const resourceState = {
        getAmount: (index: number) => (index === 0 ? coins : 0),
        getResourceIndex: (id: string) => (id === 'res:coins' ? 0 : -1),
        spendAmount: (index: number, amount: number) => {
          if (index !== 0) return false;
          if (coins >= amount) {
            coins -= amount;
            return true;
          }
          return false;
        },
      };

      const commandQueue = new CommandQueue();
      const system = createAutomationSystem({
        automations,
        stepDurationMs,
        commandQueue,
        resourceState,
      });

      system.setup?.({ events: { on: (() => {}) as any, off: () => {}, emit: () => {} } as any });
      system.tick({ step: 0, deltaMs: 100, events: noopEventPublisher });

      // No command enqueued; no cooldown/lastFired updates
      expect(commandQueue.size).toBe(0);
      const state = getAutomationState(system).get('auto:cost-int');
      expect(state?.lastFiredStep).toBe(-Infinity);
      expect(state?.cooldownExpiresStep).toBe(0);
      expect(coins).toBe(5);
    });

    it('deducts cost and enqueues when funds are sufficient (interval)', () => {
      const automations: AutomationDefinition[] = [
        {
          id: 'auto:cost-int2' as any,
          name: { default: 'Cost Interval 2', variants: {} },
          description: { default: 'Tests cost on interval', variants: {} },
          targetType: 'generator',
          targetId: 'gen:test' as any,
          trigger: { kind: 'interval', interval: { kind: 'constant', value: 100 } },
          resourceCost: {
            resourceId: 'res:coins' as any,
            rate: { kind: 'constant', value: 10 },
          },
          unlockCondition: { kind: 'always' },
          enabledByDefault: true,
          order: 0,
        },
      ];

      let coins = 25; // enough to pay 10
      const resourceState = {
        getAmount: (index: number) => (index === 0 ? coins : 0),
        getResourceIndex: (id: string) => (id === 'res:coins' ? 0 : -1),
        spendAmount: (index: number, amount: number) => {
          if (index !== 0) return false;
          if (coins >= amount) {
            coins -= amount;
            return true;
          }
          return false;
        },
      };

      const commandQueue = new CommandQueue();
      const system = createAutomationSystem({
        automations,
        stepDurationMs,
        commandQueue,
        resourceState,
      });

      system.setup?.({ events: { on: (() => {}) as any, off: () => {}, emit: () => {} } as any });
      system.tick({ step: 0, deltaMs: 100, events: noopEventPublisher });

      expect(commandQueue.size).toBe(1);
      const st = getAutomationState(system).get('auto:cost-int2');
      expect(st?.lastFiredStep).toBe(0);
      expect(coins).toBe(15);
    });

    it('retains pending event when spend fails and consumes it on success', () => {
      const automations: AutomationDefinition[] = [
        {
          id: 'auto:event-cost' as any,
          name: { default: 'Event Cost', variants: {} },
          description: { default: 'Event trigger with cost', variants: {} },
          targetType: 'generator',
          targetId: 'gen:test' as any,
          trigger: { kind: 'event', eventId: 'evt:test' as any },
          resourceCost: {
            resourceId: 'res:coins' as any,
            rate: { kind: 'constant', value: 5 },
          },
          unlockCondition: { kind: 'always' },
          enabledByDefault: true,
          order: 0,
        },
      ];

      let coins = 0;
      let eventHandler: (() => void) | undefined;
      const events = {
        on: (id: string, cb: () => void) => {
          if (id === 'evt:test') eventHandler = cb;
        },
        off: () => {},
        emit: () => {},
      } as any;

      const resourceState = {
        getAmount: (index: number) => (index === 0 ? coins : 0),
        getResourceIndex: (id: string) => (id === 'res:coins' ? 0 : -1),
        spendAmount: (index: number, amount: number) => {
          if (index !== 0) return false;
          if (coins >= amount) {
            coins -= amount;
            return true;
          }
          return false;
        },
      };

      const commandQueue = new CommandQueue();
      const system = createAutomationSystem({
        automations,
        stepDurationMs,
        commandQueue,
        resourceState,
      });

      system.setup?.({ events });

      // Emit event (pending)
      eventHandler?.();

      // Step 0: insufficient funds, event should be retained
      system.tick({ step: 0, deltaMs: 100, events: noopEventPublisher });
      expect(commandQueue.size).toBe(0);

      // Step 1: add funds; event should fire without re-emitting
      coins = 10;
      system.tick({ step: 1, deltaMs: 100, events: noopEventPublisher });
      expect(commandQueue.size).toBe(1);
      commandQueue.dequeueUpToStep(2);

      // Step 2: no new event, should not refire
      system.tick({ step: 2, deltaMs: 100, events: noopEventPublisher });
      expect(commandQueue.size).toBe(0);
    });

    it('does not consume threshold crossing when spend fails; consumes on success', () => {
      const automations: AutomationDefinition[] = [
        {
          id: 'auto:threshold-cost' as any,
          name: { default: 'Threshold Cost', variants: {} },
          description: { default: 'Threshold with cost', variants: {} },
          targetType: 'generator',
          targetId: 'gen:test' as any,
          trigger: {
            kind: 'resourceThreshold',
            resourceId: 'res:gold' as any,
            comparator: 'gte',
            threshold: { kind: 'constant', value: 100 },
          },
          resourceCost: {
            resourceId: 'res:coins' as any,
            rate: { kind: 'constant', value: 10 },
          },
          unlockCondition: { kind: 'always' },
          enabledByDefault: true,
          order: 0,
        },
      ];

      let gold = 50;
      let coins = 0;
      const resourceState = {
        getAmount: (index: number) => (index === 0 ? gold : coins),
        getResourceIndex: (id: string) => (id === 'res:gold' ? 0 : id === 'res:coins' ? 1 : -1),
        spendAmount: (index: number, amount: number) => {
          if (index !== 1) return false;
          if (coins >= amount) {
            coins -= amount;
            return true;
          }
          return false;
        },
      };

      const commandQueue = new CommandQueue();
      const system = createAutomationSystem({
        automations,
        stepDurationMs,
        commandQueue,
        resourceState,
      });

      system.setup?.({ events: { on: (() => {}) as any, off: () => {}, emit: () => {} } as any });

      // Step 0: below threshold
      system.tick({ step: 0, deltaMs: 100, events: noopEventPublisher });
      expect(commandQueue.size).toBe(0);

      // Step 1: cross threshold, but cannot pay cost → no enqueue, crossing not consumed
      gold = 150;
      system.tick({ step: 1, deltaMs: 100, events: noopEventPublisher });
      expect(commandQueue.size).toBe(0);

      // Step 2: still above threshold; now can pay → should fire
      coins = 20;
      system.tick({ step: 2, deltaMs: 100, events: noopEventPublisher });
      expect(commandQueue.size).toBe(1);
    });

    it('event trigger: no cooldown/lastFired on failed spend; updates on success', () => {
      const automations: AutomationDefinition[] = [
        {
          id: 'auto:event-cost-cd' as any,
          name: { default: 'Event Cost + Cooldown', variants: {} },
          description: { default: 'Event with cost and cooldown', variants: {} },
          targetType: 'generator',
          targetId: 'gen:test' as any,
          trigger: { kind: 'event', eventId: 'evt:test' as any },
          resourceCost: {
            resourceId: 'res:coins' as any,
            rate: { kind: 'constant', value: 5 },
          },
          cooldown: 300, // 3 steps at 100ms step size, +1 step boundary
          unlockCondition: { kind: 'always' },
          enabledByDefault: true,
          order: 0,
        },
      ];

      let coins = 0;
      let eventHandler: (() => void) | undefined;
      const events = {
        on: (id: string, cb: () => void) => {
          if (id === 'evt:test') eventHandler = cb;
        },
        off: () => {},
        emit: () => {},
      } as any;

      const resourceState = {
        getAmount: (index: number) => (index === 0 ? coins : 0),
        getResourceIndex: (id: string) => (id === 'res:coins' ? 0 : -1),
        spendAmount: (index: number, amount: number) => {
          if (index !== 0) return false;
          if (coins >= amount) {
            coins -= amount;
            return true;
          }
          return false;
        },
      };

      const commandQueue = new CommandQueue();
      const system = createAutomationSystem({
        automations,
        stepDurationMs,
        commandQueue,
        resourceState,
      });

      system.setup?.({ events });

      // Emit event (pending)
      eventHandler?.();

      // Step 0: insufficient funds → no enqueue, no cooldown/lastFired
      system.tick({ step: 0, deltaMs: 100, events: noopEventPublisher });
      expect(commandQueue.size).toBe(0);
      const s0 = getAutomationState(system).get('auto:event-cost-cd');
      expect(s0?.lastFiredStep).toBe(-Infinity);
      expect(s0?.cooldownExpiresStep).toBe(0);

      // Step 1: add funds and process without re-emitting event → should fire
      coins = 10;
      system.tick({ step: 1, deltaMs: 100, events: noopEventPublisher });
      expect(commandQueue.size).toBe(1);
      const s1 = getAutomationState(system).get('auto:event-cost-cd');
      expect(s1?.lastFiredStep).toBe(1);
      // cooldownSteps = ceil(300/100) = 3, +1 boundary → 1 + 3 + 1 = 5
      expect(s1?.cooldownExpiresStep).toBe(5);
    });

    it('threshold trigger: no cooldown on failed spend; lastFired/cooldown set on success', () => {
      const automations: AutomationDefinition[] = [
        {
          id: 'auto:threshold-cost-cd' as any,
          name: { default: 'Threshold Cost + Cooldown', variants: {} },
          description: { default: 'Threshold with cost and cooldown', variants: {} },
          targetType: 'generator',
          targetId: 'gen:test' as any,
          trigger: {
            kind: 'resourceThreshold',
            resourceId: 'res:gold' as any,
            comparator: 'gte',
            threshold: { kind: 'constant', value: 100 },
          },
          resourceCost: {
            resourceId: 'res:coins' as any,
            rate: { kind: 'constant', value: 10 },
          },
          cooldown: 200,
          unlockCondition: { kind: 'always' },
          enabledByDefault: true,
          order: 0,
        },
      ];

      let gold = 50;
      let coins = 0;
      const resourceState = {
        getAmount: (index: number) => (index === 0 ? gold : coins),
        getResourceIndex: (id: string) => (id === 'res:gold' ? 0 : id === 'res:coins' ? 1 : -1),
        spendAmount: (index: number, amount: number) => {
          if (index !== 1) return false;
          if (coins >= amount) {
            coins -= amount;
            return true;
          }
          return false;
        },
      };

      const commandQueue = new CommandQueue();
      const system = createAutomationSystem({
        automations,
        stepDurationMs,
        commandQueue,
        resourceState,
      });

      system.setup?.({ events: { on: (() => {}) as any, off: () => {}, emit: () => {} } as any });

      // Step 0: below threshold
      system.tick({ step: 0, deltaMs: 100, events: noopEventPublisher });
      let s = getAutomationState(system).get('auto:threshold-cost-cd');
      expect(s?.cooldownExpiresStep).toBe(0);
      expect(s?.lastFiredStep).toBe(-Infinity);

      // Step 1: cross threshold, but cost fails → no cooldown, crossing not consumed
      gold = 150;
      system.tick({ step: 1, deltaMs: 100, events: noopEventPublisher });
      s = getAutomationState(system).get('auto:threshold-cost-cd');
      expect(commandQueue.size).toBe(0);
      expect(s?.cooldownExpiresStep).toBe(0);
      expect(s?.lastFiredStep).toBe(-Infinity);
      // lastThresholdSatisfied must remain false so it can retrigger
      expect(s?.lastThresholdSatisfied).toBe(false);

      // Step 2: still above threshold; now funds available → should fire and set cooldown
      coins = 20;
      system.tick({ step: 2, deltaMs: 100, events: noopEventPublisher });
      s = getAutomationState(system).get('auto:threshold-cost-cd');
      expect(commandQueue.size).toBe(1);
      expect(s?.lastFiredStep).toBe(2);
      // cooldownSteps = ceil(200/100)=2; expires at 2 + 2 + 1 = 5
      expect(s?.cooldownExpiresStep).toBe(5);
      expect(s?.lastThresholdSatisfied).toBe(true);
    });

    it('upgrade target: resourceCost is additional fee; upgrade cost validated separately', () => {
      // Prepare shared resource state with two resources: coins (automation fee) and energy (upgrade cost)
      const resources = createResourceState([
        { id: 'coins', startAmount: 50 },
        { id: 'energy', startAmount: 30 },
      ]);

      // Adapter so AutomationSystem can resolve indices and spend via the same state
      const resourceAccessor = createResourceStateAdapter(resources);

      const automations: AutomationDefinition[] = [
        {
          id: 'auto:upgrade-fee' as any,
          name: { default: 'Upgrade with Fee', variants: {} },
          description: { default: 'Upgrade target charges automation fee', variants: {} },
          targetType: 'upgrade',
          targetId: 'upg:alpha' as any,
          trigger: { kind: 'interval', interval: { kind: 'constant', value: 100 } },
          resourceCost: {
            resourceId: 'coins' as any,
            rate: { kind: 'constant', value: 10 },
          },
          cooldown: 100,
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
        resourceState: resourceAccessor,
      });

      system.setup?.({ events: { on: (() => {}) as any, off: () => {}, emit: () => {} } as any });
      system.tick({ step: 0, deltaMs: 100, events: noopEventPublisher });

      // One command enqueued: PURCHASE_UPGRADE
      expect(commandQueue.size).toBe(1);

      // Automation fee should be deducted immediately at fire-time
      const coinsIndex = resources.requireIndex('coins');
      expect(resources.getAmount(coinsIndex)).toBe(40);

      // Execute the command to validate upgrade cost handling
      const dispatcher = new CommandDispatcher();

      class StubUpgrades implements UpgradePurchaseEvaluator {
        public applied: Array<{ upgradeId: string }> = [];
        getPurchaseQuote(upgradeId: string): UpgradePurchaseQuote | undefined {
          if (upgradeId !== 'upg:alpha') return undefined;
          return {
            upgradeId,
            status: 'available',
            costs: [{ resourceId: 'energy', amount: 15 }],
          };
        }
        applyPurchase(upgradeId: string): void {
          this.applied.push({ upgradeId });
        }
      }

      const upgrades = new StubUpgrades();
      registerResourceCommandHandlers({
        dispatcher,
        resources,
        generatorPurchases: {
          getPurchaseQuote: () => undefined,
          applyPurchase: () => undefined,
        },
        upgradePurchases: upgrades,
      });

      const [snapshot] = commandQueue.dequeueUpToStep(1);
      expect(snapshot?.type).toBe(RUNTIME_COMMAND_TYPES.PURCHASE_UPGRADE);
      dispatcher.execute({
        type: snapshot!.type,
        payload: snapshot!.payload as any,
        priority: snapshot!.priority,
        timestamp: snapshot!.timestamp,
        step: snapshot!.step,
      } as any);

      // Upgrade cost should be deducted separately from energy
      const energyIndex = resources.requireIndex('energy');
      expect(resources.getAmount(energyIndex)).toBe(15);
      // Purchase applied
      expect(upgrades.applied).toEqual([{ upgradeId: 'upg:alpha' }]);
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
          publish: noopEventPublisher.publish,
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
      system.tick({ step: 10, deltaMs: 100, events: noopEventPublisher });

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
        system.tick({ step: 5, deltaMs: 100, events: noopEventPublisher });

        const commands = commandQueue.dequeueUpToStep(6);
        timestamps.push(commands[0]?.timestamp ?? -1);
      }

      // Both runs should produce the same timestamp
      expect(timestamps[0]).toBe(timestamps[1]);
      expect(timestamps[0]).toBe(500); // step 5 * 100ms
    });
  });
});
