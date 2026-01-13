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
import { EntitySystem } from './entity-system.js';
import { createEntityDefinition } from './content-test-helpers.js';

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

    it('should successfully submit a valid mission decision', async () => {
      // Create a new setup with mission transform
      const missionDispatcher = new CommandDispatcher();
      const missionPublishedEvents: Array<{ type: string; payload: unknown }> = [];

      const mockMissionEventBus: EventBus = {
        publish: vi.fn((type: string, payload: unknown) => {
          missionPublishedEvents.push({ type, payload });
        }),
        on: vi.fn(),
        off: vi.fn(),
        once: vi.fn(),
      } as unknown as EventBus;

      missionDispatcher.setEventPublisher(mockMissionEventBus);

      const missionTransforms: TransformDefinition[] = [
        {
          id: 'transform:mission' as any,
          name: { default: 'Mission', variants: {} },
          description: { default: 'Test mission', variants: {} },
          mode: 'mission',
          inputs: [],
          outputs: [],
          trigger: { kind: 'manual' },
          tags: [],
          entityRequirements: [
            {
              entityId: 'entity.scout' as any,
              count: { kind: 'constant', value: 1 },
              returnOnComplete: true,
            },
          ],
          successRate: { baseRate: { kind: 'constant', value: 1 }, usePRD: false },
          outcomes: {
            success: { outputs: [], entityExperience: { kind: 'constant', value: 0 } },
          },
          stages: [
            {
              id: 'stage1',
              duration: { kind: 'constant', value: 100 },
              decision: {
                prompt: { default: 'Pick', variants: {} },
                timeout: { kind: 'constant', value: 1000 },
                defaultOption: 'opt1',
                options: [
                  { id: 'opt1', label: { default: 'Option 1', variants: {} }, nextStage: null },
                  { id: 'opt2', label: { default: 'Option 2', variants: {} }, nextStage: null },
                ],
              },
            },
          ],
          initialStage: 'stage1',
        },
      ];

      const missionResourceState = createMockResourceState([
        ['res:gold', 100],
        ['res:gems', 0],
      ]);

      // Create entity system (required for mission transforms)
      const entityDefinition = createEntityDefinition('entity.scout', {
        trackInstances: true,
        startCount: 1,
        unlocked: true,
      });
      const missionEntitySystem = new EntitySystem([entityDefinition], {
        nextInt: () => 1,
      });

      const missionTransformSystem = createTransformSystem({
        transforms: missionTransforms,
        stepDurationMs,
        resourceState: missionResourceState,
        entitySystem: missionEntitySystem,
      });

      registerTransformCommandHandlers({
        dispatcher: missionDispatcher,
        transformSystem: missionTransformSystem,
      });

      // Initialize transforms
      missionTransformSystem.tick({
        deltaMs: stepDurationMs,
        step: 0,
        events: mockMissionEventBus,
      });

      // Execute mission to create batch
      const runResult = await missionDispatcher.executeWithResult({
        type: RUNTIME_COMMAND_TYPES.RUN_TRANSFORM,
        payload: { transformId: 'transform:mission' },
        priority: CommandPriority.PLAYER,
        timestamp: 0,
        step: 0,
      });
      expect(runResult.success).toBe(true);

      // Tick to reach decision point (past stage duration)
      missionTransformSystem.tick({
        deltaMs: stepDurationMs,
        step: 1,
        events: mockMissionEventBus,
      });

      // Find decision-required event to get batchId
      const decisionRequired = missionPublishedEvents.find(
        (e) => e.type === 'mission:decision-required',
      );
      expect(decisionRequired).toBeTruthy();
      const { batchId } = decisionRequired!.payload as { batchId: string };

      // Submit decision
      const result = await missionDispatcher.executeWithResult({
        type: RUNTIME_COMMAND_TYPES.MAKE_MISSION_DECISION,
        payload: {
          transformId: 'transform:mission',
          batchId,
          stageId: 'stage1',
          optionId: 'opt1',
        },
        priority: CommandPriority.PLAYER,
        timestamp: 0,
        step: 1,
      });

      expect(result).toEqual({ success: true });
      expect(
        missionPublishedEvents.some((e) => e.type === 'mission:decision-made'),
      ).toBe(true);
    });
  });
});
