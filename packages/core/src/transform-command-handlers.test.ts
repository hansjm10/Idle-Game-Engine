import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommandDispatcher } from './command-dispatcher.js';
import {
  CommandPriority,
  RUNTIME_COMMAND_TYPES,
  type MakeMissionDecisionPayload,
  type RunTransformPayload,
} from './command.js';
import { registerTransformCommandHandlers } from './transform-command-handlers.js';
import { createTransformSystem } from './transform-system.js';
import type { EventBus } from './events/event-bus.js';
import type { TransformDefinition } from '@idle-engine/content-schema';

describe('registerTransformCommandHandlers', () => {
  const stepDurationMs = 100;

  let dispatcher: CommandDispatcher;
  let transformSystem: ReturnType<typeof createTransformSystem>;
  let resourceState: ReturnType<typeof createMockResourceState>;
  let publishedEvents: Array<{ type: string; payload: unknown }>;

  const createMockResourceState = (resources: ReadonlyArray<[string, number]>) => {
    const indexById = new Map<string, number>();
    const amounts = new Map<number, number>();

    resources.forEach(([id, amount], index) => {
      indexById.set(id, index);
      amounts.set(index, amount);
    });

    return {
      getAmount: (index: number) => amounts.get(index) ?? 0,
      getResourceIndex: (id: string) => indexById.get(id) ?? -1,
      spendAmount: (index: number, amount: number) => {
        const current = amounts.get(index) ?? 0;
        if (current < amount) return false;
        amounts.set(index, current - amount);
        return true;
      },
      addAmount: (index: number, amount: number) => {
        const current = amounts.get(index) ?? 0;
        amounts.set(index, current + amount);
        return amount;
      },
    };
  };

  beforeEach(() => {
    dispatcher = new CommandDispatcher();
    publishedEvents = [];

    const mockEventBus: EventBus = {
      publish: vi.fn((type: string, payload: unknown) => {
        publishedEvents.push({ type, payload });
      }),
      on: vi.fn(),
      off: vi.fn(),
      once: vi.fn(),
    } as unknown as EventBus;

    dispatcher.setEventPublisher(mockEventBus);

    const transforms: TransformDefinition[] = [
      {
        id: 'transform:test' as any,
        name: { default: 'Test', variants: {} },
        description: { default: 'Test transform', variants: {} },
        mode: 'instant',
        inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 10 } }],
        outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } }],
        trigger: { kind: 'manual' },
        tags: [],
      },
    ];

    resourceState = createMockResourceState([
      ['res:gold', 100],
      ['res:gems', 0],
    ]);

    transformSystem = createTransformSystem({
      transforms,
      stepDurationMs,
      resourceState,
    });

    registerTransformCommandHandlers({
      dispatcher,
      transformSystem,
    });
  });

  describe('RUN_TRANSFORM command', () => {
    it('should register handler for RUN_TRANSFORM', () => {
      const handler = dispatcher.getHandler(RUNTIME_COMMAND_TYPES.RUN_TRANSFORM);
      expect(handler).toBeDefined();
    });

    it('should execute manual transforms during command phase', () => {
      const payload: RunTransformPayload = {
        transformId: 'transform:test',
      };

      const result = dispatcher.executeWithResult({
        type: RUNTIME_COMMAND_TYPES.RUN_TRANSFORM,
        payload,
        priority: CommandPriority.PLAYER,
        timestamp: 0,
        step: 0,
      });

      expect(result).toEqual({ success: true });
      expect(transformSystem.getState().get('transform:test')?.unlocked).toBe(true);
      expect(resourceState.getAmount(0)).toBe(90);
      expect(resourceState.getAmount(1)).toBe(1);
      expect(publishedEvents).toHaveLength(0);
    });

    it('should handle invalid transform id payloads', () => {
      const payload = { transformId: '' } as unknown as RunTransformPayload;

      const result = dispatcher.executeWithResult({
        type: RUNTIME_COMMAND_TYPES.RUN_TRANSFORM,
        payload,
        priority: CommandPriority.PLAYER,
        timestamp: 0,
        step: 0,
      });

      expect(result).toEqual({
        success: false,
        error: {
          code: 'INVALID_TRANSFORM_ID',
          message: 'Transform id must be a non-empty string.',
        },
      });
      expect(resourceState.getAmount(0)).toBe(100);
      expect(resourceState.getAmount(1)).toBe(0);
    });

    it('should reject non-integer runs values', () => {
      const payload: RunTransformPayload = {
        transformId: 'transform:test',
        runs: 1.5,
      };

      const result = dispatcher.executeWithResult({
        type: RUNTIME_COMMAND_TYPES.RUN_TRANSFORM,
        payload,
        priority: CommandPriority.PLAYER,
        timestamp: 0,
        step: 0,
      });

      expect(result).toEqual({
        success: false,
        error: {
          code: 'INVALID_RUNS',
          message: 'Runs must be a positive integer.',
        },
      });
      expect(resourceState.getAmount(0)).toBe(100);
      expect(resourceState.getAmount(1)).toBe(0);
    });

    it('should return system error when transform id is unknown', () => {
      const payload: RunTransformPayload = {
        transformId: 'transform:does-not-exist',
      };

      const result = dispatcher.executeWithResult({
        type: RUNTIME_COMMAND_TYPES.RUN_TRANSFORM,
        payload,
        priority: CommandPriority.PLAYER,
        timestamp: 0,
        step: 0,
      });

      expect(result).toEqual({
        success: false,
        error: {
          code: 'UNKNOWN_TRANSFORM',
          message: 'Transform "transform:does-not-exist" not found.',
          details: { transformId: 'transform:does-not-exist' },
        },
      });
      expect(resourceState.getAmount(0)).toBe(100);
      expect(resourceState.getAmount(1)).toBe(0);
    });

    it('should reject commands from unauthorized priority tiers', () => {
      const payload: RunTransformPayload = { transformId: 'transform:test' };

      const result = dispatcher.executeWithResult({
        type: RUNTIME_COMMAND_TYPES.RUN_TRANSFORM,
        payload,
        priority: CommandPriority.AUTOMATION,
        timestamp: 0,
        step: 0,
      });

      expect(result).toEqual({
        success: false,
        error: {
          code: 'COMMAND_UNAUTHORIZED',
          message: 'Command priority is not authorized for this command.',
          details: {
            type: RUNTIME_COMMAND_TYPES.RUN_TRANSFORM,
            priority: CommandPriority.AUTOMATION,
          },
        },
      });
      expect(resourceState.getAmount(0)).toBe(100);
      expect(resourceState.getAmount(1)).toBe(0);
    });
  });

  describe('MAKE_MISSION_DECISION command', () => {
    it('should register handler for MAKE_MISSION_DECISION', () => {
      const handler = dispatcher.getHandler(RUNTIME_COMMAND_TYPES.MAKE_MISSION_DECISION);
      expect(handler).toBeDefined();
    });

    it('should handle invalid batch id payloads', () => {
      const payload = {
        transformId: 'transform:test',
        batchId: '',
        stageId: 'stage',
        optionId: 'option',
      } as unknown as MakeMissionDecisionPayload;

      const result = dispatcher.executeWithResult({
        type: RUNTIME_COMMAND_TYPES.MAKE_MISSION_DECISION,
        payload,
        priority: CommandPriority.PLAYER,
        timestamp: 0,
        step: 0,
      });

      expect(result).toEqual({
        success: false,
        error: {
          code: 'INVALID_BATCH_ID',
          message: 'Batch id must be a non-empty string.',
        },
      });
    });

    it('should return system error when transform is not a multi-stage mission', async () => {
      const payload: MakeMissionDecisionPayload = {
        transformId: 'transform:test',
        batchId: '0',
        stageId: 'stage',
        optionId: 'option',
      };

      const result = await dispatcher.executeWithResult({
        type: RUNTIME_COMMAND_TYPES.MAKE_MISSION_DECISION,
        payload,
        priority: CommandPriority.PLAYER,
        timestamp: 0,
        step: 0,
      });

      expect(result.success).toBe(false);
      if (result.success) {
        throw new Error('Expected command to fail.');
      }

      expect(result.error.code).toBe('INVALID_TRANSFORM_MODE');
    });

    it('should reject commands from unauthorized priority tiers', () => {
      const payload: MakeMissionDecisionPayload = {
        transformId: 'transform:test',
        batchId: '0',
        stageId: 'stage',
        optionId: 'option',
      };

      const result = dispatcher.executeWithResult({
        type: RUNTIME_COMMAND_TYPES.MAKE_MISSION_DECISION,
        payload,
        priority: CommandPriority.AUTOMATION,
        timestamp: 0,
        step: 0,
      });

      expect(result).toEqual({
        success: false,
        error: {
          code: 'COMMAND_UNAUTHORIZED',
          message: 'Command priority is not authorized for this command.',
          details: {
            type: RUNTIME_COMMAND_TYPES.MAKE_MISSION_DECISION,
            priority: CommandPriority.AUTOMATION,
          },
        },
      });
    });
  });
});
