import { describe, expect, it, vi } from 'vitest';
import type { TransformDefinition } from '@idle-engine/content-schema';

import { createEntityDefinition } from '../../content-test-helpers.js';
import { EntitySystem } from '../../entity-system.js';
import { PRDRegistry } from '../../rng.js';
import {
  createTransformSystem,
  getTransformState,
  serializeTransformState,
} from '../../transform-system.js';
import { createMockResourceState } from '../helpers/transform-fixtures.js';

describe('TransformSystem', () => {
  const stepDurationMs = 100;

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

});
