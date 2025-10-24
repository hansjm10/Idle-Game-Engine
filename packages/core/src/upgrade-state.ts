import {
  createImmutableTypedArrayView,
  type ImmutableMapSnapshot,
  type ImmutableTypedArraySnapshot,
} from './immutable-snapshots.js';
import { telemetry } from './telemetry.js';

const TELEMETRY_MISSING_ID = 'UpgradeDefinitionMissingId';
const TELEMETRY_DUPLICATE_ID = 'UpgradeDefinitionDuplicateId';
const TELEMETRY_INVALID_PURCHASE_COUNT = 'UpgradePurchaseCountInvalid';
const TELEMETRY_INVALID_MAX_PURCHASES = 'UpgradeMaxPurchasesInvalid';

const SCRATCH_UNSET = -1;

export interface UpgradeDefinition {
  readonly id: string;
  readonly unlocked?: boolean;
  readonly visible?: boolean;
  readonly purchased?: boolean;
  readonly purchaseCount?: number;
  readonly maxPurchases?: number;
}

export interface NormalizedUpgradeRecord {
  readonly id: string;
  readonly purchaseCount: number;
  readonly purchaseDelta: number;
  readonly maxPurchases: number | null;
  readonly unlocked: boolean;
  readonly visible: boolean;
}

export interface UpgradeStateSnapshot {
  readonly ids: readonly string[];
  readonly indices: ImmutableTypedArraySnapshot<Uint32Array>;
  readonly purchaseCount: ImmutableTypedArraySnapshot<Uint32Array>;
  readonly purchaseDelta: ImmutableTypedArraySnapshot<Int32Array>;
  readonly unlocked: ImmutableTypedArraySnapshot<Uint8Array>;
  readonly visible: ImmutableTypedArraySnapshot<Uint8Array>;
  readonly dirtyCount: number;
}

export interface UpgradeStateView {
  readonly ids: readonly string[];
  readonly indexById: ImmutableMapSnapshot<string, number>;
  readonly purchaseCount: ImmutableTypedArraySnapshot<Uint32Array>;
  readonly purchaseDelta: ImmutableTypedArraySnapshot<Int32Array>;
  readonly unlocked: ImmutableTypedArraySnapshot<Uint8Array>;
  readonly visible: ImmutableTypedArraySnapshot<Uint8Array>;
  readonly maxPurchases: ImmutableTypedArraySnapshot<Uint32Array>;
}

export interface SerializedUpgradeState {
  readonly ids: readonly string[];
  readonly purchaseCount: readonly number[];
  readonly unlocked?: readonly boolean[];
  readonly visible?: readonly boolean[];
}

export interface UpgradeState {
  getIndex(id: string): number | undefined;
  requireIndex(id: string): number;
  getPurchaseCount(index: number): number;
  getMaxPurchases(index: number): number | null;
  purchase(index: number, count?: number): number;
  setPurchaseCount(index: number, count: number): number;
  resetPurchaseCount(index: number): void;
  isPurchased(index: number): boolean;
  isUnlocked(index: number): boolean;
  unlock(index: number): void;
  lock(index: number): void;
  isVisible(index: number): boolean;
  reveal(index: number): void;
  hide(index: number): void;
  snapshot(): UpgradeStateSnapshot;
  view(): UpgradeStateView;
  exportForSave(): SerializedUpgradeState;
  clearDirty(): void;
  collectRecords(): NormalizedUpgradeRecord[];
}

interface UpgradeStateBuffers {
  ids: readonly string[];
  indexById: ImmutableMapSnapshot<string, number>;
  purchaseCount: Uint32Array;
  purchaseDelta: Int32Array;
  unlocked: Uint8Array;
  visible: Uint8Array;
  maxPurchases: Uint32Array;
  dirtyIndices: Uint32Array;
  dirtyPositions: Int32Array;
}

interface UpgradePublishBuffers {
  indices: Uint32Array;
  purchaseCount: Uint32Array;
  purchaseDelta: Int32Array;
  unlocked: Uint8Array;
  visible: Uint8Array;
}

interface UpgradeStateInternal {
  buffers: UpgradeStateBuffers;
  publish: [UpgradePublishBuffers, UpgradePublishBuffers];
  activePublishIndex: number;
  dirtyCount: number;
}

const upgradeStateInternals = new WeakMap<UpgradeState, UpgradeStateInternal>();

