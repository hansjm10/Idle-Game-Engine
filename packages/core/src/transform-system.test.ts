import { describe, it, expect, vi } from 'vitest';
import {
  createTransformSystem,
  getTransformState,
  isTransformCooldownActive,
} from './transform-system.js';
import type { TransformDefinition } from '@idle-engine/content-schema';
import type { TransformState } from './transform-system.js';
import type { ResourceStateAccessor } from './automation-system.js';
import type { ConditionContext } from './condition-evaluator.js';

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

  describe('unsupported modes', () => {
    it('should reject batch mode transforms', () => {
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

      const result = system.executeTransform('transform:batch', 0);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UNSUPPORTED_MODE');
    });

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
  });
});
