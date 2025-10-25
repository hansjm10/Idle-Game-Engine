import {
  createImmutableTypedArrayView,
  type ImmutableTypedArraySnapshot,
} from './immutable-snapshots.js';
import type { ResourceState, ResourceStateSnapshot } from './resource-state.js';
import type {
  GeneratorState,
  GeneratorStateSnapshot,
} from './generator-state.js';
import type {
  UpgradeState,
  UpgradeStateSnapshot,
} from './upgrade-state.js';
import { telemetry } from './telemetry.js';

const TELEMETRY_NON_MONOTONIC_TICK = 'RuntimeChangeJournalNonMonotonicTick';

export interface RuntimeResourceDelta {
  readonly ids: readonly string[];
  readonly count: number;
  readonly indices: ImmutableTypedArraySnapshot<Uint32Array>;
  readonly amounts: ImmutableTypedArraySnapshot<Float64Array>;
  readonly capacities: ImmutableTypedArraySnapshot<Float64Array>;
  readonly incomePerSecond: ImmutableTypedArraySnapshot<Float64Array>;
  readonly expensePerSecond: ImmutableTypedArraySnapshot<Float64Array>;
  readonly netPerSecond: ImmutableTypedArraySnapshot<Float64Array>;
  readonly tickDelta: ImmutableTypedArraySnapshot<Float64Array>;
  readonly flags: ImmutableTypedArraySnapshot<Uint8Array>;
  readonly dirtyTolerance: ImmutableTypedArraySnapshot<Float64Array>;
}

export type RuntimeGeneratorDelta = GeneratorStateSnapshot;
export type RuntimeUpgradeDelta = UpgradeStateSnapshot;

export interface RuntimeStateDelta {
  readonly tick: number;
  readonly resources?: RuntimeResourceDelta;
  readonly generators?: RuntimeGeneratorDelta;
  readonly upgrades?: RuntimeUpgradeDelta;
}

export interface RuntimeChangeJournalOptions {
  readonly requireMonotonicTick?: boolean;
}

export interface ChangeJournalCaptureInput {
  readonly tick: number;
  readonly resources?: ResourceState;
  readonly generators?: GeneratorState;
  readonly upgrades?: UpgradeState;
}

interface ResourceDeltaBuffers {
  indices: Uint32Array;
  amounts: Float64Array;
  capacities: Float64Array;
  incomePerSecond: Float64Array;
  expensePerSecond: Float64Array;
  netPerSecond: Float64Array;
  tickDelta: Float64Array;
  flags: Uint8Array;
  dirtyTolerance: Float64Array;
}

export class RuntimeChangeJournal {
  private readonly requireMonotonicTick: boolean;
  private lastTick: number | undefined;
  private readonly resourceBuffers: ResourceDeltaBuffers = createResourceDeltaBuffers();

  constructor(options: RuntimeChangeJournalOptions = {}) {
    this.requireMonotonicTick = options.requireMonotonicTick !== false;
  }

  capture(input: ChangeJournalCaptureInput): RuntimeStateDelta | undefined {
    const { tick } = input;

    if (this.requireMonotonicTick) {
      if (this.lastTick !== undefined && tick <= this.lastTick) {
        telemetry.recordError(TELEMETRY_NON_MONOTONIC_TICK, {
          previous: this.lastTick,
          current: tick,
        });
        throw new Error('RuntimeChangeJournal capture() requires monotonically increasing tick values.');
      }
      this.lastTick = tick;
    }

    const resourceDelta = input.resources
      ? buildResourceDelta(input.resources.snapshot(), this.resourceBuffers)
      : undefined;

    const generatorSnapshot = input.generators?.snapshot();
    const generatorDelta = generatorSnapshot && generatorSnapshot.dirtyCount > 0
      ? generatorSnapshot
      : undefined;

    const upgradeSnapshot = input.upgrades?.snapshot();
    const upgradeDelta = upgradeSnapshot && upgradeSnapshot.dirtyCount > 0
      ? upgradeSnapshot
      : undefined;

    if (!resourceDelta && !generatorDelta && !upgradeDelta) {
      return undefined;
    }

    return {
      tick,
      resources: resourceDelta,
      generators: generatorDelta,
      upgrades: upgradeDelta,
    };
  }
}

