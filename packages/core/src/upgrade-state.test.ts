import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import {
  createUpgradeState,
  type UpgradeDefinition,
} from './upgrade-state.js';
import {
  resetTelemetry,
  setTelemetry,
  type TelemetryFacade,
} from './telemetry.js';

describe('UpgradeState', () => {
  let telemetryStub: TelemetryFacade;

  beforeEach(() => {
    telemetryStub = {
      recordError: vi.fn(),
      recordWarning: vi.fn(),
      recordProgress: vi.fn(),
      recordCounters: vi.fn(),
      recordTick: vi.fn(),
    };
    setTelemetry(telemetryStub);
  });

  afterEach(() => {
    resetTelemetry();
    vi.restoreAllMocks();
  });

  it('initializes upgrades with normalized struct-of-arrays buffers', () => {
    const definitions: UpgradeDefinition[] = [
      {
        id: 'core-efficiency',
        unlocked: true,
        visible: true,
        purchased: true,
        maxPurchases: 1,
      },
      {
        id: 'automation-suite',
        maxPurchases: 3,
      },
    ];

    const state = createUpgradeState(definitions);
    const core = state.requireIndex('core-efficiency');
    const automation = state.requireIndex('automation-suite');

    expect(state.getPurchaseCount(core)).toBe(1);
    expect(state.getMaxPurchases(core)).toBe(1);
    expect(state.isUnlocked(core)).toBe(true);
    expect(state.isVisible(core)).toBe(true);
    expect(state.isPurchased(core)).toBe(true);

    const view = state.view();
    expect(view.ids).toEqual(['core-efficiency', 'automation-suite']);
    expect(() => {
      (view.purchaseCount as unknown as Uint32Array)[0] = 0;
    }).toThrowError(/immutable/i);
    expect(state.getMaxPurchases(automation)).toBe(3);
  });

  it('tracks purchases and exposes deltas via snapshots', () => {
    const state = createUpgradeState([
      { id: 'automation-suite', maxPurchases: 3 },
    ]);

    const automation = state.requireIndex('automation-suite');

    state.purchase(automation);
    state.purchase(automation, 2);

    const delta = state.snapshot();
    expect(delta.dirtyCount).toBe(1);
    expect(Array.from(delta.indices)).toEqual([automation]);
    expect(Array.from(delta.purchaseCount)).toEqual([3]);
    expect(Array.from(delta.purchaseDelta)).toEqual([3]);

    // Additional snapshot should be clean after reset.
    expect(state.snapshot().dirtyCount).toBe(0);

    state.setPurchaseCount(automation, 1);
    const rollback = state.snapshot();
    expect(Array.from(rollback.purchaseCount)).toEqual([1]);
    expect(Array.from(rollback.purchaseDelta)).toEqual([-2]);
  });

  it('allows unlimited purchases when maxPurchases is omitted', () => {
    const state = createUpgradeState([{ id: 'repeatable-upgrade' }]);
    const repeatable = state.requireIndex('repeatable-upgrade');

    state.purchase(repeatable);
    state.purchase(repeatable, 4);

    expect(state.getPurchaseCount(repeatable)).toBe(5);
    expect(state.getMaxPurchases(repeatable)).toBeNull();
  });

  it('records telemetry for invalid definitions', () => {
    expect(() => {
      createUpgradeState([
        { id: 'duplicate' },
        { id: 'duplicate' },
      ]);
    }).toThrowError(/duplicated/i);
    expect(telemetryStub.recordError).toHaveBeenCalledWith(
      'UpgradeDefinitionDuplicateId',
      expect.objectContaining({ id: 'duplicate' }),
    );
  });
});
