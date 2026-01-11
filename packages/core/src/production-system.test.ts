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

    it('should handle zero production rate', () => {
      const resources = createTestResources();
      const generators = [
        {
          id: 'idle-mine',
          owned: 1,
          produces: [{ resourceId: 'gold', rate: 0 }],
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
      expect(resources.getAmount(goldIndex)).toBe(0); // Zero rate produces nothing
    });

    it('should handle NaN production rate', () => {
      const resources = createTestResources();
      const generators = [
        {
          id: 'nan-mine',
          owned: 1,
          produces: [{ resourceId: 'gold', rate: NaN }],
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
      expect(resources.getAmount(goldIndex)).toBe(0); // NaN rate treated as 0
    });

    it('should handle negative consumption rate', () => {
      const resources = createTestResources();
      const generators = [
        {
          id: 'broken-consumer',
          owned: 1,
          produces: [{ resourceId: 'gold', rate: 10 }],
          consumes: [{ resourceId: 'wood', rate: -5 }],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
      });

      system.tick(createTickContext(1000, 0));
      resources.snapshot({ mode: 'publish' });

      const goldIndex = resources.getIndex('gold')!;
      const woodIndex = resources.getIndex('wood')!;
      // Negative consumption rate is filtered out, so generator runs at full rate
      expect(resources.getAmount(goldIndex)).toBe(10);
      expect(resources.getAmount(woodIndex)).toBe(100); // No consumption
    });

    it('should handle zero consumption rate', () => {
      const resources = createTestResources();
      const generators = [
        {
          id: 'free-producer',
          owned: 1,
          produces: [{ resourceId: 'gold', rate: 10 }],
          consumes: [{ resourceId: 'wood', rate: 0 }],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
      });

      system.tick(createTickContext(1000, 0));
      resources.snapshot({ mode: 'publish' });

      const goldIndex = resources.getIndex('gold')!;
      const woodIndex = resources.getIndex('wood')!;
      // Zero consumption rate is filtered out, so generator runs at full rate
      expect(resources.getAmount(goldIndex)).toBe(10);
      expect(resources.getAmount(woodIndex)).toBe(100); // No consumption
    });

    it('should handle NaN consumption rate', () => {
      const resources = createTestResources();
      const generators = [
        {
          id: 'nan-consumer',
          owned: 1,
          produces: [{ resourceId: 'gold', rate: 10 }],
          consumes: [{ resourceId: 'wood', rate: NaN }],
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
      const woodIndex = resources.getIndex('wood')!;
      // NaN consumption rate is filtered out, so generator runs at full rate
      expect(resources.getAmount(goldIndex)).toBe(10);
      expect(resources.getAmount(woodIndex)).toBe(100); // No consumption
    });

    it('should handle Infinity consumption rate', () => {
      const resources = createTestResources();
      const generators = [
        {
          id: 'infinity-consumer',
          owned: 1,
          produces: [{ resourceId: 'gold', rate: 10 }],
          consumes: [{ resourceId: 'wood', rate: Infinity }],
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
      const woodIndex = resources.getIndex('wood')!;
      // Infinity consumption rate is filtered out, so generator runs at full rate
      expect(resources.getAmount(goldIndex)).toBe(10);
      expect(resources.getAmount(woodIndex)).toBe(100); // No consumption
    });

    it('should skip invalid rates while processing valid ones in same generator', () => {
      const resources = createResourceState([
        { id: 'gold', startAmount: 0 },
        { id: 'silver', startAmount: 0 },
        { id: 'copper', startAmount: 0 },
      ]);
      const generators = [
        {
          id: 'mixed-mine',
          owned: 1,
          produces: [
            { resourceId: 'gold', rate: 5 },
            { resourceId: 'silver', rate: -3 }, // Invalid: negative
            { resourceId: 'copper', rate: 2 },
          ],
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
      const silverIndex = resources.getIndex('silver')!;
      const copperIndex = resources.getIndex('copper')!;
      expect(resources.getAmount(goldIndex)).toBe(5); // Valid rate applied
      expect(resources.getAmount(silverIndex)).toBe(0); // Invalid rate skipped
      expect(resources.getAmount(copperIndex)).toBe(2); // Valid rate applied
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

      const tickStats: { produced: Map<string, number>; consumed: Map<string, number> }[] = [];
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

      const tickStats: { produced: Map<string, number>; consumed: Map<string, number> }[] = [];
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

      const tickStats: { produced: Map<string, number>; consumed: Map<string, number> }[] = [];
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

    it('should report applied produced amount when capacity clamps (standard vs applyViaFinalizeTick)', () => {
      const resourcesStandard = createResourceState([
        { id: 'gold', startAmount: 4, capacity: 5 },
      ]);
      const resourcesShadow = createResourceState([
        { id: 'gold', startAmount: 4, capacity: 5 },
      ]);
      const generators = [
        {
          id: 'mine',
          owned: 1,
          produces: [{ resourceId: 'gold', rate: 10 }],
          consumes: [],
        },
      ];

      const standardTickStats: {
        produced: Map<string, number>;
        consumed: Map<string, number>;
      }[] = [];
      const shadowTickStats: {
        produced: Map<string, number>;
        consumed: Map<string, number>;
      }[] = [];

      const standard = createProductionSystem({
        generators: () => generators,
        resourceState: resourcesStandard,
        onTick: (stats) => standardTickStats.push(stats),
      });
      const shadow = createProductionSystem({
        generators: () => generators,
        resourceState: resourcesShadow,
        applyViaFinalizeTick: true,
        onTick: (stats) => shadowTickStats.push(stats),
      });

      standard.tick(createTickContext(1000, 0));
      shadow.tick(createTickContext(1000, 0));
      resourcesShadow.finalizeTick(1000);

      resourcesStandard.snapshot({ mode: 'publish' });
      resourcesShadow.snapshot({ mode: 'publish' });

      const standardGoldIndex = resourcesStandard.getIndex('gold')!;
      const shadowGoldIndex = resourcesShadow.getIndex('gold')!;

      expect(resourcesStandard.getAmount(standardGoldIndex)).toBe(5);
      expect(resourcesShadow.getAmount(shadowGoldIndex)).toBe(5);

      expect(standardTickStats).toHaveLength(1);
      expect(shadowTickStats).toHaveLength(1);

      // Capacity allows only +1 (4 -> 5), so onTick should report applied amount.
      expect(standardTickStats[0].produced.get('gold')).toBe(1);
      expect(shadowTickStats[0].produced.get('gold')).toBe(1);
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

      const tickStats: { produced: Map<string, number>; consumed: Map<string, number> }[] = [];
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

  describe('rate tracking', () => {
    it('does not update per-second rates by default', () => {
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
      const snapshot = resources.snapshot({ mode: 'publish' });

      const goldIndex = resources.getIndex('gold')!;
      expect(snapshot.incomePerSecond[goldIndex]).toBe(0);
      expect(snapshot.expensePerSecond[goldIndex]).toBe(0);
      expect(snapshot.netPerSecond[goldIndex]).toBe(0);
    });

    it('populates per-second rates when applyViaFinalizeTick is enabled', () => {
      const resources = createResourceState([
        { id: 'gold', startAmount: 0 },
        { id: 'wood', startAmount: 5 },
      ]);

      const generators = [
        {
          id: 'converter',
          owned: 2,
          produces: [{ resourceId: 'gold', rate: 5 }], // 10 gold/s base
          consumes: [{ resourceId: 'wood', rate: 10 }], // 20 wood/s base
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
        applyViaFinalizeTick: true,
      });

      system.tick(createTickContext(1000, 0));
      const snapshot = resources.snapshot({ mode: 'publish' });

      const goldIndex = resources.getIndex('gold')!;
      const woodIndex = resources.getIndex('wood')!;

      // Only 5 wood available out of 20 needed => throttled to 25%.
      expect(snapshot.incomePerSecond[goldIndex]).toBeCloseTo(2.5, 6);
      expect(snapshot.expensePerSecond[woodIndex]).toBeCloseTo(5, 6);
      expect(snapshot.netPerSecond[goldIndex]).toBeCloseTo(2.5, 6);
      expect(snapshot.netPerSecond[woodIndex]).toBeCloseTo(-5, 6);
    });

    it('does not stall balances when trackRates is enabled', () => {
      const resources = createResourceState([
        { id: 'gold', startAmount: 0 },
        { id: 'wood', startAmount: 100 },
      ]);

      const generators = [
        {
          id: 'converter',
          owned: 2,
          produces: [{ resourceId: 'gold', rate: 5 }], // 10 gold/s
          consumes: [{ resourceId: 'wood', rate: 10 }], // 20 wood/s
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
        trackRates: true,
      });

      system.tick(createTickContext(1000, 0));

      const goldIndex = resources.getIndex('gold')!;
      const woodIndex = resources.getIndex('wood')!;

      expect(resources.getAmount(goldIndex)).toBeCloseTo(10, 6);
      expect(resources.getAmount(woodIndex)).toBeCloseTo(80, 6);
    });

    it('does not double-apply when finalizeTick runs without applyViaFinalizeTick', () => {
      const resources = createResourceState([
        { id: 'gold', startAmount: 0 },
        { id: 'wood', startAmount: 100 },
      ]);

      const generators = [
        {
          id: 'converter',
          owned: 2,
          produces: [{ resourceId: 'gold', rate: 5 }], // 10 gold/s
          consumes: [{ resourceId: 'wood', rate: 10 }], // 20 wood/s
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
        trackRates: true,
      });

      system.tick(createTickContext(1000, 0));

      const goldIndex = resources.getIndex('gold')!;
      const woodIndex = resources.getIndex('wood')!;

      expect(resources.getAmount(goldIndex)).toBeCloseTo(10, 6);
      expect(resources.getAmount(woodIndex)).toBeCloseTo(80, 6);

      resources.finalizeTick(1000);
      resources.snapshot({ mode: 'publish' });

      expect(resources.getAmount(goldIndex)).toBeCloseTo(10, 6);
      expect(resources.getAmount(woodIndex)).toBeCloseTo(80, 6);
    });

    it('applies balances via finalizeTick when enabled', () => {
      const resources = createResourceState([
        { id: 'gold', startAmount: 0 },
        { id: 'wood', startAmount: 100 },
      ]);

      const generators = [
        {
          id: 'converter',
          owned: 2,
          produces: [{ resourceId: 'gold', rate: 5 }], // 10 gold/s
          consumes: [{ resourceId: 'wood', rate: 10 }], // 20 wood/s
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState: resources,
        trackRates: true,
        applyViaFinalizeTick: true,
      });

      system.tick(createTickContext(1000, 0));

      const goldIndex = resources.getIndex('gold')!;
      const woodIndex = resources.getIndex('wood')!;

      expect(resources.getAmount(goldIndex)).toBe(0);
      expect(resources.getAmount(woodIndex)).toBe(100);

      resources.finalizeTick(1000);
      resources.snapshot({ mode: 'publish' });

      expect(resources.getAmount(goldIndex)).toBeCloseTo(10, 6);
      expect(resources.getAmount(woodIndex)).toBeCloseTo(80, 6);
    });

    it('standard flow applies production and consumption correctly', () => {
      const resourceAmounts = new Map<number, number>([
        [0, 100], // gold
        [1, 50], // energy
      ]);

      const resourceState = {
        getIndex: (id: string) => (id === 'gold' ? 0 : id === 'energy' ? 1 : undefined),
        getAmount: (index: number) => resourceAmounts.get(index) ?? 0,
        addAmount: (index: number, amount: number) => {
          resourceAmounts.set(index, (resourceAmounts.get(index) ?? 0) + amount);
        },
        spendAmount: (index: number, amount: number) => {
          const current = resourceAmounts.get(index) ?? 0;
          if (current >= amount) {
            resourceAmounts.set(index, current - amount);
            return true;
          }
          return false;
        },
      };

      const generators = [
        {
          id: 'smelter',
          owned: 2,
          produces: [{ resourceId: 'gold', rate: 10 }],
          consumes: [{ resourceId: 'energy', rate: 5 }],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState,
      });

      system.tick(createTickContext(1000, 0));

      expect(resourceAmounts.get(0)).toBe(120); // 100 + 20 gold
      expect(resourceAmounts.get(1)).toBe(40); // 50 - 10 energy
    });

    it('avoids overspending when epsilon aligns toApply above accumulator total', () => {
      const resourceAmounts = new Map<number, number>([
        [0, 0], // gold
        [1, 0.09 + 0.01], // energy
      ]);

      const resourceState = {
        getIndex: (id: string) => (id === 'gold' ? 0 : id === 'energy' ? 1 : undefined),
        getAmount: (index: number) => resourceAmounts.get(index) ?? 0,
        addAmount: (index: number, amount: number) => {
          resourceAmounts.set(index, (resourceAmounts.get(index) ?? 0) + amount);
        },
        spendAmount: (index: number, amount: number) => {
          const current = resourceAmounts.get(index) ?? 0;
          if (current < amount) {
            throw new Error(`Insufficient resources: ${current} < ${amount}`);
          }
          resourceAmounts.set(index, current - amount);
          return true;
        },
      };

      const generators = [
        {
          id: 'smelter',
          owned: 1,
          produces: [{ resourceId: 'gold', rate: 1 }],
          consumes: [{ resourceId: 'energy', rate: 1 }],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState,
        applyThreshold: 0.1,
      });

      expect(() => {
        system.tick(createTickContext(90, 0));
        system.tick(createTickContext(10, 1));
      }).not.toThrow();

      expect(resourceAmounts.get(0)).toBeCloseTo(0.1, 12);
      expect(resourceAmounts.get(1)).toBeCloseTo(0, 12);
    });

    it('shadow flow produces identical results to standard flow under same conditions', () => {
      const resourceAmounts = new Map<number, number>([
        [0, 100], // gold
        [1, 50], // energy
      ]);
      const incomeRates = new Map<number, number>();
      const expenseRates = new Map<number, number>();

      const resourceState = {
        getIndex: (id: string) => (id === 'gold' ? 0 : id === 'energy' ? 1 : undefined),
        getAmount: (index: number) => resourceAmounts.get(index) ?? 0,
        addAmount: (index: number, amount: number) => {
          resourceAmounts.set(index, (resourceAmounts.get(index) ?? 0) + amount);
        },
        spendAmount: (index: number, amount: number) => {
          const current = resourceAmounts.get(index) ?? 0;
          if (current >= amount) {
            resourceAmounts.set(index, current - amount);
            return true;
          }
          return false;
        },
        applyIncome: (index: number, rate: number) => {
          incomeRates.set(index, (incomeRates.get(index) ?? 0) + rate);
        },
        applyExpense: (index: number, rate: number) => {
          expenseRates.set(index, (expenseRates.get(index) ?? 0) + rate);
        },
        finalizeTick: (deltaMs: number) => {
          const deltaSeconds = deltaMs / 1000;
          for (const [index, rate] of incomeRates) {
            resourceAmounts.set(
              index,
              (resourceAmounts.get(index) ?? 0) + rate * deltaSeconds,
            );
          }
          for (const [index, rate] of expenseRates) {
            resourceAmounts.set(
              index,
              (resourceAmounts.get(index) ?? 0) - rate * deltaSeconds,
            );
          }
          incomeRates.clear();
          expenseRates.clear();
        },
        getCapacity: () => Number.POSITIVE_INFINITY,
      };

      const generators = [
        {
          id: 'smelter',
          owned: 2,
          produces: [{ resourceId: 'gold', rate: 10 }],
          consumes: [{ resourceId: 'energy', rate: 5 }],
        },
      ];

      const system = createProductionSystem({
        generators: () => generators,
        resourceState,
        applyViaFinalizeTick: true,
      });

      system.tick(createTickContext(1000, 0));
      resourceState.finalizeTick(1000);

      expect(resourceAmounts.get(0)).toBe(120); // 100 + 20 gold
      expect(resourceAmounts.get(1)).toBe(40); // 50 - 10 energy
    });

    it('applyViaFinalizeTick matches standard flow when production clamps to capacity', () => {
      const resourcesStandard = createResourceState([
        { id: 'gold', startAmount: 4, capacity: 5 },
      ]);
      const resourcesShadow = createResourceState([
        { id: 'gold', startAmount: 4, capacity: 5 },
      ]);

      const generators = [
        {
          id: 'mine',
          owned: 1,
          produces: [{ resourceId: 'gold', rate: 10 }],
          consumes: [],
        },
      ];

      const standard = createProductionSystem({
        generators: () => generators,
        resourceState: resourcesStandard,
      });
      const shadow = createProductionSystem({
        generators: () => generators,
        resourceState: resourcesShadow,
        applyViaFinalizeTick: true,
      });

      standard.tick(createTickContext(1000, 0));
      shadow.tick(createTickContext(1000, 0));
      resourcesShadow.finalizeTick(1000);

      const goldStandardIndex = resourcesStandard.getIndex('gold')!;
      const goldShadowIndex = resourcesShadow.getIndex('gold')!;

      expect(resourcesStandard.getAmount(goldStandardIndex)).toBe(5);
      expect(resourcesShadow.getAmount(goldShadowIndex)).toBe(5);
    });

    it('applyViaFinalizeTick matches standard flow with multiple consumptions and generator ordering', () => {
      const resourcesStandard = createResourceState([
        { id: 'energy', startAmount: 0 },
        { id: 'ore', startAmount: 3 },
        { id: 'gold', startAmount: 0 },
      ]);
      const resourcesShadow = createResourceState([
        { id: 'energy', startAmount: 0 },
        { id: 'ore', startAmount: 3 },
        { id: 'gold', startAmount: 0 },
      ]);

      const generators = [
        {
          id: 'charger',
          owned: 1,
          produces: [{ resourceId: 'energy', rate: 10 }],
          consumes: [],
        },
        {
          id: 'smelter',
          owned: 1,
          produces: [{ resourceId: 'gold', rate: 4 }],
          consumes: [
            { resourceId: 'energy', rate: 8 },
            { resourceId: 'ore', rate: 5 },
          ],
        },
      ];

      const standard = createProductionSystem({
        generators: () => generators,
        resourceState: resourcesStandard,
      });
      const shadow = createProductionSystem({
        generators: () => generators,
        resourceState: resourcesShadow,
        applyViaFinalizeTick: true,
      });

      standard.tick(createTickContext(1000, 0));
      shadow.tick(createTickContext(1000, 0));
      resourcesShadow.finalizeTick(1000);

      const energyStandardIndex = resourcesStandard.getIndex('energy')!;
      const oreStandardIndex = resourcesStandard.getIndex('ore')!;
      const goldStandardIndex = resourcesStandard.getIndex('gold')!;

      const energyShadowIndex = resourcesShadow.getIndex('energy')!;
      const oreShadowIndex = resourcesShadow.getIndex('ore')!;
      const goldShadowIndex = resourcesShadow.getIndex('gold')!;

      expect(resourcesStandard.getAmount(energyStandardIndex)).toBeCloseTo(5.2, 6);
      expect(resourcesStandard.getAmount(oreStandardIndex)).toBeCloseTo(0, 6);
      expect(resourcesStandard.getAmount(goldStandardIndex)).toBeCloseTo(2.4, 6);

      expect(resourcesShadow.getAmount(energyShadowIndex)).toBeCloseTo(5.2, 6);
      expect(resourcesShadow.getAmount(oreShadowIndex)).toBeCloseTo(0, 6);
      expect(resourcesShadow.getAmount(goldShadowIndex)).toBeCloseTo(2.4, 6);
    });
  });
});
