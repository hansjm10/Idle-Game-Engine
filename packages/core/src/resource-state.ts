import {
  createImmutableTypedArrayView,
  type ImmutableMapSnapshot,
} from './immutable-snapshots.js';
import { telemetry } from './telemetry.js';

const DIRTY_EPSILON_ABSOLUTE = 1e-9;
const DIRTY_EPSILON_RELATIVE = 1e-9;
const DIRTY_EPSILON_CEILING = 1e-3;
const DIRTY_EPSILON_OVERRIDE_MAX = 5e-1;

const FLAG_VISIBLE = 1 << 0;
const FLAG_UNLOCKED = 1 << 1;
const FLAG_DIRTY_THIS_TICK = 1 << 2;

const SCRATCH_UNSET = -1;
const SCRATCH_VISITED = -2;

const TELEMETRY_DIRTY_TOLERANCE_SATURATED = 'ResourceDirtyToleranceSaturated';
const TELEMETRY_FORCE_CLEAR = 'ResourceForceClearDirtyState';
const TELEMETRY_SAVE_LENGTH_MISMATCH = 'ResourceSaveLengthMismatch';
const TELEMETRY_HYDRATION_MISMATCH = 'ResourceHydrationMismatch';
const TELEMETRY_HYDRATION_INVALID_DATA = 'ResourceHydrationInvalidData';

const SNAPSHOT_GUARD_ENV_KEY = 'SNAPSHOT_GUARDS';

type SnapshotGuardMode = 'auto' | 'force-on' | 'force-off';

const enum PublishGuardState {
  Idle = 0,
  Finalized = 1,
  Published = 2,
}

type ResourceFloatField =
  | 'amount'
  | 'capacity'
  | 'incomePerSecond'
  | 'expensePerSecond'
  | 'netPerSecond'
  | 'tickDelta'
  | 'flags';

interface EpsilonTelemetryContext {
  readonly resourceId: string;
  readonly field: ResourceFloatField;
  readonly hasOverride: boolean;
}

interface EpsilonEqualsOptions {
  readonly floorToleranceOverride?: boolean;
}

export interface ResourceDefinition {
  readonly id: string;
  readonly startAmount?: number;
  readonly capacity?: number | null;
  readonly unlocked?: boolean;
  readonly visible?: boolean;
  readonly dirtyTolerance?: number;
}

export interface ResourceDefinitionDigest {
  readonly ids: readonly string[];
  readonly version: number;
  readonly hash: string;
}

export interface ResourceDefinitionReconciliation {
  readonly remap: readonly number[];
  readonly addedIds: readonly string[];
  readonly removedIds: readonly string[];
  readonly digestsMatch: boolean;
}

export interface ResourcePublishBuffers {
  readonly amounts: Float64Array;
  readonly capacities: Float64Array;
  readonly incomePerSecond: Float64Array;
  readonly expensePerSecond: Float64Array;
  readonly netPerSecond: Float64Array;
  readonly tickDelta: Float64Array;
  readonly flags: Uint8Array;
  readonly dirtyTolerance: Float64Array;
  readonly dirtyIndices: Uint32Array;
  dirtyCount: number;
}

export interface ResourceStateBuffers {
  readonly ids: readonly string[];
  readonly indexById: ImmutableMapSnapshot<string, number>;
  readonly amounts: Float64Array;
  readonly capacities: Float64Array;
  readonly incomePerSecond: Float64Array;
  readonly expensePerSecond: Float64Array;
  readonly netPerSecond: Float64Array;
  readonly tickDelta: Float64Array;
  readonly flags: Uint8Array;
  readonly dirtyTolerance: Float64Array;
  readonly publish: readonly [ResourcePublishBuffers, ResourcePublishBuffers];
  readonly dirtyIndexScratch: Uint32Array;
  readonly dirtyIndexPositions: Int32Array;
}

export interface ResourceStateSnapshot {
  readonly ids: readonly string[];
  readonly amounts: Float64Array;
  readonly capacities: Float64Array;
  readonly incomePerSecond: Float64Array;
  readonly expensePerSecond: Float64Array;
  readonly netPerSecond: Float64Array;
  readonly tickDelta: Float64Array;
  readonly flags: Uint8Array;
  readonly dirtyTolerance: Float64Array;
  readonly dirtyIndices: Uint32Array;
  readonly dirtyCount: number;
}

export interface SerializedResourceState {
  readonly ids: readonly string[];
  readonly amounts: readonly number[];
  readonly capacities: readonly (number | null)[];
  readonly unlocked?: readonly boolean[];
  readonly visible?: readonly boolean[];
  readonly flags: readonly number[];
  readonly definitionDigest?: ResourceDefinitionDigest;
  readonly automationState?: readonly import('./automation-system.js').AutomationState[];
}

export interface ResourceSpendAttemptContext {
  readonly commandId?: string;
  readonly systemId?: string;
}

export interface ResourceState {
  getIndex(id: string): number | undefined;
  requireIndex(id: string): number;
  getAmount(index: number): number;
  getCapacity(index: number): number;
  getNetPerSecond(index: number): number;
  isUnlocked(index: number): boolean;
  isVisible(index: number): boolean;
  grantVisibility(index: number): void;
  unlock(index: number): void;
  setCapacity(index: number, capacity: number): number;
  addAmount(index: number, amount: number): number;
  spendAmount(
    index: number,
    amount: number,
    context?: ResourceSpendAttemptContext,
  ): boolean;
  applyIncome(index: number, amountPerSecond: number): void;
  applyExpense(index: number, amountPerSecond: number): void;
  finalizeTick(deltaMs: number): void;
  resetPerTickAccumulators(): void;
  forceClearDirtyState(): void;
  clearDirtyScratch(): void;
  snapshot(options?: { mode?: 'publish' | 'recorder' }): ResourceStateSnapshot;
  exportForSave(): SerializedResourceState;
  getDefinitionDigest(): ResourceDefinitionDigest;
}

const resourceStateInternals = new WeakMap<ResourceState, ResourceStateInternal>();

interface PublishSnapshotOptions {
  readonly mode?: 'publish' | 'recorder';
}

interface ResourceStateInternal {
  readonly buffers: ResourceStateBuffers;
  activePublishIndex: number;
  dirtyIndexCount: number;
  publishGuardState: PublishGuardState;
  readonly definitionDigest: ResourceDefinitionDigest;
}

type FloatFieldSelector = (publish: ResourcePublishBuffers) => Float64Array;