export function createUpgradeState(definitions: readonly UpgradeDefinition[]): UpgradeState {
  const total = definitions.length;
  const ids: string[] = new Array(total);
  const indexMap = new Map<string, number>();
  const seen = new Set<string>();

  for (let index = 0; index < total; index += 1) {
    const definition = definitions[index];
    const id = definition?.id;
    if (!id) {
      telemetry.recordError(TELEMETRY_MISSING_ID, { index });
      throw new Error(`Upgrade definition at index ${index} is missing an id.`);
    }
    if (seen.has(id)) {
      telemetry.recordError(TELEMETRY_DUPLICATE_ID, { id });
      throw new Error(`Upgrade definition with id "${id}" is duplicated.`);
    }
    seen.add(id);
    ids[index] = id;
    indexMap.set(id, index);
  }

  const immutableIds = Object.freeze([...ids]);
  const indexById = createImmutableIndexMap(indexMap);

  const purchaseCount = new Uint32Array(total);
  const purchaseDelta = new Int32Array(total);
  const unlocked = new Uint8Array(total);
  const visible = new Uint8Array(total);
  const maxPurchases = new Uint32Array(total);

  const dirtyIndices = new Uint32Array(Math.max(1, total));
  const dirtyPositions = new Int32Array(total);
  dirtyPositions.fill(SCRATCH_UNSET);

  for (let index = 0; index < total; index += 1) {
    const definition = definitions[index];
    const max = sanitizeMaxPurchases(definition.maxPurchases, definition.id);
    const initialCount = sanitizePurchaseCount(
      definition.purchaseCount,
      definition.purchased,
      max,
      definition.id,
    );

    purchaseCount[index] = initialCount;
    purchaseDelta[index] = 0;
    unlocked[index] = definition.unlocked === false ? 0 : 1;
    visible[index] = definition.visible === false ? 0 : 1;
    maxPurchases[index] = max;
  }

  const publishBuffers: [UpgradePublishBuffers, UpgradePublishBuffers] = [
    createPublishBuffers(),
    createPublishBuffers(),
  ];

  const buffers: UpgradeStateBuffers = {
    ids: immutableIds,
    indexById,
    purchaseCount,
    purchaseDelta,
    unlocked,
    visible,
    maxPurchases,
    dirtyIndices,
    dirtyPositions,
  };

  const internal: UpgradeStateInternal = {
    buffers,
    publish: publishBuffers,
    activePublishIndex: 0,
    dirtyCount: 0,
  };

  const api: UpgradeState = {
    getIndex: (id) => internal.buffers.indexById.get(id),
    requireIndex: (id) => requireIndex(internal, id),
    getPurchaseCount: (index) => getPurchaseCount(internal, index),
    getMaxPurchases: (index) => getMaxPurchases(internal, index),
    purchase: (index, count) => purchase(internal, index, count ?? 1),
    setPurchaseCount: (index, count) => setPurchaseCount(internal, index, count),
    resetPurchaseCount: (index) => setPurchaseCount(internal, index, 0),
    isPurchased: (index) => getPurchaseCount(internal, index) > 0,
    isUnlocked: (index) => getBoolean(internal.buffers.unlocked, index),
    unlock: (index) => setBoolean(internal, internal.buffers.unlocked, index, true),
    lock: (index) => setBoolean(internal, internal.buffers.unlocked, index, false),
    isVisible: (index) => getBoolean(internal.buffers.visible, index),
    reveal: (index) => setBoolean(internal, internal.buffers.visible, index, true),
    hide: (index) => setBoolean(internal, internal.buffers.visible, index, false),
    snapshot: () => snapshot(internal),
    view: () => createView(internal),
    exportForSave: () => exportForSave(internal),
    clearDirty: () => clearDirty(internal),
    collectRecords: () => collectRecords(internal),
  };

  upgradeStateInternals.set(api, internal);
  return api;
}

function requireIndex(internal: UpgradeStateInternal, id: string): number {
  const index = internal.buffers.indexById.get(id);
  if (index === undefined) {
    throw new Error(`Upgrade "${id}" is not registered in the state graph.`);
  }
  return index;
}

function getPurchaseCount(internal: UpgradeStateInternal, index: number): number {
  assertValidIndex(internal, index);
  return internal.buffers.purchaseCount[index];
}

function getMaxPurchases(internal: UpgradeStateInternal, index: number): number | null {
  assertValidIndex(internal, index);
  const max = internal.buffers.maxPurchases[index];
  return max === 0 ? null : max;
}

