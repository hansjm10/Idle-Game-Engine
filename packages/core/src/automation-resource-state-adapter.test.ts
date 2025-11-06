import { describe, it, expect } from 'vitest';
import { createResourceStateAdapter } from './automation-resource-state-adapter.js';
import type { ResourceState } from './resource-state.js';

describe('createResourceStateAdapter', () => {
  it('should forward getAmount calls to underlying resource state', () => {
    const mockResourceState: Pick<ResourceState, 'getAmount' | 'getIndex'> = {
      getAmount: (index: number) => index * 10,
      getIndex: (_id: string) => 0,
    };

    const adapter = createResourceStateAdapter(mockResourceState);

    expect(adapter.getAmount(0)).toBe(0);
    expect(adapter.getAmount(1)).toBe(10);
    expect(adapter.getAmount(5)).toBe(50);
  });

  it('should map getResourceIndex to getIndex and convert undefined to -1', () => {
    const mockResourceState: Pick<ResourceState, 'getAmount' | 'getIndex'> = {
      getAmount: (_index: number) => 0,
      getIndex: (id: string) => {
        if (id === 'coins') return 0;
        if (id === 'gems') return 1;
        if (id === 'energy') return 2;
        return undefined;
      },
    };

    const adapter = createResourceStateAdapter(mockResourceState);

    expect(adapter.getResourceIndex).toBeDefined();
    expect(adapter.getResourceIndex!('coins')).toBe(0);
    expect(adapter.getResourceIndex!('gems')).toBe(1);
    expect(adapter.getResourceIndex!('energy')).toBe(2);
    expect(adapter.getResourceIndex!('unknown')).toBe(-1);
  });

  it('should handle resource state without getIndex by omitting getResourceIndex', () => {
    const mockResourceState: Pick<ResourceState, 'getAmount'> = {
      getAmount: (index: number) => index * 10,
    };

    const adapter = createResourceStateAdapter(mockResourceState);

    expect(adapter.getResourceIndex).toBeUndefined();
  });
});
