import { describe, it, expect, vi } from 'vitest';
import {
  buildTransformSnapshot,
  createTransformSystem,
  getTransformState,
  isTransformCooldownActive,
  serializeTransformState,
} from './transform-system.js';
import type { TransformDefinition } from '@idle-engine/content-schema';
import type { TransformState } from './transform-system.js';
import { createAutomationSystem, type ResourceStateAccessor } from './automation-system.js';
import type { ConditionContext } from './condition-evaluator.js';
import { IdleEngineRuntime } from './index.js';
import { createEntityDefinition } from './content-test-helpers.js';
import { EntitySystem } from './entity-system.js';
import { PRDRegistry } from './rng.js';

describe('TransformSystem', () => {
  const stepDurationMs = 100;

  const createMockResourceState = (
    resources: Map<string, { amount: number; capacity?: number }>,
  ): ResourceStateAccessor & { addAmount: (idx: number, amount: number) => number } => {
    const indexById = new Map<string, number>();
    const amounts = new Map<number, number>();
    let idx = 0;

    for (const [id, { amount }] of resources) {
      indexById.set(id, idx);
      amounts.set(idx, amount);
      idx++;
    }

    return {
      getAmount: (index) => amounts.get(index) ?? 0,
      getResourceIndex: (id) => indexById.get(id) ?? -1,
      spendAmount: (index, amount, _context) => {
        const current = amounts.get(index) ?? 0;
        if (current < amount) return false;
        amounts.set(index, current - amount);
        return true;
      },
      addAmount: (index, amount) => {
        const current = amounts.get(index) ?? 0;
        amounts.set(index, current + amount);
        return amount;
      },
    };
  };

  const createMockConditionContext = (
    resources: Map<string, number>,
    generators?: Map<string, number>,
    upgrades?: Map<string, number>,
  ): ConditionContext => ({
    getResourceAmount: (id) => resources.get(id) ?? 0,
    getGeneratorLevel: (id) => generators?.get(id) ?? 0,
    getUpgradePurchases: (id) => upgrades?.get(id) ?? 0,
  });

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

  describe('initialization', () => {
    it('should create system with correct id', () => {
      const system = createTransformSystem({
        transforms: [],
        stepDurationMs,
        resourceState: { getAmount: () => 0 },
      });

      expect(system.id).toBe('transform-system');
    });

    it('should initialize transform states with default values', () => {
      const transforms: TransformDefinition[] = [
        {
          id: 'transform:basic' as any,
          name: { default: 'Basic Transform', variants: {} },
          description: { default: 'A basic transform', variants: {} },
          mode: 'instant',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 10 } }],
          outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } }],
          trigger: { kind: 'manual' },
          tags: [],
        },
      ];

      const system = createTransformSystem({
        transforms,
        stepDurationMs,
        resourceState: { getAmount: () => 0 },
      });

      // Tick to evaluate unlock conditions (no condition = always unlocked)
      system.tick({ deltaMs: stepDurationMs, step: 0, events: { publish: vi.fn() } });

      const state = getTransformState(system);

      expect(state.size).toBe(1);
      const transformState = state.get('transform:basic');
      expect(transformState).toBeDefined();
      expect(transformState?.unlocked).toBe(true); // No unlock condition = always unlocked
      expect(transformState?.cooldownExpiresStep).toBe(0);
      expect(transformState?.runsThisTick).toBe(0);
    });

    it('should sort transforms by order then id', () => {
      const transforms: TransformDefinition[] = [
        {
          id: 'transform:b' as any,
          name: { default: 'B', variants: {} },
          description: { default: 'B', variants: {} },
          mode: 'instant',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 1 } }],
          outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } }],
          trigger: { kind: 'manual' },
          tags: [],
          order: 1,
        },
        {
          id: 'transform:a' as any,
          name: { default: 'A', variants: {} },
          description: { default: 'A', variants: {} },
          mode: 'instant',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 1 } }],
          outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } }],
          trigger: { kind: 'manual' },
          tags: [],
          order: 0,
        },
        {
          id: 'transform:c' as any,
          name: { default: 'C', variants: {} },
          description: { default: 'C', variants: {} },
          mode: 'instant',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 1 } }],
          outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } }],
          trigger: { kind: 'manual' },
          tags: [],
          order: 0,
        },
      ];

      const system = createTransformSystem({
        transforms,
        stepDurationMs,
        resourceState: { getAmount: () => 0 },
      });

      const state = getTransformState(system);
      const ids = [...state.keys()];
      // Order 0 first (a, c sorted alphabetically), then order 1 (b)
      expect(ids).toEqual(['transform:a', 'transform:c', 'transform:b']);
    });
  });

  describe('manual instant transform execution', () => {
    it('should execute successful manual transform', () => {
      const transforms: TransformDefinition[] = [
        {
          id: 'transform:convert' as any,
          name: { default: 'Convert', variants: {} },
          description: { default: 'Convert gold to gems', variants: {} },
          mode: 'instant',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 10 } }],
          outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } }],
          trigger: { kind: 'manual' },
          tags: [],
        },
      ];

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

      // Tick to initialize unlock state
      system.tick({ deltaMs: stepDurationMs, step: 0, events: { publish: vi.fn() } });

      const result = system.executeTransform('transform:convert', 0);

      expect(result.success).toBe(true);
      expect(resourceState.getAmount(0)).toBe(90); // 100 - 10 gold spent
      expect(resourceState.getAmount(1)).toBe(1);  // 0 + 1 gem gained
    });

    it('should execute without requiring a tick when no unlockCondition is defined', () => {
      const transforms: TransformDefinition[] = [
        {
          id: 'transform:convert' as any,
          name: { default: 'Convert', variants: {} },
          description: { default: 'Convert gold to gems', variants: {} },
          mode: 'instant',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 10 } }],
          outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } }],
          trigger: { kind: 'manual' },
          tags: [],
        },
      ];

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

      const result = system.executeTransform('transform:convert', 0);

      expect(result.success).toBe(true);
      expect(resourceState.getAmount(0)).toBe(90); // 100 - 10 gold spent
      expect(resourceState.getAmount(1)).toBe(1);  // 0 + 1 gem gained
    });

    it('should unlock and execute during command phase when unlockCondition passes', () => {
      const transforms: TransformDefinition[] = [
        {
          id: 'transform:unlock-on-demand' as any,
          name: { default: 'Unlocked', variants: {} },
          description: { default: 'Unlocks immediately', variants: {} },
          mode: 'instant',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 10 } }],
          outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } }],
          trigger: { kind: 'manual' },
          unlockCondition: { kind: 'always' },
          tags: [],
        },
      ];

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
        conditionContext: createMockConditionContext(new Map()),
      });

      const result = system.executeTransform('transform:unlock-on-demand', 0);

      expect(result.success).toBe(true);
      expect(resourceState.getAmount(0)).toBe(90);
      expect(resourceState.getAmount(1)).toBe(1);
    });

    it('should fail when transform not found', () => {
      const system = createTransformSystem({
        transforms: [],
        stepDurationMs,
        resourceState: { getAmount: () => 0 },
      });

      const result = system.executeTransform('transform:unknown', 0);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UNKNOWN_TRANSFORM');
    });

    it('should fail when transform is not manual', () => {
      const transforms: TransformDefinition[] = [
        {
          id: 'transform:auto' as any,
          name: { default: 'Auto', variants: {} },
          description: { default: 'Auto transform', variants: {} },
          mode: 'instant',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 10 } }],
          outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } }],
          trigger: { kind: 'condition', condition: { kind: 'always' } },
          tags: [],
        },
      ];

      const system = createTransformSystem({
        transforms,
        stepDurationMs,
        resourceState: { getAmount: () => 0 },
      });

      const result = system.executeTransform('transform:auto', 0);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_TRIGGER');
    });

    it('should fail when transform is locked', () => {
      const transforms: TransformDefinition[] = [
        {
          id: 'transform:locked' as any,
          name: { default: 'Locked', variants: {} },
          description: { default: 'Locked transform', variants: {} },
          mode: 'instant',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 10 } }],
          outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } }],
          trigger: { kind: 'manual' },
          unlockCondition: { kind: 'never' },
          tags: [],
        },
      ];

      const system = createTransformSystem({
        transforms,
        stepDurationMs,
        resourceState: { getAmount: () => 0 },
        conditionContext: createMockConditionContext(new Map()),
      });

      // Tick to evaluate unlock conditions
      system.tick({ deltaMs: stepDurationMs, step: 0, events: { publish: vi.fn() } });

      const result = system.executeTransform('transform:locked', 0);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('TRANSFORM_LOCKED');
    });

    it('should fail when cannot afford inputs', () => {
      const transforms: TransformDefinition[] = [
        {
          id: 'transform:expensive' as any,
          name: { default: 'Expensive', variants: {} },
          description: { default: 'Expensive transform', variants: {} },
          mode: 'instant',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 100 } }],
          outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } }],
          trigger: { kind: 'manual' },
          tags: [],
        },
      ];

      const resourceState = createMockResourceState(
        new Map([
          ['res:gold', { amount: 50 }], // Only 50, need 100
          ['res:gems', { amount: 0 }],
        ]),
      );

      const system = createTransformSystem({
        transforms,
        stepDurationMs,
        resourceState,
      });

      // Tick to initialize
      system.tick({ deltaMs: stepDurationMs, step: 0, events: { publish: vi.fn() } });

      const result = system.executeTransform('transform:expensive', 0);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INSUFFICIENT_RESOURCES');
      expect(resourceState.getAmount(0)).toBe(50); // Gold unchanged
    });

    it('should not partially spend inputs when any input is insufficient', () => {
      const transforms: TransformDefinition[] = [
        {
          id: 'transform:multi-input' as any,
          name: { default: 'Multi Input', variants: {} },
          description: { default: 'Consumes multiple resources atomically', variants: {} },
          mode: 'instant',
          inputs: [
            { resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 10 } },
            { resourceId: 'res:silver' as any, amount: { kind: 'constant', value: 5 } },
          ],
          outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } }],
          trigger: { kind: 'manual' },
          tags: [],
        },
      ];

      const resourceState = createMockResourceState(
        new Map([
          ['res:gold', { amount: 100 }],
          ['res:silver', { amount: 0 }], // Insufficient
          ['res:gems', { amount: 0 }],
        ]),
      );

      const system = createTransformSystem({
        transforms,
        stepDurationMs,
        resourceState,
      });

      system.tick({ deltaMs: stepDurationMs, step: 0, events: { publish: vi.fn() } });

      const result = system.executeTransform('transform:multi-input', 0);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INSUFFICIENT_RESOURCES');
      expect(resourceState.getAmount(0)).toBe(100); // Gold unchanged
      expect(resourceState.getAmount(1)).toBe(0); // Silver unchanged
      expect(resourceState.getAmount(2)).toBe(0); // No outputs
    });

    it('should rollback spent inputs if spendAmount fails mid-run', () => {
      const transforms: TransformDefinition[] = [
        {
          id: 'transform:rollback' as any,
          name: { default: 'Rollback', variants: {} },
          description: { default: 'Validates atomic spend rollback', variants: {} },
          mode: 'instant',
          inputs: [
            { resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 10 } },
            { resourceId: 'res:silver' as any, amount: { kind: 'constant', value: 5 } },
          ],
          outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } }],
          trigger: { kind: 'manual' },
          tags: [],
        },
      ];

      const indexById = new Map([
        ['res:gold', 0],
        ['res:silver', 1],
        ['res:gems', 2],
      ]);
      const amounts = new Map<number, number>([
        [0, 100],
        [1, 100],
        [2, 0],
      ]);

      let spendCalls = 0;

      const resourceState: ResourceStateAccessor & {
        addAmount: (idx: number, amount: number) => number;
      } = {
        getAmount: (index) => amounts.get(index) ?? 0,
        getResourceIndex: (id) => indexById.get(id) ?? -1,
        spendAmount: (index, amount) => {
          spendCalls += 1;
          if (index === 1) {
            return false;
          }
          const current = amounts.get(index) ?? 0;
          if (current < amount) return false;
          amounts.set(index, current - amount);
          return true;
        },
        addAmount: (index, amount) => {
          const current = amounts.get(index) ?? 0;
          amounts.set(index, current + amount);
          return amount;
        },
      };

      const system = createTransformSystem({
        transforms,
        stepDurationMs,
        resourceState: resourceState as any,
      });

      system.tick({ deltaMs: stepDurationMs, step: 0, events: { publish: vi.fn() } });

      const result = system.executeTransform('transform:rollback', 0);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SPEND_FAILED');
      expect(resourceState.getAmount(0)).toBe(100); // Gold rolled back
      expect(resourceState.getAmount(1)).toBe(100); // Silver unchanged (never spent)
      expect(resourceState.getAmount(2)).toBe(0); // No outputs
      expect(spendCalls).toBe(2);
    });

    it('should reject non-integer runs parameter', () => {
      const transforms: TransformDefinition[] = [
        {
          id: 'transform:convert' as any,
          name: { default: 'Convert', variants: {} },
          description: { default: 'Convert gold to gems', variants: {} },
          mode: 'instant',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 10 } }],
          outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } }],
          trigger: { kind: 'manual' },
          tags: [],
        },
      ];

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

      const result = system.executeTransform('transform:convert', 0, { runs: 1.5 as any });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_RUNS');
      expect(resourceState.getAmount(0)).toBe(100); // No spend
      expect(resourceState.getAmount(1)).toBe(0); // No outputs
    });

    it('should fail without spending when outputs cannot be applied', () => {
      const transforms: TransformDefinition[] = [
        {
          id: 'transform:no-add' as any,
          name: { default: 'No add', variants: {} },
          description: { default: 'Missing addAmount', variants: {} },
          mode: 'instant',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 10 } }],
          outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } }],
          trigger: { kind: 'manual' },
          tags: [],
        },
      ];

      const indexById = new Map([
        ['res:gold', 0],
        ['res:gems', 1],
      ]);
      const amounts = new Map<number, number>([
        [0, 100],
        [1, 0],
      ]);

      const resourceState: ResourceStateAccessor = {
        getAmount: (index) => amounts.get(index) ?? 0,
        getResourceIndex: (id) => indexById.get(id) ?? -1,
        spendAmount: (index, amount) => {
          const current = amounts.get(index) ?? 0;
          if (current < amount) return false;
          amounts.set(index, current - amount);
          return true;
        },
      };

      const system = createTransformSystem({
        transforms,
        stepDurationMs,
        resourceState: resourceState as any,
      });

      system.tick({ deltaMs: stepDurationMs, step: 0, events: { publish: vi.fn() } });

      const result = system.executeTransform('transform:no-add', 0);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('RESOURCE_STATE_MISSING_ADD_AMOUNT');
      expect(resourceState.getAmount(0)).toBe(100); // No spend
      expect(resourceState.getAmount(1)).toBe(0); // No outputs
    });

    it('should fail without spending when an output resource is missing', () => {
      const transforms: TransformDefinition[] = [
        {
          id: 'transform:missing-output' as any,
          name: { default: 'Missing output', variants: {} },
          description: { default: 'Output resource not defined', variants: {} },
          mode: 'instant',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 10 } }],
          outputs: [
            { resourceId: 'res:missing' as any, amount: { kind: 'constant', value: 1 } },
          ],
          trigger: { kind: 'manual' },
          tags: [],
        },
      ];

      const resourceState = createMockResourceState(
        new Map([
          ['res:gold', { amount: 100 }],
        ]),
      );

      const system = createTransformSystem({
        transforms,
        stepDurationMs,
        resourceState,
      });

      system.tick({ deltaMs: stepDurationMs, step: 0, events: { publish: vi.fn() } });

      const result = system.executeTransform('transform:missing-output', 0);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('OUTPUT_RESOURCE_NOT_FOUND');
      expect(resourceState.getAmount(0)).toBe(100); // No spend
    });
  });

  describe('cooldown behavior', () => {
    it('should apply cooldown after successful execution', () => {
      const transforms: TransformDefinition[] = [
        {
          id: 'transform:cooldown' as any,
          name: { default: 'Cooldown', variants: {} },
          description: { default: 'Transform with cooldown', variants: {} },
          mode: 'instant',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 10 } }],
          outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } }],
          trigger: { kind: 'manual' },
          cooldown: { kind: 'constant', value: 500 }, // 500ms cooldown
          tags: [],
        },
      ];

      const resourceState = createMockResourceState(
        new Map([
          ['res:gold', { amount: 100 }],
          ['res:gems', { amount: 0 }],
        ]),
      );

      const system = createTransformSystem({
        transforms,
        stepDurationMs, // 100ms per step
        resourceState,
      });

      // Tick to initialize
      system.tick({ deltaMs: stepDurationMs, step: 0, events: { publish: vi.fn() } });

      // First execution succeeds
      const result1 = system.executeTransform('transform:cooldown', 0);
      expect(result1.success).toBe(true);

      // Second execution fails due to cooldown
      const result2 = system.executeTransform('transform:cooldown', 1);
      expect(result2.success).toBe(false);
      expect(result2.error?.code).toBe('COOLDOWN_ACTIVE');

      // Check cooldown state
      const state = getTransformState(system);
      const transformState = state.get('transform:cooldown');
      expect(transformState?.cooldownExpiresStep).toBe(6); // 0 + ceil(500/100) + 1 = 6
    });

    it('should allow execution after cooldown expires', () => {
      const transforms: TransformDefinition[] = [
        {
          id: 'transform:cooldown' as any,
          name: { default: 'Cooldown', variants: {} },
          description: { default: 'Transform with cooldown', variants: {} },
          mode: 'instant',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 10 } }],
          outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } }],
          trigger: { kind: 'manual' },
          cooldown: { kind: 'constant', value: 200 }, // 200ms = 2 steps
          tags: [],
        },
      ];

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

      // Tick to initialize
      system.tick({ deltaMs: stepDurationMs, step: 0, events: { publish: vi.fn() } });

      // Execute at step 0
      system.executeTransform('transform:cooldown', 0);

      // Cooldown expires at step 4 (0 + ceil(200/100) + 1 = 3, so step >= 4 is okay)
      const result = system.executeTransform('transform:cooldown', 4);
      expect(result.success).toBe(true);
    });

    it('isTransformCooldownActive should correctly check cooldown state', () => {
      const state: TransformState = {
        id: 'test',
        unlocked: true,
        visible: true,
        cooldownExpiresStep: 10,
        runsThisTick: 0,
      };

      expect(isTransformCooldownActive(state, 5)).toBe(true);
      expect(isTransformCooldownActive(state, 9)).toBe(true);
      expect(isTransformCooldownActive(state, 10)).toBe(false);
      expect(isTransformCooldownActive(state, 15)).toBe(false);
    });
  });

  describe('visibility conditions', () => {
    it('should update visibility based on visibilityCondition without gating execution', () => {
      const transforms: TransformDefinition[] = [
        {
          id: 'transform:invisible' as any,
          name: { default: 'Invisible', variants: {} },
          description: { default: 'Hidden but runnable', variants: {} },
          mode: 'instant',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 10 } }],
          outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } }],
          trigger: { kind: 'manual' },
          visibilityCondition: { kind: 'never' },
          tags: [],
        },
      ];

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
        conditionContext: createMockConditionContext(new Map()),
      });

      system.tick({ deltaMs: stepDurationMs, step: 0, events: { publish: vi.fn() } });

      const state = getTransformState(system);
      expect(state.get('transform:invisible')?.visible).toBe(false);

      const result = system.executeTransform('transform:invisible', 0);
      expect(result.success).toBe(true);
      expect(resourceState.getAmount(0)).toBe(90);
      expect(resourceState.getAmount(1)).toBe(1);
    });
  });

  describe('maxRunsPerTick safety cap', () => {
    it('should enforce default maxRunsPerTick of 10', () => {
      const transforms: TransformDefinition[] = [
        {
          id: 'transform:spam' as any,
          name: { default: 'Spam', variants: {} },
          description: { default: 'Spammable transform', variants: {} },
          mode: 'instant',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 1 } }],
          outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } }],
          trigger: { kind: 'manual' },
          tags: [],
        },
      ];

      const resourceState = createMockResourceState(
        new Map([
          ['res:gold', { amount: 1000 }],
          ['res:gems', { amount: 0 }],
        ]),
      );

      const system = createTransformSystem({
        transforms,
        stepDurationMs,
        resourceState,
      });

      // Tick to initialize
      system.tick({ deltaMs: stepDurationMs, step: 0, events: { publish: vi.fn() } });

      // Try to execute 15 runs
      const result = system.executeTransform('transform:spam', 0, { runs: 15 });
      expect(result.success).toBe(true);

      // Should have executed 10 (default max)
      expect(resourceState.getAmount(0)).toBe(990); // 1000 - 10 gold
      expect(resourceState.getAmount(1)).toBe(10);  // 0 + 10 gems

      // 11th run should fail
      const result2 = system.executeTransform('transform:spam', 0);
      expect(result2.success).toBe(false);
      expect(result2.error?.code).toBe('MAX_RUNS_EXCEEDED');
    });

    it('should respect custom maxRunsPerTick', () => {
      const transforms: TransformDefinition[] = [
        {
          id: 'transform:limited' as any,
          name: { default: 'Limited', variants: {} },
          description: { default: 'Limited transform', variants: {} },
          mode: 'instant',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 1 } }],
          outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } }],
          trigger: { kind: 'manual' },
          safety: { maxRunsPerTick: 3 },
          tags: [],
        },
      ];

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

      // Tick to initialize
      system.tick({ deltaMs: stepDurationMs, step: 0, events: { publish: vi.fn() } });

      // Execute 3 times (should succeed)
      for (let i = 0; i < 3; i++) {
        const result = system.executeTransform('transform:limited', 0);
        expect(result.success).toBe(true);
      }

      // 4th run should fail
      const result = system.executeTransform('transform:limited', 0);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MAX_RUNS_EXCEEDED');
    });

    it('should clamp maxRunsPerTick to hard cap of 100', () => {
      const transforms: TransformDefinition[] = [
        {
          id: 'transform:excessive' as any,
          name: { default: 'Excessive', variants: {} },
          description: { default: 'Excessive transform', variants: {} },
          mode: 'instant',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 1 } }],
          outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } }],
          trigger: { kind: 'manual' },
          safety: { maxRunsPerTick: 500 }, // Exceeds hard cap
          tags: [],
        },
      ];

      const resourceState = createMockResourceState(
        new Map([
          ['res:gold', { amount: 10000 }],
          ['res:gems', { amount: 0 }],
        ]),
      );

      const system = createTransformSystem({
        transforms,
        stepDurationMs,
        resourceState,
      });

      // Tick to initialize
      system.tick({ deltaMs: stepDurationMs, step: 0, events: { publish: vi.fn() } });

      // Try to execute 150 runs
      const result = system.executeTransform('transform:excessive', 0, { runs: 150 });
      expect(result.success).toBe(true);

      // Should have executed 100 (hard cap)
      expect(resourceState.getAmount(0)).toBe(9900); // 10000 - 100 gold
      expect(resourceState.getAmount(1)).toBe(100);  // 0 + 100 gems
    });

    it('should reset runsThisTick counter each tick', () => {
      const transforms: TransformDefinition[] = [
        {
          id: 'transform:limited' as any,
          name: { default: 'Limited', variants: {} },
          description: { default: 'Limited transform', variants: {} },
          mode: 'instant',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 1 } }],
          outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } }],
          trigger: { kind: 'manual' },
          safety: { maxRunsPerTick: 2 },
          tags: [],
        },
      ];

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

      // Tick to initialize (step 0)
      system.tick({ deltaMs: stepDurationMs, step: 0, events: { publish: vi.fn() } });

      // Execute 2 times at step 0
      system.executeTransform('transform:limited', 0);
      system.executeTransform('transform:limited', 0);

      // 3rd run should fail
      expect(system.executeTransform('transform:limited', 0).success).toBe(false);

      // Tick to step 1 (resets counter)
      system.tick({ deltaMs: stepDurationMs, step: 1, events: { publish: vi.fn() } });

      // Can execute again
      expect(system.executeTransform('transform:limited', 1).success).toBe(true);
    });

    it('should not reset counter mid-step when tick() is called after commands', () => {
      // Regression test: runsThisTick should reset at step boundary, not inside tick()
      // Bug: commands execute before tick() in runtime, so tick() was resetting counters
      // mid-step, allowing more runs than maxRunsPerTick in a single step.
      const transforms: TransformDefinition[] = [
        {
          id: 'transform:limited' as any,
          name: { default: 'Limited', variants: {} },
          description: { default: 'Limited transform', variants: {} },
          mode: 'instant',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 1 } }],
          outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } }],
          trigger: { kind: 'manual' },
          safety: { maxRunsPerTick: 2 },
          tags: [],
        },
      ];

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

      // Initialize/unlock transforms with a tick at step -1
      // (In real runtime, transforms get unlocked during tick())
      system.tick({ deltaMs: stepDurationMs, step: -1, events: { publish: vi.fn() } });

      // Step 0: Execute twice (command phase - hits limit)
      expect(system.executeTransform('transform:limited', 0).success).toBe(true);
      expect(system.executeTransform('transform:limited', 0).success).toBe(true);

      // Step 0: tick() (system phase) - counter should NOT reset mid-step
      system.tick({ deltaMs: stepDurationMs, step: 0, events: { publish: vi.fn() } });

      // Step 0: Third execution should still fail (same step, counter preserved)
      const result = system.executeTransform('transform:limited', 0);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MAX_RUNS_EXCEEDED');

      // Verify only 2 runs happened (not 3+)
      expect(resourceState.getAmount(1)).toBe(2); // 2 gems produced

      // Step 1: Counter resets at new step boundary, execution succeeds
      expect(system.executeTransform('transform:limited', 1).success).toBe(true);
    });
  });

  describe('event trigger path', () => {
    // Event trigger tests use a mock events pattern since EventBus resets
    // internal buffers on beginTick(), which loses events published between ticks.
    // This mirrors the approach used in automation-system.test.ts.

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

  describe('unlock conditions', () => {
    it('should respect unlock condition', () => {
      const transforms: TransformDefinition[] = [
        {
          id: 'transform:unlockable' as any,
          name: { default: 'Unlockable', variants: {} },
          description: { default: 'Needs unlock', variants: {} },
          mode: 'instant',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 10 } }],
          outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } }],
          trigger: { kind: 'manual' },
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
        ['res:gold', 100],
        ['res:gems', 0],
        ['res:prestige', 0], // No prestige yet
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

      // Tick to evaluate unlock conditions
      system.tick({ deltaMs: stepDurationMs, step: 0, events: { publish: vi.fn() } });

      // Should be locked
      const state = getTransformState(system);
      expect(state.get('transform:unlockable')?.unlocked).toBe(false);
    });

    it('should unlock when condition becomes true and stay unlocked', () => {
      const transforms: TransformDefinition[] = [
        {
          id: 'transform:unlockable' as any,
          name: { default: 'Unlockable', variants: {} },
          description: { default: 'Needs unlock', variants: {} },
          mode: 'instant',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 10 } }],
          outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } }],
          trigger: { kind: 'manual' },
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
        ['res:gold', 100],
        ['res:gems', 0],
        ['res:prestige', 1], // Has prestige
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

      // Tick to unlock
      system.tick({ deltaMs: stepDurationMs, step: 0, events: { publish: vi.fn() } });

      // Should be unlocked
      const state1 = getTransformState(system);
      expect(state1.get('transform:unlockable')?.unlocked).toBe(true);

      // Even if condition becomes false, should stay unlocked (monotonic)
      resources.set('res:prestige', 0);
      system.tick({ deltaMs: stepDurationMs, step: 1, events: { publish: vi.fn() } });

      const state2 = getTransformState(system);
      expect(state2.get('transform:unlockable')?.unlocked).toBe(true);
    });
  });

  describe('batch mode', () => {
    it('should schedule outputs and deliver them at the completion step', () => {
      const transforms: TransformDefinition[] = [
        {
          id: 'transform:batch' as any,
          name: { default: 'Batch', variants: {} },
          description: { default: 'Batch transform', variants: {} },
          mode: 'batch',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 10 } }],
          outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } }],
          trigger: { kind: 'manual' },
          duration: { kind: 'constant', value: 250 },
          tags: [],
        },
      ];

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

      const result = system.executeTransform('transform:batch', 0);
      expect(result.success).toBe(true);
      expect(resourceState.getAmount(0)).toBe(90);
      expect(resourceState.getAmount(1)).toBe(0);

      system.tick({ deltaMs: stepDurationMs, step: 0, events: { publish: vi.fn() } });
      system.tick({ deltaMs: stepDurationMs, step: 1, events: { publish: vi.fn() } });
      system.tick({ deltaMs: stepDurationMs, step: 2, events: { publish: vi.fn() } });
      expect(resourceState.getAmount(1)).toBe(0);

      system.tick({ deltaMs: stepDurationMs, step: 3, events: { publish: vi.fn() } });
      expect(resourceState.getAmount(1)).toBe(1);
    });

    it('should deliver same-step batches in FIFO order', () => {
      const transforms: TransformDefinition[] = [
        {
          id: 'transform:batch' as any,
          name: { default: 'Batch', variants: {} },
          description: { default: 'Batch transform', variants: {} },
          mode: 'batch',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 1 } }],
          outputs: [
            { resourceId: 'res:alpha' as any, amount: { kind: 'constant', value: 1 } },
            { resourceId: 'res:beta' as any, amount: { kind: 'constant', value: 1 } },
          ],
          trigger: { kind: 'manual' },
          duration: { kind: 'constant', value: 100 },
          tags: [],
        },
      ];

      const addOrder: string[] = [];
      const indexById = new Map([
        ['res:gold', 0],
        ['res:alpha', 1],
        ['res:beta', 2],
      ]);
      const idByIndex = new Map([
        [0, 'res:gold'],
        [1, 'res:alpha'],
        [2, 'res:beta'],
      ]);
      const amounts = new Map([
        [0, 10],
        [1, 0],
        [2, 0],
      ]);

      const resourceState = {
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
          const id = idByIndex.get(index);
          if (id) {
            addOrder.push(id);
          }
          return amount;
        },
      };

      const system = createTransformSystem({
        transforms,
        stepDurationMs,
        resourceState,
      });

      const result = system.executeTransform('transform:batch', 0, { runs: 2 });
      expect(result.success).toBe(true);

      system.tick({ deltaMs: stepDurationMs, step: 0, events: { publish: vi.fn() } });
      system.tick({ deltaMs: stepDurationMs, step: 1, events: { publish: vi.fn() } });

      expect(addOrder).toEqual([
        'res:alpha',
        'res:beta',
        'res:alpha',
        'res:beta',
      ]);
    });

    it('should enforce maxOutstandingBatches at scheduling time', () => {
      const transforms: TransformDefinition[] = [
        {
          id: 'transform:batch' as any,
          name: { default: 'Batch', variants: {} },
          description: { default: 'Batch transform', variants: {} },
          mode: 'batch',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 10 } }],
          outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } }],
          trigger: { kind: 'manual' },
          duration: { kind: 'constant', value: 1000 },
          safety: { maxOutstandingBatches: 1 },
          tags: [],
        },
      ];

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

      const first = system.executeTransform('transform:batch', 0);
      const second = system.executeTransform('transform:batch', 0);

      expect(first.success).toBe(true);
      expect(second.success).toBe(false);
      expect(second.error?.code).toBe('MAX_OUTSTANDING_BATCHES');
      expect(resourceState.getAmount(0)).toBe(90);

      const state = getTransformState(system).get('transform:batch');
      expect(state?.batches?.length).toBe(1);
    });

    it('should rebase batch completion steps on restore', () => {
      const transforms: TransformDefinition[] = [
        {
          id: 'transform:batch' as any,
          name: { default: 'Batch', variants: {} },
          description: { default: 'Batch transform', variants: {} },
          mode: 'batch',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 10 } }],
          outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } }],
          trigger: { kind: 'manual' },
          duration: { kind: 'constant', value: 200 },
          cooldown: { kind: 'constant', value: 500 },
          tags: [],
        },
      ];

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

      const result = system.executeTransform('transform:batch', 5);
      expect(result.success).toBe(true);

      const serialized = serializeTransformState(system.getState());

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

      restored.restoreState(serialized, {
        savedWorkerStep: 5,
        currentStep: 10,
      });

      const restoredState = getTransformState(restored).get('transform:batch');
      expect(restoredState?.cooldownExpiresStep).toBe(16);
      expect(restoredState?.batches?.[0].completeAtStep).toBe(12);

      restored.tick({ deltaMs: stepDurationMs, step: 11, events: { publish: vi.fn() } });
      expect(restoredResourceState.getAmount(1)).toBe(0);

      restored.tick({ deltaMs: stepDurationMs, step: 12, events: { publish: vi.fn() } });
      expect(restoredResourceState.getAmount(1)).toBe(1);
    });
  });

  describe('unsupported modes', () => {
    it('should reject continuous mode transforms', () => {
      const transforms: TransformDefinition[] = [
        {
          id: 'transform:continuous' as any,
          name: { default: 'Continuous', variants: {} },
          description: { default: 'Continuous transform', variants: {} },
          mode: 'continuous',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 10 } }],
          outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } }],
          trigger: { kind: 'manual' },
          tags: [],
        },
      ];

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

      // Tick to initialize
      system.tick({ deltaMs: stepDurationMs, step: 0, events: { publish: vi.fn() } });

      const result = system.executeTransform('transform:continuous', 0);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UNSUPPORTED_MODE');
    });

    it('should execute mission mode transforms and apply PRD rolls', () => {
      const transforms: TransformDefinition[] = [
        {
          id: 'transform:mission' as any,
          name: { default: 'Mission', variants: {} },
          description: { default: 'Mission transform', variants: {} },
          mode: 'mission',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 10 } }],
          outputs: [],
          duration: { kind: 'constant', value: 100 },
          entityRequirements: [
            {
              entityId: 'entity.scout' as any,
              count: { kind: 'constant', value: 1 },
              returnOnComplete: true,
            },
          ],
          successRate: {
            baseRate: { kind: 'constant', value: 1 },
            usePRD: true,
          },
          outcomes: {
            success: {
              outputs: [
                { resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } },
              ],
              entityExperience: { kind: 'constant', value: 5 },
            },
          },
          trigger: { kind: 'manual' },
          tags: [],
        },
      ];

      const resourceState = createMockResourceState(
        new Map([
          ['res:gold', { amount: 100 }],
          ['res:gems', { amount: 0 }],
        ]),
      );

      const entityDefinition = createEntityDefinition('entity.scout', {
        trackInstances: true,
        startCount: 1,
        unlocked: true,
      });
      const entitySystem = new EntitySystem([entityDefinition], {
        nextInt: () => 1,
      });
      const prdRegistry = new PRDRegistry(() => 0);

      const system = createTransformSystem({
        transforms,
        stepDurationMs,
        resourceState,
        entitySystem,
        prdRegistry,
      });

      // Tick to initialize
      system.tick({ deltaMs: stepDurationMs, step: 0, events: { publish: vi.fn() } });

      const instanceId = entitySystem.getInstancesForEntity('entity.scout')[0]
        ?.instanceId;
      expect(instanceId).toBeTruthy();

      const result = system.executeTransform('transform:mission', 0);

      expect(result.success).toBe(true);
      expect(resourceState.getAmount(0)).toBe(90);
      expect(Object.keys(prdRegistry.captureState())).toContain('transform:mission');
      const assigned = instanceId
        ? entitySystem.getInstanceState(instanceId)?.assignment
        : null;
      expect(assigned?.missionId).toBe('transform:mission');

      system.tick({ deltaMs: stepDurationMs, step: 1, events: { publish: vi.fn() } });
      expect(resourceState.getAmount(1)).toBe(1);
      if (instanceId) {
        expect(entitySystem.getInstanceState(instanceId)?.experience).toBe(5);
      }

      entitySystem.tick({ deltaMs: stepDurationMs, step: 1, events: { publish: vi.fn() } });
      if (instanceId) {
        expect(entitySystem.getInstanceState(instanceId)?.assignment).toBeNull();
      }
    });
  });

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
      expect(state?.batches?.[0].entityExperience).toBe(5);

      const serialized = serializeTransformState(system.getState());
      const serializedBatch = serialized[0]?.batches?.[0];
      expect(serializedBatch?.entityInstanceIds).toEqual(
        instanceId ? [instanceId] : [],
      );
      expect(serializedBatch?.entityExperience).toBe(5);

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
      expect(restoredState?.batches?.[0].entityExperience).toBe(5);

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

      expect(resourceState.getAmount(0)).toBe(2);
    });
  });
});