function purchase(internal: UpgradeStateInternal, index: number, count: number): number {
  if (!Number.isFinite(count) || count <= 0) {
    telemetry.recordError(TELEMETRY_INVALID_PURCHASE_COUNT, {
      reason: 'purchase-invalid-count',
      index,
      count,
    });
    throw new Error('Upgrade purchases must be positive finite integers.');
  }
  const integerCount = Math.trunc(count);
  const max = internal.buffers.maxPurchases[index];
  const current = getPurchaseCount(internal, index);
  const target = max > 0 ? Math.min(current + integerCount, max) : current + integerCount;
  if (target === current) {
    return current;
  }
  return setPurchaseCount(internal, index, target);
}

function setPurchaseCount(internal: UpgradeStateInternal, index: number, count: number): number {
  assertValidIndex(internal, index);
  if (!Number.isFinite(count) || count < 0) {
    telemetry.recordError(TELEMETRY_INVALID_PURCHASE_COUNT, {
      reason: 'set-invalid',
      index,
      count,
    });
    throw new Error('Upgrade purchase counts must be finite non-negative numbers.');
  }
  const integerCount = Math.trunc(count);
  const max = internal.buffers.maxPurchases[index];
  const bounded = max > 0 ? Math.min(integerCount, max) : integerCount;
  const current = internal.buffers.purchaseCount[index];
  if (current === bounded) {
    return current;
  }
  internal.buffers.purchaseCount[index] = bounded;
  internal.buffers.purchaseDelta[index] += bounded - current;
  markDirty(internal, index);
  return bounded;
}

function getBoolean(array: Uint8Array, index: number): boolean {
  return array[index] === 1;
}

function setBoolean(
  internal: UpgradeStateInternal,
  array: Uint8Array,
  index: number,
  value: boolean,
): void {
  assertValidIndex(internal, index);
  const resolved = value ? 1 : 0;
  if (array[index] === resolved) {
    return;
  }
  array[index] = resolved;
  markDirty(internal, index);
}

function snapshot(internal: UpgradeStateInternal): UpgradeStateSnapshot {
  const dirtyCount = internal.dirtyCount;
  const publish = swapPublishBuffers(internal);
  ensurePublishCapacity(publish, dirtyCount);

  const { buffers } = internal;
  for (let position = 0; position < dirtyCount; position += 1) {
    const index = buffers.dirtyIndices[position];
    publish.indices[position] = index;
    publish.purchaseCount[position] = buffers.purchaseCount[index];
    publish.purchaseDelta[position] = buffers.purchaseDelta[index];
    publish.unlocked[position] = buffers.unlocked[index];
    publish.visible[position] = buffers.visible[index];
    buffers.purchaseDelta[index] = 0;
    buffers.dirtyPositions[index] = SCRATCH_UNSET;
  }

  const snapshotResult: UpgradeStateSnapshot = {
    ids: buffers.ids,
    dirtyCount,
    indices: createImmutableTypedArrayView(publish.indices.subarray(0, dirtyCount)),
    purchaseCount: createImmutableTypedArrayView(publish.purchaseCount.subarray(0, dirtyCount)),
    purchaseDelta: createImmutableTypedArrayView(publish.purchaseDelta.subarray(0, dirtyCount)),
    unlocked: createImmutableTypedArrayView(publish.unlocked.subarray(0, dirtyCount)),
    visible: createImmutableTypedArrayView(publish.visible.subarray(0, dirtyCount)),
  };

  internal.dirtyCount = 0;
  return snapshotResult;
}

function createView(internal: UpgradeStateInternal): UpgradeStateView {
  const { buffers } = internal;
  return {
    ids: buffers.ids,
    indexById: buffers.indexById,
    purchaseCount: createImmutableTypedArrayView(buffers.purchaseCount),
    purchaseDelta: createImmutableTypedArrayView(buffers.purchaseDelta),
    unlocked: createImmutableTypedArrayView(buffers.unlocked),
    visible: createImmutableTypedArrayView(buffers.visible),
    maxPurchases: createImmutableTypedArrayView(buffers.maxPurchases),
  };
}

function exportForSave(internal: UpgradeStateInternal): SerializedUpgradeState {
  const { buffers } = internal;
  return {
    ids: buffers.ids,
    purchaseCount: Array.from(buffers.purchaseCount, (value) => value),
    unlocked: Array.from(buffers.unlocked, (value) => value === 1),
    visible: Array.from(buffers.visible, (value) => value === 1),
  };
}

function clearDirty(internal: UpgradeStateInternal): void {
  const { buffers } = internal;
  const dirtyCount = internal.dirtyCount;
  for (let position = 0; position < dirtyCount; position += 1) {
    const index = buffers.dirtyIndices[position];
    buffers.purchaseDelta[index] = 0;
    buffers.dirtyPositions[index] = SCRATCH_UNSET;
  }
  internal.dirtyCount = 0;
}

