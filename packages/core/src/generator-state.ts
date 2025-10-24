import {
  createImmutableTypedArrayView,
  type ImmutableMapSnapshot,
  type ImmutableTypedArraySnapshot,
} from './immutable-snapshots.js';
import { telemetry } from './telemetry.js';

const TELEMETRY_MISSING_ID = 'GeneratorDefinitionMissingId';
const TELEMETRY_DUPLICATE_ID = 'GeneratorDefinitionDuplicateId';
const TELEMETRY_INVALID_LEVEL = 'GeneratorLevelInvalid';
const TELEMETRY_INVALID_MAX_LEVEL = 'GeneratorMaxLevelInvalid';

const SCRATCH_UNSET = -1;

export interface GeneratorDefinition {
  readonly id: string;
  readonly startLevel?: number;
  readonly maxLevel?: number;
  readonly unlocked?: boolean;
  readonly visible?: boolean;
  readonly enabled?: boolean;
}

export interface NormalizedGeneratorRecord {
  readonly id: string;
  readonly level: number;
  readonly levelDelta: number;
  readonly unlocked: boolean;
  readonly visible: boolean;
  readonly enabled: boolean;
}

export interface GeneratorStateSnapshot {
  readonly ids: readonly string[];
  readonly indices: ImmutableTypedArraySnapshot<Uint32Array>;
  readonly levels: ImmutableTypedArraySnapshot<Uint32Array>;
  readonly levelDelta: ImmutableTypedArraySnapshot<Int32Array>;
  readonly unlocked: ImmutableTypedArraySnapshot<Uint8Array>;
  readonly visible: ImmutableTypedArraySnapshot<Uint8Array>;
  readonly enabled: ImmutableTypedArraySnapshot<Uint8Array>;
  readonly dirtyCount: number;
}

export interface GeneratorStateView {
  readonly ids: readonly string[];
  readonly indexById: ImmutableMapSnapshot<string, number>;
  readonly levels: ImmutableTypedArraySnapshot<Uint32Array>;
  readonly levelDelta: ImmutableTypedArraySnapshot<Int32Array>;
  readonly unlocked: ImmutableTypedArraySnapshot<Uint8Array>;
  readonly visible: ImmutableTypedArraySnapshot<Uint8Array>;
  readonly enabled: ImmutableTypedArraySnapshot<Uint8Array>;
}

export interface SerializedGeneratorState {
  readonly ids: readonly string[];
  readonly levels: readonly number[];
  readonly unlocked?: readonly boolean[];
  readonly visible?: readonly boolean[];
  readonly enabled?: readonly boolean[];
}

export interface GeneratorState {
  getIndex(id: string): number | undefined;
  requireIndex(id: string): number;
  getLevel(index: number): number;
  getMaxLevel(index: number): number;
  setLevel(index: number, level: number): number;
  adjustLevel(index: number, delta: number): number;
  isUnlocked(index: number): boolean;
  unlock(index: number): void;
  lock(index: number): void;
  isVisible(index: number): boolean;
  reveal(index: number): void;
  hide(index: number): void;
  isEnabled(index: number): boolean;
  setEnabled(index: number, enabled: boolean): void;
  snapshot(): GeneratorStateSnapshot;
  view(): GeneratorStateView;
  exportForSave(): SerializedGeneratorState;
  clearDirty(): void;
  collectRecords(): NormalizedGeneratorRecord[];
}

interface GeneratorStateBuffers {
  ids: readonly string[];
  indexById: ImmutableMapSnapshot<string, number>;
  levels: Uint32Array;
  levelDelta: Int32Array;
  unlocked: Uint8Array;
  visible: Uint8Array;
  enabled: Uint8Array;
  maxLevel: Uint32Array;
  dirtyIndices: Uint32Array;
  dirtyPositions: Int32Array;
}

interface GeneratorPublishBuffers {
  indices: Uint32Array;
  levels: Uint32Array;
  levelDelta: Int32Array;
  unlocked: Uint8Array;
  visible: Uint8Array;
  enabled: Uint8Array;
}

interface GeneratorStateInternal {
  buffers: GeneratorStateBuffers;
  publish: [GeneratorPublishBuffers, GeneratorPublishBuffers];
  activePublishIndex: number;
  dirtyCount: number;
}

const generatorStateInternals = new WeakMap<GeneratorState, GeneratorStateInternal>();