function buildResourceDelta(
  snapshot: ResourceStateSnapshot,
  buffers: ResourceDeltaBuffers,
): RuntimeResourceDelta | undefined {
  const dirtyCount = snapshot.dirtyCount;
  if (dirtyCount === 0) {
    return undefined;
  }

  ensureResourceCapacity(buffers, dirtyCount);

  for (let position = 0; position < dirtyCount; position += 1) {
    const resourceIndex = snapshot.dirtyIndices[position];
    buffers.indices[position] = resourceIndex;
    buffers.amounts[position] = snapshot.amounts[resourceIndex];
    buffers.capacities[position] = snapshot.capacities[resourceIndex];
    buffers.incomePerSecond[position] = snapshot.incomePerSecond[resourceIndex];
    buffers.expensePerSecond[position] = snapshot.expensePerSecond[resourceIndex];
    buffers.netPerSecond[position] = snapshot.netPerSecond[resourceIndex];
    buffers.tickDelta[position] = snapshot.tickDelta[resourceIndex];
    buffers.flags[position] = snapshot.flags[resourceIndex];
    buffers.dirtyTolerance[position] = snapshot.dirtyTolerance[resourceIndex];
  }

  return {
    ids: snapshot.ids,
    count: dirtyCount,
    indices: createImmutableTypedArrayView(buffers.indices.subarray(0, dirtyCount)),
    amounts: createImmutableTypedArrayView(buffers.amounts.subarray(0, dirtyCount)),
    capacities: createImmutableTypedArrayView(buffers.capacities.subarray(0, dirtyCount)),
    incomePerSecond: createImmutableTypedArrayView(buffers.incomePerSecond.subarray(0, dirtyCount)),
    expensePerSecond: createImmutableTypedArrayView(buffers.expensePerSecond.subarray(0, dirtyCount)),
    netPerSecond: createImmutableTypedArrayView(buffers.netPerSecond.subarray(0, dirtyCount)),
    tickDelta: createImmutableTypedArrayView(buffers.tickDelta.subarray(0, dirtyCount)),
    flags: createImmutableTypedArrayView(buffers.flags.subarray(0, dirtyCount)),
    dirtyTolerance: createImmutableTypedArrayView(buffers.dirtyTolerance.subarray(0, dirtyCount)),
  };
}

function createResourceDeltaBuffers(): ResourceDeltaBuffers {
  return {
    indices: new Uint32Array(1),
    amounts: new Float64Array(1),
    capacities: new Float64Array(1),
    incomePerSecond: new Float64Array(1),
    expensePerSecond: new Float64Array(1),
    netPerSecond: new Float64Array(1),
    tickDelta: new Float64Array(1),
    flags: new Uint8Array(1),
    dirtyTolerance: new Float64Array(1),
  };
}

function ensureResourceCapacity(buffers: ResourceDeltaBuffers, required: number): void {
  if (buffers.indices.length >= required) {
    return;
  }
  const capacity = nextPowerOfTwo(required);
  buffers.indices = new Uint32Array(capacity);
  buffers.amounts = new Float64Array(capacity);
  buffers.capacities = new Float64Array(capacity);
  buffers.incomePerSecond = new Float64Array(capacity);
  buffers.expensePerSecond = new Float64Array(capacity);
  buffers.netPerSecond = new Float64Array(capacity);
  buffers.tickDelta = new Float64Array(capacity);
  buffers.flags = new Uint8Array(capacity);
  buffers.dirtyTolerance = new Float64Array(capacity);
}

function nextPowerOfTwo(value: number): number {
  if (value <= 1) {
    return 1;
  }
  return 2 ** Math.ceil(Math.log2(value));
}

