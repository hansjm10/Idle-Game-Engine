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
  reconcileSaveAgainstDefinitions,
  type ResourceDefinition,
  type SerializedResourceState,
  __unsafeWriteAmountDirect,
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
      recordCounters: vi.fn(),
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
    const context = {
      commandId: 'PURCHASE_GENERATOR',
      systemId: 'TestSystem',
    };
    expect(state.spendAmount(energy, 50, context)).toBe(false);
    expect(telemetryStub.recordWarning).toHaveBeenCalledWith(
      'ResourceSpendFailed',
      expect.objectContaining({
        index: energy,
        commandId: context.commandId,
        systemId: context.systemId,
      }),
    );

    const cleanSnapshot = state.snapshot();
    expect(cleanSnapshot.dirtyCount).toBe(0);
    expect(cleanSnapshot.tickDelta[energy]).toBe(0);

    const recorderSnapshot = state.snapshot({ mode: 'recorder' });
    expect(recorderSnapshot.tickDelta[energy]).toBe(postSpend.tickDelta[energy]);
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

  it('blocks buffer-backed mutation attempts when guards are enabled', () => {
    const state = createResourceState([
      { id: 'energy', startAmount: 0, capacity: 10 },
    ]);
    const energy = state.requireIndex('energy');
    state.addAmount(energy, 4);

    const snapshot = state.snapshot();
    const bufferWrapper = (snapshot.amounts as unknown as {
      buffer: unknown;
    }).buffer as {
      toArrayBuffer?: () => ArrayBuffer;
      valueOf?: () => ArrayBuffer | SharedArrayBuffer;
    };

    expect(typeof bufferWrapper).toBe('object');
    expect(bufferWrapper).not.toBeInstanceOf(ArrayBuffer);
    if (typeof SharedArrayBuffer !== 'undefined') {
      expect(bufferWrapper).not.toBeInstanceOf(SharedArrayBuffer);
    }

    expect(bufferWrapper?.toArrayBuffer).toBeInstanceOf(Function);
    expect(bufferWrapper?.valueOf).toBeInstanceOf(Function);
    const clone = bufferWrapper?.toArrayBuffer?.();
    expect(clone).toBeInstanceOf(ArrayBuffer);

    const copy = bufferWrapper.valueOf?.();
    expect(copy).toBeDefined();
    expect(
      copy instanceof ArrayBuffer ||
        (typeof SharedArrayBuffer !== 'undefined' && copy instanceof SharedArrayBuffer),
    ).toBe(true);

    const mirror = new Float64Array(copy as ArrayBufferLike);
    mirror[energy] = 99;
    expect(snapshot.amounts[energy]).toBe(4);
  });

  it('allows disabling snapshot guards via SNAPSHOT_GUARDS=force-off', () => {
    const originalMode = process.env.SNAPSHOT_GUARDS;
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.SNAPSHOT_GUARDS = 'force-off';
    process.env.NODE_ENV = 'production';

    try {
      const state = createResourceState([
        { id: 'energy', startAmount: 0, capacity: 10 },
      ]);
      const energy = state.requireIndex('energy');
      state.addAmount(energy, 2);

      const snapshot = state.snapshot();
      expect(() => {
        (snapshot.amounts as unknown as Float64Array)[energy] = 42;
      }).not.toThrow();
    } finally {
      if (originalMode === undefined) {
        delete process.env.SNAPSHOT_GUARDS;
      } else {
        process.env.SNAPSHOT_GUARDS = originalMode;
      }

      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    }
  });

  it('forces guards on in production when SNAPSHOT_GUARDS=force-on', () => {
    const originalMode = process.env.SNAPSHOT_GUARDS;
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.SNAPSHOT_GUARDS = 'force-on';
    process.env.NODE_ENV = 'production';

    try {
      const state = createResourceState([
        { id: 'energy', startAmount: 0, capacity: 10 },
      ]);
      const energy = state.requireIndex('energy');
      state.addAmount(energy, 1);

      const snapshot = state.snapshot();
      expect(() => {
        (snapshot.amounts as unknown as Float64Array)[energy] = 13;
      }).toThrowError(/read-only/);
    } finally {
      if (originalMode === undefined) {
        delete process.env.SNAPSHOT_GUARDS;
      } else {
        process.env.SNAPSHOT_GUARDS = originalMode;
      }

      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    }
  });

  it('forceClearDirtyState clears scratch metadata without publish', () => {
    const state = createResourceState([
      { id: 'energy', startAmount: 0, capacity: 10 },
    ]);
    const energy = state.requireIndex('energy');
    state.addAmount(energy, 3);

    state.forceClearDirtyState();
    expect(telemetryStub.recordProgress).toHaveBeenCalledWith(
      'ResourceForceClearDirtyState',
      expect.objectContaining({
        dirtyCountBefore: 1,
        publishGuardState: 'idle',
      }),
    );
    const recorderSnapshot = state.snapshot({ mode: 'recorder' });
    expect(recorderSnapshot.dirtyCount).toBe(0);
    expect(recorderSnapshot.tickDelta[energy]).toBe(0);
  });

  it('retains tick delta between publish and recorder snapshots until reset', () => {
    const state = createResourceState([
      { id: 'energy', startAmount: 0, capacity: 100 },
    ]);
    const energy = state.requireIndex('energy');

    state.addAmount(energy, 25);
    const publishSnapshot = state.snapshot();
    expect(publishSnapshot.tickDelta[energy]).toBe(25);

    const recorderBeforeReset = state.snapshot({ mode: 'recorder' });
    expect(recorderBeforeReset.tickDelta[energy]).toBe(25);

    state.resetPerTickAccumulators();
    const recorderAfterReset = state.snapshot({ mode: 'recorder' });
    expect(recorderAfterReset.tickDelta[energy]).toBe(0);
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

  it('clamps oversized dirty tolerance overrides and includes resource id in telemetry', () => {
    createResourceState([{ id: 'energy', dirtyTolerance: 10 }]);

    expect(telemetryStub.recordWarning).toHaveBeenCalledWith(
      'ResourceDirtyToleranceClamped',
      expect.objectContaining({
        resourceId: 'energy',
        value: 10,
      }),
    );
  });

  it('allows privileged direct writes to bypass capacity clamps while marking dirty', () => {
    const state = createResourceState([
      { id: 'energy', capacity: 10, startAmount: 5 },
    ]);
    const energy = state.requireIndex('energy');

    __unsafeWriteAmountDirect(state, energy, 25);

    expect(state.getAmount(energy)).toBe(25);
    const publishSnapshot = state.snapshot();
    expect(publishSnapshot.dirtyCount).toBe(1);
    expect(publishSnapshot.dirtyIndices[0]).toBe(energy);
    expect(publishSnapshot.amounts[energy]).toBe(25);
    expect(publishSnapshot.tickDelta[energy]).toBe(0);
  });

  it('includes definition digest in exported save payloads', () => {
    const state = createResourceState([
      { id: 'energy' },
      { id: 'crystal' },
    ]);

    const save = state.exportForSave();
    expect(save.definitionDigest).toEqual(state.getDefinitionDigest());
  });

  it('reconciles matching save payloads against unchanged definitions', () => {
    const definitions: ResourceDefinition[] = [
      { id: 'energy' },
      { id: 'crystal' },
    ];
    const state = createResourceState(definitions);
    const save = state.exportForSave();

    const result = reconcileSaveAgainstDefinitions(save, definitions);
    expect(Array.from(result.remap)).toEqual([0, 1]);
    expect(result.addedIds).toHaveLength(0);
    expect(result.removedIds).toHaveLength(0);
    expect(result.digestsMatch).toBe(true);
    expect(telemetryStub.recordError).not.toHaveBeenCalledWith(
      'ResourceHydrationMismatch',
      expect.anything(),
    );
  });

  it('reconciles save payloads when definitions reorder without divergence', () => {
    const definitions: ResourceDefinition[] = [
      { id: 'energy' },
      { id: 'crystal' },
    ];
    const state = createResourceState(definitions);
    const save = state.exportForSave();

    const reordered: ResourceDefinition[] = [
      { id: 'crystal' },
      { id: 'energy' },
    ];

    const result = reconcileSaveAgainstDefinitions(save, reordered);
    expect(Array.from(result.remap)).toEqual([1, 0]);
    expect(result.addedIds).toHaveLength(0);
    expect(result.removedIds).toHaveLength(0);
    expect(result.digestsMatch).toBe(false);
    expect(telemetryStub.recordProgress).toHaveBeenCalledWith(
      'ResourceHydrationMismatch',
      expect.objectContaining({
        reason: 'digest-mismatch',
      }),
    );
    expect(telemetryStub.recordError).not.toHaveBeenCalledWith(
      'ResourceHydrationMismatch',
      expect.anything(),
    );
  });

  it('throws when save ids diverge from definitions', () => {
    const definitions: ResourceDefinition[] = [
      { id: 'energy' },
      { id: 'crystal' },
    ];
    const state = createResourceState(definitions);
    const save = state.exportForSave();

    const incompatible: ResourceDefinition[] = [
      { id: 'energy' },
      { id: 'alloy' },
    ];

    expect(() =>
      reconcileSaveAgainstDefinitions(save, incompatible),
    ).toThrowError(/incompatible/);

    expect(telemetryStub.recordError).toHaveBeenCalledWith(
      'ResourceHydrationMismatch',
      expect.objectContaining({
        addedIds: ['alloy'],
        removedIds: ['crystal'],
      }),
    );
  });

  it('allows hydration when definitions introduce new resources', () => {
    const savedDefinitions: ResourceDefinition[] = [{ id: 'energy' }];
    const state = createResourceState(savedDefinitions);
    const save = state.exportForSave();

    const expandedDefinitions: ResourceDefinition[] = [
      { id: 'energy' },
      { id: 'crystal' },
    ];

    const reconciliation = reconcileSaveAgainstDefinitions(
      save,
      expandedDefinitions,
    );

    expect(Array.from(reconciliation.remap)).toEqual([0]);
    expect(reconciliation.addedIds).toEqual(['crystal']);
    expect(reconciliation.removedIds).toEqual([]);
    expect(reconciliation.digestsMatch).toBe(false);

    expect(telemetryStub.recordError).not.toHaveBeenCalledWith(
      'ResourceHydrationMismatch',
      expect.anything(),
    );

    expect(telemetryStub.recordProgress).toHaveBeenCalledWith(
      'ResourceHydrationMismatch',
      expect.objectContaining({
        addedIds: ['crystal'],
        reason: 'definitions-added',
      }),
    );
  });

  it('throws when serialized arrays have mismatched lengths', () => {
    const definitions: ResourceDefinition[] = [
      { id: 'energy' },
      { id: 'crystal' },
    ];
    const state = createResourceState(definitions);
    const save = state.exportForSave();

    const truncated = {
      ...save,
      amounts: save.amounts.slice(0, 1),
    } as SerializedResourceState;

    expect(() =>
      reconcileSaveAgainstDefinitions(truncated, definitions),
    ).toThrowError(/length/);

    expect(telemetryStub.recordError).toHaveBeenCalledWith(
      'ResourceSaveLengthMismatch',
      expect.objectContaining({
        field: 'amounts',
        expected: 2,
        actual: 1,
      }),
    );
  });

  it('throws when serialized amounts contain invalid data', () => {
    const definitions: ResourceDefinition[] = [
      { id: 'energy' },
      { id: 'crystal' },
    ];
    const state = createResourceState(definitions);
    const save = state.exportForSave();

    const invalid = {
      ...save,
      amounts: [Number.NaN, ...save.amounts.slice(1)],
    } as SerializedResourceState;

    expect(() =>
      reconcileSaveAgainstDefinitions(invalid, definitions),
    ).toThrowError(/amounts/);

    expect(telemetryStub.recordError).toHaveBeenCalledWith(
      'ResourceHydrationInvalidData',
      expect.objectContaining({
        reason: 'invalid-amount',
        index: 0,
      }),
    );
  });

  it('reconstructs definition digest when serialized save omits it', () => {
    const definitions: ResourceDefinition[] = [
      { id: 'energy' },
      { id: 'crystal' },
    ];
    const state = createResourceState(definitions);
    const save = state.exportForSave();

    const { definitionDigest: _discard, ...withoutDigest } = save as {
      definitionDigest?: SerializedResourceState['definitionDigest'];
    };

    const reconciliation = reconcileSaveAgainstDefinitions(
      withoutDigest as SerializedResourceState,
      definitions,
    );

    expect(reconciliation.remap).toEqual([0, 1]);
    expect(reconciliation.addedIds).toEqual([]);
    expect(reconciliation.removedIds).toEqual([]);
    expect(reconciliation.digestsMatch).toBe(true);

    expect(telemetryStub.recordWarning).toHaveBeenCalledWith(
      'ResourceHydrationInvalidData',
      expect.objectContaining({
        reason: 'missing-digest',
        ids: save.ids,
        recovery: 'reconstructed',
      }),
    );

    expect(telemetryStub.recordError).not.toHaveBeenCalled();
  });

  it('preserves definition order and stable index mapping', () => {
    const definitions: ResourceDefinition[] = [
      { id: 'alpha', startAmount: 1 },
      { id: 'beta', startAmount: 2 },
      { id: 'gamma', startAmount: 3 },
    ];

    const state = createResourceState(definitions);
    expect(state.getDefinitionDigest().ids).toEqual(['alpha', 'beta', 'gamma']);
    expect(state.getIndex('alpha')).toBe(0);
    expect(state.getIndex('gamma')).toBe(2);

    const publishSnapshot = state.snapshot({ mode: 'publish' });
    expect(Array.from(publishSnapshot.ids)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('rejects resource definitions with non-finite start amounts', () => {
    expect(() =>
      createResourceState([
        { id: 'bad-nan', startAmount: Number.NaN },
      ]),
    ).toThrowError(/non-finite startAmount/);
    expect(telemetryStub.recordError).toHaveBeenCalledWith(
      'ResourceDefinitionInvalidStartAmount',
      expect.objectContaining({ id: 'bad-nan' }),
    );

    const recordErrorMock = telemetryStub.recordError as unknown as ReturnType<typeof vi.fn>;
    recordErrorMock.mockClear();
    expect(() =>
      createResourceState([
        { id: 'bad-infinity', startAmount: Number.POSITIVE_INFINITY },
      ]),
    ).toThrowError(/non-finite startAmount/);
    expect(telemetryStub.recordError).toHaveBeenCalledWith(
      'ResourceDefinitionInvalidStartAmount',
      expect.objectContaining({ id: 'bad-infinity' }),
    );
  });

  it('accepts infinite capacities, clamps overflow, and validates capacity input', () => {
    const state = createResourceState([
      { id: 'energy', startAmount: 15, capacity: null },
    ]);
    const energy = state.requireIndex('energy');
    expect(state.getCapacity(energy)).toBe(Number.POSITIVE_INFINITY);

    state.setCapacity(energy, 10);
    expect(state.getCapacity(energy)).toBe(10);
    const publishSnapshot = state.snapshot({ mode: 'publish' });
    expect(publishSnapshot.amounts[energy]).toBe(10);
    expect(publishSnapshot.tickDelta[energy]).toBe(-5);

    expect(() => state.setCapacity(energy, Number.NaN)).toThrowError(/Capacity must be/);
    expect(telemetryStub.recordError).toHaveBeenCalledWith(
      'ResourceCapacityInvalidInput',
      expect.objectContaining({ index: energy, value: Number.NaN }),
    );
  });

  it('emits telemetry when index-based helpers receive out-of-range indices', () => {
    const state = createResourceState([{ id: 'energy' }]);
    expect(() => state.getAmount(5)).toThrowError(/out of bounds/);
    expect(telemetryStub.recordError).toHaveBeenCalledWith(
      'ResourceIndexViolation',
      expect.objectContaining({ index: 5 }),
    );
  });

  it('rejects invalid rate submissions with telemetry metadata', () => {
    const state = createResourceState([{ id: 'energy' }]);
    const energy = state.requireIndex('energy');

    expect(() => state.applyIncome(energy, Number.POSITIVE_INFINITY)).toThrowError(
      /finite, non-negative value/,
    );
    expect(telemetryStub.recordError).toHaveBeenCalledWith(
      'ResourceRateInvalidInput',
      expect.objectContaining({
        field: 'income',
        index: energy,
        amountPerSecond: Number.POSITIVE_INFINITY,
      }),
    );

    const recordErrorMock = telemetryStub.recordError as unknown as ReturnType<typeof vi.fn>;
    recordErrorMock.mockClear();
    expect(() => state.applyExpense(energy, -1)).toThrowError(/finite, non-negative value/);
    expect(telemetryStub.recordError).toHaveBeenCalledWith(
      'ResourceRateInvalidInput',
      expect.objectContaining({
        field: 'expense',
        index: energy,
        amountPerSecond: -1,
      }),
    );
  });

  it('ignores zero-valued income and expense submissions to avoid dirty churn', () => {
    const state = createResourceState([{ id: 'energy' }]);
    const energy = state.requireIndex('energy');

    state.applyIncome(energy, 0);
    state.applyExpense(energy, 0);

    const publishSnapshot = state.snapshot({ mode: 'publish' });
    expect(publishSnapshot.dirtyCount).toBe(0);
  });

  it('suppresses finalizeTick deltas that fall below the epsilon tolerance', () => {
    const state = createResourceState([
      { id: 'energy', capacity: Number.POSITIVE_INFINITY },
    ]);
    const energy = state.requireIndex('energy');

    state.applyIncome(energy, 1);
    state.applyExpense(energy, 1 - 5e-7);
    state.finalizeTick(1);

    const publishSnapshot = state.snapshot({ mode: 'publish' });
    expect(publishSnapshot.tickDelta[energy]).toBe(0);
    expect(state.getAmount(energy)).toBeCloseTo(5e-10, 15);
  });

  it('ignores sub-epsilon amount adjustments while retaining live state', () => {
    const state = createResourceState([
      { id: 'energy', capacity: Number.POSITIVE_INFINITY },
    ]);
    const energy = state.requireIndex('energy');

    const applied = state.addAmount(energy, 5e-10);
    expect(applied).toBeCloseTo(5e-10, 15);
    expect(state.getAmount(energy)).toBeCloseTo(5e-10, 15);

    const publishSnapshot = state.snapshot({ mode: 'publish' });
    expect(publishSnapshot.dirtyCount).toBe(0);
    expect(publishSnapshot.tickDelta[energy]).toBe(0);
    expect(publishSnapshot.amounts[energy]).toBe(0);
  });

  it('respects dirty tolerance overrides and surfaces saturation telemetry', () => {
    const state = createResourceState([
      { id: 'default', startAmount: 1e8, capacity: null },
      { id: 'relaxed', startAmount: 1e8, capacity: null, dirtyTolerance: 1e-2 },
    ]);
    const defaultIndex = state.requireIndex('default');
    const relaxedIndex = state.requireIndex('relaxed');

    state.addAmount(defaultIndex, 5e-3);
    state.addAmount(relaxedIndex, 5e-3);

    const publishSnapshot = state.snapshot({ mode: 'publish' });
    expect(publishSnapshot.dirtyCount).toBe(1);
    expect(Array.from(publishSnapshot.dirtyIndices.slice(0, publishSnapshot.dirtyCount))).toEqual([
      defaultIndex,
    ]);
    expect(publishSnapshot.amounts[relaxedIndex]).toBeCloseTo(1e8, 9);
    expect(publishSnapshot.tickDelta[relaxedIndex]).toBe(0);
    expect(publishSnapshot.dirtyTolerance[relaxedIndex]).toBeCloseTo(1e-2, 12);

    const recorderSnapshot = state.snapshot({ mode: 'recorder' });
    expect(recorderSnapshot.dirtyTolerance[relaxedIndex]).toBeCloseTo(1e-2, 12);
    expect(recorderSnapshot.amounts[relaxedIndex]).toBeCloseTo(
      state.getAmount(relaxedIndex),
      12,
    );
    expect(recorderSnapshot.tickDelta[relaxedIndex]).toBeCloseTo(5e-3, 6);

    expect(telemetryStub.recordWarning).toHaveBeenCalledWith(
      'ResourceDirtyToleranceSaturated',
      expect.objectContaining({
        resourceId: 'relaxed',
        field: 'amount',
        toleranceCeiling: 1e-2,
      }),
    );
  });

  it('accumulates tick deltas across sub-tolerance increments when overrides apply', () => {
    const state = createResourceState([
      { id: 'relaxed', capacity: Number.POSITIVE_INFINITY, dirtyTolerance: 1e-2 },
    ]);
    const relaxed = state.requireIndex('relaxed');

    state.addAmount(relaxed, 6e-3);
    const recorderSnapshot = state.snapshot({ mode: 'recorder' });
    expect(recorderSnapshot.dirtyCount).toBe(0);
    expect(recorderSnapshot.tickDelta[relaxed]).toBeCloseTo(6e-3, 12);

    state.addAmount(relaxed, 6e-3);
    const publishSnapshot = state.snapshot({ mode: 'publish' });
    expect(publishSnapshot.dirtyCount).toBe(1);
    expect(publishSnapshot.dirtyIndices[0]).toBe(relaxed);
    expect(publishSnapshot.tickDelta[relaxed]).toBeCloseTo(1.2e-2, 9);
    expect(publishSnapshot.amounts[relaxed]).toBeCloseTo(1.2e-2, 9);
  });

  it('drops reverted indices from dirty tracking via tail swaps', () => {
    const state = createResourceState([
      { id: 'alpha', capacity: 100 },
      { id: 'beta', capacity: 100 },
    ]);
    const alpha = state.requireIndex('alpha');
    const beta = state.requireIndex('beta');

    state.addAmount(alpha, 10);
    state.addAmount(beta, 3);
    state.spendAmount(alpha, 10);

    const recorderSnapshot = state.snapshot({ mode: 'recorder' });
    expect(recorderSnapshot.dirtyCount).toBe(1);
    expect(recorderSnapshot.dirtyIndices[0]).toBe(beta);

    const publishSnapshot = state.snapshot({ mode: 'publish' });
    expect(publishSnapshot.dirtyCount).toBe(1);
    expect(publishSnapshot.dirtyIndices[0]).toBe(beta);
  });

  it('ping-pongs publish buffers while zeroing reverted tick deltas and preserving prior snapshots', () => {
    const state = createResourceState([
      { id: 'energy', startAmount: 10, capacity: 50 },
      { id: 'crystal', startAmount: 5, capacity: 50 },
    ]);
    const energy = state.requireIndex('energy');
    const crystal = state.requireIndex('crystal');

    state.addAmount(energy, 5);
    const firstPublish = state.snapshot({ mode: 'publish' });
    expect(firstPublish.dirtyCount).toBe(1);
    expect(firstPublish.dirtyIndices[0]).toBe(energy);
    expect(firstPublish.tickDelta[energy]).toBe(5);

    state.addAmount(energy, 5);
    state.spendAmount(energy, 5);
    state.addAmount(crystal, 2);

    const secondPublish = state.snapshot({ mode: 'publish' });
    expect(secondPublish.dirtyCount).toBe(1);
    expect(secondPublish.dirtyIndices[0]).toBe(crystal);
    expect(secondPublish.tickDelta[energy]).toBe(0);
    expect(secondPublish.amounts[energy]).toBe(15);
    expect(firstPublish.tickDelta[energy]).toBe(5);
    expect(firstPublish.amounts[energy]).toBe(15);
  });

  it('rejects serialized saves with duplicate ids and reports telemetry', () => {
    const state = createResourceState([{ id: 'energy' }]);
    const save = state.exportForSave();

    const duplicate: SerializedResourceState = {
      ...save,
      definitionDigest: undefined,
      ids: ['energy', 'energy'],
      amounts: [...save.amounts, save.amounts[0]],
      capacities: [...save.capacities, save.capacities[0]],
      flags: [...save.flags, save.flags[0]],
      unlocked: save.unlocked ? [...save.unlocked, save.unlocked[0]] : undefined,
      visible: save.visible ? [...save.visible, save.visible[0]] : undefined,
    };

    expect(() =>
      reconcileSaveAgainstDefinitions(duplicate, [{ id: 'energy' }]),
    ).toThrowError(/appears multiple times/);
    expect(telemetryStub.recordError).toHaveBeenCalledWith(
      'ResourceHydrationInvalidData',
      expect.objectContaining({
        reason: 'duplicate-id',
        id: 'energy',
      }),
    );
  });
});