export function createResourceState(
  definitions: readonly ResourceDefinition[],
): ResourceState {
  const resourceCount = definitions.length;

  const ids: string[] = new Array(resourceCount);
  const indexMap = new Map<string, number>();

  const seenIds = new Set<string>();
  for (let index = 0; index < resourceCount; index += 1) {
    const definition = definitions[index];
    const id = definition?.id;

    if (!id) {
      telemetry.recordError('ResourceDefinitionMissingId', {
        index,
      });
      throw new Error(`Resource definition at index ${index} is missing an id.`);
    }

    if (seenIds.has(id)) {
      telemetry.recordError('ResourceDefinitionDuplicateId', {
        id,
      });
      throw new Error(`Resource definition with id "${id}" is duplicated.`);
    }

    seenIds.add(id);
    ids[index] = id;
    indexMap.set(id, index);
  }

  const immutableIds = Object.freeze([...ids]);
  const indexById = createImmutableIndexMap(indexMap);

  const floatBuffer = new ArrayBuffer(
    Float64Array.BYTES_PER_ELEMENT * 7 * Math.max(1, resourceCount),
  );
  const stride = resourceCount * Float64Array.BYTES_PER_ELEMENT;
  const amounts = new Float64Array(floatBuffer, 0 * stride, resourceCount);
  const capacities = new Float64Array(floatBuffer, 1 * stride, resourceCount);
  const incomePerSecond = new Float64Array(floatBuffer, 2 * stride, resourceCount);
  const expensePerSecond = new Float64Array(floatBuffer, 3 * stride, resourceCount);
  const netPerSecond = new Float64Array(floatBuffer, 4 * stride, resourceCount);
  const tickDelta = new Float64Array(floatBuffer, 5 * stride, resourceCount);
  const dirtyTolerance = new Float64Array(floatBuffer, 6 * stride, resourceCount);

  const flags = new Uint8Array(resourceCount);

  const publishBuffers: [ResourcePublishBuffers, ResourcePublishBuffers] = [
    createPublishBuffers(resourceCount),
    createPublishBuffers(resourceCount),
  ];

  const dirtyIndexScratch = new Uint32Array(resourceCount);
  const dirtyIndexPositions = new Int32Array(resourceCount);
  dirtyIndexPositions.fill(SCRATCH_UNSET);

  const buffers: ResourceStateBuffers = {
    ids: immutableIds,
    indexById,
    amounts,
    capacities,
    incomePerSecond,
    expensePerSecond,
    netPerSecond,
    tickDelta,
    flags,
    dirtyTolerance,
    publish: publishBuffers,
    dirtyIndexScratch,
    dirtyIndexPositions,
  };

  initializeBuffers(buffers, definitions);

  const internal: ResourceStateInternal = {
    buffers,
    activePublishIndex: 0,
    dirtyIndexCount: 0,
    publishGuardState: PublishGuardState.Idle,
    definitionDigest: createDefinitionDigest(immutableIds),
  };

  const facade = createResourceStateFacade(internal);
  resourceStateInternals.set(facade, internal);
  return facade;
}

/** @internal */
export function __unsafeWriteAmountDirect(
  state: ResourceState,
  index: number,
  amount: number,
): void {
  const internal = resourceStateInternals.get(state);
  if (internal === undefined) {
    telemetry.recordError('ResourceStateInternalUnavailable');
    throw new Error('ResourceState internals are unavailable for the provided instance.');
  }

  writeAmountDirect(internal, index, amount);
}

function initializeBuffers(
  buffers: ResourceStateBuffers,
  definitions: readonly ResourceDefinition[],
): void {
  const { amounts, capacities, incomePerSecond, expensePerSecond, netPerSecond, tickDelta, flags, dirtyTolerance, publish } =
    buffers;

  const initialPublish = publish[0];
  const standbyPublish = publish[1];

  const { resources: sanitized } = sanitizeDefinitions(definitions);

  for (let index = 0; index < sanitized.length; index += 1) {
    const definition = sanitized[index];

    amounts[index] = definition.amount;
    capacities[index] = definition.capacity;
    incomePerSecond[index] = 0;
    expensePerSecond[index] = 0;
    netPerSecond[index] = definition.netPerSecond;
    tickDelta[index] = 0;
    flags[index] = definition.flags;
    dirtyTolerance[index] = definition.dirtyTolerance;

    initialPublish.amounts[index] = definition.amount;
    initialPublish.capacities[index] = definition.capacity;
    initialPublish.incomePerSecond[index] = 0;
    initialPublish.expensePerSecond[index] = 0;
    initialPublish.netPerSecond[index] = definition.netPerSecond;
    initialPublish.tickDelta[index] = 0;
    initialPublish.flags[index] = definition.flags & ~FLAG_DIRTY_THIS_TICK;
    initialPublish.dirtyTolerance[index] = definition.dirtyTolerance;

    standbyPublish.amounts[index] = definition.amount;
    standbyPublish.capacities[index] = definition.capacity;
    standbyPublish.incomePerSecond[index] = 0;
    standbyPublish.expensePerSecond[index] = 0;
    standbyPublish.netPerSecond[index] = definition.netPerSecond;
    standbyPublish.tickDelta[index] = 0;
    standbyPublish.flags[index] = definition.flags & ~FLAG_DIRTY_THIS_TICK;
    standbyPublish.dirtyTolerance[index] = definition.dirtyTolerance;
  }

  initialPublish.dirtyCount = 0;
  standbyPublish.dirtyCount = 0;
}

function sanitizeDefinitions(
  definitions: readonly ResourceDefinition[],
): {
  readonly resources: readonly {
    readonly amount: number;
    readonly capacity: number;
    readonly flags: number;
    readonly netPerSecond: number;
    readonly dirtyTolerance: number;
  }[];
} {
  const sanitized = definitions.map((definition, _index) => {
    const rawStartAmount = definition.startAmount ?? 0;
    const rawCapacity = definition.capacity ?? Number.POSITIVE_INFINITY;
    const unlocked = definition.unlocked ?? true;
    const visible = definition.visible ?? true;
    const dirtyTolerance =
      definition.dirtyTolerance ?? DIRTY_EPSILON_CEILING;

    if (!Number.isFinite(rawStartAmount)) {
      telemetry.recordError('ResourceDefinitionInvalidStartAmount', {
        id: definition.id,
        value: rawStartAmount,
      });
      throw new Error(
        `Resource definition "${definition.id}" has a non-finite startAmount.`,
      );
    }

    let sanitizedCapacity: number;
    if (rawCapacity === null) {
      sanitizedCapacity = Number.POSITIVE_INFINITY;
    } else if (typeof rawCapacity === 'number') {
      if (Number.isNaN(rawCapacity) || rawCapacity < 0) {
        telemetry.recordError('ResourceDefinitionInvalidCapacity', {
          id: definition.id,
          value: rawCapacity,
        });
        throw new Error(
          `Resource definition "${definition.id}" has an invalid capacity.`,
        );
      }
      sanitizedCapacity = rawCapacity;
    } else {
      sanitizedCapacity = Number.POSITIVE_INFINITY;
    }

    let amount = rawStartAmount;
    if (amount < 0) {
      telemetry.recordWarning('ResourceInitialAmountClampLow', {
        id: definition.id,
        value: amount,
      });
      amount = 0;
    }

    if (amount > sanitizedCapacity) {
      telemetry.recordWarning('ResourceInitialAmountClampHigh', {
        id: definition.id,
        value: amount,
        capacity: sanitizedCapacity,
      });
      amount = sanitizedCapacity;
    }

    const tolerance = clampDirtyTolerance(dirtyTolerance, definition.id);

    const initialFlags =
      (visible ? FLAG_VISIBLE : 0) |
      (unlocked ? FLAG_UNLOCKED : 0);

    return {
      amount,
      capacity: sanitizedCapacity,
      flags: initialFlags,
      netPerSecond: 0,
      dirtyTolerance: tolerance,
    };
  });

  return {
    resources: sanitized,
  };
}

