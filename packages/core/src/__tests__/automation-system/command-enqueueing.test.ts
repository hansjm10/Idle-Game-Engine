import { describe, expect, it, vi } from 'vitest';
import type { AutomationDefinition } from '@idle-engine/content-schema';

import { createAutomationSystem, enqueueAutomationCommand } from '../../automation-system.js';
import { CommandQueue } from '../../command-queue.js';
import { CommandPriority, RUNTIME_COMMAND_TYPES } from '../../command.js';
import { IdleEngineRuntime } from '../../index.js';
import { noopEventPublisher } from '../helpers/event-fixtures.js';
import { literal } from '../helpers/formula-fixtures.js';

describe('AutomationSystem', () => {
  const stepDurationMs = 100;

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
      const eventBus = {
        on: vi.fn(() => ({ unsubscribe: vi.fn() })),
        publish: vi.fn(),
      } as any;
      const runtime = new IdleEngineRuntime({ stepSizeMs: 100, eventBus });
      const system = createAutomationSystem({
        automations,
        stepDurationMs: 100,
        commandQueue,
        resourceState: { getAmount: () => 0 },
      });

      runtime.addSystem(system);

      expect(system.id).toBe('automation-system');
      expect(eventBus.on).toHaveBeenCalledWith(
        'resource:threshold-reached',
        expect.any(Function),
        { label: 'system:automation-system' },
      );
      expect(eventBus.on).toHaveBeenCalledWith(
        'automation:toggled',
        expect.any(Function),
        { label: 'system:automation-system' },
      );
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
          cooldown: literal(500), // 5 steps
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
          cooldown: literal(500), // 500ms cooldown with 100ms steps = 5 steps
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
          cooldown: literal(500), // 500ms cooldown with 100ms steps = 5 steps AFTER command execution
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

});
