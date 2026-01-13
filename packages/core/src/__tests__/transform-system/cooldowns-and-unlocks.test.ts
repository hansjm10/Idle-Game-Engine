import { describe, expect, it, vi } from 'vitest';
import type { TransformDefinition } from '@idle-engine/content-schema';

import type { TransformState } from '../../transform-system.js';
import {
  createTransformSystem,
  getTransformState,
  isTransformCooldownActive,
} from '../../transform-system.js';
import {
  createMockConditionContext,
  createMockResourceState,
} from '../helpers/transform-fixtures.js';

describe('TransformSystem', () => {
  const stepDurationMs = 100;

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

    it('should respect configured maxRunsPerTick when not authored', () => {
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
        config: { limits: { maxRunsPerTick: 2 } },
      });

      system.tick({ deltaMs: stepDurationMs, step: 0, events: { publish: vi.fn() } });

      const result = system.executeTransform('transform:spam', 0, { runs: 15 });
      expect(result.success).toBe(true);

      expect(resourceState.getAmount(0)).toBe(998);
      expect(resourceState.getAmount(1)).toBe(2);

      const result2 = system.executeTransform('transform:spam', 0);
      expect(result2.success).toBe(false);
      expect(result2.error?.code).toBe('MAX_RUNS_EXCEEDED');
    });

    it('should clamp authored maxRunsPerTick to configured hard cap', () => {
      const transforms: TransformDefinition[] = [
        {
          id: 'transform:excessiveConfigured' as any,
          name: { default: 'Excessive (Configured)', variants: {} },
          description: { default: 'Exceeds configured hard cap', variants: {} },
          mode: 'instant',
          inputs: [{ resourceId: 'res:gold' as any, amount: { kind: 'constant', value: 1 } }],
          outputs: [{ resourceId: 'res:gems' as any, amount: { kind: 'constant', value: 1 } }],
          trigger: { kind: 'manual' },
          safety: { maxRunsPerTick: 500 },
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
        config: { limits: { maxRunsPerTickHardCap: 3 } },
      });

      system.tick({ deltaMs: stepDurationMs, step: 0, events: { publish: vi.fn() } });

      const result = system.executeTransform('transform:excessiveConfigured', 0, { runs: 10 });
      expect(result.success).toBe(true);

      expect(resourceState.getAmount(0)).toBe(997);
      expect(resourceState.getAmount(1)).toBe(3);
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

});