function clampDirtyTolerance(value: number, resourceId: string): number {
  if (!Number.isFinite(value)) {
    return DIRTY_EPSILON_CEILING;
  }

  if (value < DIRTY_EPSILON_ABSOLUTE) {
    return DIRTY_EPSILON_ABSOLUTE;
  }

  if (value > DIRTY_EPSILON_OVERRIDE_MAX) {
    telemetry.recordWarning('ResourceDirtyToleranceClamped', {
      resourceId,
      value,
    });
    return DIRTY_EPSILON_OVERRIDE_MAX;
  }

  return value;
}

function createPublishBuffers(
  resourceCount: number,
): ResourcePublishBuffers {
  const floatBuffer = new ArrayBuffer(
    Float64Array.BYTES_PER_ELEMENT * 7 * Math.max(1, resourceCount),
  );
  const stride = resourceCount * Float64Array.BYTES_PER_ELEMENT;

  const amounts = new Float64Array(floatBuffer, 0 * stride, resourceCount);
  const capacities = new Float64Array(floatBuffer, 1 * stride, resourceCount);
  const incomePerSecond = new Float64Array(floatBuffer, 2 * stride, resourceCount);
  const expensePerSecond = new Float64Array(floatBuffer, 3 * stride, resourceCount);
  const netPerSecond = new Float64Array(floatBuffer, 4 * stride, resourceCount);
  const tickDelta = new Float64Array(floatBuffer, 5 * stride, resourceCount);
  const dirtyTolerance = new Float64Array(floatBuffer, 6 * stride, resourceCount);
  const flags = new Uint8Array(resourceCount);
  const dirtyIndices = new Uint32Array(resourceCount);

  return {
    amounts,
    capacities,
    incomePerSecond,
    expensePerSecond,
    netPerSecond,
    tickDelta,
    flags,
    dirtyTolerance,
    dirtyIndices,
    dirtyCount: 0,
  };
}

function createImmutableIndexMap(
  source: Map<string, number>,
): ImmutableMapSnapshot<string, number> {
  const immutable = new Map(source);
  return new Proxy(immutable, {
    get(target, property, receiver) {
      if (property === 'set' || property === 'delete' || property === 'clear') {
        return () => {
          throw new Error(
            'ResourceState index map is immutable once created.',
          );
        };
      }

      const result = Reflect.get(target, property, receiver);
      return typeof result === 'function' ? result.bind(target) : result;
    },
  }) as ImmutableMapSnapshot<string, number>;
}

function createResourceStateFacade(
  internal: ResourceStateInternal,
): ResourceState {
  const { buffers } = internal;

  return {
    getIndex: (id) => internal.buffers.indexById.get(id),
    requireIndex: (id) => requireIndex(internal, id),
    getAmount: (index) => {
      assertValidIndex(internal, index);
      return buffers.amounts[index];
    },
    getCapacity: (index) => {
      assertValidIndex(internal, index);
      return buffers.capacities[index];
    },
    getNetPerSecond: (index) => {
      assertValidIndex(internal, index);
      return buffers.netPerSecond[index];
    },
    isUnlocked: (index) => {
      assertValidIndex(internal, index);
      return (buffers.flags[index] & FLAG_UNLOCKED) !== 0;
    },
    isVisible: (index) => {
      assertValidIndex(internal, index);
      return (buffers.flags[index] & FLAG_VISIBLE) !== 0;
    },
    grantVisibility: (index) => {
      setFlagField(internal, index, FLAG_VISIBLE, true);
    },
    unlock: (index) => {
      setFlagField(internal, index, FLAG_UNLOCKED, true);
    },
    setCapacity: (index, capacity) => setCapacity(internal, index, capacity),
    addAmount: (index, amount) => addAmount(internal, index, amount),
    spendAmount: (index, amount, context) =>
      spendAmount(internal, index, amount, context),
    applyIncome: (index, amountPerSecond) =>
      applyRate(internal, index, amountPerSecond, 'income'),
    applyExpense: (index, amountPerSecond) =>
      applyRate(internal, index, amountPerSecond, 'expense'),
    finalizeTick: (deltaMs) => finalizeTick(internal, deltaMs),
    resetPerTickAccumulators: () => resetPerTickAccumulators(internal),
    forceClearDirtyState: () => forceClearDirtyState(internal),
    clearDirtyScratch: () => clearDirtyScratch(internal),
    snapshot: (options?: PublishSnapshotOptions) =>
      snapshot(internal, options ?? {}),
    exportForSave: () => exportForSave(internal),
    getDefinitionDigest: () => internal.definitionDigest,
  };
}

function requireIndex(
  internal: ResourceStateInternal,
  id: string,
): number {
  const index = internal.buffers.indexById.get(id);
  if (index === undefined) {
    telemetry.recordError('ResourceUnknownId', { id });
    throw new Error(`Resource with id "${id}" does not exist.`);
  }

  return index;
}

function assertValidIndex(
  internal: ResourceStateInternal,
  index: number,
): void {
  if (!Number.isInteger(index) || index < 0 || index >= internal.buffers.ids.length) {
    telemetry.recordError('ResourceIndexViolation', { index });
    throw new Error(`Resource index ${index} is out of bounds.`);
  }
}

function setCapacity(
  internal: ResourceStateInternal,
  index: number,
  rawCapacity: number,
): number {
  assertValidIndex(internal, index);

  if (
    (Number.isNaN(rawCapacity) || rawCapacity < 0) &&
    rawCapacity !== Number.POSITIVE_INFINITY
  ) {
    telemetry.recordError('ResourceCapacityInvalidInput', {
      index,
      value: rawCapacity,
    });
    throw new Error('Capacity must be a finite, non-negative number or Infinity.');
  }

  const { buffers } = internal;
  const nextCapacity =
    rawCapacity === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : rawCapacity;
  const previousCapacity = buffers.capacities[index];
  if (!Object.is(previousCapacity, nextCapacity)) {
    writeFloatField(
      internal,
      buffers.capacities,
      (publish) => publish.capacities,
      index,
      nextCapacity,
      'capacity',
    );
  }

  const currentAmount = buffers.amounts[index];
  if (currentAmount > nextCapacity) {
    const clampedAmount = nextCapacity;
    const delta = clampedAmount - currentAmount;
    writeFloatField(
      internal,
      buffers.amounts,
      (publish) => publish.amounts,
      index,
      clampedAmount,
      'amount',
    );
    accumulateTickDelta(internal, index, delta);
  }

  return buffers.capacities[index];
}

