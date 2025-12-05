import { describe, it, expect } from 'vitest';
import { createProductionSystem } from './production-system.js';
import { createResourceState, type ResourceState } from './resource-state.js';

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

      system.tick({ deltaMs: 1000, step: 0, events: {} as any });
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

      system.tick({ deltaMs: 1000, step: 0, events: {} as any });
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

      system.tick({ deltaMs: 1000, step: 0, events: {} as any });
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

      system.tick({ deltaMs: 1000, step: 0, events: {} as any });
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

      system.tick({ deltaMs: 1000, step: 0, events: {} as any });
      resources.snapshot({ mode: 'publish' });

      const goldIndex = resources.getIndex('gold')!;
      expect(resources.getAmount(goldIndex)).toBe(10); // 5 rate * 2 owned * 1 multiplier * 1 second
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

      system.tick({ deltaMs: 1000, step: 0, events: {} as any });
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
        system.tick({ deltaMs: 1000, step: 0, events: {} as any });
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

      system.tick({ deltaMs: 100, step: 0, events: {} as any }); // 0.1 seconds
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

      system.tick({ deltaMs: 0, step: 0, events: {} as any });
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

      system.tick({ deltaMs: 1000, step: 0, events: {} as any });
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
        system.tick({ deltaMs: 1000, step: 0, events: {} as any });
      }).not.toThrow();

      resources.snapshot({ mode: 'publish' });
      const goldIndex = resources.getIndex('gold')!;
      expect(resources.getAmount(goldIndex)).toBe(0); // Non-finite rate treated as 0
    });
  });
});
