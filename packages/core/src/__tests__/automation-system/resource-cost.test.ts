import { describe, expect, it } from 'vitest';
import type { AutomationDefinition } from '@idle-engine/content-schema';

import type { UpgradePurchaseEvaluator, UpgradePurchaseQuote } from '../../resource-command-handlers.js';
import {
  createAutomationSystem,
  evaluateEventTrigger,
  getAutomationState,
} from '../../automation-system.js';
import { CommandDispatcher } from '../../command-dispatcher.js';
import { CommandQueue } from '../../command-queue.js';
import { RUNTIME_COMMAND_TYPES } from '../../command.js';
import { IdleEngineRuntime } from '../../index.js';
import { createResourceStateAdapter } from '../../automation-resource-state-adapter.js';
import { createResourceState } from '../../resource-state.js';
import { registerResourceCommandHandlers } from '../../resource-command-handlers.js';
import { noopEventPublisher } from '../helpers/event-fixtures.js';
import { literal } from '../helpers/formula-fixtures.js';

describe('AutomationSystem', () => {
  const stepDurationMs = 100;

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
          cooldown: literal(300), // 3 steps at 100ms step size, +1 step boundary
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
          cooldown: literal(200),
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
          cooldown: literal(100),
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

});