function addAmount(
  internal: ResourceStateInternal,
  index: number,
  amount: number,
): number {
  assertValidIndex(internal, index);
  if (!Number.isFinite(amount)) {
    telemetry.recordError('ResourceAddAmountNonFinite', {
      index,
      amount,
    });
    throw new Error('addAmount requires a finite input.');
  }

  if (amount < 0) {
    telemetry.recordError('ResourceAddAmountNegativeInput', {
      index,
      amount,
    });
    throw new Error('addAmount cannot receive a negative value.');
  }

  if (amount === 0) {
    return 0;
  }

  const { buffers } = internal;
  const previousAmount = buffers.amounts[index];
  const capacity = buffers.capacities[index];

  const tentativeAmount = previousAmount + amount;
  const clampedAmount = Math.min(tentativeAmount, capacity);
  const appliedDelta = clampedAmount - previousAmount;

  if (appliedDelta === 0) {
    return 0;
  }

  writeFloatField(
    internal,
    buffers.amounts,
    (publish) => publish.amounts,
    index,
    clampedAmount,
    'amount',
  );
  accumulateTickDelta(internal, index, appliedDelta);
  return appliedDelta;
}

function spendAmount(
  internal: ResourceStateInternal,
  index: number,
  amount: number,
  context?: ResourceSpendAttemptContext,
): boolean {
  assertValidIndex(internal, index);
  if (!Number.isFinite(amount)) {
    telemetry.recordError('ResourceSpendAmountNonFinite', {
      index,
      amount,
    });
    throw new Error('spendAmount requires a finite input.');
  }

  if (amount < 0) {
    telemetry.recordError('ResourceSpendAmountNegativeInput', {
      index,
      amount,
    });
    throw new Error('spendAmount cannot receive a negative value.');
  }

  if (amount === 0) {
    return true;
  }

  const { buffers } = internal;
  const currentAmount = buffers.amounts[index];
  if (currentAmount < amount) {
    telemetry.recordWarning('ResourceSpendFailed', {
      index,
      amount,
      available: currentAmount,
      commandId: context?.commandId,
      systemId: context?.systemId,
    });
    return false;
  }

  const nextAmount = currentAmount - amount;
  writeFloatField(
    internal,
    buffers.amounts,
    (publish) => publish.amounts,
    index,
    nextAmount,
    'amount',
  );
  accumulateTickDelta(internal, index, -amount);
  return true;
}

type RateField = 'income' | 'expense';

function writeAmountDirect(
  internal: ResourceStateInternal,
  index: number,
  amount: number,
): void {
  assertValidIndex(internal, index);

  if (!Number.isFinite(amount)) {
    telemetry.recordError('ResourceWriteAmountDirectNonFinite', {
      index,
      amount,
    });
    throw new Error('writeAmountDirect requires a finite amount.');
  }

  writeFloatField(
    internal,
    internal.buffers.amounts,
    (publish) => publish.amounts,
    index,
    amount,
    'amount',
  );
}

function applyRate(
  internal: ResourceStateInternal,
  index: number,
  amountPerSecond: number,
  field: RateField,
): void {
  assertValidIndex(internal, index);

  if (!Number.isFinite(amountPerSecond) || amountPerSecond < 0) {
    telemetry.recordError('ResourceRateInvalidInput', {
      index,
      amountPerSecond,
      field,
    });
    throw new Error(`${field} amount must be a finite, non-negative value.`);
  }

  if (amountPerSecond === 0) {
    return;
  }

  const { buffers } = internal;
  const target = field === 'income' ? buffers.incomePerSecond : buffers.expensePerSecond;
  const fieldName: ResourceFloatField =
    field === 'income' ? 'incomePerSecond' : 'expensePerSecond';

  const nextValue = target[index] + amountPerSecond;
  writeFloatField(
    internal,
    target,
    (publish) =>
      field === 'income'
        ? publish.incomePerSecond
        : publish.expensePerSecond,
    index,
    nextValue,
    fieldName,
  );
}

function finalizeTick(
  internal: ResourceStateInternal,
  deltaMs: number,
): void {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) {
    telemetry.recordError('ResourceFinalizeInvalidDelta', {
      deltaMs,
    });
    throw new Error('finalizeTick requires a finite, non-negative deltaMs.');
  }

  const { buffers } = internal;
  const deltaSeconds = deltaMs / 1_000;
  const resourceCount = buffers.ids.length;

  for (let index = 0; index < resourceCount; index += 1) {
    const incomePerSecond = buffers.incomePerSecond[index];
    const expensePerSecond = buffers.expensePerSecond[index];
    const currentAmount = buffers.amounts[index];
    const capacity = buffers.capacities[index];

    const incomeDelta = incomePerSecond * deltaSeconds;
    const expenseDelta = expensePerSecond * deltaSeconds;
    const proposedDelta = incomeDelta - expenseDelta;
    const nextAmount = clampAmount(currentAmount + proposedDelta, capacity);
    const appliedDelta = nextAmount - currentAmount;

    if (!Object.is(currentAmount, nextAmount)) {
      writeFloatField(
        internal,
        buffers.amounts,
        (publish) => publish.amounts,
        index,
        nextAmount,
        'amount',
      );
    }

    if (appliedDelta !== 0) {
      accumulateTickDelta(internal, index, appliedDelta);
    }

    const net = incomePerSecond - expensePerSecond;
    writeFloatField(
      internal,
      buffers.netPerSecond,
      (publish) => publish.netPerSecond,
      index,
      net,
      'netPerSecond',
    );
  }

  internal.publishGuardState = PublishGuardState.Finalized;
}

function resetPerTickAccumulators(internal: ResourceStateInternal): void {
  if (internal.publishGuardState !== PublishGuardState.Published) {
    telemetry.recordError('ResourceResetOutOfOrder');
    throw new Error(
      'resetPerTickAccumulators requires a publish snapshot before clearing.',
    );
  }

  const { buffers } = internal;
  buffers.incomePerSecond.fill(0);
  buffers.expensePerSecond.fill(0);
  buffers.tickDelta.fill(0);
  internal.publishGuardState = PublishGuardState.Idle;
}

function clearDirtyScratch(internal: ResourceStateInternal): void {
  internal.dirtyIndexCount = 0;
  internal.buffers.dirtyIndexPositions.fill(SCRATCH_UNSET);
  const { flags } = internal.buffers;
  for (let index = 0; index < flags.length; index += 1) {
    flags[index] &= ~FLAG_DIRTY_THIS_TICK;
  }
}

function forceClearDirtyState(internal: ResourceStateInternal): void {
  const previousDirtyCount = internal.dirtyIndexCount;
  const previousGuardState = internal.publishGuardState;

  clearDirtyScratch(internal);
  internal.buffers.incomePerSecond.fill(0);
  internal.buffers.expensePerSecond.fill(0);
  internal.buffers.tickDelta.fill(0);
  internal.publishGuardState = PublishGuardState.Idle;

  telemetry.recordProgress(TELEMETRY_FORCE_CLEAR, {
    dirtyCountBefore: previousDirtyCount,
    publishGuardState: describePublishGuardState(previousGuardState),
  });
}

function describePublishGuardState(state: PublishGuardState): 'idle' | 'finalized' | 'published' {
  switch (state) {
    case PublishGuardState.Idle:
      return 'idle';
    case PublishGuardState.Finalized:
      return 'finalized';
    case PublishGuardState.Published:
      return 'published';
    default:
      return 'idle';
  }
}

