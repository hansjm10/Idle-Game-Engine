import { describe, it, expect } from 'vitest';
import { createProductionSystem } from './production-system.js';
import { createResourceState } from './resource-state.js';
import { createTickContext } from './test-utils.js';

describe('createProductionSystem - serialization', () => {
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

    it('should restore both produce and consume accumulators and keep them in sync', () => {
      const resources = createResourceState([
        { id: 'energy', startAmount: 1 },
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

      system.restoreAccumulators({
        accumulators: {
          'harvester:produce:ore': 0.009,
          'harvester:consume:energy': 0.009,
        },
      });

      system.tick(createTickContext(1000, 0));
      resources.snapshot({ mode: 'publish' });

      expect(resources.getAmount(resources.getIndex('ore')!)).toBeCloseTo(0.01, 12);
      expect(resources.getAmount(resources.getIndex('energy')!)).toBeCloseTo(0.99, 12);

      const exported = system.exportAccumulators();
      expect(exported.accumulators['harvester:produce:ore']).toBeCloseTo(0.002, 12);
      expect(exported.accumulators['harvester:consume:energy']).toBeCloseTo(0.002, 12);
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
});
