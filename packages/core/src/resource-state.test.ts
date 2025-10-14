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
});