function collectRecords(internal: UpgradeStateInternal): NormalizedUpgradeRecord[] {
  const { buffers } = internal;
  const records: NormalizedUpgradeRecord[] = new Array(buffers.ids.length);
  for (let index = 0; index < buffers.ids.length; index += 1) {
    records[index] = {
      id: buffers.ids[index],
      purchaseCount: buffers.purchaseCount[index],
      purchaseDelta: buffers.purchaseDelta[index],
      maxPurchases: buffers.maxPurchases[index] === 0 ? null : buffers.maxPurchases[index],
      unlocked: buffers.unlocked[index] === 1,
      visible: buffers.visible[index] === 1,
    };
  }
  return records;
}

function swapPublishBuffers(internal: UpgradeStateInternal): UpgradePublishBuffers {
  const nextIndex = internal.activePublishIndex ^ 1;
  internal.activePublishIndex = nextIndex;
  return internal.publish[nextIndex];
}

function ensurePublishCapacity(buffers: UpgradePublishBuffers, required: number): void {
  const capacity = buffers.indices.length;
  if (capacity >= required) {
    return;
  }
  const nextCapacity = nextPowerOfTwo(required);
  buffers.indices = new Uint32Array(nextCapacity);
  buffers.purchaseCount = new Uint32Array(nextCapacity);
  buffers.purchaseDelta = new Int32Array(nextCapacity);
  buffers.unlocked = new Uint8Array(nextCapacity);
  buffers.visible = new Uint8Array(nextCapacity);
}

function createPublishBuffers(): UpgradePublishBuffers {
  return {
    indices: new Uint32Array(1),
    purchaseCount: new Uint32Array(1),
    purchaseDelta: new Int32Array(1),
    unlocked: new Uint8Array(1),
    visible: new Uint8Array(1),
  };
}

function nextPowerOfTwo(value: number): number {
  if (value <= 1) {
    return 1;
  }
  return 2 ** Math.ceil(Math.log2(value));
}

function sanitizeMaxPurchases(maxPurchases: number | undefined, id: string | undefined): number {
  if (maxPurchases === undefined) {
    return 0;
  }
  if (!Number.isFinite(maxPurchases) || maxPurchases <= 0) {
    telemetry.recordError(TELEMETRY_INVALID_MAX_PURCHASES, {
      id,
      value: maxPurchases,
    });
    throw new Error('Upgrade maxPurchases must be a positive finite number when provided.');
  }
  return Math.trunc(maxPurchases);
}

function sanitizePurchaseCount(
  purchaseCount: number | undefined,
  purchased: boolean | undefined,
  maxPurchases: number,
  id: string | undefined,
): number {
  if (purchaseCount === undefined) {
    if (purchased === true) {
      return maxPurchases > 0 ? Math.min(1, maxPurchases) : 1;
    }
    return 0;
  }
  if (!Number.isFinite(purchaseCount) || purchaseCount < 0) {
    telemetry.recordError(TELEMETRY_INVALID_PURCHASE_COUNT, {
      reason: 'initial-invalid',
      id,
      value: purchaseCount,
    });
    throw new Error('Upgrade purchaseCount must be a finite non-negative number when provided.');
  }
  const truncated = Math.trunc(purchaseCount);
  if (maxPurchases > 0 && truncated > maxPurchases) {
    return maxPurchases;
  }
  return truncated;
}

function markDirty(internal: UpgradeStateInternal, index: number): void {
  const position = internal.buffers.dirtyPositions[index];
  if (position !== SCRATCH_UNSET) {
    return;
  }
  const nextPosition = internal.dirtyCount;
  internal.buffers.dirtyIndices[nextPosition] = index;
  internal.buffers.dirtyPositions[index] = nextPosition;
  internal.dirtyCount += 1;
}

function assertValidIndex(internal: UpgradeStateInternal, index: number): void {
  if (index < 0 || index >= internal.buffers.ids.length) {
    throw new RangeError(`Upgrade index ${index} is out of bounds.`);
  }
}

function createImmutableIndexMap(
  map: Map<string, number>,
): ImmutableMapSnapshot<string, number> {
  const immutable = new Map(map);
  return new Proxy(immutable, {
    get(target, property, receiver) {
      if (property === 'set' || property === 'delete' || property === 'clear') {
        return () => {
          throw new Error('UpgradeState index map is immutable once created.');
        };
      }
      const result = Reflect.get(target, property, receiver);
      return typeof result === 'function' ? result.bind(target) : result;
    },
  }) as ImmutableMapSnapshot<string, number>;
}