function snapshot(
  internal: ResourceStateInternal,
  options: PublishSnapshotOptions,
): ResourceStateSnapshot {
  if (options.mode === 'recorder') {
    return createRecorderSnapshot(internal);
  }

  return createPublishSnapshot(internal);
}

function createRecorderSnapshot(
  internal: ResourceStateInternal,
): ResourceStateSnapshot {
  const { buffers } = internal;
  const resourceCount = buffers.ids.length;

  const copy = <TArray extends Float64Array | Uint8Array | Uint32Array>(
    view: TArray,
  ): TArray => {
    const Ctor = view.constructor as {
      new(length: number): TArray;
    };
    const clone = new Ctor(view.length);
    (clone as unknown as Float64Array | Uint8Array | Uint32Array).set(view);
    return clone;
  };

  const dirtyIndices = new Uint32Array(resourceCount);
  dirtyIndices.set(
    buffers.dirtyIndexScratch.subarray(0, internal.dirtyIndexCount),
  );

  return {
    ids: buffers.ids,
    amounts: copy(buffers.amounts),
    capacities: copy(buffers.capacities),
    incomePerSecond: copy(buffers.incomePerSecond),
    expensePerSecond: copy(buffers.expensePerSecond),
    netPerSecond: copy(buffers.netPerSecond),
    tickDelta: copy(buffers.tickDelta),
    flags: copy(buffers.flags),
    dirtyTolerance: copy(buffers.dirtyTolerance),
    dirtyIndices,
    dirtyCount: internal.dirtyIndexCount,
  };
}

function createPublishSnapshot(
  internal: ResourceStateInternal,
): ResourceStateSnapshot {
  const { buffers } = internal;
  const source = buffers.publish[internal.activePublishIndex];
  const targetIndex = internal.activePublishIndex ^ 1;
  const target = buffers.publish[targetIndex];

  const visitedIndices: number[] = [];

  const visitIndex = (index: number): boolean => {
    const current = buffers.dirtyIndexPositions[index];
    if (current === SCRATCH_VISITED) {
      return false;
    }

    visitedIndices.push(index);
    buffers.dirtyIndexPositions[index] = SCRATCH_VISITED;
    return true;
  };

  for (let i = 0; i < source.dirtyCount; i += 1) {
    const index = source.dirtyIndices[i];
    if (visitIndex(index)) {
      target.tickDelta[index] = 0;
    }
  }

  for (let i = 0; i < internal.dirtyIndexCount; i += 1) {
    const index = buffers.dirtyIndexScratch[i];
    if (visitIndex(index)) {
      target.tickDelta[index] = 0;
    }
  }

  for (let i = 0; i < source.dirtyCount; i += 1) {
    const index = source.dirtyIndices[i];
    copyPublishField(target.amounts, source.amounts, index);
    copyPublishField(target.capacities, source.capacities, index);
    copyPublishField(target.incomePerSecond, source.incomePerSecond, index);
    copyPublishField(target.expensePerSecond, source.expensePerSecond, index);
    copyPublishField(target.netPerSecond, source.netPerSecond, index);
    target.flags[index] = source.flags[index] & ~FLAG_DIRTY_THIS_TICK;
    copyPublishField(target.dirtyTolerance, source.dirtyTolerance, index);
  }

  const nextDirtyCount = processCurrentDirtyIndices(internal, source, target);
  target.dirtyCount = nextDirtyCount;

  for (const index of visitedIndices) {
    buffers.dirtyIndexPositions[index] = SCRATCH_UNSET;
  }

  internal.dirtyIndexCount = 0;
  internal.activePublishIndex = targetIndex;

  clearDirtyBits(buffers.flags, visitedIndices);
  clearDirtyBits(target.flags, visitedIndices);

  internal.publishGuardState = PublishGuardState.Published;

  return {
    ids: buffers.ids,
    amounts: wrapSnapshotArray(target.amounts),
    capacities: wrapSnapshotArray(target.capacities),
    incomePerSecond: wrapSnapshotArray(target.incomePerSecond),
    expensePerSecond: wrapSnapshotArray(target.expensePerSecond),
    netPerSecond: wrapSnapshotArray(target.netPerSecond),
    tickDelta: wrapSnapshotArray(target.tickDelta),
    flags: wrapSnapshotArray(target.flags),
    dirtyTolerance: wrapSnapshotArray(target.dirtyTolerance),
    dirtyIndices: wrapSnapshotArray(target.dirtyIndices),
    dirtyCount: target.dirtyCount,
  };
}

function copyPublishField(
  target: Float64Array,
  source: Float64Array,
  index: number,
): void {
  target[index] = source[index];
}

function processCurrentDirtyIndices(
  internal: ResourceStateInternal,
  source: ResourcePublishBuffers,
  target: ResourcePublishBuffers,
): number {
  let nextDirtyCount = 0;

  for (let i = 0; i < internal.dirtyIndexCount; i += 1) {
    const index = internal.buffers.dirtyIndexScratch[i];
    const shouldPublish = isIndexDirtyAgainstPublish(internal, source, index);

    if (shouldPublish) {
      copyLiveToPublish(internal, target, index);
      target.dirtyIndices[nextDirtyCount] = index;
      nextDirtyCount += 1;
    }
  }

  return nextDirtyCount;
}

function isIndexDirtyAgainstPublish(
  internal: ResourceStateInternal,
  source: ResourcePublishBuffers,
  index: number,
): boolean {
  const tolerance = internal.buffers.dirtyTolerance[index];
  const { buffers } = internal;

  if (
    !epsilonEquals(
      buffers.amounts[index],
      source.amounts[index],
      tolerance,
      createEpsilonContext(internal, index, 'amount', tolerance),
    )
  ) {
    return true;
  }

  if (
    !epsilonEquals(
      buffers.capacities[index],
      source.capacities[index],
      tolerance,
      createEpsilonContext(internal, index, 'capacity', tolerance),
    )
  ) {
    return true;
  }

  if (
    !epsilonEquals(
      buffers.incomePerSecond[index],
      source.incomePerSecond[index],
      tolerance,
      createEpsilonContext(internal, index, 'incomePerSecond', tolerance),
    )
  ) {
    return true;
  }

  if (
    !epsilonEquals(
      buffers.expensePerSecond[index],
      source.expensePerSecond[index],
      tolerance,
      createEpsilonContext(internal, index, 'expensePerSecond', tolerance),
    )
  ) {
    return true;
  }

  if (
    !epsilonEquals(
      buffers.netPerSecond[index],
      source.netPerSecond[index],
      tolerance,
      createEpsilonContext(internal, index, 'netPerSecond', tolerance),
    )
  ) {
    return true;
  }

  if (
    !epsilonEquals(
      buffers.tickDelta[index],
      source.tickDelta[index],
      tolerance,
      createEpsilonContext(internal, index, 'tickDelta', tolerance),
    )
  ) {
    return true;
  }

  if (
    !epsilonEquals(
      buffers.dirtyTolerance[index],
      source.dirtyTolerance[index],
      DIRTY_EPSILON_ABSOLUTE,
    )
  ) {
    return true;
  }

  const liveFlags = buffers.flags[index] & ~(FLAG_DIRTY_THIS_TICK);
  const publishFlags = source.flags[index] & ~(FLAG_DIRTY_THIS_TICK);
  if (liveFlags !== publishFlags) {
    return true;
  }

  return false;
}

