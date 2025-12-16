import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommandDispatcher } from './command-dispatcher.js';
import { CommandPriority, RUNTIME_COMMAND_TYPES, type ToggleAutomationPayload } from './command.js';
import { registerAutomationCommandHandlers } from './automation-command-handlers.js';
import { createAutomationSystem, type AutomationState } from './automation-system.js';
import { CommandQueue } from './command-queue.js';
import type { EventBus, PublishMetadata } from './events/event-bus.js';

describe('registerAutomationCommandHandlers', () => {
  let dispatcher: CommandDispatcher;
  let automationSystem: ReturnType<typeof createAutomationSystem>;
  let commandQueue: CommandQueue;
  let mockEventBus: EventBus;
  let publishedEvents: Array<{
    type: string;
    payload: unknown;
    metadata?: PublishMetadata;
  }>;

  beforeEach(() => {
    dispatcher = new CommandDispatcher();
    commandQueue = new CommandQueue();
    publishedEvents = [];

    mockEventBus = {
      publish: vi.fn((type: string, payload: unknown, metadata?: PublishMetadata) => {
        publishedEvents.push({ type, payload, metadata });
      }),
      on: vi.fn(),
      off: vi.fn(),
      once: vi.fn(),
    } as unknown as EventBus;

    dispatcher.setEventPublisher(mockEventBus);

    automationSystem = createAutomationSystem({
      automations: [
        {
          id: 'auto:test-collector' as any,
          name: { default: 'Test Collector', variants: {} },
          description: { default: 'Test automation', variants: {} },
          enabledByDefault: false,
          targetType: 'generator',
          targetId: 'gen:click' as any,
          trigger: {
            kind: 'interval',
            interval: { kind: 'constant', value: 1000 },
          },
          unlockCondition: { kind: 'always' },
          order: 0,
        },
      ],
      stepDurationMs: 100,
      commandQueue,
      resourceState: {
        getAmount: () => 0,
        getResourceIndex: () => 0,
      },
    });

    registerAutomationCommandHandlers({
      dispatcher,
      automationSystem,
    });
  });

  describe('TOGGLE_AUTOMATION command', () => {
    it('should register handler for TOGGLE_AUTOMATION', () => {
      const handler = dispatcher.getHandler(RUNTIME_COMMAND_TYPES.TOGGLE_AUTOMATION);
      expect(handler).toBeDefined();
    });

    it('should enable automation when enabled is true', () => {
      const payload: ToggleAutomationPayload = {
        automationId: 'auto:test-collector',
        enabled: true,
      };

      dispatcher.execute({
        type: RUNTIME_COMMAND_TYPES.TOGGLE_AUTOMATION,
        payload,
        priority: CommandPriority.PLAYER,
        timestamp: 0,
        step: 0,
      });

      const state = automationSystem.getState();
      const autoState = state.get('auto:test-collector');
      expect(autoState?.enabled).toBe(true);
    });

    it('should disable automation when enabled is false', () => {
      // First enable it
      const state = automationSystem.getState();
      const autoState = state.get('auto:test-collector') as AutomationState;
      autoState.enabled = true;

      // Then disable
      const payload: ToggleAutomationPayload = {
        automationId: 'auto:test-collector',
        enabled: false,
      };

      dispatcher.execute({
        type: RUNTIME_COMMAND_TYPES.TOGGLE_AUTOMATION,
        payload,
        priority: CommandPriority.PLAYER,
        timestamp: 0,
        step: 0,
      });

      const updatedState = automationSystem.getState();
      const updatedAutoState = updatedState.get('auto:test-collector');
      expect(updatedAutoState?.enabled).toBe(false);
    });

    it('should publish automation:toggled event when state changes', () => {
      const payload: ToggleAutomationPayload = {
        automationId: 'auto:test-collector',
        enabled: true,
      };

      dispatcher.execute({
        type: RUNTIME_COMMAND_TYPES.TOGGLE_AUTOMATION,
        payload,
        priority: CommandPriority.PLAYER,
        timestamp: 1000,
        step: 10,
      });

      expect(publishedEvents).toHaveLength(1);
      expect(publishedEvents[0]).toEqual({
        type: 'automation:toggled',
        payload: {
          automationId: 'auto:test-collector',
          enabled: true,
        },
        metadata: {
          issuedAt: 1000,
        },
      });
    });

    it('should handle non-existent automation gracefully', () => {
      const payload: ToggleAutomationPayload = {
        automationId: 'auto:does-not-exist',
        enabled: true,
      };

      expect(() => {
        dispatcher.execute({
          type: RUNTIME_COMMAND_TYPES.TOGGLE_AUTOMATION,
          payload,
          priority: CommandPriority.PLAYER,
          timestamp: 0,
          step: 0,
        });
      }).not.toThrow();

      // Should not publish event for non-existent automation
      expect(publishedEvents).toHaveLength(0);
    });

    it('should accept commands from all priority tiers', () => {
      const priorities = [
        CommandPriority.SYSTEM,
        CommandPriority.PLAYER,
        CommandPriority.AUTOMATION,
      ];

      for (const priority of priorities) {
        publishedEvents = [];

        dispatcher.execute({
          type: RUNTIME_COMMAND_TYPES.TOGGLE_AUTOMATION,
          payload: {
            automationId: 'auto:test-collector',
            enabled: true,
          },
          priority,
          timestamp: 0,
          step: 0,
        });

        expect(publishedEvents).toHaveLength(1);
      }
    });

    it('should handle invalid payload gracefully', () => {
      const invalidPayloads = [
        { automationId: '', enabled: true },
        { automationId: 'auto:test', enabled: 'not-a-boolean' },
        { automationId: null, enabled: true },
        {},
      ];

      for (const payload of invalidPayloads) {
        publishedEvents = [];

        expect(() => {
          dispatcher.execute({
            type: RUNTIME_COMMAND_TYPES.TOGGLE_AUTOMATION,
            payload: payload as ToggleAutomationPayload,
            priority: CommandPriority.PLAYER,
            timestamp: 0,
            step: 0,
          });
        }).not.toThrow();

        // Should not publish event for invalid payload
        expect(publishedEvents).toHaveLength(0);
      }
    });
  });
});
