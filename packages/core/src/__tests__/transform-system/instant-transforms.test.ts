import { describe, expect, it, vi } from 'vitest';
import type { TransformDefinition } from '@idle-engine/content-schema';

import type { ResourceStateAccessor } from '../../automation-system.js';
import { createTransformSystem, getTransformState } from '../../transform-system.js';
import {
  createMockConditionContext,
  createMockResourceState,
} from '../helpers/transform-fixtures.js';

describe('TransformSystem', () => {
  const stepDurationMs = 100;

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

});