function copyLiveToPublish(
  internal: ResourceStateInternal,
  target: ResourcePublishBuffers,
  index: number,
): void {
  const { buffers } = internal;
  target.amounts[index] = buffers.amounts[index];
  target.capacities[index] = buffers.capacities[index];
  target.incomePerSecond[index] = buffers.incomePerSecond[index];
  target.expensePerSecond[index] = buffers.expensePerSecond[index];
  target.netPerSecond[index] = buffers.netPerSecond[index];
  target.tickDelta[index] = buffers.tickDelta[index];
  target.flags[index] = buffers.flags[index] & ~FLAG_DIRTY_THIS_TICK;
  target.dirtyTolerance[index] = buffers.dirtyTolerance[index];
}

function clearDirtyBits(flags: Uint8Array, indices: readonly number[]): void {
  for (const index of indices) {
    flags[index] &= ~FLAG_DIRTY_THIS_TICK;
  }
}

function exportForSave(
  internal: ResourceStateInternal,
): SerializedResourceState {
  const { buffers } = internal;
  const resourceCount = buffers.ids.length;

  const amounts: number[] = new Array(resourceCount);
  const capacities: (number | null)[] = new Array(resourceCount);
  const flags: number[] = new Array(resourceCount);
  const unlocked: boolean[] = new Array(resourceCount);
  const visible: boolean[] = new Array(resourceCount);

  for (let index = 0; index < resourceCount; index += 1) {
    amounts[index] = buffers.amounts[index];
    capacities[index] =
      buffers.capacities[index] === Number.POSITIVE_INFINITY
        ? null
        : buffers.capacities[index];
    flags[index] = buffers.flags[index];
    unlocked[index] = (buffers.flags[index] & FLAG_UNLOCKED) !== 0;
    visible[index] = (buffers.flags[index] & FLAG_VISIBLE) !== 0;
  }

  return {
    ids: buffers.ids,
    amounts,
    capacities,
    unlocked,
    visible,
    flags,
    definitionDigest: internal.definitionDigest,
  };
}

export function reconcileSaveAgainstDefinitions(
  serialized: SerializedResourceState,
  definitions: readonly ResourceDefinition[],
): ResourceDefinitionReconciliation {
  const expectedLength = serialized.ids.length;

  assertSerializedArrayLength('amounts', serialized.amounts.length, expectedLength);
  assertSerializedArrayLength('capacities', serialized.capacities.length, expectedLength);
  assertSerializedArrayLength('flags', serialized.flags.length, expectedLength);

  if (serialized.unlocked !== undefined) {
    assertSerializedArrayLength('unlocked', serialized.unlocked.length, expectedLength);
  }

  if (serialized.visible !== undefined) {
    assertSerializedArrayLength('visible', serialized.visible.length, expectedLength);
  }

  validateSerializedIds(serialized.ids);
  if (serialized.definitionDigest == null) {
    telemetry.recordWarning(TELEMETRY_HYDRATION_INVALID_DATA, {
      reason: 'missing-digest',
      ids: serialized.ids,
      recovery: 'reconstructed',
    });
  }

  const definitionDigest =
    serialized.definitionDigest ?? createDefinitionDigest(serialized.ids);
  validateDefinitionDigest(definitionDigest, serialized.ids);
  validateSerializedValues(serialized, expectedLength);

  const { liveIds, indexById } = buildDefinitionIndex(definitions);
  const remap: number[] = [];
  const removedIds: string[] = [];
  const savedIds = new Set<string>();
  const firstIndexById = new Map<string, number>();

  for (let index = 0; index < expectedLength; index += 1) {
    const id = serialized.ids[index];
    const firstIndex = firstIndexById.get(id);
    if (firstIndex !== undefined) {
      telemetry.recordError(TELEMETRY_HYDRATION_INVALID_DATA, {
        reason: 'duplicate-id',
        id,
        firstIndex,
        duplicateIndex: index,
      });
      throw new Error(`Serialized resource id "${id}" appears multiple times.`);
    }

    savedIds.add(id);
    firstIndexById.set(id, index);

    const liveIndex = indexById.get(id);
    if (liveIndex === undefined) {
      removedIds.push(id);
      continue;
    }

    remap.push(liveIndex);
  }

  const addedIds = liveIds.filter((id) => !savedIds.has(id));
  const expectedDigest = createDefinitionDigest(liveIds);
  const digestsMatch =
    definitionDigest.hash === expectedDigest.hash &&
    definitionDigest.version === expectedDigest.version;

  if (removedIds.length > 0) {
    telemetry.recordError(TELEMETRY_HYDRATION_MISMATCH, {
      addedIds,
      removedIds,
      expectedDigest,
      receivedDigest: definitionDigest,
    });
    throw new Error(
      'Serialized resource definitions are incompatible with live definitions.',
    );
  }

  if (addedIds.length > 0) {
    telemetry.recordProgress(TELEMETRY_HYDRATION_MISMATCH, {
      addedIds,
      removedIds,
      expectedDigest,
      receivedDigest: definitionDigest,
      reason: 'definitions-added',
    });
  }

  if (!digestsMatch) {
    telemetry.recordProgress(TELEMETRY_HYDRATION_MISMATCH, {
      addedIds,
      removedIds,
      expectedDigest,
      receivedDigest: definitionDigest,
      reason: 'digest-mismatch',
    });
  }

  return {
    remap: Object.freeze(remap),
    addedIds: Object.freeze(addedIds),
    removedIds: Object.freeze(removedIds),
    digestsMatch,
  };
}

function assertSerializedArrayLength(
  field: string,
  actual: number,
  expected: number,
): void {
  if (actual === expected) {
    return;
  }

  telemetry.recordError(TELEMETRY_SAVE_LENGTH_MISMATCH, {
    field,
    expected,
    actual,
  });
  throw new Error(
    `Serialized resource state field "${field}" length (${actual}) does not match ids length (${expected}).`,
  );
}

function validateSerializedIds(ids: readonly string[]): void {
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];
    if (typeof id !== 'string' || id.length === 0) {
      telemetry.recordError(TELEMETRY_HYDRATION_INVALID_DATA, {
        reason: 'invalid-id',
        index,
        value: id,
      });
      throw new Error('Serialized resource ids must be non-empty strings.');
    }
  }
}