export function createGeneratorState(
  definitions: readonly GeneratorDefinition[],
): GeneratorState {
  const total = definitions.length;
  const ids: string[] = new Array(total);
  const indexMap = new Map<string, number>();
  const seen = new Set<string>();

  for (let index = 0; index < total; index += 1) {
    const definition = definitions[index];
    const id = definition?.id;
    if (!id) {
      telemetry.recordError(TELEMETRY_MISSING_ID, { index });
      throw new Error(`Generator definition at index ${index} is missing an id.`);
    }

    if (seen.has(id)) {
      telemetry.recordError(TELEMETRY_DUPLICATE_ID, { id });
      throw new Error(`Generator definition with id "${id}" is duplicated.`);
    }

    seen.add(id);
    ids[index] = id;
    indexMap.set(id, index);
  }

  const immutableIds = Object.freeze([...ids]);
  const indexById = createImmutableIndexMap(indexMap);

  const levels = new Uint32Array(total);
  const levelDelta = new Int32Array(total);
  const unlocked = new Uint8Array(total);
  const visible = new Uint8Array(total);
  const enabled = new Uint8Array(total);
  const maxLevel = new Uint32Array(total);

  const dirtyIndices = new Uint32Array(Math.max(1, total));
  const dirtyPositions = new Int32Array(total);
  dirtyPositions.fill(SCRATCH_UNSET);

  for (let index = 0; index < total; index += 1) {
    const definition = definitions[index];
    const max = sanitizeMaxLevel(definition.maxLevel, definition.id);
    const initialLevel = sanitizeStartLevel(definition.startLevel, max, definition.id);

    levels[index] = initialLevel;
    levelDelta[index] = 0;
    unlocked[index] = definition.unlocked === false ? 0 : 1;
    visible[index] = definition.visible === false ? 0 : 1;
    enabled[index] = definition.enabled === true ? 1 : 0;
    maxLevel[index] = max;
  }

  const publishBuffers: [GeneratorPublishBuffers, GeneratorPublishBuffers] = [
    createPublishBuffers(),
    createPublishBuffers(),
  ];

  const buffers: GeneratorStateBuffers = {
    ids: immutableIds,
    indexById,
    levels,
    levelDelta,
    unlocked,
    visible,
    enabled,
    maxLevel,
    dirtyIndices,
    dirtyPositions,
  };

  const internal: GeneratorStateInternal = {
    buffers,
    publish: publishBuffers,
    activePublishIndex: 0,
    dirtyCount: 0,
  };

  const api: GeneratorState = {
    getIndex: (id) => internal.buffers.indexById.get(id),
    requireIndex: (id) => requireIndex(internal, id),
    getLevel: (index) => getLevel(internal, index),
    getMaxLevel: (index) => getMaxLevel(internal, index),
    setLevel: (index, level) => setLevel(internal, index, level),
    adjustLevel: (index, delta) => adjustLevel(internal, index, delta),
    isUnlocked: (index) => getBoolean(internal.buffers.unlocked, index),
    unlock: (index) => setBoolean(internal, internal.buffers.unlocked, index, true),
    lock: (index) => setBoolean(internal, internal.buffers.unlocked, index, false),
    isVisible: (index) => getBoolean(internal.buffers.visible, index),
    reveal: (index) => setBoolean(internal, internal.buffers.visible, index, true),
    hide: (index) => setBoolean(internal, internal.buffers.visible, index, false),
    isEnabled: (index) => getBoolean(internal.buffers.enabled, index),
    setEnabled: (index, value) => setBoolean(internal, internal.buffers.enabled, index, value),
    snapshot: () => snapshot(internal),
    view: () => createView(internal),
    exportForSave: () => exportForSave(internal),
    clearDirty: () => clearDirty(internal),
    collectRecords: () => collectRecords(internal),
  };

  generatorStateInternals.set(api, internal);
  return api;
}

function requireIndex(internal: GeneratorStateInternal, id: string): number {
  const index = internal.buffers.indexById.get(id);
  if (index === undefined) {
    throw new Error(`Generator "${id}" is not registered in the state graph.`);
  }
  return index;
}

function getLevel(internal: GeneratorStateInternal, index: number): number {
  assertValidIndex(internal, index);
  return internal.buffers.levels[index];
}

