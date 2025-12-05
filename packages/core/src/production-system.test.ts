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

      system.tick({ deltaMs: 1000 });
      resources.snapshot({ mode: 'publish' });

      const goldIndex = resources.getIndex('gold')!;
      expect(resources.getAmount(goldIndex)).toBe(10); // 5 rate * 2 owned * 1 second
    });
  });
});
