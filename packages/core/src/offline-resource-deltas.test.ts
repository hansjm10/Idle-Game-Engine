import { describe, expect, it, vi } from 'vitest';

import { applyOfflineResourceDeltas } from './offline-resource-deltas.js';

describe('offline-resource-deltas', () => {
  const createMockCoordinator = () => {
    const resources = new Map<string, { amount: number; index: number }>();

    return {
      resourceState: {
        getIndex: vi.fn((id: string) => resources.get(id)?.index),
        getAmount: vi.fn((index: number) => {
          for (const [, data] of resources) {
            if (data.index === index) {
              return data.amount;
            }
          }
          return 0;
        }),
        addAmount: vi.fn((index: number, amount: number) => {
          for (const [, data] of resources) {
            if (data.index === index) {
              data.amount += amount;
            }
          }
        }),
        spendAmount: vi.fn(
          (
            index: number,
            amount: number,
            _options: { systemId: string },
          ) => {
            for (const [, data] of resources) {
              if (data.index === index) {
                data.amount -= amount;
              }
            }
          },
        ),
      },
      _setResource: (id: string, amount: number, index: number) => {
        resources.set(id, { amount, index });
      },
    };
  };

  it('applies positive deltas using addAmount', () => {
    const coordinator = createMockCoordinator();
    coordinator._setResource('gold', 100, 0);

    applyOfflineResourceDeltas(coordinator as any, { gold: 50 });

    expect(coordinator.resourceState.addAmount).toHaveBeenCalledWith(0, 50);
  });

  it('applies negative deltas using spendAmount', () => {
    const coordinator = createMockCoordinator();
    coordinator._setResource('gold', 100, 0);

    applyOfflineResourceDeltas(coordinator as any, { gold: -30 });

    expect(coordinator.resourceState.spendAmount).toHaveBeenCalledWith(0, 30, {
      systemId: 'offline-catchup',
    });
  });

  it('caps negative deltas to current resource amount', () => {
    const coordinator = createMockCoordinator();
    coordinator._setResource('gold', 50, 0);

    applyOfflineResourceDeltas(coordinator as any, { gold: -100 });

    expect(coordinator.resourceState.spendAmount).toHaveBeenCalledWith(
      0,
      50, // Capped to current amount, not 100
      { systemId: 'offline-catchup' },
    );
  });

  it('skips zero deltas', () => {
    const coordinator = createMockCoordinator();
    coordinator._setResource('gold', 100, 0);

    applyOfflineResourceDeltas(coordinator as any, { gold: 0 });

    expect(coordinator.resourceState.addAmount).not.toHaveBeenCalled();
    expect(coordinator.resourceState.spendAmount).not.toHaveBeenCalled();
  });

  it('skips NaN deltas', () => {
    const coordinator = createMockCoordinator();
    coordinator._setResource('gold', 100, 0);

    applyOfflineResourceDeltas(coordinator as any, { gold: NaN });

    expect(coordinator.resourceState.addAmount).not.toHaveBeenCalled();
    expect(coordinator.resourceState.spendAmount).not.toHaveBeenCalled();
  });

  it('skips Infinity deltas', () => {
    const coordinator = createMockCoordinator();
    coordinator._setResource('gold', 100, 0);

    applyOfflineResourceDeltas(coordinator as any, { gold: Infinity });

    expect(coordinator.resourceState.addAmount).not.toHaveBeenCalled();
    expect(coordinator.resourceState.spendAmount).not.toHaveBeenCalled();
  });

  it('skips negative Infinity deltas', () => {
    const coordinator = createMockCoordinator();
    coordinator._setResource('gold', 100, 0);

    applyOfflineResourceDeltas(coordinator as any, { gold: -Infinity });

    expect(coordinator.resourceState.addAmount).not.toHaveBeenCalled();
    expect(coordinator.resourceState.spendAmount).not.toHaveBeenCalled();
  });

  it('skips unknown resource IDs', () => {
    const coordinator = createMockCoordinator();
    // Don't set up any resources

    applyOfflineResourceDeltas(coordinator as any, { unknown: 50 });

    expect(coordinator.resourceState.addAmount).not.toHaveBeenCalled();
  });

  it('processes multiple resources in deterministic order', () => {
    const coordinator = createMockCoordinator();
    coordinator._setResource('gold', 100, 0);
    coordinator._setResource('silver', 200, 1);
    coordinator._setResource('bronze', 300, 2);

    const callOrder: number[] = [];
    coordinator.resourceState.addAmount = vi.fn((index: number) => {
      callOrder.push(index);
    });

    applyOfflineResourceDeltas(coordinator as any, {
      silver: 10, // Alphabetically second
      gold: 20, // Alphabetically first
      bronze: 30, // Alphabetically third (but locale sort puts it first)
    });

    // Should be sorted by localeCompare: bronze (2), gold (0), silver (1)
    expect(callOrder).toEqual([2, 0, 1]);
  });

  it('handles mixed positive and negative deltas', () => {
    const coordinator = createMockCoordinator();
    coordinator._setResource('gold', 100, 0);
    coordinator._setResource('silver', 50, 1);

    applyOfflineResourceDeltas(coordinator as any, {
      gold: 25,
      silver: -20,
    });

    expect(coordinator.resourceState.addAmount).toHaveBeenCalledWith(0, 25);
    expect(coordinator.resourceState.spendAmount).toHaveBeenCalledWith(1, 20, {
      systemId: 'offline-catchup',
    });
  });

  it('handles empty deltas object', () => {
    const coordinator = createMockCoordinator();

    applyOfflineResourceDeltas(coordinator as any, {});

    expect(coordinator.resourceState.addAmount).not.toHaveBeenCalled();
    expect(coordinator.resourceState.spendAmount).not.toHaveBeenCalled();
  });

  it('skips spending when current amount is zero', () => {
    const coordinator = createMockCoordinator();
    coordinator._setResource('gold', 0, 0);

    applyOfflineResourceDeltas(coordinator as any, { gold: -50 });

    // toSpend = Math.min(0, 50) = 0, so spendAmount should not be called
    expect(coordinator.resourceState.spendAmount).not.toHaveBeenCalled();
  });
});