function getMaxLevel(internal: GeneratorStateInternal, index: number): number {
  assertValidIndex(internal, index);
  return internal.buffers.maxLevel[index];
}

function setLevel(internal: GeneratorStateInternal, index: number, level: number): number {
  assertValidIndex(internal, index);
  const { buffers } = internal;
  const clamped = clampLevel(level, buffers.maxLevel[index]);
  const current = buffers.levels[index];
  if (current === clamped) {
    return current;
  }

  buffers.levels[index] = clamped;
  buffers.levelDelta[index] += clamped - current;
  markDirty(internal, index);
  return clamped;
}

function adjustLevel(
  internal: GeneratorStateInternal,
  index: number,
  delta: number,
): number {
  assertValidIndex(internal, index);
  if (!Number.isFinite(delta)) {
    telemetry.recordError(TELEMETRY_INVALID_LEVEL, {
      reason: 'delta-non-finite',
      index,
      delta,
    });
    throw new Error('Generator level adjustments must be finite numbers.');
  }

  const { buffers } = internal;
  const next = buffers.levels[index] + Math.trunc(delta);
  return setLevel(internal, index, next);
}

function getBoolean(array: Uint8Array, index: number): boolean {
  return array[index] === 1;
}

function setBoolean(
  internal: GeneratorStateInternal,
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

function snapshot(internal: GeneratorStateInternal): GeneratorStateSnapshot {
  const dirtyCount = internal.dirtyCount;
  const publish = swapPublishBuffers(internal);
  ensurePublishCapacity(publish, dirtyCount);

  const { buffers } = internal;
  const { dirtyIndices, levels, levelDelta, unlocked, visible, enabled } = buffers;

  for (let position = 0; position < dirtyCount; position += 1) {
    const index = dirtyIndices[position];
    publish.indices[position] = index;
    publish.levels[position] = levels[index];
    publish.levelDelta[position] = levelDelta[index];
    publish.unlocked[position] = unlocked[index];
    publish.visible[position] = visible[index];
    publish.enabled[position] = enabled[index];
    buffers.levelDelta[index] = 0;
    buffers.dirtyPositions[index] = SCRATCH_UNSET;
  }

  const snapshotResult: GeneratorStateSnapshot = {
    ids: buffers.ids,
    dirtyCount,
    indices: createImmutableTypedArrayView(publish.indices.subarray(0, dirtyCount)),
    levels: createImmutableTypedArrayView(publish.levels.subarray(0, dirtyCount)),
    levelDelta: createImmutableTypedArrayView(publish.levelDelta.subarray(0, dirtyCount)),
    unlocked: createImmutableTypedArrayView(publish.unlocked.subarray(0, dirtyCount)),
    visible: createImmutableTypedArrayView(publish.visible.subarray(0, dirtyCount)),
    enabled: createImmutableTypedArrayView(publish.enabled.subarray(0, dirtyCount)),
  };

  internal.dirtyCount = 0;
  return snapshotResult;
}

function createView(internal: GeneratorStateInternal): GeneratorStateView {
  const { buffers } = internal;
  return {
    ids: buffers.ids,
    indexById: buffers.indexById,
    levels: createImmutableTypedArrayView(buffers.levels),
    levelDelta: createImmutableTypedArrayView(buffers.levelDelta),
    unlocked: createImmutableTypedArrayView(buffers.unlocked),
    visible: createImmutableTypedArrayView(buffers.visible),
    enabled: createImmutableTypedArrayView(buffers.enabled),
  };
}

function exportForSave(internal: GeneratorStateInternal): SerializedGeneratorState {
  const { buffers } = internal;
  const { levels, unlocked, visible, enabled } = buffers;
  return {
    ids: buffers.ids,
    levels: Array.from(levels, (value) => value),
    unlocked: Array.from(unlocked, (value) => value === 1),
    visible: Array.from(visible, (value) => value === 1),
    enabled: Array.from(enabled, (value) => value === 1),
  };
}

function clearDirty(internal: GeneratorStateInternal): void {
  const { buffers } = internal;
  const dirtyCount = internal.dirtyCount;
  for (let position = 0; position < dirtyCount; position += 1) {
    const index = buffers.dirtyIndices[position];
    buffers.levelDelta[index] = 0;
    buffers.dirtyPositions[index] = SCRATCH_UNSET;
  }
  internal.dirtyCount = 0;
}

function collectRecords(internal: GeneratorStateInternal): NormalizedGeneratorRecord[] {
  const { buffers } = internal;
  const records: NormalizedGeneratorRecord[] = new Array(buffers.ids.length);
  for (let index = 0; index < buffers.ids.length; index += 1) {
    records[index] = {
      id: buffers.ids[index],
      level: buffers.levels[index],
      levelDelta: buffers.levelDelta[index],
      unlocked: buffers.unlocked[index] === 1,
      visible: buffers.visible[index] === 1,
      enabled: buffers.enabled[index] === 1,
    };
  }
  return records;
}

function swapPublishBuffers(internal: GeneratorStateInternal): GeneratorPublishBuffers {
  const nextIndex = internal.activePublishIndex ^ 1;
  internal.activePublishIndex = nextIndex;
  return internal.publish[nextIndex];
}

function ensurePublishCapacity(buffers: GeneratorPublishBuffers, required: number): void {
  const capacity = buffers.indices.length;
  if (capacity >= required) {
    return;
  }
  const nextCapacity = nextPowerOfTwo(required);
  buffers.indices = new Uint32Array(nextCapacity);
  buffers.levels = new Uint32Array(nextCapacity);
  buffers.levelDelta = new Int32Array(nextCapacity);
  buffers.unlocked = new Uint8Array(nextCapacity);
  buffers.visible = new Uint8Array(nextCapacity);
  buffers.enabled = new Uint8Array(nextCapacity);
}

function nextPowerOfTwo(value: number): number {
  if (value <= 1) {
    return 1;
  }
  return 2 ** Math.ceil(Math.log2(value));
}

function sanitizeMaxLevel(maxLevel: number | undefined, id: string | undefined): number {
  if (maxLevel === undefined) {
    return 0;
  }
  if (!Number.isFinite(maxLevel) || maxLevel < 0) {
    telemetry.recordError(TELEMETRY_INVALID_MAX_LEVEL, {
      id,
      value: maxLevel,
    });
    throw new Error('Generator maxLevel must be a finite non-negative number when provided.');
  }
  return Math.trunc(maxLevel);
}

function sanitizeStartLevel(startLevel: number | undefined, maxLevel: number, id: string | undefined): number {
  if (startLevel === undefined) {
    return 0;
  }
  if (!Number.isFinite(startLevel) || startLevel < 0) {
    telemetry.recordError(TELEMETRY_INVALID_LEVEL, {
      id,
      value: startLevel,
      reason: 'initial-invalid',
    });
    throw new Error('Generator startLevel must be a finite non-negative number when provided.');
  }
  const truncated = Math.trunc(startLevel);
  if (maxLevel > 0 && truncated > maxLevel) {
    return maxLevel;
  }
  return truncated;
}

function clampLevel(level: number, maxLevel: number): number {
  if (!Number.isFinite(level)) {
    throw new Error('Generator levels must be finite numbers.');
  }
  const truncated = Math.max(0, Math.trunc(level));
  if (maxLevel > 0 && truncated > maxLevel) {
    return maxLevel;
  }
  return truncated;
}

function createPublishBuffers(): GeneratorPublishBuffers {
  return {
    indices: new Uint32Array(1),
    levels: new Uint32Array(1),
    levelDelta: new Int32Array(1),
    unlocked: new Uint8Array(1),
    visible: new Uint8Array(1),
    enabled: new Uint8Array(1),
  };
}

function markDirty(internal: GeneratorStateInternal, index: number): void {
  const position = internal.buffers.dirtyPositions[index];
  if (position !== SCRATCH_UNSET) {
    return;
  }
  const nextPosition = internal.dirtyCount;
  internal.buffers.dirtyIndices[nextPosition] = index;
  internal.buffers.dirtyPositions[index] = nextPosition;
  internal.dirtyCount += 1;
}

function assertValidIndex(internal: GeneratorStateInternal, index: number): void {
  if (index < 0 || index >= internal.buffers.ids.length) {
    throw new RangeError(`Generator index ${index} is out of bounds.`);
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
          throw new Error('GeneratorState index map is immutable once created.');
        };
      }
      const result = Reflect.get(target, property, receiver);
      return typeof result === 'function' ? result.bind(target) : result;
    },
  }) as ImmutableMapSnapshot<string, number>;
}
