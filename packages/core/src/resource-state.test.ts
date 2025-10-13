import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  createResourceState,
  type ResourceDefinition,
} from './resource-state.js';
import {
  resetTelemetry,
  setTelemetry,
  type TelemetryFacade,
} from './telemetry.js';

describe('ResourceState', () => {
  let telemetryStub: TelemetryFacade;

  beforeEach(() => {
    telemetryStub = {
      recordError: vi.fn(),
      recordWarning: vi.fn(),
      recordProgress: vi.fn(),
      recordTick: vi.fn(),
    };
    setTelemetry(telemetryStub);
  });

  afterEach(() => {
    resetTelemetry();
    vi.restoreAllMocks();
  });

  it('initializes resources with clamped start amounts', () => {
    const definitions: ResourceDefinition[] = [
      {
        id: 'energy',
        startAmount: 42,
        capacity: 10,
      },
      {
        id: 'crystal',
        startAmount: 0,
      },
    ];

    const state = createResourceState(definitions);
    const energy = state.requireIndex('energy');
    const crystal = state.requireIndex('crystal');

    expect(state.getAmount(energy)).toBe(10);
    expect(state.getCapacity(energy)).toBe(10);
    expect(state.getAmount(crystal)).toBe(0);
    expect(state.isUnlocked(energy)).toBe(true);
    expect(state.isVisible(energy)).toBe(true);
    expect(telemetryStub.recordWarning).toHaveBeenCalledWith(
      'ResourceInitialAmountClampHigh',
      expect.objectContaining({ id: 'energy' }),
    );

    const snapshot = state.snapshot();
    expect(snapshot.dirtyCount).toBe(0);
    expect(snapshot.amounts[energy]).toBe(10);
    expect(snapshot.capacities[energy]).toBe(10);
    expect(() => {
      (snapshot.amounts as unknown as Float64Array)[energy] = 99;
    }).toThrowError(/read-only/);
  });

  it('requires publish before resetting per-tick accumulators', () => {
    const state = createResourceState([{ id: 'energy' }]);
    expect(() => state.resetPerTickAccumulators()).toThrowError(/publish snapshot/);
    expect(telemetryStub.recordError).toHaveBeenCalledWith(
      'ResourceResetOutOfOrder',
      undefined,
    );
  });

  it('adds and spends amounts with capacity and balance guards', () => {
    const state = createResourceState([
      { id: 'energy', startAmount: 5, capacity: 10 },
    ]);
    const energy = state.requireIndex('energy');

    const applied = state.addAmount(energy, 4);
    expect(applied).toBe(4);
    expect(state.getAmount(energy)).toBe(9);

    const publishSnapshot = state.snapshot();
    expect(publishSnapshot.dirtyCount).toBe(1);
    expect(publishSnapshot.dirtyIndices[0]).toBe(energy);
    expect(publishSnapshot.tickDelta[energy]).toBe(4);

    expect(state.spendAmount(energy, 2)).toBe(true);
    expect(state.getAmount(energy)).toBe(7);
    const postSpend = state.snapshot();
    expect(postSpend.amounts[energy]).toBe(7);
    expect(postSpend.dirtyCount).toBe(1);
    expect(state.spendAmount(energy, 50)).toBe(false);
    expect(telemetryStub.recordWarning).toHaveBeenCalledWith(
      'ResourceSpendInsufficient',
      expect.objectContaining({ index: energy }),
    );

    const cleanSnapshot = state.snapshot();
    expect(cleanSnapshot.dirtyCount).toBe(0);
    expect(cleanSnapshot.tickDelta[energy]).toBe(0);
  });

  it('applies per-second rates during finalizeTick and resets accumulators after publish', () => {
    const state = createResourceState([
      { id: 'energy', startAmount: 0, capacity: 10 },
    ]);
    const energy = state.requireIndex('energy');

    state.applyIncome(energy, 6);
    state.applyExpense(energy, 1);
    state.finalizeTick(500);

    const publishSnapshot = state.snapshot();
    expect(publishSnapshot.amounts[energy]).toBeCloseTo(2.5, 6);
    expect(publishSnapshot.netPerSecond[energy]).toBeCloseTo(5, 6);
    expect(publishSnapshot.tickDelta[energy]).toBeCloseTo(2.5, 6);
    expect(publishSnapshot.dirtyCount).toBe(1);

    state.resetPerTickAccumulators();
    const recorderSnapshot = state.snapshot({ mode: 'recorder' });
    expect(recorderSnapshot.incomePerSecond[energy]).toBe(0);
    expect(recorderSnapshot.expensePerSecond[energy]).toBe(0);
    expect(recorderSnapshot.tickDelta[energy]).toBe(0);
  });

  it('guards snapshot arrays against mutation by default', () => {
    const state = createResourceState([
      { id: 'energy', startAmount: 0, capacity: 10 },
    ]);
    const energy = state.requireIndex('energy');
    state.addAmount(energy, 5);

    const snapshot = state.snapshot();
    expect(() => {
      (snapshot.amounts as unknown as Float64Array)[energy] = 123;
    }).toThrowError(/read-only/);
  });

  it('forceClearDirtyState clears scratch metadata without publish', () => {
    const state = createResourceState([
      { id: 'energy', startAmount: 0, capacity: 10 },
    ]);
    const energy = state.requireIndex('energy');
    state.addAmount(energy, 3);

    state.forceClearDirtyState();
    const recorderSnapshot = state.snapshot({ mode: 'recorder' });
    expect(recorderSnapshot.dirtyCount).toBe(0);
    expect(recorderSnapshot.tickDelta[energy]).toBe(0);
  });

  it('throws on duplicate ids and unknown lookups', () => {
    expect(() =>
      createResourceState([
        { id: 'energy' },
        { id: 'energy' },
      ]),
    ).toThrowError(/duplicated/);

    expect(telemetryStub.recordError).toHaveBeenCalledWith(
      'ResourceDefinitionDuplicateId',
      expect.objectContaining({ id: 'energy' }),
    );

    const state = createResourceState([]);
    expect(() => state.requireIndex('missing')).toThrowError(/does not exist/);
    expect(telemetryStub.recordError).toHaveBeenCalledWith(
      'ResourceUnknownId',
      expect.objectContaining({ id: 'missing' }),
    );
  });

  it('clears dirty tracking for uncapped resources that revert to their prior state', () => {
    const state = createResourceState([
      { id: 'energy', capacity: null, startAmount: 0 },
    ]);
    const energy = state.requireIndex('energy');

    state.addAmount(energy, 50);
    state.spendAmount(energy, 50);

    const snapshot = state.snapshot();
    expect(snapshot.dirtyCount).toBe(0);
  });

  it('records telemetry when dirty tolerance overrides saturate the relative epsilon', () => {
    const state = createResourceState([
      { id: 'energy', startAmount: 1_000_000, dirtyTolerance: 1e-6 },
    ]);
    const energy = state.requireIndex('energy');

    state.addAmount(energy, 1e-3);

    expect(telemetryStub.recordWarning).toHaveBeenCalledWith(
      'ResourceDirtyToleranceSaturated',
      expect.objectContaining({
        resourceId: 'energy',
        field: 'amount',
        toleranceCeiling: 1e-6,
      }),
    );
  });
});
