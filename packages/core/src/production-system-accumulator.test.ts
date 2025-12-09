import { describe, it, expect } from 'vitest';
import { createProductionSystem } from './production-system.js';
import { createResourceState, type ResourceState } from './resource-state.js';
import { createTickContext } from './test-utils.js';

describe('createProductionSystem - accumulators', () => {
  const createTestResources = (): ResourceState => {
    return createResourceState([
      { id: 'gold', startAmount: 0 },
      { id: 'wood', startAmount: 100 },
    ]);
  };

  describe('applyThreshold option', () => {
    it('should throw for invalid threshold values', () => {
      const resources = createTestResources();
      const generators = [
        {
          id: 'mine',
          owned: 1,
          produces: [{ resourceId: 'gold', rate: 1 }],
          consumes: [],
        },
      ];

      expect(() =>
        createProductionSystem({
          generators: () => generators,
          resourceState: resources,
          applyThreshold: 0,
        }),
      ).toThrow('applyThreshold must be a positive finite number');

      expect(() =>
        createProductionSystem({
          generators: () => generators,
          resourceState: resources,
          applyThreshold: -1,
        }),
      ).toThrow('applyThreshold must be a positive finite number');

      expect(() =>
        createProductionSystem({
          generators: () => generators,
          resourceState: resources,
          applyThreshold: Infinity,
        }),
      ).toThrow('applyThreshold must be a positive finite number');
    });

    it('should accumulate sub-threshold amounts across ticks', () => {
      const resources = createResourceState([{ id: 'gold', startAmount: 0 }]);
      const generators = [
        {
          id: 'mine',
          owned: 1,
          produces: [{ resourceId: 'gold', rate: 0.003 }],
          consumes: [],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
        applyThreshold: 0.01,
      });

      // First tick: 0.003 accumulated, nothing applied (below 0.01)
      system.tick(createTickContext(1000, 0));
      resources.snapshot({ mode: 'publish' });
      expect(resources.getAmount(resources.getIndex('gold')!)).toBe(0);

      // Second tick: 0.006 accumulated, nothing applied
      system.tick(createTickContext(1000, 1));
      resources.snapshot({ mode: 'publish' });
      expect(resources.getAmount(resources.getIndex('gold')!)).toBe(0);

      // Third tick: 0.009 accumulated, nothing applied
      system.tick(createTickContext(1000, 2));
      resources.snapshot({ mode: 'publish' });
      expect(resources.getAmount(resources.getIndex('gold')!)).toBe(0);

      // Fourth tick: 0.012 accumulated, 0.01 applied, 0.002 remainder
      system.tick(createTickContext(1000, 3));
      resources.snapshot({ mode: 'publish' });
      expect(resources.getAmount(resources.getIndex('gold')!)).toBe(0.01);
    });

    it('should not accumulate floating-point drift over many ticks', () => {
      const resources = createResourceState([{ id: 'gold', startAmount: 0 }]);
      const generators = [
        {
          id: 'mine',
          owned: 1,
          produces: [{ resourceId: 'gold', rate: 0.1 }],
          consumes: [],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
        applyThreshold: 0.0001,
      });

      // Run 10,000 ticks of 100ms each (1000 seconds total)
      for (let i = 0; i < 10000; i++) {
        system.tick(createTickContext(100, i));
      }
      resources.snapshot({ mode: 'publish' });

      const goldIndex = resources.getIndex('gold')!;
      // 0.1 rate * 1000 seconds = exactly 100
      // With accumulator, we should be very close (within threshold)
      expect(resources.getAmount(goldIndex)).toBeCloseTo(100, 4);
    });

    it('should handle whole-unit threshold', () => {
      const resources = createResourceState([{ id: 'gold', startAmount: 0 }]);
      const generators = [
        {
          id: 'mine',
          owned: 1,
          produces: [{ resourceId: 'gold', rate: 0.5 }],
          consumes: [],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
        applyThreshold: 1,
      });

      // Tick 1: 0.5 accumulated, nothing applied
      system.tick(createTickContext(1000, 0));
      resources.snapshot({ mode: 'publish' });
      expect(resources.getAmount(resources.getIndex('gold')!)).toBe(0);

      // Tick 2: 1.0 accumulated, 1 applied
      system.tick(createTickContext(1000, 1));
      resources.snapshot({ mode: 'publish' });
      expect(resources.getAmount(resources.getIndex('gold')!)).toBe(1);

      // Tick 3: 0.5 accumulated (remainder from tick 2 + new), nothing applied
      system.tick(createTickContext(1000, 2));
      resources.snapshot({ mode: 'publish' });
      expect(resources.getAmount(resources.getIndex('gold')!)).toBe(1);

      // Tick 4: 1.0 accumulated, 1 applied (total: 2)
      system.tick(createTickContext(1000, 3));
      resources.snapshot({ mode: 'publish' });
      expect(resources.getAmount(resources.getIndex('gold')!)).toBe(2);
    });

    it('should calculate consumption ratio based on actual accumulated amounts', () => {
      // This test verifies the fix for the consumption ratio desync issue:
      // The ratio should be based on what will ACTUALLY be consumed (after threshold),
      // not the raw target amount. This prevents production from running at full rate
      // when consumption is still accumulating below threshold.
      const resources = createResourceState([
        { id: 'energy', startAmount: 0.005 }, // Just enough for ~half the threshold
        { id: 'ore', startAmount: 0 },
      ]);
      const generators = [
        {
          id: 'harvester',
          owned: 1,
          produces: [{ resourceId: 'ore', rate: 10 }],
          consumes: [{ resourceId: 'energy', rate: 1 }],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
        applyThreshold: 0.01,
      });

      // Tick 1: Consumes 0.001 energy (1 rate * 0.001s), accumulates below threshold
      // Since no consumption is actually applied (below threshold),
      // production should also not apply (no consumption = no production)
      system.tick(createTickContext(1, 0)); // 1ms = 0.001s
      resources.snapshot({ mode: 'publish' });

      const oreIndex = resources.getIndex('ore')!;
      const energyIndex = resources.getIndex('energy')!;

      // Before fix: ratio calculated on raw amounts, production might proceed incorrectly
      // After fix: no consumption applied yet (below threshold), so production waits too
      expect(resources.getAmount(energyIndex)).toBe(0.005); // Energy unchanged
      expect(resources.getAmount(oreIndex)).toBe(0); // No ore produced yet

      // Run more ticks until consumption threshold is reached
      for (let i = 1; i <= 10; i++) {
        system.tick(createTickContext(1, i));
      }
      resources.snapshot({ mode: 'publish' });

      // After 11ms total: 0.011 energy would be consumed, 0.01 applied
      // This should trigger proportional production
      expect(resources.getAmount(energyIndex)).toBeCloseTo(0.005 - 0.005, 5); // 0.005 consumed (limited by available)
      expect(resources.getAmount(oreIndex)).toBeCloseTo(0.05, 5); // 10 * 0.005 = 0.05 ore produced (scaled by ratio)
    });
  });

  describe('clearAccumulators', () => {
    it('should reset accumulated sub-threshold amounts', () => {
      const resources = createResourceState([{ id: 'gold', startAmount: 0 }]);
      const generators = [
        {
          id: 'mine',
          owned: 1,
          produces: [{ resourceId: 'gold', rate: 0.003 }],
          consumes: [],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
        applyThreshold: 0.01,
      });

      // Tick 1: 0.003 accumulated, nothing applied
      system.tick(createTickContext(1000, 0));
      resources.snapshot({ mode: 'publish' });
      expect(resources.getAmount(resources.getIndex('gold')!)).toBe(0);

      // Tick 2: 0.006 accumulated, nothing applied
      system.tick(createTickContext(1000, 1));
      resources.snapshot({ mode: 'publish' });
      expect(resources.getAmount(resources.getIndex('gold')!)).toBe(0);

      // Clear accumulators
      system.clearAccumulators();

      // Tick 3: Should start fresh with 0.003 (not 0.009)
      system.tick(createTickContext(1000, 2));
      resources.snapshot({ mode: 'publish' });
      expect(resources.getAmount(resources.getIndex('gold')!)).toBe(0);

      // Tick 4: Should have 0.006 accumulated (not 0.012)
      system.tick(createTickContext(1000, 3));
      resources.snapshot({ mode: 'publish' });
      expect(resources.getAmount(resources.getIndex('gold')!)).toBe(0);
    });

    it('should allow production to continue normally after clearing', () => {
      const resources = createResourceState([{ id: 'gold', startAmount: 0 }]);
      const generators = [
        {
          id: 'mine',
          owned: 1,
          produces: [{ resourceId: 'gold', rate: 0.003 }],
          consumes: [],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
        applyThreshold: 0.01,
      });

      // Accumulate some sub-threshold amounts
      system.tick(createTickContext(1000, 0));
      system.tick(createTickContext(1000, 1));

      // Clear accumulators
      system.clearAccumulators();

      // Continue production - should eventually apply amounts again
      system.tick(createTickContext(1000, 2));
      system.tick(createTickContext(1000, 3));
      system.tick(createTickContext(1000, 4));
      system.tick(createTickContext(1000, 5)); // 4 ticks * 0.003 = 0.012, should apply 0.01

      resources.snapshot({ mode: 'publish' });
      expect(resources.getAmount(resources.getIndex('gold')!)).toBe(0.01);
    });

    it('should prevent old accumulated values from being applied after clearing mid-accumulation', () => {
      const resources = createResourceState([{ id: 'gold', startAmount: 0 }]);
      const generators = [
        {
          id: 'mine',
          owned: 1,
          produces: [{ resourceId: 'gold', rate: 0.003 }],
          consumes: [],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
        applyThreshold: 0.01,
      });

      // Build up 0.009 accumulated (3 ticks * 0.003)
      system.tick(createTickContext(1000, 0));
      system.tick(createTickContext(1000, 1));
      system.tick(createTickContext(1000, 2));
      resources.snapshot({ mode: 'publish' });
      expect(resources.getAmount(resources.getIndex('gold')!)).toBe(0); // Not yet applied

      // Clear accumulators before the threshold is reached
      system.clearAccumulators();

      // Next tick would have pushed it over 0.01 if we hadn't cleared
      // But since we cleared, we start fresh
      system.tick(createTickContext(1000, 3));
      resources.snapshot({ mode: 'publish' });
      expect(resources.getAmount(resources.getIndex('gold')!)).toBe(0); // Only 0.003 accumulated, not 0.012

      // Verify we need 4 more ticks to reach the threshold
      system.tick(createTickContext(1000, 4));
      system.tick(createTickContext(1000, 5));
      system.tick(createTickContext(1000, 6));
      resources.snapshot({ mode: 'publish' });
      expect(resources.getAmount(resources.getIndex('gold')!)).toBe(0.01); // Now we've accumulated enough
    });

    it('should clear accumulators for multiple generators and resources', () => {
      const resources = createResourceState([
        { id: 'gold', startAmount: 0 },
        { id: 'wood', startAmount: 0 },
      ]);
      const generators = [
        {
          id: 'gold-mine',
          owned: 1,
          produces: [{ resourceId: 'gold', rate: 0.003 }],
          consumes: [],
        },
        {
          id: 'lumbermill',
          owned: 1,
          produces: [{ resourceId: 'wood', rate: 0.004 }],
          consumes: [],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
        applyThreshold: 0.01,
      });

      // Accumulate sub-threshold amounts for both generators
      system.tick(createTickContext(1000, 0));
      system.tick(createTickContext(1000, 1));
      resources.snapshot({ mode: 'publish' });
      expect(resources.getAmount(resources.getIndex('gold')!)).toBe(0);
      expect(resources.getAmount(resources.getIndex('wood')!)).toBe(0);

      // Clear all accumulators
      system.clearAccumulators();

      // Both should start fresh
      system.tick(createTickContext(1000, 2));
      resources.snapshot({ mode: 'publish' });
      expect(resources.getAmount(resources.getIndex('gold')!)).toBe(0);
      expect(resources.getAmount(resources.getIndex('wood')!)).toBe(0);
    });
  });

  describe('cleanupAccumulators', () => {
    it('should remove entries with effectively zero values', () => {
      const resources = createResourceState([{ id: 'gold', startAmount: 0 }]);
      const generators = [
        {
          id: 'mine',
          owned: 1,
          produces: [{ resourceId: 'gold', rate: 0.01 }],
          consumes: [],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
        applyThreshold: 0.01,
      });

      // Tick to create accumulator entry, then apply exactly threshold
      // This should leave a near-zero remainder
      system.tick(createTickContext(1000, 0)); // 0.01 produced, 0.01 applied, ~0 remainder
      resources.snapshot({ mode: 'publish' });
      expect(resources.getAmount(resources.getIndex('gold')!)).toBe(0.01);

      // Cleanup should remove the near-zero entry
      system.cleanupAccumulators();

      // Continuing should work normally (creates fresh accumulator)
      system.tick(createTickContext(1000, 1));
      resources.snapshot({ mode: 'publish' });
      expect(resources.getAmount(resources.getIndex('gold')!)).toBe(0.02);
    });

    it('should preserve entries with significant accumulated values', () => {
      const resources = createResourceState([{ id: 'gold', startAmount: 0 }]);
      const generators = [
        {
          id: 'mine',
          owned: 1,
          produces: [{ resourceId: 'gold', rate: 0.003 }],
          consumes: [],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
        applyThreshold: 0.01,
      });

      // Accumulate sub-threshold amount
      system.tick(createTickContext(1000, 0)); // 0.003 accumulated
      system.tick(createTickContext(1000, 1)); // 0.006 accumulated
      resources.snapshot({ mode: 'publish' });
      expect(resources.getAmount(resources.getIndex('gold')!)).toBe(0);

      // Cleanup should NOT remove this entry (0.006 is significant)
      system.cleanupAccumulators();

      // Next ticks should continue from accumulated value
      system.tick(createTickContext(1000, 2)); // 0.009 accumulated
      system.tick(createTickContext(1000, 3)); // 0.012 accumulated, 0.01 applied
      resources.snapshot({ mode: 'publish' });
      expect(resources.getAmount(resources.getIndex('gold')!)).toBe(0.01);
    });

    it('should remove stale entries from removed generators', () => {
      const resources = createResourceState([{ id: 'gold', startAmount: 0 }]);
      let generators = [
        {
          id: 'temp-mine',
          owned: 1,
          produces: [{ resourceId: 'gold', rate: 0.003 }],
          consumes: [],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
        applyThreshold: 0.01,
      });

      // Accumulate for temp-mine
      system.tick(createTickContext(1000, 0));
      system.tick(createTickContext(1000, 1));

      // "Remove" the generator
      generators = [];

      // Run a tick with no generators (accumulators remain but get no updates)
      system.tick(createTickContext(1000, 2));

      // Clear the accumulator (this simulates prestige cleanup)
      system.clearAccumulators();

      // Add back a different generator
      generators = [
        {
          id: 'new-mine',
          owned: 1,
          produces: [{ resourceId: 'gold', rate: 0.01 }],
          consumes: [],
        },
      ];

      // New generator should start fresh
      system.tick(createTickContext(1000, 3));
      resources.snapshot({ mode: 'publish' });
      expect(resources.getAmount(resources.getIndex('gold')!)).toBe(0.01);
    });
  });

  describe('clearGeneratorAccumulators', () => {
    it('should remove accumulators for a specific generator only', () => {
      const resources = createResourceState([{ id: 'gold', startAmount: 0 }]);
      const generators = [
        {
          id: 'mine-a',
          owned: 1,
          produces: [{ resourceId: 'gold', rate: 0.003 }],
          consumes: [],
        },
        {
          id: 'mine-b',
          owned: 1,
          produces: [{ resourceId: 'gold', rate: 0.003 }],
          consumes: [],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
        applyThreshold: 0.01,
      });

      // Tick both generators to accumulate sub-threshold amounts
      system.tick(createTickContext(1000, 0)); // 0.003 each
      system.tick(createTickContext(1000, 1)); // 0.006 each
      resources.snapshot({ mode: 'publish' });
      expect(resources.getAmount(resources.getIndex('gold')!)).toBe(0);

      // Clear only mine-a's accumulators
      system.clearGeneratorAccumulators('mine-a');

      // Two more ticks: mine-a restarts at 0.006, mine-b reaches 0.012 and applies 0.01
      system.tick(createTickContext(1000, 2)); // mine-a: 0.003, mine-b: 0.009
      system.tick(createTickContext(1000, 3)); // mine-a: 0.006, mine-b: 0.012 -> applies 0.01
      resources.snapshot({ mode: 'publish' });

      // Only mine-b should have applied (0.01), mine-a still accumulating
      expect(resources.getAmount(resources.getIndex('gold')!)).toBe(0.01);
    });

    it('should handle clearing non-existent generator gracefully', () => {
      const resources = createResourceState([{ id: 'gold', startAmount: 0 }]);
      const generators = [
        {
          id: 'mine',
          owned: 1,
          produces: [{ resourceId: 'gold', rate: 0.003 }],
          consumes: [],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
        applyThreshold: 0.01,
      });

      system.tick(createTickContext(1000, 0));

      // Should not throw
      expect(() => {
        system.clearGeneratorAccumulators('non-existent');
      }).not.toThrow();

      // Continue ticking - original generator should still work
      system.tick(createTickContext(1000, 1));
      system.tick(createTickContext(1000, 2));
      system.tick(createTickContext(1000, 3)); // 0.012 accumulated, applies 0.01
      resources.snapshot({ mode: 'publish' });

      expect(resources.getAmount(resources.getIndex('gold')!)).toBe(0.01);
    });

    it('should clear both produce and consume accumulators for a generator', () => {
      const resources = createResourceState([
        { id: 'energy', startAmount: 100 },
        { id: 'ore', startAmount: 0 },
      ]);
      const generators = [
        {
          id: 'harvester',
          owned: 1,
          produces: [{ resourceId: 'ore', rate: 0.003 }],
          consumes: [{ resourceId: 'energy', rate: 0.003 }],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
        applyThreshold: 0.01,
      });

      // Accumulate some sub-threshold amounts
      system.tick(createTickContext(1000, 0));
      system.tick(createTickContext(1000, 1));
      resources.snapshot({ mode: 'publish' });

      // Clear the harvester's accumulators
      system.clearGeneratorAccumulators('harvester');

      // Now it should take 4 more ticks to reach threshold again (not 2)
      system.tick(createTickContext(1000, 2));
      system.tick(createTickContext(1000, 3));
      resources.snapshot({ mode: 'publish' });
      expect(resources.getAmount(resources.getIndex('ore')!)).toBe(0); // Still below threshold

      system.tick(createTickContext(1000, 4));
      system.tick(createTickContext(1000, 5)); // 0.012 accumulated, applies 0.01
      resources.snapshot({ mode: 'publish' });
      expect(resources.getAmount(resources.getIndex('ore')!)).toBe(0.01);
    });
  });
});
