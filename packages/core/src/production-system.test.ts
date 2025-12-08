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
  });
});
