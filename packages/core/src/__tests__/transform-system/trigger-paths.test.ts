import { describe, expect, it, vi } from 'vitest';
import type { TransformDefinition } from '@idle-engine/content-schema';

import { createAutomationSystem } from '../../automation-system.js';
import { IdleEngineRuntime } from '../../index.js';
import { createTransformSystem } from '../../transform-system.js';
import {
  createMockConditionContext,
  createMockResourceState,
} from '../helpers/transform-fixtures.js';

describe('TransformSystem', () => {
  const stepDurationMs = 100;

  describe('event trigger path', () => {
    // Event trigger tests use a mock events pattern since EventBus resets
    // internal buffers on beginTick(), which loses events published between ticks.
    // This mirrors the approach used in `packages/core/src/__tests__/automation-system/`.

    it('should execute transform when subscribed event fires', () => {
      const transforms: TransformDefinition[] = [
        {
          id: 'transform:event-based' as any,
          name: { default: 'Event Based', variants: {} },
          description: { default: 'Triggered by event', variants: {} },
          mode: 'instant',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 10 } }],
          outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } }],
          trigger: { kind: 'event', eventId: 'evt:test' as any },
          tags: [],
        },
      ];

      const resourceState = createMockResourceState(
        new Map([
          ['res:gold', { amount: 100 }],
          ['res:gems', { amount: 0 }],
        ]),
      );

      // Capture event handler during setup
      let eventHandler: (() => void) | undefined;
      const mockEvents = {
        on: (eventId: string, handler: () => void) => {
          if (eventId === 'evt:test') {
            eventHandler = handler;
          }
          return { unsubscribe: () => {} };
        },
      };

      const system = createTransformSystem({
        transforms,
        stepDurationMs,
        resourceState,
      });

      // Call setup with mock events
      system.setup?.({ events: mockEvents as any });

      // Initialize unlock state
      system.tick({ deltaMs: stepDurationMs, step: 0, events: { publish: vi.fn() } });

      // Trigger the event
      eventHandler?.();

      // Tick to process event
      system.tick({ deltaMs: stepDurationMs, step: 1, events: { publish: vi.fn() } });

      // Transform should have executed
      expect(resourceState.getAmount(0)).toBe(90); // 100 - 10 gold
      expect(resourceState.getAmount(1)).toBe(1);  // 0 + 1 gem
    });

    it('should coalesce multiple events of same type per tick', () => {
      const transforms: TransformDefinition[] = [
        {
          id: 'transform:event-based' as any,
          name: { default: 'Event Based', variants: {} },
          description: { default: 'Triggered by event', variants: {} },
          mode: 'instant',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 10 } }],
          outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } }],
          trigger: { kind: 'event', eventId: 'evt:test' as any },
          tags: [],
        },
      ];

      const resourceState = createMockResourceState(
        new Map([
          ['res:gold', { amount: 100 }],
          ['res:gems', { amount: 0 }],
        ]),
      );

      let eventHandler: (() => void) | undefined;
      const mockEvents = {
        on: (eventId: string, handler: () => void) => {
          if (eventId === 'evt:test') {
            eventHandler = handler;
          }
          return { unsubscribe: () => {} };
        },
      };

      const system = createTransformSystem({
        transforms,
        stepDurationMs,
        resourceState,
      });

      system.setup?.({ events: mockEvents as any });

      // Initialize unlock state
      system.tick({ deltaMs: stepDurationMs, step: 0, events: { publish: vi.fn() } });

      // Fire same event multiple times
      eventHandler?.();
      eventHandler?.();
      eventHandler?.();

      // Tick to process events
      system.tick({ deltaMs: stepDurationMs, step: 1, events: { publish: vi.fn() } });

      // Transform should only execute once (coalesced via Set)
      expect(resourceState.getAmount(0)).toBe(90); // 100 - 10 gold (only one execution)
      expect(resourceState.getAmount(1)).toBe(1);  // 0 + 1 gem
    });

    it('should retain event trigger when blocked by cooldown', () => {
      const transforms: TransformDefinition[] = [
        {
          id: 'transform:event-cooldown' as any,
          name: { default: 'Event Cooldown', variants: {} },
          description: { default: 'Event with cooldown', variants: {} },
          mode: 'instant',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 10 } }],
          outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } }],
          trigger: { kind: 'event', eventId: 'evt:test' as any },
          cooldown: { kind: 'constant', value: 200 }, // 2 steps
          tags: [],
        },
      ];

      const resourceState = createMockResourceState(
        new Map([
          ['res:gold', { amount: 100 }],
          ['res:gems', { amount: 0 }],
        ]),
      );

      let eventHandler: (() => void) | undefined;
      const mockEvents = {
        on: (eventId: string, handler: () => void) => {
          if (eventId === 'evt:test') {
            eventHandler = handler;
          }
          return { unsubscribe: () => {} };
        },
      };

      const system = createTransformSystem({
        transforms,
        stepDurationMs,
        resourceState,
      });

      system.setup?.({ events: mockEvents as any });

      // Tick 0: Initialize unlock state
      system.tick({ deltaMs: stepDurationMs, step: 0, events: { publish: vi.fn() } });

      // Fire first event and tick - executes
      eventHandler?.();
      system.tick({ deltaMs: stepDurationMs, step: 1, events: { publish: vi.fn() } });
      expect(resourceState.getAmount(1)).toBe(1);

      // Fire second event while in cooldown - should be retained
      eventHandler?.();
      system.tick({ deltaMs: stepDurationMs, step: 2, events: { publish: vi.fn() } }); // still in cooldown
      expect(resourceState.getAmount(1)).toBe(1); // No change

      system.tick({ deltaMs: stepDurationMs, step: 3, events: { publish: vi.fn() } }); // still in cooldown
      expect(resourceState.getAmount(1)).toBe(1); // No change

      system.tick({ deltaMs: stepDurationMs, step: 4, events: { publish: vi.fn() } }); // cooldown expires, retained event fires
      expect(resourceState.getAmount(1)).toBe(2); // Now 2 gems
    });

    it('should retain event trigger when blocked by insufficient resources', () => {
      const transforms: TransformDefinition[] = [
        {
          id: 'transform:event-expensive' as any,
          name: { default: 'Event Expensive', variants: {} },
          description: { default: 'Expensive event trigger', variants: {} },
          mode: 'instant',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 100 } }],
          outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 10 } }],
          trigger: { kind: 'event', eventId: 'evt:test' as any },
          tags: [],
        },
      ];

      const resourceState = createMockResourceState(
        new Map([
          ['res:gold', { amount: 50 }], // Not enough initially
          ['res:gems', { amount: 0 }],
        ]),
      );

      let eventHandler: (() => void) | undefined;
      const mockEvents = {
        on: (eventId: string, handler: () => void) => {
          if (eventId === 'evt:test') {
            eventHandler = handler;
          }
          return { unsubscribe: () => {} };
        },
      };

      const system = createTransformSystem({
        transforms,
        stepDurationMs,
        resourceState,
      });

      system.setup?.({ events: mockEvents as any });

      // Initialize unlock state
      system.tick({ deltaMs: stepDurationMs, step: 0, events: { publish: vi.fn() } });

      // Event fires but can't afford
      eventHandler?.();
      system.tick({ deltaMs: stepDurationMs, step: 1, events: { publish: vi.fn() } });
      expect(resourceState.getAmount(1)).toBe(0); // No gems yet

      // Add more gold (simulating another system)
      resourceState.addAmount(0, 100); // Now has 150

      // Next tick should execute retained trigger
      system.tick({ deltaMs: stepDurationMs, step: 2, events: { publish: vi.fn() } });
      expect(resourceState.getAmount(1)).toBe(10); // Now has gems
      expect(resourceState.getAmount(0)).toBe(50); // 150 - 100 gold
    });

    it('should retain event trigger when blocked by locked state', () => {
      const transforms: TransformDefinition[] = [
        {
          id: 'transform:event-locked' as any,
          name: { default: 'Event Locked', variants: {} },
          description: { default: 'Event retained while locked', variants: {} },
          mode: 'instant',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 10 } }],
          outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } }],
          trigger: { kind: 'event', eventId: 'evt:test' as any },
          unlockCondition: {
            kind: 'resourceThreshold',
            resourceId: 'res:prestige' as any,
            comparator: 'gte',
            amount: { kind: 'constant', value: 1 },
          },
          tags: [],
        },
      ];

      const resources = new Map([
        ['res:prestige', 0],
      ]);

      const resourceState = createMockResourceState(
        new Map([
          ['res:gold', { amount: 100 }],
          ['res:gems', { amount: 0 }],
        ]),
      );

      const conditionContext = createMockConditionContext(resources);

      let eventHandler: (() => void) | undefined;
      const mockEvents = {
        on: (eventId: string, handler: () => void) => {
          if (eventId === 'evt:test') {
            eventHandler = handler;
          }
          return { unsubscribe: () => {} };
        },
      };

      const system = createTransformSystem({
        transforms,
        stepDurationMs,
        resourceState,
        conditionContext,
      });

      system.setup?.({ events: mockEvents as any });

      // Tick 0: evaluate unlock state (still locked)
      system.tick({ deltaMs: stepDurationMs, step: 0, events: { publish: vi.fn() } });

      // Fire event while locked; it should be retained
      eventHandler?.();
      system.tick({ deltaMs: stepDurationMs, step: 1, events: { publish: vi.fn() } });
      expect(resourceState.getAmount(0)).toBe(100);
      expect(resourceState.getAmount(1)).toBe(0);

      // Unlock in a later tick without firing the event again
      resources.set('res:prestige', 1);
      system.tick({ deltaMs: stepDurationMs, step: 2, events: { publish: vi.fn() } });
      expect(resourceState.getAmount(0)).toBe(90);
      expect(resourceState.getAmount(1)).toBe(1);
    });

    it('should retain event trigger when blocked by maxRunsPerTick', () => {
      const transforms: TransformDefinition[] = [
        {
          id: 'transform:event-capped' as any,
          name: { default: 'Event Capped', variants: {} },
          description: { default: 'Event retained when run budget exhausted', variants: {} },
          mode: 'instant',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 10 } }],
          outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } }],
          trigger: { kind: 'event', eventId: 'evt:test' as any },
          safety: { maxRunsPerTick: 1 },
          tags: [],
        },
      ];

      const resourceState = createMockResourceState(
        new Map([
          ['res:gold', { amount: 100 }],
          ['res:gems', { amount: 0 }],
        ]),
      );

      let eventHandler: (() => void) | undefined;
      const mockEvents = {
        on: (eventId: string, handler: () => void) => {
          if (eventId === 'evt:test') {
            eventHandler = handler;
          }
          return { unsubscribe: () => {} };
        },
      };

      const system = createTransformSystem({
        transforms,
        stepDurationMs,
        resourceState,
      });

      system.setup?.({ events: mockEvents as any });

      // Tick once to initialize
      system.tick({ deltaMs: stepDurationMs, step: 0, events: { publish: vi.fn() } });

      // Fire and process an event in step 0 (executes)
      eventHandler?.();
      system.tick({ deltaMs: stepDurationMs, step: 0, events: { publish: vi.fn() } });
      expect(resourceState.getAmount(0)).toBe(90);
      expect(resourceState.getAmount(1)).toBe(1);

      // Fire another event in the same step; should be retained due to maxRunsPerTick
      eventHandler?.();
      system.tick({ deltaMs: stepDurationMs, step: 0, events: { publish: vi.fn() } });
      expect(resourceState.getAmount(0)).toBe(90);
      expect(resourceState.getAmount(1)).toBe(1);

      // Next step consumes the retained event without firing again
      system.tick({ deltaMs: stepDurationMs, step: 1, events: { publish: vi.fn() } });
      expect(resourceState.getAmount(0)).toBe(80);
      expect(resourceState.getAmount(1)).toBe(2);
    });
  });

  describe('automation trigger path', () => {
    it('should execute transform when referenced automation fires', () => {
      const automations = [
        {
          id: 'auto:collector' as any,
          name: { default: 'Auto Collector', variants: {} },
          description: { default: 'Collects automatically', variants: {} },
          targetType: 'collectResource',
          targetId: 'res:gold' as any,
          trigger: { kind: 'interval', interval: { kind: 'constant', value: 100 } },
          unlockCondition: { kind: 'always' },
          enabledByDefault: true,
        },
      ] as const;

      const transforms: TransformDefinition[] = [
        {
          id: 'transform:auto-fired' as any,
          name: { default: 'Automation Fired Transform', variants: {} },
          description: { default: 'Triggered by automation firing', variants: {} },
          mode: 'instant',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 10 } }],
          outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } }],
          trigger: { kind: 'automation', automationId: 'auto:collector' as any },
          automation: { automationId: 'auto:collector' as any },
          tags: [],
        },
      ];

      const resourceState = createMockResourceState(
        new Map([
          ['res:gold', { amount: 100 }],
          ['res:gems', { amount: 0 }],
        ]),
      );

      const runtime = new IdleEngineRuntime({ stepSizeMs: stepDurationMs });

      runtime.addSystem(
        createAutomationSystem({
          automations: automations as any,
          stepDurationMs,
          commandQueue: runtime.getCommandQueue(),
          resourceState,
        }),
      );
      runtime.addSystem(
        createTransformSystem({
          transforms,
          stepDurationMs,
          resourceState,
        }),
      );

      runtime.tick(stepDurationMs);

      // Transform should have executed once during the same tick the automation fired
      expect(resourceState.getAmount(0)).toBe(90); // 100 - 10 gold
      expect(resourceState.getAmount(1)).toBe(1);  // 0 + 1 gem
    });

    it('should execute transform on the next tick when TransformSystem runs before AutomationSystem', () => {
      const automations = [
        {
          id: 'auto:collector' as any,
          name: { default: 'Auto Collector', variants: {} },
          description: { default: 'Collects automatically', variants: {} },
          targetType: 'collectResource',
          targetId: 'res:gold' as any,
          trigger: { kind: 'interval', interval: { kind: 'constant', value: 100 } },
          unlockCondition: { kind: 'always' },
          enabledByDefault: true,
        },
      ] as const;

      const transforms: TransformDefinition[] = [
        {
          id: 'transform:auto-fired' as any,
          name: { default: 'Automation Fired Transform', variants: {} },
          description: { default: 'Triggered by automation firing', variants: {} },
          mode: 'instant',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 10 } }],
          outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } }],
          trigger: { kind: 'automation', automationId: 'auto:collector' as any },
          automation: { automationId: 'auto:collector' as any },
          tags: [],
        },
      ];

      const resourceState = createMockResourceState(
        new Map([
          ['res:gold', { amount: 100 }],
          ['res:gems', { amount: 0 }],
        ]),
      );

      const runtime = new IdleEngineRuntime({ stepSizeMs: stepDurationMs });

      runtime.addSystem(
        createTransformSystem({
          transforms,
          stepDurationMs,
          resourceState,
        }),
      );
      runtime.addSystem(
        createAutomationSystem({
          automations: automations as any,
          stepDurationMs,
          commandQueue: runtime.getCommandQueue(),
          resourceState,
        }),
      );

      runtime.tick(stepDurationMs);
      expect(resourceState.getAmount(0)).toBe(100);
      expect(resourceState.getAmount(1)).toBe(0);

      runtime.tick(stepDurationMs);
      expect(resourceState.getAmount(0)).toBe(90);
      expect(resourceState.getAmount(1)).toBe(1);
    });

    it('should not execute transform when automation fire is blocked by resource cost', () => {
      const automations = [
        {
          id: 'auto:collector' as any,
          name: { default: 'Auto Collector', variants: {} },
          description: { default: 'Collects automatically', variants: {} },
          targetType: 'collectResource',
          targetId: 'res:gold' as any,
          trigger: { kind: 'interval', interval: { kind: 'constant', value: 100 } },
          resourceCost: {
            resourceId: 'res:tokens' as any,
            rate: { kind: 'constant', value: 1 },
          },
          unlockCondition: { kind: 'always' },
          enabledByDefault: true,
        },
      ] as const;

      const transforms: TransformDefinition[] = [
        {
          id: 'transform:auto-fired' as any,
          name: { default: 'Automation Fired Transform', variants: {} },
          description: { default: 'Triggered by automation firing', variants: {} },
          mode: 'instant',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 10 } }],
          outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } }],
          trigger: { kind: 'automation', automationId: 'auto:collector' as any },
          automation: { automationId: 'auto:collector' as any },
          tags: [],
        },
      ];

      const resourceState = createMockResourceState(
        new Map([
          ['res:gold', { amount: 100 }],
          ['res:gems', { amount: 0 }],
          ['res:tokens', { amount: 0 }],
        ]),
      );

      const runtime = new IdleEngineRuntime({ stepSizeMs: stepDurationMs });

      runtime.addSystem(
        createAutomationSystem({
          automations: automations as any,
          stepDurationMs,
          commandQueue: runtime.getCommandQueue(),
          resourceState,
        }),
      );
      runtime.addSystem(
        createTransformSystem({
          transforms,
          stepDurationMs,
          resourceState,
        }),
      );

      runtime.tick(stepDurationMs);

      // Automation should not publish automation:fired when spend fails, so transform does not run
      expect(resourceState.getAmount(0)).toBe(100);
      expect(resourceState.getAmount(1)).toBe(0);
    });
  });

  describe('condition trigger path', () => {
    it('should execute transform when condition becomes true', () => {
      const transforms: TransformDefinition[] = [
        {
          id: 'transform:condition-based' as any,
          name: { default: 'Condition Based', variants: {} },
          description: { default: 'Triggered by condition', variants: {} },
          mode: 'instant',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 10 } }],
          outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } }],
          trigger: {
            kind: 'condition',
            condition: {
              kind: 'resourceThreshold',
              resourceId: 'res:gold' as any,
              comparator: 'gte',
              amount: { kind: 'constant', value: 50 },
            },
          },
          tags: [],
        },
      ];

      const resources = new Map([
        ['res:gold', 100],
        ['res:gems', 0],
      ]);

      const resourceState = createMockResourceState(
        new Map([
          ['res:gold', { amount: 100 }],
          ['res:gems', { amount: 0 }],
        ]),
      );

      const conditionContext = createMockConditionContext(resources);

      const system = createTransformSystem({
        transforms,
        stepDurationMs,
        resourceState,
        conditionContext,
      });

      // Tick - condition is true (gold >= 50), should execute
      system.tick({ deltaMs: stepDurationMs, step: 0, events: { publish: vi.fn() } });

      expect(resourceState.getAmount(0)).toBe(90); // 100 - 10 gold
      expect(resourceState.getAmount(1)).toBe(1);  // 0 + 1 gem
    });

    it('should not execute when condition is false', () => {
      const transforms: TransformDefinition[] = [
        {
          id: 'transform:condition-based' as any,
          name: { default: 'Condition Based', variants: {} },
          description: { default: 'Triggered by condition', variants: {} },
          mode: 'instant',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 10 } }],
          outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } }],
          trigger: {
            kind: 'condition',
            condition: {
              kind: 'resourceThreshold',
              resourceId: 'res:gold' as any,
              comparator: 'gte',
              amount: { kind: 'constant', value: 200 }, // Need 200
            },
          },
          tags: [],
        },
      ];

      const resources = new Map([
        ['res:gold', 100], // Only have 100
        ['res:gems', 0],
      ]);

      const resourceState = createMockResourceState(
        new Map([
          ['res:gold', { amount: 100 }],
          ['res:gems', { amount: 0 }],
        ]),
      );

      const conditionContext = createMockConditionContext(resources);

      const system = createTransformSystem({
        transforms,
        stepDurationMs,
        resourceState,
        conditionContext,
      });

      // Tick - condition is false (gold < 200)
      system.tick({ deltaMs: stepDurationMs, step: 0, events: { publish: vi.fn() } });

      expect(resourceState.getAmount(0)).toBe(100); // Unchanged
      expect(resourceState.getAmount(1)).toBe(0);   // Unchanged
    });
  });

});
