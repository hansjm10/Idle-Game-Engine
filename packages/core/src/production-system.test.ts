import { describe, it, expect } from 'vitest';
import { createProductionSystem } from './production-system.js';
import { createResourceState, type ResourceState } from './resource-state.js';
import { createTickContext } from './test-utils.js';

describe('createProductionSystem', () => {
  const createTestResources = (): ResourceState => {
    return createResourceState([
      { id: 'gold', startAmount: 0 },
      { id: 'wood', startAmount: 100 },
    ]);
  };

  describe('production', () => {
    it('should add produced resources based on rate and owned count', () => {
      const resources = createTestResources();
      const generators = [
        {
          id: 'gold-mine',
          owned: 2,
          produces: [{ resourceId: 'gold', rate: 5 }],
          consumes: [],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
      });

      system.tick(createTickContext(1000, 0));
      resources.snapshot({ mode: 'publish' });

      const goldIndex = resources.getIndex('gold')!;
      expect(resources.getAmount(goldIndex)).toBe(10); // 5 rate * 2 owned * 1 second
    });
  });

  describe('consumption', () => {
    it('should spend consumed resources based on rate and owned count', () => {
      const resources = createTestResources();
      const generators = [
        {
          id: 'sawmill',
          owned: 2,
          produces: [],
          consumes: [{ resourceId: 'wood', rate: 10 }],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
      });

      system.tick(createTickContext(1000, 0));
      resources.snapshot({ mode: 'publish' });

      const woodIndex = resources.getIndex('wood')!;
      expect(resources.getAmount(woodIndex)).toBe(80); // 100 - (10 rate * 2 owned * 1 second)
    });

    it('should not consume more than available', () => {
      const resources = createTestResources();
      const generators = [
        {
          id: 'sawmill',
          owned: 10,
          produces: [],
          consumes: [{ resourceId: 'wood', rate: 50 }],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
      });

      system.tick(createTickContext(1000, 0));
      resources.snapshot({ mode: 'publish' });

      const woodIndex = resources.getIndex('wood')!;
      // Would consume 500, but only 100 available
      expect(resources.getAmount(woodIndex)).toBe(0);
    });
  });

  describe('multipliers', () => {
    it('should apply multiplier to production rate', () => {
      const resources = createTestResources();
      const generators = [
        {
          id: 'gold-mine',
          owned: 2,
          produces: [{ resourceId: 'gold', rate: 5 }],
          consumes: [],
        },
      ];
      const multipliers = new Map([['gold-mine', 3]]);

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
        getMultiplier: (id) => multipliers.get(id) ?? 1,
      });

      system.tick(createTickContext(1000, 0));
      resources.snapshot({ mode: 'publish' });

      const goldIndex = resources.getIndex('gold')!;
      expect(resources.getAmount(goldIndex)).toBe(30); // 5 rate * 2 owned * 3 multiplier * 1 second
    });

    it('should default to multiplier of 1 when getMultiplier not provided', () => {
      const resources = createTestResources();
      const generators = [
        {
          id: 'gold-mine',
          owned: 2,
          produces: [{ resourceId: 'gold', rate: 5 }],
          consumes: [],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
      });

      system.tick(createTickContext(1000, 0));
      resources.snapshot({ mode: 'publish' });

      const goldIndex = resources.getIndex('gold')!;
      expect(resources.getAmount(goldIndex)).toBe(10); // 5 rate * 2 owned * 1 multiplier * 1 second
    });
  });

  describe('production with consumption requirements', () => {
    it('should not produce when consumed resource is empty', () => {
      const resources = createResourceState([
        { id: 'energy', startAmount: 0 },
        { id: 'ore', startAmount: 0 },
      ]);
      const generators = [
        {
          id: 'harvester',
          owned: 1,
          produces: [{ resourceId: 'ore', rate: 10 }],
          consumes: [{ resourceId: 'energy', rate: 5 }],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
      });

      system.tick(createTickContext(1000, 0));
      resources.snapshot({ mode: 'publish' });

      const oreIndex = resources.getIndex('ore')!;
      // No energy available, so no ore should be produced
      expect(resources.getAmount(oreIndex)).toBe(0);
    });

    it('should scale production proportionally to available consumed resource', () => {
      const resources = createResourceState([
        { id: 'energy', startAmount: 2.5 },
        { id: 'ore', startAmount: 0 },
      ]);
      const generators = [
        {
          id: 'harvester',
          owned: 1,
          produces: [{ resourceId: 'ore', rate: 10 }],
          consumes: [{ resourceId: 'energy', rate: 5 }],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
      });

      system.tick(createTickContext(1000, 0));
      resources.snapshot({ mode: 'publish' });

      const oreIndex = resources.getIndex('ore')!;
      const energyIndex = resources.getIndex('energy')!;
      // Only 2.5 energy available out of 5 needed (50%), so produce 5 ore instead of 10
      expect(resources.getAmount(oreIndex)).toBe(5);
      expect(resources.getAmount(energyIndex)).toBe(0); // All energy consumed
    });

    it('should produce at full rate when all consumption requirements are met', () => {
      const resources = createResourceState([
        { id: 'energy', startAmount: 100 },
        { id: 'ore', startAmount: 0 },
      ]);
      const generators = [
        {
          id: 'harvester',
          owned: 1,
          produces: [{ resourceId: 'ore', rate: 10 }],
          consumes: [{ resourceId: 'energy', rate: 5 }],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
      });

      system.tick(createTickContext(1000, 0));
      resources.snapshot({ mode: 'publish' });

      const oreIndex = resources.getIndex('ore')!;
      const energyIndex = resources.getIndex('energy')!;
      expect(resources.getAmount(oreIndex)).toBe(10); // Full production
      expect(resources.getAmount(energyIndex)).toBe(95); // 100 - 5 consumed
    });

    it('should use minimum consumption ratio when multiple resources are consumed', () => {
      const resources = createResourceState([
        { id: 'energy', startAmount: 5 },
        { id: 'water', startAmount: 2 },
        { id: 'ore', startAmount: 0 },
      ]);
      const generators = [
        {
          id: 'harvester',
          owned: 1,
          produces: [{ resourceId: 'ore', rate: 10 }],
          consumes: [
            { resourceId: 'energy', rate: 5 },
            { resourceId: 'water', rate: 4 },
          ],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
      });

      system.tick(createTickContext(1000, 0));
      resources.snapshot({ mode: 'publish' });

      const oreIndex = resources.getIndex('ore')!;
      const energyIndex = resources.getIndex('energy')!;
      const waterIndex = resources.getIndex('water')!;
      // Water is limiting: 2/4 = 50%, so produce 5 ore
      // Energy consumption also scaled: 5 * 0.5 = 2.5
      expect(resources.getAmount(oreIndex)).toBe(5);
      expect(resources.getAmount(waterIndex)).toBe(0);
      expect(resources.getAmount(energyIndex)).toBe(2.5);
    });
  });

  describe('edge cases', () => {
    it('should skip generators with zero owned count', () => {
      const resources = createTestResources();
      const generators = [
        {
          id: 'gold-mine',
          owned: 0,
          produces: [{ resourceId: 'gold', rate: 5 }],
          consumes: [],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
      });

      system.tick(createTickContext(1000, 0));
      resources.snapshot({ mode: 'publish' });

      const goldIndex = resources.getIndex('gold')!;
      expect(resources.getAmount(goldIndex)).toBe(0);
    });

    it('should skip resources that do not exist', () => {
      const resources = createTestResources();
      const generators = [
        {
          id: 'mystery-generator',
          owned: 1,
          produces: [{ resourceId: 'nonexistent', rate: 5 }],
          consumes: [],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
      });

      // Should not throw
      expect(() => {
        system.tick(createTickContext(1000, 0));
      }).not.toThrow();
    });

    it('should handle fractional delta times', () => {
      const resources = createTestResources();
      const generators = [
        {
          id: 'gold-mine',
          owned: 1,
          produces: [{ resourceId: 'gold', rate: 10 }],
          consumes: [],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
      });

      system.tick(createTickContext(100, 0)); // 0.1 seconds
      resources.snapshot({ mode: 'publish' });

      const goldIndex = resources.getIndex('gold')!;
      expect(resources.getAmount(goldIndex)).toBe(1); // 10 rate * 1 owned * 0.1 seconds
    });

    it('should handle zero delta time', () => {
      const resources = createTestResources();
      const generators = [
        {
          id: 'gold-mine',
          owned: 1,
          produces: [{ resourceId: 'gold', rate: 10 }],
          consumes: [],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
      });

      system.tick(createTickContext(0, 0));
      resources.snapshot({ mode: 'publish' });

      const goldIndex = resources.getIndex('gold')!;
      expect(resources.getAmount(goldIndex)).toBe(0);
    });

    it('should handle negative rates by treating as zero', () => {
      const resources = createTestResources();
      const generators = [
        {
          id: 'broken-mine',
          owned: 1,
          produces: [{ resourceId: 'gold', rate: -5 }],
          consumes: [],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
      });

      system.tick(createTickContext(1000, 0));
      resources.snapshot({ mode: 'publish' });

      const goldIndex = resources.getIndex('gold')!;
      expect(resources.getAmount(goldIndex)).toBe(0); // Negative rate treated as 0
    });

    it('should handle non-finite rates gracefully', () => {
      const resources = createTestResources();
      const generators = [
        {
          id: 'infinity-mine',
          owned: 1,
          produces: [{ resourceId: 'gold', rate: Number.POSITIVE_INFINITY }],
          consumes: [],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
      });

      // Should not throw
      expect(() => {
        system.tick(createTickContext(1000, 0));
      }).not.toThrow();

      resources.snapshot({ mode: 'publish' });
      const goldIndex = resources.getIndex('gold')!;
      expect(resources.getAmount(goldIndex)).toBe(0); // Non-finite rate treated as 0
    });

    it('should handle generator that produces and consumes same resource', () => {
      const resources = createResourceState([{ id: 'ore', startAmount: 100 }]);
      const generators = [
        {
          id: 'ore-refiner',
          owned: 1,
          produces: [{ resourceId: 'ore', rate: 8 }],
          consumes: [{ resourceId: 'ore', rate: 10 }],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
      });

      system.tick(createTickContext(1000, 0));
      resources.snapshot({ mode: 'publish' });

      const oreIndex = resources.getIndex('ore')!;
      // Net effect: -2/s (consumes 10, produces 8)
      // After 1 second: 100 - 10 + 8 = 98
      expect(resources.getAmount(oreIndex)).toBe(98);
    });
  });

  describe('onTick callback', () => {
    it('should call onTick with correct produced amounts', () => {
      const resources = createTestResources();
      const generators = [
        {
          id: 'gold-mine',
          owned: 2,
          produces: [{ resourceId: 'gold', rate: 5 }],
          consumes: [],
        },
      ];

      const tickStats: Array<{ produced: Map<string, number>; consumed: Map<string, number> }> = [];
      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
        onTick: (stats) => tickStats.push(stats),
      });

      system.tick(createTickContext(1000, 0));
      resources.snapshot({ mode: 'publish' });

      expect(tickStats).toHaveLength(1);
      expect(tickStats[0].produced.get('gold')).toBe(10); // 5 rate * 2 owned * 1 second
      expect(tickStats[0].consumed.size).toBe(0);
    });

    it('should call onTick with correct consumed amounts', () => {
      const resources = createTestResources();
      const generators = [
        {
          id: 'sawmill',
          owned: 2,
          produces: [],
          consumes: [{ resourceId: 'wood', rate: 10 }],
        },
      ];

      const tickStats: Array<{ produced: Map<string, number>; consumed: Map<string, number> }> = [];
      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
        onTick: (stats) => tickStats.push(stats),
      });

      system.tick(createTickContext(1000, 0));
      resources.snapshot({ mode: 'publish' });

      expect(tickStats).toHaveLength(1);
      expect(tickStats[0].produced.size).toBe(0);
      expect(tickStats[0].consumed.get('wood')).toBe(20); // 10 rate * 2 owned * 1 second
    });

    it('should not error when onTick is not provided', () => {
      const resources = createTestResources();
      const generators = [
        {
          id: 'gold-mine',
          owned: 1,
          produces: [{ resourceId: 'gold', rate: 5 }],
          consumes: [],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
        // onTick not provided
      });

      // Should not throw
      expect(() => {
        system.tick(createTickContext(1000, 0));
        resources.snapshot({ mode: 'publish' });
      }).not.toThrow();

      const goldIndex = resources.getIndex('gold')!;
      expect(resources.getAmount(goldIndex)).toBe(5);
    });

    it('should reflect actual applied values after threshold', () => {
      const resources = createResourceState([{ id: 'gold', startAmount: 0 }]);
      const generators = [
        {
          id: 'mine',
          owned: 1,
          produces: [{ resourceId: 'gold', rate: 0.003 }],
          consumes: [],
        },
      ];

      const tickStats: Array<{ produced: Map<string, number>; consumed: Map<string, number> }> = [];
      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
        applyThreshold: 0.01,
        onTick: (stats) => tickStats.push(stats),
      });

      // First tick: 0.003 accumulated, nothing applied (below 0.01)
      system.tick(createTickContext(1000, 0));
      resources.snapshot({ mode: 'publish' });
      expect(tickStats).toHaveLength(1);
      expect(tickStats[0].produced.size).toBe(0); // Nothing applied yet

      // Second tick: 0.006 accumulated, nothing applied
      system.tick(createTickContext(1000, 1));
      resources.snapshot({ mode: 'publish' });
      expect(tickStats).toHaveLength(2);
      expect(tickStats[1].produced.size).toBe(0); // Still nothing applied

      // Third tick: 0.009 accumulated, nothing applied
      system.tick(createTickContext(1000, 2));
      resources.snapshot({ mode: 'publish' });
      expect(tickStats).toHaveLength(3);
      expect(tickStats[2].produced.size).toBe(0); // Still nothing applied

      // Fourth tick: 0.012 accumulated, 0.01 applied, 0.002 remainder
      system.tick(createTickContext(1000, 3));
      resources.snapshot({ mode: 'publish' });
      expect(tickStats).toHaveLength(4);
      expect(tickStats[3].produced.get('gold')).toBe(0.01); // Now 0.01 is applied
    });

    it('should aggregate amounts from multiple generators', () => {
      const resources = createTestResources();
      const generators = [
        {
          id: 'gold-mine-1',
          owned: 1,
          produces: [{ resourceId: 'gold', rate: 3 }],
          consumes: [],
        },
        {
          id: 'gold-mine-2',
          owned: 2,
          produces: [{ resourceId: 'gold', rate: 2 }],
          consumes: [],
        },
      ];

      const tickStats: Array<{ produced: Map<string, number>; consumed: Map<string, number> }> = [];
      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
        onTick: (stats) => tickStats.push(stats),
      });

      system.tick(createTickContext(1000, 0));
      resources.snapshot({ mode: 'publish' });

      expect(tickStats).toHaveLength(1);
      // Total gold: (3 * 1) + (2 * 2) = 7
      expect(tickStats[0].produced.get('gold')).toBe(7);
    });
  });

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

  describe('systemId option', () => {
    it('should use default system id when not provided', () => {
      const resources = createTestResources();
      const generators = [
        {
          id: 'mine',
          owned: 1,
          produces: [{ resourceId: 'gold', rate: 1 }],
          consumes: [],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
      });

      expect(system.id).toBe('production');
    });

    it('should use custom system id when provided', () => {
      const resources = createTestResources();
      const generators = [
        {
          id: 'mine',
          owned: 1,
          produces: [{ resourceId: 'gold', rate: 1 }],
          consumes: [],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
        systemId: 'custom-production',
      });

      expect(system.id).toBe('custom-production');
    });

    it('should allow multiple production systems with different ids', () => {
      const resources = createTestResources();
      const generators = [
        {
          id: 'mine',
          owned: 1,
          produces: [{ resourceId: 'gold', rate: 1 }],
          consumes: [],
        },
      ];

      const system1 = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
        systemId: 'production-layer-1',
      });

      const system2 = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
        systemId: 'production-layer-2',
      });

      expect(system1.id).toBe('production-layer-1');
      expect(system2.id).toBe('production-layer-2');
      expect(system1.id).not.toBe(system2.id);
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

  describe('exportAccumulators and restoreAccumulators', () => {
    it('should export empty object when no accumulators exist', () => {
      const resources = createResourceState([{ id: 'gold', startAmount: 0 }]);
      const generators = [
        {
          id: 'mine',
          owned: 1,
          produces: [{ resourceId: 'gold', rate: 1 }],
          consumes: [],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
        applyThreshold: 0.01,
      });

      const exported = system.exportAccumulators();
      expect(exported.accumulators).toEqual({});
    });

    it('should export accumulated sub-threshold values', () => {
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

      // Tick twice to accumulate 0.006 (below threshold of 0.01)
      system.tick(createTickContext(1000, 0));
      system.tick(createTickContext(1000, 1));
      resources.snapshot({ mode: 'publish' });

      const exported = system.exportAccumulators();
      expect(exported.accumulators['mine:produce:gold']).toBeCloseTo(0.006, 6);
    });

    it('should export remainder after threshold application', () => {
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

      // Tick 4 times: 0.012 accumulated, 0.01 applied, 0.002 remainder
      system.tick(createTickContext(1000, 0));
      system.tick(createTickContext(1000, 1));
      system.tick(createTickContext(1000, 2));
      system.tick(createTickContext(1000, 3));
      resources.snapshot({ mode: 'publish' });

      const exported = system.exportAccumulators();
      expect(exported.accumulators['mine:produce:gold']).toBeCloseTo(0.002, 6);
    });

    it('should restore accumulators and continue accumulation correctly', () => {
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

      // Restore 0.006 accumulated (simulating a loaded save)
      system.restoreAccumulators({
        accumulators: { 'mine:produce:gold': 0.006 },
      });

      // Two more ticks should push it over threshold: 0.006 + 0.006 = 0.012
      system.tick(createTickContext(1000, 0));
      system.tick(createTickContext(1000, 1));
      resources.snapshot({ mode: 'publish' });

      expect(resources.getAmount(resources.getIndex('gold')!)).toBe(0.01);
    });

    it('should clear existing accumulators when restoring', () => {
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

      // Accumulate some amount
      system.tick(createTickContext(1000, 0));
      system.tick(createTickContext(1000, 1)); // 0.006 accumulated

      // Restore with different value
      system.restoreAccumulators({
        accumulators: { 'mine:produce:gold': 0.008 },
      });

      // One tick should push over threshold: 0.008 + 0.003 = 0.011
      system.tick(createTickContext(1000, 2));
      resources.snapshot({ mode: 'publish' });

      expect(resources.getAmount(resources.getIndex('gold')!)).toBe(0.01);
    });

    it('should handle null/undefined state gracefully', () => {
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

      // Accumulate some amount
      system.tick(createTickContext(1000, 0));

      // These should not throw
      expect(() =>
        system.restoreAccumulators(null as unknown as { accumulators: Record<string, number> }),
      ).not.toThrow();
      expect(() =>
        system.restoreAccumulators(undefined as unknown as { accumulators: Record<string, number> }),
      ).not.toThrow();
      expect(() => system.restoreAccumulators({ accumulators: {} })).not.toThrow();
    });

    it('should filter out invalid accumulator values on restore', () => {
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

      // Restore with mixed valid/invalid values
      system.restoreAccumulators({
        accumulators: {
          'mine:produce:gold': 0.006,
          'invalid:key': Infinity,
          'another:invalid': NaN,
          'string:value': 'not a number' as unknown as number,
        },
      });

      const exported = system.exportAccumulators();
      // Only the valid value should be restored
      expect(Object.keys(exported.accumulators)).toHaveLength(1);
      expect(exported.accumulators['mine:produce:gold']).toBeCloseTo(0.006, 6);
    });

    it('should export both produce and consume accumulators', () => {
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

      // Tick to accumulate sub-threshold amounts
      system.tick(createTickContext(1000, 0));
      system.tick(createTickContext(1000, 1));
      resources.snapshot({ mode: 'publish' });

      const exported = system.exportAccumulators();
      expect(exported.accumulators['harvester:produce:ore']).toBeCloseTo(0.006, 6);
      expect(exported.accumulators['harvester:consume:energy']).toBeCloseTo(0.006, 6);
    });

    it('should not export zero values', () => {
      const resources = createResourceState([{ id: 'gold', startAmount: 0 }]);
      const generators = [
        {
          id: 'mine',
          owned: 1,
          produces: [{ resourceId: 'gold', rate: 0.005 }],
          consumes: [],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
        applyThreshold: 0.01,
      });

      // Tick twice: 0.01 accumulated, 0.01 applied, 0 remainder
      system.tick(createTickContext(1000, 0));
      system.tick(createTickContext(1000, 1));
      resources.snapshot({ mode: 'publish' });

      const exported = system.exportAccumulators();
      // Zero remainder should not be exported
      expect(exported.accumulators['mine:produce:gold']).toBeUndefined();
    });

    it('should preserve accumulator state across simulated save/load cycle', () => {
      const resources1 = createResourceState([{ id: 'gold', startAmount: 0 }]);
      const generators = [
        {
          id: 'mine',
          owned: 1,
          produces: [{ resourceId: 'gold', rate: 0.003 }],
          consumes: [],
        },
      ];

      const system1 = createProductionSystem({
        generators: () => generators,
        resourceState: resources1,
        applyThreshold: 0.01,
      });

      // Tick twice in first system
      system1.tick(createTickContext(1000, 0));
      system1.tick(createTickContext(1000, 1));
      resources1.snapshot({ mode: 'publish' });

      // Export state (simulating save)
      const savedState = system1.exportAccumulators();

      // Create new system (simulating load)
      const resources2 = createResourceState([{ id: 'gold', startAmount: 0 }]);
      const system2 = createProductionSystem({
        generators: () => generators,
        resourceState: resources2,
        applyThreshold: 0.01,
      });

      // Restore state
      system2.restoreAccumulators(savedState);

      // Two more ticks should reach threshold
      system2.tick(createTickContext(1000, 2));
      system2.tick(createTickContext(1000, 3));
      resources2.snapshot({ mode: 'publish' });

      expect(resources2.getAmount(resources2.getIndex('gold')!)).toBe(0.01);
    });
  });

  describe('ProductionResourceState abstraction', () => {
    it('should work with a minimal resource state implementation', () => {
      // Create a minimal mock that implements only ProductionResourceState
      const amounts = new Map<number, number>([
        [0, 0], // gold
        [1, 100], // energy
      ]);
      const indices = new Map<string, number>([
        ['gold', 0],
        ['energy', 1],
      ]);

      const minimalResourceState = {
        getIndex: (resourceId: string) => indices.get(resourceId),
        getAmount: (index: number) => amounts.get(index) ?? 0,
        addAmount: (index: number, amount: number) => {
          amounts.set(index, (amounts.get(index) ?? 0) + amount);
        },
        spendAmount: (index: number, amount: number) => {
          const current = amounts.get(index) ?? 0;
          if (current >= amount) {
            amounts.set(index, current - amount);
            return true;
          }
          return false;
        },
      };

      const generators = [
        {
          id: 'converter',
          owned: 1,
          produces: [{ resourceId: 'gold', rate: 10 }],
          consumes: [{ resourceId: 'energy', rate: 5 }],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: minimalResourceState,
      });

      system.tick(createTickContext(1000, 0));

      // Gold produced: 10/s * 1s = 10
      // Energy consumed: 5/s * 1s = 5
      expect(amounts.get(0)).toBe(10);
      expect(amounts.get(1)).toBe(95);
    });

    it('should handle consumption limiting with minimal implementation', () => {
      const amounts = new Map<number, number>([
        [0, 0], // output
        [1, 2.5], // input (limited)
      ]);
      const indices = new Map<string, number>([
        ['output', 0],
        ['input', 1],
      ]);

      const minimalResourceState = {
        getIndex: (resourceId: string) => indices.get(resourceId),
        getAmount: (index: number) => amounts.get(index) ?? 0,
        addAmount: (index: number, amount: number) => {
          amounts.set(index, (amounts.get(index) ?? 0) + amount);
        },
        spendAmount: (index: number, amount: number) => {
          const current = amounts.get(index) ?? 0;
          if (current >= amount) {
            amounts.set(index, current - amount);
            return true;
          }
          return false;
        },
      };

      const generators = [
        {
          id: 'converter',
          owned: 1,
          produces: [{ resourceId: 'output', rate: 10 }],
          consumes: [{ resourceId: 'input', rate: 5 }],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: minimalResourceState,
      });

      system.tick(createTickContext(1000, 0));

      // Only 2.5 input available out of 5 needed (50%)
      // Output produced: 10 * 0.5 = 5
      // Input consumed: 5 * 0.5 = 2.5
      expect(amounts.get(0)).toBe(5);
      expect(amounts.get(1)).toBe(0);
    });
  });
});