function validateDefinitionDigest(
  digest: ResourceDefinitionDigest,
  ids: readonly string[],
): void {
  if (!Number.isInteger(digest.version) || digest.version < 0) {
    telemetry.recordError(TELEMETRY_HYDRATION_INVALID_DATA, {
      reason: 'invalid-digest-version',
      version: digest.version,
    });
    throw new Error('Serialized resource digest has an invalid version.');
  }

  if (digest.version !== ids.length) {
    telemetry.recordError(TELEMETRY_HYDRATION_INVALID_DATA, {
      reason: 'digest-version-mismatch',
      version: digest.version,
      idsLength: ids.length,
    });
    throw new Error('Serialized resource digest version does not match saved ids length.');
  }

  if (!arraysEqual(digest.ids, ids)) {
    telemetry.recordError(TELEMETRY_HYDRATION_INVALID_DATA, {
      reason: 'digest-ids-mismatch',
      digestIds: digest.ids,
      ids,
    });
    throw new Error('Serialized resource digest ids diverge from the saved ids.');
  }

  // Verify digest hash consistency to detect spoofed or corrupted digests
  const expectedHash = computeStableDigest(ids);
  if (digest.hash !== expectedHash) {
    telemetry.recordError(TELEMETRY_HYDRATION_INVALID_DATA, {
      reason: 'digest-hash-mismatch',
      digestHash: digest.hash,
      expectedHash,
    });
    throw new Error(
      `Serialized resource digest hash mismatch: expected "${expectedHash}" but got "${digest.hash}". ` +
      'This may indicate a corrupted or tampered save file.',
    );
  }
}

function validateSerializedValues(
  serialized: SerializedResourceState,
  expectedLength: number,
): void {
  for (let index = 0; index < expectedLength; index += 1) {
    const amount = serialized.amounts[index];
    if (!Number.isFinite(amount)) {
      telemetry.recordError(TELEMETRY_HYDRATION_INVALID_DATA, {
        reason: 'invalid-amount',
        index,
        value: amount,
      });
      throw new Error('Serialized resource amounts must be finite numbers.');
    }

    const capacity = serialized.capacities[index];
    if (
      capacity !== null &&
      (!Number.isFinite(capacity) || capacity < 0)
    ) {
      telemetry.recordError(TELEMETRY_HYDRATION_INVALID_DATA, {
        reason: 'invalid-capacity',
        index,
        value: capacity,
      });
      throw new Error(
        'Serialized resource capacities must be null or finite, non-negative numbers.',
      );
    }

    const flag = serialized.flags[index];
    if (!Number.isInteger(flag) || flag < 0 || flag > 0xff) {
      telemetry.recordError(TELEMETRY_HYDRATION_INVALID_DATA, {
        reason: 'invalid-flag',
        index,
        value: flag,
      });
      throw new Error('Serialized resource flags must be integers between 0 and 255.');
    }

    if (serialized.unlocked !== undefined) {
      const unlockedValue = serialized.unlocked[index];
      if (typeof unlockedValue !== 'boolean') {
        telemetry.recordError(TELEMETRY_HYDRATION_INVALID_DATA, {
          reason: 'invalid-unlocked',
          index,
          value: unlockedValue,
        });
        throw new Error(
          'Serialized resource unlocked values must be boolean when provided.',
        );
      }
    }

    if (serialized.visible !== undefined) {
      const visibleValue = serialized.visible[index];
      if (typeof visibleValue !== 'boolean') {
        telemetry.recordError(TELEMETRY_HYDRATION_INVALID_DATA, {
          reason: 'invalid-visible',
          index,
          value: visibleValue,
        });
        throw new Error(
          'Serialized resource visible values must be boolean when provided.',
        );
      }
    }
  }
}

