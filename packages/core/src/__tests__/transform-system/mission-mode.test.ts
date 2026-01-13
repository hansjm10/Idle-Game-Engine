import { describe, expect, it, vi } from 'vitest';
import type { TransformDefinition } from '@idle-engine/content-schema';

import type { ResourceStateAccessor } from '../../automation-system.js';
import { createEntityDefinition } from '../../content-test-helpers.js';
import { EntitySystem } from '../../entity-system.js';
import { PRDRegistry } from '../../rng.js';
import type { TransformState } from '../../transform-system.js';
import {
  buildTransformSnapshot,
  createTransformSystem,
  getTransformState,
  serializeTransformState,
} from '../../transform-system.js';
import { createMockResourceState } from '../helpers/transform-fixtures.js';

describe('TransformSystem', () => {
  const stepDurationMs = 100;

  const getResourceAmount = (
    resourceState: ResourceStateAccessor,
    resourceId: string,
  ): number => {
    const resourceIndex = resourceState.getResourceIndex?.(resourceId) ?? -1;
    expect(resourceIndex).toBeGreaterThanOrEqual(0);
    return resourceState.getAmount(resourceIndex);
  };

  const createMissionTransform = (
    overrides: Partial<TransformDefinition> = {},
  ): TransformDefinition => ({
    id: 'transform:mission' as any,
    name: { default: 'Mission', variants: {} },
    description: { default: 'Mission transform', variants: {} },
    mode: 'mission',
    inputs: [
      { resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 1 } },
    ],
    outputs: [],
    duration: { kind: 'constant', value: 100 },
    entityRequirements: [
      {
        entityId: 'entity.scout' as any,
        count: { kind: 'constant', value: 1 },
        returnOnComplete: true,
      },
    ],
    trigger: { kind: 'manual' },
    tags: [],
    ...overrides,
  });

  const createEntitySystemWithStats = (
    statsByInstance: Array<Record<string, number>>,
  ): EntitySystem => {
    const entityDefinition = createEntityDefinition('entity.scout', {
      trackInstances: true,
      startCount: statsByInstance.length,
      unlocked: true,
    });
    const entitySystem = new EntitySystem([entityDefinition], {
      nextInt: () => 1,
    });
    const instances = entitySystem.getInstancesForEntity('entity.scout');

    instances.forEach((instance, index) => {
      const state = entitySystem.getInstanceState(instance.instanceId) as
        | { stats: Record<string, number> }
        | undefined;
      if (state) {
        state.stats = { ...statsByInstance[index] };
      }
    });

    return entitySystem;
  };

  const createMissionHarness = ({
    transformOverrides = {},
    entitySystem = createEntitySystemWithStats([{ power: 1 }]),
    resourceState = createMockResourceState(
      new Map([
        ['res:gold', { amount: 100 }],
        ['res:gems', { amount: 0 }],
      ]),
    ),
    prdRegistry,
  }: {
    transformOverrides?: Partial<TransformDefinition>;
    entitySystem?: EntitySystem;
    resourceState?: ResourceStateAccessor & {
      addAmount?: (idx: number, amount: number) => number;
    };
    prdRegistry?: PRDRegistry;
  } = {}) => {
    const transforms = [createMissionTransform(transformOverrides)];
    const system = createTransformSystem({
      transforms,
      stepDurationMs,
      resourceState,
      entitySystem,
      prdRegistry,
    });

    system.tick({ deltaMs: stepDurationMs, step: 0, events: { publish: vi.fn() } });

    return { system, transforms, resourceState, entitySystem };
  };

  describe('mission mode', () => {
    it('rejects mission transforms without an entity system', () => {
      const transforms = [createMissionTransform()];
      const resourceState = createMockResourceState(
        new Map([
          ['res:gold', { amount: 100 }],
          ['res:gems', { amount: 0 }],
        ]),
      );

      const system = createTransformSystem({
        transforms,
        stepDurationMs,
        resourceState,
      });

      system.tick({ deltaMs: stepDurationMs, step: 0, events: { publish: vi.fn() } });

      const result = system.executeTransform('transform:mission', 0);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MISSING_ENTITY_SYSTEM');
    });

    it('uses PRD to determine outcome at completion time', () => {
      const resourceState = createMockResourceState(
        new Map([
          ['res:gold', { amount: 100 }],
          ['res:gems', { amount: 0 }],
        ]),
      );
      const entitySystem = createEntitySystemWithStats([{ power: 1 }]);
      let prdCallCount = 0;
      const prdRegistry = new PRDRegistry(() => {
        prdCallCount += 1;
        return 0;
      });

      const { system } = createMissionHarness({
        resourceState,
        entitySystem,
        prdRegistry,
        transformOverrides: {
          successRate: {
            baseRate: { kind: 'constant', value: 1 },
            usePRD: true,
          },
          outcomes: {
            success: {
              outputs: [
                { resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 3 } },
              ],
              entityExperience: { kind: 'constant', value: 5 },
            },
          },
        },
      });

      const publish = vi.fn();
      const events = { publish };

      const result = system.executeTransform('transform:mission', 0, {
        events: events as any,
      });
      expect(result.success).toBe(true);

      const prdCallsBeforeCompletion = prdCallCount;
      system.tick({ deltaMs: stepDurationMs, step: 1, events: events as any });

      expect(prdCallCount).toBeGreaterThan(prdCallsBeforeCompletion);
      expect(getResourceAmount(resourceState, 'res:gems')).toBe(3);

      const completed = publish.mock.calls.find(([type]) => type === 'mission:completed');
      expect(completed).toBeTruthy();
      const payload = completed?.[1] as any;
      expect(payload.success).toBe(true);
    });

    it('grants checkpoint rewards across multiple stages', () => {
      const { system, resourceState, entitySystem } = createMissionHarness({
        transformOverrides: {
          successRate: {
            baseRate: { kind: 'constant', value: 1 },
            usePRD: false,
          },
          outcomes: {
            success: {
              outputs: [
                { resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 5 } },
              ],
              entityExperience: { kind: 'constant', value: 0 },
            },
          },
          stages: [
            {
              id: 'stage1',
              duration: { kind: 'constant', value: 100 },
              checkpoint: {
                outputs: [
                  { resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 2 } },
                ],
              },
              nextStage: 'stage2',
            },
            {
              id: 'stage2',
              duration: { kind: 'constant', value: 100 },
              nextStage: null,
            },
          ],
          initialStage: 'stage1',
        },
      });

      const instanceId = entitySystem.getInstancesForEntity('entity.scout')[0]?.instanceId;
      expect(instanceId).toBeTruthy();

      const publish = vi.fn();
      const events = { publish };

      const result = system.executeTransform('transform:mission', 0, { events: events as any });
      expect(result.success).toBe(true);

      system.tick({ deltaMs: stepDurationMs, step: 1, events: events as any });
      expect(getResourceAmount(resourceState, 'res:gems')).toBe(2);

      system.tick({ deltaMs: stepDurationMs, step: 2, events: events as any });
      expect(getResourceAmount(resourceState, 'res:gems')).toBe(7);

      if (instanceId) {
        expect(entitySystem.getInstanceState(instanceId)?.assignment).toBeNull();
      }

      const stageCompletedEvents = publish.mock.calls.filter(
        ([type]) => type === 'mission:stage-completed',
      );
      expect(stageCompletedEvents).toHaveLength(2);

      const completed = publish.mock.calls.find(([type]) => type === 'mission:completed');
      expect(completed).toBeTruthy();
      const payload = completed?.[1] as any;
      expect(payload.success).toBe(true);
    });

    it('grants checkpoint entityExperience to assigned entities', () => {
      const { system, entitySystem } = createMissionHarness({
        transformOverrides: {
          successRate: {
            baseRate: { kind: 'constant', value: 1 },
            usePRD: false,
          },
          outcomes: {
            success: {
              outputs: [],
              entityExperience: { kind: 'constant', value: 10 },
            },
          },
          stages: [
            {
              id: 'stage1',
              duration: { kind: 'constant', value: 100 },
              checkpoint: {
                outputs: [],
                entityExperience: { kind: 'constant', value: 25 },
              },
              nextStage: 'stage2',
            },
            {
              id: 'stage2',
              duration: { kind: 'constant', value: 100 },
              nextStage: null,
            },
          ],
          initialStage: 'stage1',
        },
      });

      const instanceId = entitySystem.getInstancesForEntity('entity.scout')[0]?.instanceId;
      expect(instanceId).toBeTruthy();

      const publish = vi.fn();
      const events = { publish };

      // Start mission
      const result = system.executeTransform('transform:mission', 0, { events: events as any });
      expect(result.success).toBe(true);

      // Initial experience should be 0
      const initialExp = entitySystem.getInstanceState(instanceId!)?.experience ?? 0;
      expect(initialExp).toBe(0);

      // Tick to complete stage 1 (checkpoint grants 25 experience)
      system.tick({ deltaMs: stepDurationMs, step: 1, events: events as any });

      // Verify checkpoint experience was granted
      const expAfterStage1 = entitySystem.getInstanceState(instanceId!)?.experience ?? 0;
      expect(expAfterStage1).toBe(25);

      // Tick to complete stage 2 and mission (mission grants 10 more)
      system.tick({ deltaMs: stepDurationMs, step: 2, events: events as any });

      // Verify total experience: 25 (checkpoint) + 10 (mission success) = 35
      const finalExp = entitySystem.getInstanceState(instanceId!)?.experience ?? 0;
      expect(finalExp).toBe(35);
    });

    it('uses stage outcome override instead of mission outcome on success', () => {
      const resourceState = createMockResourceState(
        new Map([
          ['res:gold', { amount: 100 }],
          ['res:gems', { amount: 0 }],
          ['res:iron', { amount: 0 }],
        ]),
      );

      const { system } = createMissionHarness({
        resourceState,
        transformOverrides: {
          successRate: {
            baseRate: { kind: 'constant', value: 1 },
            usePRD: false,
          },
          outcomes: {
            success: {
              outputs: [
                { resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 100 } },
              ],
              entityExperience: { kind: 'constant', value: 0 },
            },
          },
          stages: [
            {
              id: 'stage1',
              duration: { kind: 'constant', value: 100 },
              stageSuccessRate: { kind: 'constant', value: 1 },
              stageOutcomes: {
                success: {
                  outputs: [
                    { resourceId: 'res:iron' as any, amount: { kind: 'constant', value: 50 } },
                  ],
                  entityExperience: { kind: 'constant', value: 0 },
                },
              },
              nextStage: null,
            },
          ],
          initialStage: 'stage1',
        },
      });

      const publish = vi.fn();
      const events = { publish };

      const result = system.executeTransform('transform:mission', 0, { events: events as any });
      expect(result.success).toBe(true);

      // Complete the mission
      system.tick({ deltaMs: stepDurationMs, step: 1, events: events as any });

      // Stage outcome override should grant iron, NOT gems
      expect(getResourceAmount(resourceState, 'res:iron')).toBe(50);
      expect(getResourceAmount(resourceState, 'res:gems')).toBe(0);
    });

    it('uses stage outcome override instead of mission outcome on failure', () => {
      const resourceState = createMockResourceState(
        new Map([
          ['res:gold', { amount: 100 }],
          ['res:gems', { amount: 0 }],
          ['res:copper', { amount: 0 }],
        ]),
      );

      const { system } = createMissionHarness({
        resourceState,
        transformOverrides: {
          successRate: {
            baseRate: { kind: 'constant', value: 1 },
            usePRD: false,
          },
          outcomes: {
            success: {
              outputs: [],
              entityExperience: { kind: 'constant', value: 0 },
            },
            failure: {
              outputs: [
                { resourceId: 'res:copper' as any, amount: { kind: 'constant', value: 5 } },
              ],
              entityExperience: { kind: 'constant', value: 0 },
            },
          },
          stages: [
            {
              id: 'stage1',
              duration: { kind: 'constant', value: 100 },
              stageSuccessRate: { kind: 'constant', value: 0 }, // Guaranteed failure
              stageOutcomes: {
                failure: {
                  outputs: [
                    { resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 10 } },
                  ],
                  entityExperience: { kind: 'constant', value: 0 },
                },
              },
              nextStage: null,
            },
          ],
          initialStage: 'stage1',
        },
      });

      const publish = vi.fn();
      const events = { publish };

      const result = system.executeTransform('transform:mission', 0, { events: events as any });
      expect(result.success).toBe(true);

      // Complete the mission (stage fails)
      system.tick({ deltaMs: stepDurationMs, step: 1, events: events as any });

      // Stage failure override should grant gems, NOT copper
      expect(getResourceAmount(resourceState, 'res:gems')).toBe(10);
      expect(getResourceAmount(resourceState, 'res:copper')).toBe(0);

      // Verify mission completed with failure
      const completed = publish.mock.calls.find(([type]) => type === 'mission:completed');
      expect(completed).toBeTruthy();
      expect((completed?.[1] as any).success).toBe(false);
    });

    it('pauses on decisions and auto-selects the default option on timeout', () => {
      const { system, resourceState, entitySystem } = createMissionHarness({
        transformOverrides: {
          successRate: {
            baseRate: { kind: 'constant', value: 1 },
            usePRD: false,
          },
          outcomes: {
            success: {
              outputs: [
                { resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 5 } },
              ],
              entityExperience: { kind: 'constant', value: 0 },
            },
          },
          stages: [
            {
              id: 'stage1',
              duration: { kind: 'constant', value: 100 },
              checkpoint: {
                outputs: [
                  { resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } },
                ],
              },
              decision: {
                prompt: { default: 'Pick a path', variants: {} },
                timeout: { kind: 'constant', value: 100 },
                defaultOption: 'left',
                options: [
                  {
                    id: 'left',
                    label: { default: 'Left', variants: {} },
                    nextStage: 'stage2',
                    modifiers: {
                      successRateBonus: { kind: 'constant', value: 1 },
                      durationMultiplier: { kind: 'constant', value: 2 },
                      outputMultiplier: { kind: 'constant', value: 2 },
                    },
                  },
                  {
                    id: 'right',
                    label: { default: 'Right', variants: {} },
                    nextStage: null,
                  },
                ],
              },
            },
            {
              id: 'stage2',
              duration: { kind: 'constant', value: 100 },
              stageSuccessRate: { kind: 'constant', value: 0 },
              nextStage: null,
            },
          ],
          initialStage: 'stage1',
        },
      });

      const instanceId = entitySystem.getInstancesForEntity('entity.scout')[0]?.instanceId;
      expect(instanceId).toBeTruthy();

      const publish = vi.fn();
      const events = { publish };

      const result = system.executeTransform('transform:mission', 0, { events: events as any });
      expect(result.success).toBe(true);

      // Stage 1 completes at step 1 and triggers decision requirement.
      system.tick({ deltaMs: stepDurationMs, step: 1, events: events as any });
      expect(getResourceAmount(resourceState, 'res:gems')).toBe(1);

      const decisionRequired = publish.mock.calls.find(
        ([type]) => type === 'mission:decision-required',
      );
      expect(decisionRequired).toBeTruthy();

      // Auto-select default option after timeout (1 step).
      system.tick({ deltaMs: stepDurationMs, step: 2, events: events as any });
      const decisionMade = publish.mock.calls.find(
        ([type]) => type === 'mission:decision-made',
      );
      expect(decisionMade).toBeTruthy();

      // Duration multiplier delays stage 2 completion until step 4.
      system.tick({ deltaMs: stepDurationMs, step: 3, events: events as any });
      expect(getResourceAmount(resourceState, 'res:gems')).toBe(1);

      system.tick({ deltaMs: stepDurationMs, step: 4, events: events as any });
      expect(getResourceAmount(resourceState, 'res:gems')).toBe(11);

      if (instanceId) {
        expect(entitySystem.getInstanceState(instanceId)?.assignment).toBeNull();
      }

      const completed = publish.mock.calls.find(([type]) => type === 'mission:completed');
      expect(completed).toBeTruthy();
      const payload = completed?.[1] as any;
      expect(payload.success).toBe(true);
    });

    it('falls back to the first available option when default option is unavailable on timeout', () => {
      const { system, resourceState, entitySystem } = createMissionHarness({
        transformOverrides: {
          successRate: {
            baseRate: { kind: 'constant', value: 1 },
            usePRD: false,
          },
          outcomes: {
            success: {
              outputs: [
                { resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 10 } },
              ],
              entityExperience: { kind: 'constant', value: 0 },
            },
            failure: {
              outputs: [
                { resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 3 } },
              ],
              entityExperience: { kind: 'constant', value: 0 },
            },
          },
          stages: [
            {
              id: 'stage1',
              duration: { kind: 'constant', value: 100 },
              checkpoint: {
                outputs: [
                  { resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } },
                ],
              },
              decision: {
                prompt: { default: 'Pick a path', variants: {} },
                timeout: { kind: 'constant', value: 100 },
                defaultOption: 'left',
                options: [
                  {
                    id: 'left',
                    label: { default: 'Left', variants: {} },
                    condition: { kind: 'never' },
                    nextStage: null,
                  },
                  {
                    id: 'right',
                    label: { default: 'Right', variants: {} },
                    nextStage: null,
                  },
                ],
              },
            },
          ],
          initialStage: 'stage1',
        },
      });

      const instanceId = entitySystem.getInstancesForEntity('entity.scout')[0]?.instanceId;
      expect(instanceId).toBeTruthy();

      const publish = vi.fn();
      const events = { publish };

      const result = system.executeTransform('transform:mission', 0, { events: events as any });
      expect(result.success).toBe(true);

      system.tick({ deltaMs: stepDurationMs, step: 1, events: events as any });
      expect(getResourceAmount(resourceState, 'res:gems')).toBe(1);

      const decisionRequired = publish.mock.calls.find(
        ([type]) => type === 'mission:decision-required',
      );
      expect(decisionRequired).toBeTruthy();
      const decisionRequiredPayload = decisionRequired?.[1] as any;
      expect(decisionRequiredPayload.options).toEqual([
        { id: 'left', label: 'Left', available: false },
        { id: 'right', label: 'Right', available: true },
      ]);

      system.tick({ deltaMs: stepDurationMs, step: 2, events: events as any });
      expect(getResourceAmount(resourceState, 'res:gems')).toBe(11);

      if (instanceId) {
        expect(entitySystem.getInstanceState(instanceId)?.assignment).toBeNull();
      }

      const decisionMade = publish.mock.calls.find(([type]) => type === 'mission:decision-made');
      expect(decisionMade).toBeTruthy();
      const decisionMadePayload = decisionMade?.[1] as any;
      expect(decisionMadePayload.optionId).toBe('right');

      const completed = publish.mock.calls.find(([type]) => type === 'mission:completed');
      expect(completed).toBeTruthy();
      const payload = completed?.[1] as any;
      expect(payload.success).toBe(true);
    });

    it('fails decision timeouts when no options are available', () => {
      const { system, resourceState, entitySystem } = createMissionHarness({
        transformOverrides: {
          successRate: {
            baseRate: { kind: 'constant', value: 1 },
            usePRD: false,
          },
          outcomes: {
            success: {
              outputs: [
                { resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 10 } },
              ],
              entityExperience: { kind: 'constant', value: 0 },
            },
            failure: {
              outputs: [
                { resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 3 } },
              ],
              entityExperience: { kind: 'constant', value: 0 },
            },
          },
          stages: [
            {
              id: 'stage1',
              duration: { kind: 'constant', value: 100 },
              checkpoint: {
                outputs: [
                  { resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } },
                ],
              },
              decision: {
                prompt: { default: 'Pick a path', variants: {} },
                timeout: { kind: 'constant', value: 100 },
                defaultOption: 'left',
                options: [
                  {
                    id: 'left',
                    label: { default: 'Left', variants: {} },
                    condition: { kind: 'never' },
                    nextStage: null,
                  },
                  {
                    id: 'right',
                    label: { default: 'Right', variants: {} },
                    condition: { kind: 'never' },
                    nextStage: null,
                  },
                ],
              },
            },
          ],
          initialStage: 'stage1',
        },
      });

      const instanceId = entitySystem.getInstancesForEntity('entity.scout')[0]?.instanceId;
      expect(instanceId).toBeTruthy();

      const publish = vi.fn();
      const events = { publish };

      const result = system.executeTransform('transform:mission', 0, { events: events as any });
      expect(result.success).toBe(true);

      system.tick({ deltaMs: stepDurationMs, step: 1, events: events as any });
      expect(getResourceAmount(resourceState, 'res:gems')).toBe(1);

      const decisionRequired = publish.mock.calls.find(
        ([type]) => type === 'mission:decision-required',
      );
      expect(decisionRequired).toBeTruthy();
      const decisionRequiredPayload = decisionRequired?.[1] as any;
      expect(decisionRequiredPayload.options).toEqual([
        { id: 'left', label: 'Left', available: false },
        { id: 'right', label: 'Right', available: false },
      ]);

      system.tick({ deltaMs: stepDurationMs, step: 2, events: events as any });
      expect(getResourceAmount(resourceState, 'res:gems')).toBe(4);

      if (instanceId) {
        expect(entitySystem.getInstanceState(instanceId)?.assignment).toBeNull();
      }

      const decisionMade = publish.mock.calls.find(
        ([type]) => type === 'mission:decision-made',
      );
      expect(decisionMade).toBeFalsy();

      const completed = publish.mock.calls.find(([type]) => type === 'mission:completed');
      expect(completed).toBeTruthy();
      const payload = completed?.[1] as any;
      expect(payload.success).toBe(false);
    });

    it('serializes mission batches with entity metadata and snapshots next batch time', () => {
      const resourceState = createMockResourceState(
        new Map([
          ['res:gold', { amount: 10 }],
          ['res:gems', { amount: 0 }],
        ]),
      );
      const entitySystem = createEntitySystemWithStats([{ power: 1 }]);
      const { system, transforms } = createMissionHarness({
        resourceState,
        entitySystem,
        transformOverrides: {
          entityRequirements: [
            {
              entityId: 'entity.scout' as any,
              count: { kind: 'constant', value: 1 },
              returnOnComplete: false,
            },
          ],
          outcomes: {
            success: {
              outputs: [
                { resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } },
              ],
              entityExperience: { kind: 'constant', value: 5 },
            },
          },
        },
      });

      const instanceId = entitySystem.getInstancesForEntity('entity.scout')[0]
        ?.instanceId;
      expect(instanceId).toBeTruthy();

      const result = system.executeTransform('transform:mission', 0);
      expect(result.success).toBe(true);

      if (instanceId) {
        expect(
          entitySystem.getInstanceState(instanceId)?.assignment?.returnStep,
        ).toBe(Number.MAX_SAFE_INTEGER);
      }

      const state = getTransformState(system).get('transform:mission');
      expect(state?.batches?.[0].entityInstanceIds).toEqual(
        instanceId ? [instanceId] : [],
      );
      expect(state?.batches?.[0].batchId).toBe('0');
      expect(state?.batches?.[0].outputs).toEqual([]);
      expect(state?.batches?.[0].mission?.success.entityExperience).toBe(5);

      const serialized = serializeTransformState(system.getState());
      const serializedBatch = serialized[0]?.batches?.[0];
      expect(serializedBatch?.entityInstanceIds).toEqual(
        instanceId ? [instanceId] : [],
      );
      expect(serializedBatch?.batchId).toBe('0');
      expect(serializedBatch?.outputs).toEqual([]);
      expect(serializedBatch?.mission?.success.entityExperience).toBe(5);

      const restoredResourceState = createMockResourceState(
        new Map([
          ['res:gold', { amount: 0 }],
          ['res:gems', { amount: 0 }],
        ]),
      );
      const restored = createTransformSystem({
        transforms,
        stepDurationMs,
        resourceState: restoredResourceState,
      });

      restored.restoreState(serialized);

      const restoredState = getTransformState(restored).get('transform:mission');
      expect(restoredState?.batches?.[0].entityInstanceIds).toEqual(
        instanceId ? [instanceId] : [],
      );
      expect(restoredState?.batches?.[0].batchId).toBe('0');
      expect(restoredState?.batches?.[0].outputs).toEqual([]);
      expect(restoredState?.batches?.[0].mission?.success.entityExperience).toBe(5);

      const snapshot = buildTransformSnapshot(0, 0, {
        transforms,
        state: restored.getState(),
        stepDurationMs,
        resourceState: restoredResourceState,
      });

      expect(snapshot.transforms[0]?.nextBatchReadyAtStep).toBe(
        restoredState?.batches?.[0].completeAtStep,
      );
    });

    it('omits next batch timing when no mission batches exist', () => {
      const transforms = [createMissionTransform()];

      const snapshot = buildTransformSnapshot(0, 0, {
        transforms,
        state: new Map(),
        stepDurationMs,
      });

      expect(snapshot.transforms[0]?.outstandingBatches).toBe(0);
      expect(snapshot.transforms[0]?.nextBatchReadyAtStep).toBeUndefined();
    });

    it('sorts snapshot endpoints and computes affordability without resource state', () => {
      const transforms: TransformDefinition[] = [
        {
          id: 'transform:sorted' as any,
          name: { default: 'Sorted', variants: {} },
          description: { default: 'Sorted', variants: {} },
          mode: 'instant',
          inputs: [
            { resourceId: 'res:b' as any, amount: { kind: 'constant', value: 0 } },
            { resourceId: 'res:a' as any, amount: { kind: 'constant', value: 0 } },
          ],
          outputs: [
            { resourceId: 'res:b' as any, amount: { kind: 'constant', value: 2 } },
            { resourceId: 'res:a' as any, amount: { kind: 'constant', value: 1 } },
          ],
          trigger: { kind: 'manual' },
          tags: [],
        },
      ];

      const state = new Map<string, TransformState>();
      state.set('transform:sorted', {
        id: 'transform:sorted',
        unlocked: true,
        visible: true,
        cooldownExpiresStep: 0,
        runsThisTick: 0,
      });

      const snapshot = buildTransformSnapshot(0, 0, {
        transforms,
        state,
        stepDurationMs,
      });

      expect(snapshot.transforms[0]?.inputs.map(({ resourceId }) => resourceId)).toEqual([
        'res:a',
        'res:b',
      ]);
      expect(snapshot.transforms[0]?.outputs.map(({ resourceId }) => resourceId)).toEqual([
        'res:a',
        'res:b',
      ]);
      expect(snapshot.transforms[0]?.canAfford).toBe(true);

      const expensiveSnapshot = buildTransformSnapshot(0, 0, {
        transforms: [
          {
            ...transforms[0],
            id: 'transform:sorted-expensive' as any,
            inputs: [
              { resourceId: 'res:b' as any, amount: { kind: 'constant', value: 1 } },
              { resourceId: 'res:a' as any, amount: { kind: 'constant', value: 1 } },
            ],
          },
        ],
        state: new Map([
          [
            'transform:sorted-expensive',
            {
              id: 'transform:sorted-expensive',
              unlocked: true,
              visible: true,
              cooldownExpiresStep: 0,
              runsThisTick: 0,
            },
          ],
        ]),
        stepDurationMs,
      });

      expect(expensiveSnapshot.transforms[0]?.canAfford).toBe(false);
    });

    it('normalizes non-finite batch outputs during serialization', () => {
      const state = new Map<string, TransformState>();
      state.set('transform:mission', {
        id: 'transform:mission',
        unlocked: true,
        visible: true,
        cooldownExpiresStep: 0,
        runsThisTick: 0,
        batches: [
          {
            completeAtStep: 1,
            outputs: [
              {
                resourceId: 'res:gold' as any,
                amount: Number.NaN,
              },
            ],
          },
        ],
      });

      const serialized = serializeTransformState(state);

      expect(serialized[0]?.batches?.[0].outputs[0]?.amount).toBe(0);
    });

    it('completes restored mission batches with correct outcomes', () => {
      const transforms = [
        createMissionTransform({
          successRate: {
            baseRate: { kind: 'constant', value: 1 },
            usePRD: false,
          },
          outcomes: {
            success: {
              outputs: [
                { resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 5 } },
              ],
              entityExperience: { kind: 'constant', value: 10 },
            },
            critical: {
              chance: { kind: 'constant', value: 1 },
              outputs: [
                { resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 8 } },
              ],
              entityExperience: { kind: 'constant', value: 15 },
            },
          },
        }),
      ];
      const resourceState = createMockResourceState(
        new Map([
          ['res:gold', { amount: 0 }],
          ['res:gems', { amount: 0 }],
        ]),
      );
      const entitySystem = createEntitySystemWithStats([{ power: 1 }]);
      const instanceId = entitySystem.getInstancesForEntity('entity.scout')[0]?.instanceId;
      expect(instanceId).toBeTruthy();

      const system = createTransformSystem({
        transforms,
        stepDurationMs,
        resourceState,
        entitySystem,
      });

      system.restoreState([
        {
          id: 'transform:mission',
          unlocked: true,
          cooldownExpiresStep: 0,
          batches: [
            {
              batchId: 'restored-batch',
              completeAtStep: 1,
              outputs: [],
              entityInstanceIds: [instanceId!],
              mission: {
                baseRate: 1,
                usePRD: false,
                criticalChance: 1,
                success: {
                  outputs: [{ resourceId: 'res:gems' as any, amount: 5 }],
                  entityExperience: 10,
                },
                failure: {
                  outputs: [],
                  entityExperience: 0,
                },
                critical: {
                  outputs: [{ resourceId: 'res:gems' as any, amount: 8 }],
                  entityExperience: 15,
                },
              },
            },
          ],
        },
      ]);

      const publish = vi.fn();
      const events = { publish };

      system.tick({ deltaMs: stepDurationMs, step: 1, events: events as any });

      expect(getResourceAmount(resourceState, 'res:gems')).toBe(8);
      expect(entitySystem.getInstanceState(instanceId!)?.experience).toBe(15);

      const completed = publish.mock.calls.find(([type]) => type === 'mission:completed');
      expect(completed).toBeTruthy();
      const payload = completed?.[1] as any;
      expect(payload.batchId).toBe('restored-batch');
      expect(payload.outcomeKind).toBe('critical');
      expect(payload.success).toBe(true);
      expect(payload.critical).toBe(true);
    });

    it('handles empty assignments and missing outcomes', () => {
      const { system, entitySystem } = createMissionHarness({
        transformOverrides: {
          entityRequirements: [
            {
              entityId: 'entity.scout' as any,
              count: { kind: 'constant', value: 0 },
              returnOnComplete: true,
            },
          ],
          successRate: {
            baseRate: { kind: 'constant', value: 0 },
            usePRD: false,
            statModifiers: [
              {
                stat: 'power' as any,
                weight: { kind: 'constant', value: 1 },
                entityScope: 'average',
              },
            ],
          },
        },
      });

      const result = system.executeTransform('transform:mission', 0);
      expect(result.success).toBe(true);

      const instance = entitySystem.getInstancesForEntity('entity.scout')[0];
      if (instance) {
        expect(
          entitySystem.getInstanceState(instance.instanceId)?.assignment,
        ).toBeNull();
      }

      const state = getTransformState(system).get('transform:mission');
      expect(state?.batches?.[0].outputs).toEqual([]);
    });

    it('treats missing failure outcome as no rewards on failure', () => {
      const { system, resourceState, entitySystem } = createMissionHarness({
        transformOverrides: {
          successRate: {
            baseRate: { kind: 'constant', value: 0 },
            usePRD: false,
          },
          outcomes: {
            success: {
              outputs: [
                { resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 3 } },
              ],
              entityExperience: { kind: 'constant', value: 10 },
            },
          },
        },
      });

      const publish = vi.fn();
      const events = { publish };
      const instanceId = entitySystem.getInstancesForEntity('entity.scout')[0]?.instanceId;

      const result = system.executeTransform('transform:mission', 0, {
        events: events as any,
      });
      expect(result.success).toBe(true);

      system.tick({ deltaMs: stepDurationMs, step: 1, events: events as any });

      expect(getResourceAmount(resourceState, 'res:gems')).toBe(0);
      if (instanceId) {
        expect(entitySystem.getInstanceState(instanceId)?.experience).toBe(0);
      }

      const completed = publish.mock.calls.find(([type]) => type === 'mission:completed');
      expect(completed).toBeTruthy();
      const payload = completed?.[1] as any;
      expect(payload.outcomeKind).toBe('failure');
      expect(payload.outputs).toEqual([]);
      expect(payload.entityExperience).toBe(0);
    });

    it('applies critical outcomes when rolled at completion', () => {
      const { system, resourceState, entitySystem } = createMissionHarness({
        transformOverrides: {
          successRate: {
            baseRate: { kind: 'constant', value: 1 },
            usePRD: false,
          },
          outcomes: {
            success: {
              outputs: [
                { resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } },
              ],
              entityExperience: { kind: 'constant', value: 5 },
            },
            critical: {
              chance: { kind: 'constant', value: 1 },
              outputs: [
                { resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 2 } },
              ],
              entityExperience: { kind: 'constant', value: 7 },
            },
          },
        },
      });

      const publish = vi.fn();
      const events = { publish };
      const instanceId = entitySystem.getInstancesForEntity('entity.scout')[0]?.instanceId;

      const result = system.executeTransform('transform:mission', 0, {
        events: events as any,
      });
      expect(result.success).toBe(true);

      system.tick({ deltaMs: stepDurationMs, step: 1, events: events as any });

      expect(getResourceAmount(resourceState, 'res:gems')).toBe(2);
      if (instanceId) {
        expect(entitySystem.getInstanceState(instanceId)?.experience).toBe(7);
      }

      const completed = publish.mock.calls.find(([type]) => type === 'mission:completed');
      expect(completed).toBeTruthy();
      const payload = completed?.[1] as any;
      expect(payload.outcomeKind).toBe('critical');
      expect(payload.success).toBe(true);
      expect(payload.critical).toBe(true);
      expect(payload.outputs).toEqual([{ resourceId: 'res:gems', amount: 2 }]);
      expect(payload.entityExperience).toBe(7);
    });

    it('publishes mission:started event when mission begins', () => {
      const { system, entitySystem } = createMissionHarness({
        transformOverrides: {
          duration: { kind: 'constant', value: 200 },
          outcomes: {
            success: {
              outputs: [
                { resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } },
              ],
            },
          },
        },
      });

      const publish = vi.fn();
      const events = { publish };
      const instanceId = entitySystem.getInstancesForEntity('entity.scout')[0]?.instanceId;

      const result = system.executeTransform('transform:mission', 0, {
        events: events as any,
      });
      expect(result.success).toBe(true);

      const started = publish.mock.calls.find(([type]) => type === 'mission:started');
      expect(started).toBeTruthy();
      const payload = started?.[1] as any;
      expect(payload.transformId).toBe('transform:mission');
      expect(payload.batchId).toBe('0');
      expect(payload.startedAtStep).toBe(0);
      expect(payload.completeAtStep).toBe(2);
      expect(payload.entityInstanceIds).toEqual(instanceId ? [instanceId] : []);
    });

    it('applies explicit failure outcome rewards on failure', () => {
      const { system, resourceState, entitySystem } = createMissionHarness({
        transformOverrides: {
          successRate: {
            baseRate: { kind: 'constant', value: 0 },
            usePRD: false,
          },
          outcomes: {
            success: {
              outputs: [
                { resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 5 } },
              ],
              entityExperience: { kind: 'constant', value: 10 },
            },
            failure: {
              outputs: [
                { resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } },
              ],
              entityExperience: { kind: 'constant', value: 2 },
            },
          },
        },
      });

      const publish = vi.fn();
      const events = { publish };
      const instanceId = entitySystem.getInstancesForEntity('entity.scout')[0]?.instanceId;

      const result = system.executeTransform('transform:mission', 0, {
        events: events as any,
      });
      expect(result.success).toBe(true);

      system.tick({ deltaMs: stepDurationMs, step: 1, events: events as any });

      expect(getResourceAmount(resourceState, 'res:gems')).toBe(1);
      if (instanceId) {
        expect(entitySystem.getInstanceState(instanceId)?.experience).toBe(2);
      }

      const completed = publish.mock.calls.find(([type]) => type === 'mission:completed');
      expect(completed).toBeTruthy();
      const payload = completed?.[1] as any;
      expect(payload.outcomeKind).toBe('failure');
      expect(payload.success).toBe(false);
      expect(payload.critical).toBe(false);
      expect(payload.outputs).toEqual([{ resourceId: 'res:gems', amount: 1 }]);
      expect(payload.entityExperience).toBe(2);
    });

    it('selects mission entities by stats and prefers higher values', () => {
      const entitySystem = createEntitySystemWithStats([
        { power: 2 },
        { power: 5 },
      ]);
      const { system } = createMissionHarness({
        entitySystem,
        transformOverrides: {
          entityRequirements: [
            {
              entityId: 'entity.scout' as any,
              count: { kind: 'constant', value: 1 },
              returnOnComplete: true,
              minStats: { power: { kind: 'constant', value: 1 } } as any,
              preferHighStats: ['power' as any],
            },
          ],
        },
      });

      const result = system.executeTransform('transform:mission', 0);
      expect(result.success).toBe(true);

      const assigned = entitySystem
        .getInstancesForEntity('entity.scout')
        .find((instance) =>
          Boolean(entitySystem.getInstanceState(instance.instanceId)?.assignment),
        );
      expect(assigned?.stats.power).toBe(5);
    });

    it('falls back to deterministic ordering when stats tie', () => {
      const entitySystem = createEntitySystemWithStats([
        { power: 2 },
        { power: 2 },
      ]);
      const { system } = createMissionHarness({
        entitySystem,
        transformOverrides: {
          entityRequirements: [
            {
              entityId: 'entity.scout' as any,
              count: { kind: 'constant', value: 1 },
              returnOnComplete: true,
              preferHighStats: ['power' as any],
            },
          ],
        },
      });

      const result = system.executeTransform('transform:mission', 0);
      expect(result.success).toBe(true);

      const instances = entitySystem.getInstancesForEntity('entity.scout');
      const expected = [...instances].sort((left, right) =>
        left.instanceId.localeCompare(right.instanceId, 'en'),
      )[0];
      const assigned = instances.find((instance) =>
        Boolean(entitySystem.getInstanceState(instance.instanceId)?.assignment),
      );
      expect(assigned?.instanceId).toBe(expected?.instanceId);
    });

    it('applies mission stat modifiers across scopes', () => {
      const entitySystem = createEntitySystemWithStats([
        { skill: 2, luck: 1 },
        { skill: 4, luck: 3 },
      ]);
      const { system } = createMissionHarness({
        entitySystem,
        transformOverrides: {
          entityRequirements: [
            {
              entityId: 'entity.scout' as any,
              count: { kind: 'constant', value: 2 },
              returnOnComplete: true,
            },
          ],
          successRate: {
            baseRate: { kind: 'constant', value: 0 },
            usePRD: false,
            statModifiers: [
              {
                stat: 'skill' as any,
                weight: { kind: 'constant', value: 0.1 },
                entityScope: 'sum',
              },
              {
                stat: 'skill' as any,
                weight: { kind: 'constant', value: 0.1 },
                entityScope: 'min',
              },
              {
                stat: 'skill' as any,
                weight: { kind: 'constant', value: 0.1 },
                entityScope: 'max',
              },
              {
                stat: 'luck' as any,
                weight: { kind: 'constant', value: 0.1 },
                entityScope: 'average',
              },
            ],
          },
        },
      });

      const result = system.executeTransform('transform:mission', 0);
      expect(result.success).toBe(true);
    });

    type MissionValidationCase = {
      readonly label: string;
      readonly expected: string;
      readonly transformOverrides: Partial<TransformDefinition>;
      readonly resourceStateFactory?: () => ResourceStateAccessor & {
        addAmount?: (idx: number, amount: number) => number;
      };
      readonly entitySystemFactory?: () => EntitySystem;
    };

    const missionValidationCases: MissionValidationCase[] = [
      {
        label: 'entity requirements are missing',
        expected: 'MISSING_ENTITY_REQUIREMENTS',
        transformOverrides: { entityRequirements: [] },
      },
      {
        label: 'entity count is non-finite',
        expected: 'INVALID_ENTITY_COUNT',
        transformOverrides: {
          entityRequirements: [
            {
              entityId: 'entity.scout' as any,
              count: { kind: 'constant', value: Number.NaN },
              returnOnComplete: true,
            },
          ],
        },
      },
      {
        label: 'stat requirement is non-finite',
        expected: 'INVALID_ENTITY_STAT_REQUIREMENT',
        transformOverrides: {
          entityRequirements: [
            {
              entityId: 'entity.scout' as any,
              count: { kind: 'constant', value: 1 },
              returnOnComplete: true,
              minStats: { power: { kind: 'constant', value: Number.NaN } } as any,
            },
          ],
        },
      },
      {
        label: 'entities are insufficient',
        expected: 'INSUFFICIENT_ENTITIES',
        transformOverrides: {
          entityRequirements: [
            {
              entityId: 'entity.scout' as any,
              count: { kind: 'constant', value: 2 },
              returnOnComplete: true,
            },
          ],
        },
      },
      {
        label: 'duration formula is non-finite',
        expected: 'INVALID_DURATION_FORMULA',
        transformOverrides: {
          duration: { kind: 'constant', value: Number.NaN },
        },
      },
      {
        label: 'input formula is non-finite',
        expected: 'INVALID_INPUT_FORMULA',
        transformOverrides: {
          inputs: [
            {
              resourceId: 'res:gold' as any,
              amount: { kind: 'constant', value: Number.NaN },
            },
          ],
        },
      },
      {
        label: 'resources are insufficient',
        expected: 'INSUFFICIENT_RESOURCES',
        transformOverrides: {
          inputs: [
            {
              resourceId: 'res:gold' as any,
              amount: { kind: 'constant', value: 10 },
            },
          ],
        },
        resourceStateFactory: () =>
          createMockResourceState(
            new Map([
              ['res:gold', { amount: 0 }],
              ['res:gems', { amount: 0 }],
            ]),
          ),
      },
      {
        label: 'success rate is non-finite',
        expected: 'INVALID_SUCCESS_RATE',
        transformOverrides: {
          successRate: {
            baseRate: { kind: 'constant', value: Number.NaN },
            usePRD: false,
          },
        },
      },
      {
        label: 'success rate modifier weight is non-finite',
        expected: 'INVALID_SUCCESS_RATE',
        transformOverrides: {
          successRate: {
            baseRate: { kind: 'constant', value: 1 },
            usePRD: false,
            statModifiers: [
              {
                stat: 'power' as any,
                weight: { kind: 'constant', value: Number.NaN },
                entityScope: 'sum',
              },
            ],
          },
        },
      },
      {
        label: 'output formula is non-finite',
        expected: 'INVALID_OUTPUT_FORMULA',
        transformOverrides: {
          outcomes: {
            success: {
              outputs: [
                {
                  resourceId: 'res:gems' as any,
                  amount: { kind: 'constant', value: Number.NaN },
                },
              ],
            },
          },
        },
      },
      {
        label: 'experience formula is non-finite',
        expected: 'INVALID_OUTPUT_FORMULA',
        transformOverrides: {
          outcomes: {
            success: {
              outputs: [],
              entityExperience: { kind: 'constant', value: Number.NaN },
            },
          },
        },
      },
      {
        label: 'output resource is missing',
        expected: 'OUTPUT_RESOURCE_NOT_FOUND',
        transformOverrides: {
          outcomes: {
            success: {
              outputs: [
                {
                  resourceId: 'res:missing' as any,
                  amount: { kind: 'constant', value: 1 },
                },
              ],
            },
          },
        },
      },
      {
        label: 'critical chance formula is non-finite',
        expected: 'INVALID_SUCCESS_RATE',
        transformOverrides: {
          successRate: {
            baseRate: { kind: 'constant', value: 1 },
            usePRD: false,
          },
          outcomes: {
            success: {
              outputs: [],
            },
            critical: {
              chance: { kind: 'constant', value: Number.NaN },
              outputs: [],
            },
          },
        },
      },
      {
        label: 'critical outcome output formula is non-finite',
        expected: 'INVALID_OUTPUT_FORMULA',
        transformOverrides: {
          successRate: {
            baseRate: { kind: 'constant', value: 1 },
            usePRD: false,
          },
          outcomes: {
            success: {
              outputs: [],
            },
            critical: {
              chance: { kind: 'constant', value: 0.5 },
              outputs: [
                {
                  resourceId: 'res:gems' as any,
                  amount: { kind: 'constant', value: Number.NaN },
                },
              ],
            },
          },
        },
      },
      {
        label: 'critical outcome experience formula is non-finite',
        expected: 'INVALID_OUTPUT_FORMULA',
        transformOverrides: {
          successRate: {
            baseRate: { kind: 'constant', value: 1 },
            usePRD: false,
          },
          outcomes: {
            success: {
              outputs: [],
            },
            critical: {
              chance: { kind: 'constant', value: 0.5 },
              outputs: [],
              entityExperience: { kind: 'constant', value: Number.NaN },
            },
          },
        },
      },
    ];

    it.each(missionValidationCases)(
      'rejects mission transforms when $label',
      ({ expected, transformOverrides, resourceStateFactory, entitySystemFactory }) => {
        const { system } = createMissionHarness({
          transformOverrides,
          resourceState: resourceStateFactory ? resourceStateFactory() : undefined,
          entitySystem: entitySystemFactory ? entitySystemFactory() : undefined,
        });

        const result = system.executeTransform('transform:mission', 0);

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(expected);
      },
    );

    it('caps outstanding mission batches', () => {
      const entitySystem = createEntitySystemWithStats([
        { power: 1 },
        { power: 2 },
      ]);
      const { system } = createMissionHarness({
        entitySystem,
        transformOverrides: {
          safety: { maxOutstandingBatches: 1 },
          outcomes: {
            success: {
              outputs: [
                { resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } },
              ],
            },
          },
        },
      });

      const first = system.executeTransform('transform:mission', 0);
      const second = system.executeTransform('transform:mission', 0);

      expect(first.success).toBe(true);
      expect(second.success).toBe(false);
      expect(second.error?.code).toBe('MAX_OUTSTANDING_BATCHES');
    });

    it('reports spend failures while executing missions', () => {
      const resourceState: ResourceStateAccessor = {
        getAmount: () => 10,
        getResourceIndex: () => 0,
        spendAmount: () => false,
      };
      const { system } = createMissionHarness({ resourceState });

      const result = system.executeTransform('transform:mission', 0);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SPEND_FAILED');
    });

    it('delivers mission experience without an entity system', () => {
      const transforms = [createMissionTransform()];
      const resourceState = createMockResourceState(
        new Map([['res:gold', { amount: 0 }]]),
      );
      const system = createTransformSystem({
        transforms,
        stepDurationMs,
        resourceState,
      });

      system.restoreState([
        {
          id: 'transform:mission',
          unlocked: true,
          cooldownExpiresStep: 0,
          batches: [
            {
              completeAtStep: 0,
              outputs: [
                {
                  resourceId: 'res:gold' as any,
                  amount: 2,
                },
              ],
              entityInstanceIds: ['entity.scout_0_0001'],
              entityExperience: 5,
            },
          ],
        },
      ]);

      system.tick({ deltaMs: stepDurationMs, step: 0, events: { publish: vi.fn() } });

      expect(getResourceAmount(resourceState, 'res:gold')).toBe(2);
    });

    it('skips mission experience when entity instances are missing', () => {
      const transforms = [createMissionTransform()];
      const resourceState = createMockResourceState(
        new Map([['res:gold', { amount: 0 }]]),
      );
      const entitySystem = createEntitySystemWithStats([{ power: 1 }]);
      const instances = entitySystem.getInstancesForEntity('entity.scout');
      expect(instances).toHaveLength(1);
      const existingInstanceId = instances[0]?.instanceId;
      if (!existingInstanceId) {
        throw new Error('Expected entity instance for mission experience test.');
      }
      const system = createTransformSystem({
        transforms,
        stepDurationMs,
        resourceState,
        entitySystem,
      });

      system.restoreState([
        {
          id: 'transform:mission',
          unlocked: true,
          cooldownExpiresStep: 0,
          batches: [
            {
              completeAtStep: 0,
              outputs: [
                {
                  resourceId: 'res:gold' as any,
                  amount: 2,
                },
              ],
              entityInstanceIds: [`${existingInstanceId}_missing`],
              entityExperience: 5,
            },
          ],
        },
      ]);

      system.tick({ deltaMs: stepDurationMs, step: 0, events: { publish: vi.fn() } });

      expect(getResourceAmount(resourceState, 'res:gold')).toBe(2);
      expect(entitySystem.getInstanceState(existingInstanceId)?.experience).toBe(0);
    });
  });
});
