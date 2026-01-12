import { describe, expect, it } from 'vitest';
import type { AutomationDefinition } from '@idle-engine/content-schema';

import type { AutomationState, SerializedAutomationState } from '../../automation-system.js';
import {
  createAutomationSystem,
  getAutomationState,
  isCooldownActive,
  updateCooldown,
} from '../../automation-system.js';
import { CommandQueue } from '../../command-queue.js';
import { noopEventPublisher } from '../helpers/event-fixtures.js';
import { literal } from '../helpers/formula-fixtures.js';

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

  describe('updateCooldown formula evaluation', () => {
    it('should evaluate dynamic cooldown formulas with FormulaContext', () => {
      // Test that linear formulas are evaluated correctly at runtime
      const automation: AutomationDefinition = {
        id: 'auto:dynamic-cooldown' as any,
        name: { default: 'Dynamic Cooldown', variants: {} },
        description: { default: 'Test dynamic cooldown', variants: {} },
        targetType: 'generator',
        targetId: 'gen:test' as any,
        trigger: { kind: 'interval', interval: literal(1000) },
        cooldown: { kind: 'linear', base: 500, slope: 100 }, // base + slope * level
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
        order: 0,
      };

      const state: AutomationState = {
        id: 'auto:dynamic-cooldown',
        enabled: true,
        lastFiredStep: 10,
        cooldownExpiresStep: 0,
        unlocked: true,
      };

      const stepDurationMs = 100;
      const currentStep = 10;

      // Create a FormulaContext with level=2, so cooldown = 500 + 100*2 = 700ms
      const formulaContext = {
        variables: { level: 2, time: 1, deltaTime: 0.1 },
        entities: {
          resource: () => 0,
          generator: () => 0,
          upgrade: () => 0,
          automation: () => 0,
          prestigeLayer: () => 0,
        },
      };

      updateCooldown(automation, state, currentStep, stepDurationMs, formulaContext);

      // 700ms / 100ms = 7 steps, plus 1 for command execution delay
      // cooldownExpiresStep = 10 + 7 + 1 = 18
      expect(state.cooldownExpiresStep).toBe(18);
    });

    it('should create minimal FormulaContext when none provided', () => {
      // When formulaContext is undefined, updateCooldown creates one internally
      const automation: AutomationDefinition = {
        id: 'auto:no-context' as any,
        name: { default: 'No Context', variants: {} },
        description: { default: 'Test without context', variants: {} },
        targetType: 'generator',
        targetId: 'gen:test' as any,
        trigger: { kind: 'interval', interval: literal(1000) },
        cooldown: literal(500), // constant 500ms cooldown
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
        order: 0,
      };

      const state: AutomationState = {
        id: 'auto:no-context',
        enabled: true,
        lastFiredStep: 10,
        cooldownExpiresStep: 0,
        unlocked: true,
      };

      const stepDurationMs = 100;
      const currentStep = 10;

      // Call without formulaContext - should use internal context creation
      updateCooldown(automation, state, currentStep, stepDurationMs, undefined);

      // 500ms / 100ms = 5 steps, plus 1 for command execution delay
      // cooldownExpiresStep = 10 + 5 + 1 = 16
      expect(state.cooldownExpiresStep).toBe(16);
    });

    it('should set cooldownExpiresStep to 0 when formula evaluates to non-positive', () => {
      // Edge case: formula evaluates to 0 or negative
      const automation: AutomationDefinition = {
        id: 'auto:zero-cooldown' as any,
        name: { default: 'Zero Cooldown', variants: {} },
        description: { default: 'Test zero cooldown', variants: {} },
        targetType: 'generator',
        targetId: 'gen:test' as any,
        trigger: { kind: 'interval', interval: literal(1000) },
        cooldown: literal(0), // zero cooldown
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
        order: 0,
      };

      const state: AutomationState = {
        id: 'auto:zero-cooldown',
        enabled: true,
        lastFiredStep: 10,
        cooldownExpiresStep: 999, // Should be reset to 0
        unlocked: true,
      };

      updateCooldown(automation, state, 10, 100);

      expect(state.cooldownExpiresStep).toBe(0);
    });

    it('should set cooldownExpiresStep to 0 when formula evaluates to negative', () => {
      // Edge case: formula evaluates to negative via linear with negative base
      const automation: AutomationDefinition = {
        id: 'auto:negative-cooldown' as any,
        name: { default: 'Negative Cooldown', variants: {} },
        description: { default: 'Test negative cooldown', variants: {} },
        targetType: 'generator',
        targetId: 'gen:test' as any,
        trigger: { kind: 'interval', interval: literal(1000) },
        cooldown: { kind: 'linear', base: -100, slope: 10 }, // -100 + 10*0 = -100 at level 0
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
        order: 0,
      };

      const state: AutomationState = {
        id: 'auto:negative-cooldown',
        enabled: true,
        lastFiredStep: 10,
        cooldownExpiresStep: 999, // Should be reset to 0
        unlocked: true,
      };

      const formulaContext = {
        variables: { level: 0, time: 1, deltaTime: 0.1 },
        entities: {
          resource: () => 0,
          generator: () => 0,
          upgrade: () => 0,
          automation: () => 0,
          prestigeLayer: () => 0,
        },
      };

      updateCooldown(automation, state, 10, 100, formulaContext);

      expect(state.cooldownExpiresStep).toBe(0);
    });

    it('should set cooldownExpiresStep to 0 when cooldown is undefined', () => {
      const automation: AutomationDefinition = {
        id: 'auto:no-cooldown' as any,
        name: { default: 'No Cooldown', variants: {} },
        description: { default: 'Test no cooldown', variants: {} },
        targetType: 'generator',
        targetId: 'gen:test' as any,
        trigger: { kind: 'interval', interval: literal(1000) },
        // No cooldown defined
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
        order: 0,
      };

      const state: AutomationState = {
        id: 'auto:no-cooldown',
        enabled: true,
        lastFiredStep: 10,
        cooldownExpiresStep: 999, // Should be reset to 0
        unlocked: true,
      };

      updateCooldown(automation, state, 10, 100);

      expect(state.cooldownExpiresStep).toBe(0);
    });
  });
});