function buildDefinitionIndex(
  definitions: readonly ResourceDefinition[],
): {
  readonly liveIds: readonly string[];
  readonly indexById: Map<string, number>;
} {
  const liveIds: string[] = new Array(definitions.length);
  const indexById = new Map<string, number>();
  const seenIds = new Set<string>();

  for (let index = 0; index < definitions.length; index += 1) {
    const definition = definitions[index];
    const id = definition?.id;

    if (!id) {
      telemetry.recordError('ResourceDefinitionMissingId', {
        index,
      });
      throw new Error(`Resource definition at index ${index} is missing an id.`);
    }

    if (seenIds.has(id)) {
      telemetry.recordError('ResourceDefinitionDuplicateId', {
        id,
      });
      throw new Error(`Resource definition with id "${id}" is duplicated.`);
    }

    seenIds.add(id);
    liveIds[index] = id;
    indexById.set(id, index);
  }

  return {
    liveIds,
    indexById,
  };
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  if (left === right) {
    return true;
  }

  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function writeFloatField(
  internal: ResourceStateInternal,
  field: Float64Array,
  selectPublishField: FloatFieldSelector,
  index: number,
  nextValue: number,
  fieldName: ResourceFloatField,
): void {
  const currentValue = field[index];
  if (Object.is(currentValue, nextValue)) {
    return;
  }

  field[index] = nextValue;
  reconcileDirtyState(
    internal,
    index,
    nextValue,
    selectPublishField(internal.buffers.publish[internal.activePublishIndex])[index],
    fieldName,
  );
}

function setFlagField(
  internal: ResourceStateInternal,
  index: number,
  mask: number,
  shouldSet: boolean,
): void {
  assertValidIndex(internal, index);
  const { buffers } = internal;
  const previous = buffers.flags[index];
  const next = shouldSet ? previous | mask : previous & ~mask;

  if (previous === next) {
    return;
  }

  buffers.flags[index] = next;
  const publishFlags =
    internal.buffers.publish[internal.activePublishIndex].flags[index];

  reconcileDirtyState(
    internal,
    index,
    next & ~FLAG_DIRTY_THIS_TICK,
    publishFlags & ~FLAG_DIRTY_THIS_TICK,
    'flags',
  );
}

function createEpsilonContext(
  internal: ResourceStateInternal,
  index: number,
  field: ResourceFloatField,
  tolerance: number,
): EpsilonTelemetryContext | undefined {
  const resourceId = internal.buffers.ids[index];
  if (resourceId === undefined) {
    return undefined;
  }

  return {
    resourceId,
    field,
    hasOverride: !Object.is(tolerance, DIRTY_EPSILON_CEILING),
  };
}

function reconcileDirtyState(
  internal: ResourceStateInternal,
  index: number,
  liveValue: number,
  publishedValue: number,
  field: ResourceFloatField,
): void {
  const tolerance = internal.buffers.dirtyTolerance[index];
  if (
    !epsilonEquals(
      liveValue,
      publishedValue,
      tolerance,
      createEpsilonContext(internal, index, field, tolerance),
    )
  ) {
    markDirty(internal, index);
    return;
  }

  unmarkIfClean(internal, index);
}

function markDirty(
  internal: ResourceStateInternal,
  index: number,
): void {
  const { buffers } = internal;
  const currentPosition = buffers.dirtyIndexPositions[index];
  buffers.flags[index] |= FLAG_DIRTY_THIS_TICK;

  if (currentPosition >= 0) {
    return;
  }

  const position = internal.dirtyIndexCount;
  buffers.dirtyIndexScratch[position] = index;
  buffers.dirtyIndexPositions[index] = position;
  internal.dirtyIndexCount += 1;
}

function unmarkIfClean(
  internal: ResourceStateInternal,
  index: number,
): void {
  if (!isIndexClean(internal, index)) {
    return;
  }

  const { buffers } = internal;
  const position = buffers.dirtyIndexPositions[index];
  if (position >= 0) {
    const lastIndex = internal.dirtyIndexCount - 1;
    const swapIndex = buffers.dirtyIndexScratch[lastIndex];
    buffers.dirtyIndexScratch[position] = swapIndex;
    buffers.dirtyIndexPositions[swapIndex] = position;
    buffers.dirtyIndexPositions[index] = SCRATCH_UNSET;
    internal.dirtyIndexCount -= 1;
  }

  buffers.flags[index] &= ~FLAG_DIRTY_THIS_TICK;
}

function isIndexClean(
  internal: ResourceStateInternal,
  index: number,
): boolean {
  const source = internal.buffers.publish[internal.activePublishIndex];
  const tolerance = internal.buffers.dirtyTolerance[index];
  const { buffers } = internal;

  if (
    !epsilonEquals(
      buffers.amounts[index],
      source.amounts[index],
      tolerance,
      createEpsilonContext(internal, index, 'amount', tolerance),
    )
  ) {
    return false;
  }

  if (
    !epsilonEquals(
      buffers.capacities[index],
      source.capacities[index],
      tolerance,
      createEpsilonContext(internal, index, 'capacity', tolerance),
    )
  ) {
    return false;
  }

  if (
    !epsilonEquals(
      buffers.incomePerSecond[index],
      source.incomePerSecond[index],
      tolerance,
      createEpsilonContext(internal, index, 'incomePerSecond', tolerance),
    )
  ) {
    return false;
  }

  if (
    !epsilonEquals(
      buffers.expensePerSecond[index],
      source.expensePerSecond[index],
      tolerance,
      createEpsilonContext(internal, index, 'expensePerSecond', tolerance),
    )
  ) {
    return false;
  }

  if (
    !epsilonEquals(
      buffers.netPerSecond[index],
      source.netPerSecond[index],
      tolerance,
      createEpsilonContext(internal, index, 'netPerSecond', tolerance),
    )
  ) {
    return false;
  }

  if (
    !epsilonEquals(
      buffers.tickDelta[index],
      source.tickDelta[index],
      tolerance,
      createEpsilonContext(internal, index, 'tickDelta', tolerance),
    )
  ) {
    return false;
  }

  if (
    !epsilonEquals(
      buffers.dirtyTolerance[index],
      source.dirtyTolerance[index],
      DIRTY_EPSILON_ABSOLUTE,
    )
  ) {
    return false;
  }

  if (
    (buffers.flags[index] & ~FLAG_DIRTY_THIS_TICK) !==
    (source.flags[index] & ~FLAG_DIRTY_THIS_TICK)
  ) {
    return false;
  }

  return true;
}

function accumulateTickDelta(
  internal: ResourceStateInternal,
  index: number,
  delta: number,
): void {
  if (delta === 0) {
    return;
  }

  const { buffers } = internal;
  const previous = buffers.tickDelta[index];
  const next = previous + delta;
  const tolerance = buffers.dirtyTolerance[index];
  const context = createEpsilonContext(internal, index, 'tickDelta', tolerance);
  const resolved = epsilonEquals(
    next,
    0,
    tolerance,
    context,
    { floorToleranceOverride: false },
  )
    ? 0
    : next;

  if (Object.is(previous, resolved)) {
    return;
  }

  buffers.tickDelta[index] = resolved;
  reconcileDirtyState(
    internal,
    index,
    resolved,
    internal.buffers.publish[internal.activePublishIndex].tickDelta[index],
    'tickDelta',
  );
}

function clampAmount(amount: number, capacity: number): number {
  if (amount < 0) {
    return 0;
  }

  if (amount > capacity) {
    return capacity;
  }

  return amount;
}

function epsilonEquals(
  a: number,
  b: number,
  toleranceCeiling: number,
  context?: EpsilonTelemetryContext,
  options?: EpsilonEqualsOptions,
): boolean {
  if (Object.is(a, b)) {
    return true;
  }

  const difference = Math.abs(a - b);
  if (Number.isNaN(difference)) {
    return false;
  }

  const magnitude = Math.max(Math.abs(a), Math.abs(b));
  const relativeTolerance = DIRTY_EPSILON_RELATIVE * magnitude;
  const clampedRelative = Math.min(toleranceCeiling, relativeTolerance);
  const tolerance = Math.max(
    DIRTY_EPSILON_ABSOLUTE,
    clampedRelative,
  );
  const hasOverride = context?.hasOverride === true;
  const shouldFloorOverride = options?.floorToleranceOverride ?? hasOverride;
  const effectiveTolerance = shouldFloorOverride
    ? Math.max(tolerance, toleranceCeiling)
    : tolerance;

  if (
    context?.hasOverride &&
    Number.isFinite(relativeTolerance) &&
    Number.isFinite(toleranceCeiling) &&
    relativeTolerance > toleranceCeiling
  ) {
    telemetry.recordWarning(TELEMETRY_DIRTY_TOLERANCE_SATURATED, {
      resourceId: context.resourceId,
      field: context.field,
      difference,
      toleranceCeiling,
      relativeTolerance,
      magnitude,
    });
  }

  return difference <= effectiveTolerance;
}

/**
 * Creates a resource definition digest from an ordered list of resource IDs.
 * The digest includes the IDs, version (count), and FNV-1a hash.
 *
 * @param ids - Ordered resource IDs
 * @returns Resource definition digest
 */
export function createDefinitionDigest(
  ids: readonly string[],
): ResourceDefinitionDigest {
  return {
    ids,
    version: ids.length,
    hash: computeStableDigest(ids),
  };
}

/**
 * Computes FNV-1a hash of resource IDs for content digest.
 * Hash includes ID separators (0xff) to distinguish ['ab'] from ['a', 'b'].
 *
 * @param ids - Ordered resource IDs
 * @returns Hash string in format "fnv1a-{hex}"
 */
export function computeStableDigest(ids: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const id of ids) {
    for (let i = 0; i < id.length; i += 1) {
      hash ^= id.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
      hash >>>= 0;
    }
    hash ^= 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash >>>= 0;
  }
  return `fnv1a-${hash.toString(16).padStart(8, '0')}`;
}

function wrapSnapshotArray<TArray extends Float64Array | Uint8Array | Uint32Array>(
  array: TArray,
): TArray {
  return shouldGuardSnapshots()
    ? (createImmutableTypedArrayView(array) as unknown as TArray)
    : array;
}

function shouldGuardSnapshots(): boolean {
  const mode = getSnapshotGuardMode();
  if (mode === 'force-on') {
    return true;
  }
  if (mode === 'force-off') {
    return false;
  }

  return getNodeEnv() !== 'production';
}

function getSnapshotGuardMode(): SnapshotGuardMode {
  const globalObject = globalThis as {
    readonly process?: {
      readonly env?: Record<string, string | undefined>;
    };
  };

  const envValue = globalObject.process?.env?.[SNAPSHOT_GUARD_ENV_KEY];
  if (envValue === 'force-on' || envValue === 'force-off' || envValue === 'auto') {
    return envValue;
  }

  return 'auto';
}

function getNodeEnv(): string | undefined {
  const globalObject = globalThis as {
    readonly process?: {
      readonly env?: Record<string, string | undefined>;
    };
  };
  return globalObject.process?.env?.NODE_ENV;
}
