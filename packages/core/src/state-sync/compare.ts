import type { SerializedAutomationState } from '../automation-system.js';
import type {
  JsonValue,
  SerializedCommandQueueEntryV1,
  SerializedCommandQueueV1,
} from '../command-queue.js';
import type { SerializedProductionAccumulators } from '../production-system.js';
import type {
  SerializedProgressionAchievementStateV2,
  SerializedProgressionCoordinatorStateV2,
  SerializedProgressionGeneratorStateV1,
  SerializedProgressionUpgradeStateV1,
} from '../progression-coordinator-save.js';
import type {
  ResourceDefinitionDigest,
  SerializedResourceState,
} from '../resource-state.js';
import type { SerializedTransformState } from '../transform-system.js';
import type { GameStateSnapshot } from './types.js';

import { computeStateChecksum } from './checksum.js';

type Mutable<T> = {
  -readonly [K in keyof T]: T[K];
};

type ValueDiff<T> = Readonly<{
  readonly local: T;
  readonly remote: T;
}>;

type MissingDiff = Readonly<{
  readonly local: boolean;
  readonly remote: boolean;
}>;

export interface StateDiff {
  /** Whether states are identical */
  readonly identical: boolean;

  /** Snapshot version differences */
  readonly version?: ValueDiff<number>;

  /** Runtime metadata differences */
  readonly runtime?: RuntimeDiff;

  /** Resource differences (by resource ID) */
  readonly resources?: ReadonlyMap<string, ResourceDiff>;

  /** Resource definition digest differences */
  readonly resourceDefinitionDigest?: ValueDiff<ResourceDefinitionDigest | undefined>;

  /** Progression differences */
  readonly progression?: ProgressionDiff;

  /** Automation differences */
  readonly automation?: ReadonlyMap<string, AutomationDiff>;

  /** Transform differences */
  readonly transforms?: ReadonlyMap<string, TransformDiff>;

  /** Command queue differences */
  readonly commandQueue?: CommandQueueDiff;
}

export interface RuntimeDiff {
  readonly step?: ValueDiff<number>;
  readonly stepSizeMs?: ValueDiff<number>;
  readonly rngSeed?: ValueDiff<number | undefined>;
  readonly rngState?: ValueDiff<number | undefined>;
}

export interface ResourceDiff {
  readonly id: string;
  readonly missing?: MissingDiff;
  readonly amount?: ValueDiff<number | undefined>;
  readonly capacity?: ValueDiff<number | null | undefined>;
  readonly unlocked?: ValueDiff<boolean | undefined>;
  readonly visible?: ValueDiff<boolean | undefined>;
  readonly flags?: ValueDiff<number | undefined>;
}

export interface ProgressionDiff {
  readonly schemaVersion?: ValueDiff<number>;
  readonly step?: ValueDiff<number>;
  readonly resources?: ReadonlyMap<string, ResourceDiff>;
  readonly resourceDefinitionDigest?: ValueDiff<ResourceDefinitionDigest | undefined>;
  readonly generators?: ReadonlyMap<string, GeneratorDiff>;
  readonly upgrades?: ReadonlyMap<string, UpgradeDiff>;
  readonly achievements?: ReadonlyMap<string, AchievementDiff>;
  readonly productionAccumulatorsDefined?: ValueDiff<boolean>;
  readonly productionAccumulators?: ReadonlyMap<string, ProductionAccumulatorDiff>;
}

export interface GeneratorDiff {
  readonly id: string;
  readonly missing?: MissingDiff;
  readonly owned?: ValueDiff<number | undefined>;
  readonly enabled?: ValueDiff<boolean | undefined>;
  readonly isUnlocked?: ValueDiff<boolean | undefined>;
  readonly nextPurchaseReadyAtStep?: ValueDiff<number | undefined>;
}

export interface UpgradeDiff {
  readonly id: string;
  readonly missing?: MissingDiff;
  readonly purchases?: ValueDiff<number | undefined>;
}

export interface AchievementDiff {
  readonly id: string;
  readonly missing?: MissingDiff;
  readonly completions?: ValueDiff<number | undefined>;
  readonly progress?: ValueDiff<number | undefined>;
  readonly nextRepeatableAtStep?: ValueDiff<number | undefined>;
  readonly lastCompletedStep?: ValueDiff<number | undefined>;
}

export interface ProductionAccumulatorDiff {
  readonly key: string;
  readonly missing?: MissingDiff;
  readonly value?: ValueDiff<number | undefined>;
}

export interface AutomationDiff {
  readonly id: string;
  readonly missing?: MissingDiff;
  readonly enabled?: ValueDiff<boolean | undefined>;
  readonly lastFiredStep?: ValueDiff<number | null | undefined>;
  readonly cooldownExpiresStep?: ValueDiff<number | undefined>;
  readonly unlocked?: ValueDiff<boolean | undefined>;
  readonly lastThresholdSatisfied?: ValueDiff<boolean | undefined>;
}

export interface TransformDiff {
  readonly id: string;
  readonly missing?: MissingDiff;
  readonly unlocked?: ValueDiff<boolean | undefined>;
  readonly cooldownExpiresStep?: ValueDiff<number | undefined>;
  readonly batchesDefined?: ValueDiff<boolean>;
  readonly batches?: readonly TransformBatchDiff[];
}

export interface TransformBatchDiff {
  readonly index: number;
  readonly missing?: MissingDiff;
  readonly completeAtStep?: ValueDiff<number | undefined>;
  readonly outputs?: readonly TransformBatchOutputDiff[];
}

export interface TransformBatchOutputDiff {
  readonly index: number;
  readonly missing?: MissingDiff;
  readonly resourceId?: ValueDiff<string | undefined>;
  readonly amount?: ValueDiff<number | undefined>;
}

export interface CommandQueueDiff {
  readonly schemaVersion?: ValueDiff<number>;
  readonly entryCountDiff: ValueDiff<number>;
  readonly missingInLocal: readonly string[];
  readonly missingInRemote: readonly string[];
  readonly entryDiffs?: readonly CommandQueueEntryDiff[];
}

export interface CommandQueueEntryDiff {
  readonly index: number;
  readonly missing?: MissingDiff;
  readonly type?: ValueDiff<string | undefined>;
  readonly priority?: ValueDiff<SerializedCommandQueueEntryV1['priority'] | undefined>;
  readonly timestamp?: ValueDiff<number | undefined>;
  readonly step?: ValueDiff<number | undefined>;
  readonly payload?: ValueDiff<JsonValue | undefined>;
}

const normalizeForComparison = (value: unknown): unknown => {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForComparison(entry));
  }

  const result: Record<string, unknown> = {};
  const keys = Object.keys(value).sort();
  for (const key of keys) {
    result[key] = normalizeForComparison(
      (value as Record<string, unknown>)[key],
    );
  }
  return result;
};

const stableStringify = (value: unknown): string =>
  JSON.stringify(normalizeForComparison(value));

const valuesEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) {
    return true;
  }
  if (left === null || right === null) {
    return false;
  }
  if (typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  return stableStringify(left) === stableStringify(right);
};

const recordMissingDiff = (
  target: { missing?: MissingDiff },
  localPresent: boolean,
  remotePresent: boolean,
): boolean => {
  if (localPresent === remotePresent) {
    return false;
  }
  target.missing = {
    local: !localPresent,
    remote: !remotePresent,
  };
  return true;
};

const recordValueDiff = <T>(
  target: Record<string, unknown>,
  key: string,
  localValue: T,
  remoteValue: T,
  equals: (left: T, right: T) => boolean = valuesEqual as (
    left: T,
    right: T,
  ) => boolean,
): boolean => {
  if (equals(localValue, remoteValue)) {
    return false;
  }
  target[key] = { local: localValue, remote: remoteValue };
  return true;
};

const collectSortedIds = (
  localIds: readonly string[],
  remoteIds: readonly string[],
): readonly string[] => {
  const ids = new Set<string>();
  for (const id of localIds) {
    ids.add(id);
  }
  for (const id of remoteIds) {
    ids.add(id);
  }
  return Array.from(ids).sort();
};

const buildIndexById = (ids: readonly string[]): Map<string, number> => {
  const map = new Map<string, number>();
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];
    if (!map.has(id)) {
      map.set(id, index);
    }
  }
  return map;
};

const mapById = <T extends { id: string }>(
  entries: readonly T[],
): Map<string, T> => {
  const map = new Map<string, T>();
  for (const entry of entries) {
    if (!map.has(entry.id)) {
      map.set(entry.id, entry);
    }
  }
  return map;
};

const hasOwn = (record: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

const compareRuntime = (
  local: GameStateSnapshot['runtime'],
  remote: GameStateSnapshot['runtime'],
): RuntimeDiff | undefined => {
  const diff: Mutable<RuntimeDiff> = {};
  let hasDiff = false;

  hasDiff = recordValueDiff(diff, 'step', local.step, remote.step) || hasDiff;
  hasDiff =
    recordValueDiff(diff, 'stepSizeMs', local.stepSizeMs, remote.stepSizeMs) ||
    hasDiff;
  hasDiff =
    recordValueDiff(diff, 'rngSeed', local.rngSeed, remote.rngSeed) || hasDiff;
  hasDiff =
    recordValueDiff(diff, 'rngState', local.rngState, remote.rngState) ||
    hasDiff;

  return hasDiff ? diff : undefined;
};

const compareResourceState = (
  local: SerializedResourceState,
  remote: SerializedResourceState,
): {
  readonly diffs: ReadonlyMap<string, ResourceDiff>;
  readonly definitionDigest?: ValueDiff<ResourceDefinitionDigest | undefined>;
} => {
  const diffs = new Map<string, ResourceDiff>();
  const ids = collectSortedIds(local.ids, remote.ids);
  const localIndex = buildIndexById(local.ids);
  const remoteIndex = buildIndexById(remote.ids);

  for (const id of ids) {
    const localIdx = localIndex.get(id);
    const remoteIdx = remoteIndex.get(id);
    const diff: Mutable<ResourceDiff> = { id };
    let hasDiff = false;

    hasDiff =
      recordMissingDiff(diff, localIdx !== undefined, remoteIdx !== undefined) ||
      hasDiff;

    const localAmount =
      localIdx === undefined ? undefined : local.amounts[localIdx];
    const remoteAmount =
      remoteIdx === undefined ? undefined : remote.amounts[remoteIdx];
    hasDiff =
      recordValueDiff(diff, 'amount', localAmount, remoteAmount) || hasDiff;

    const localCapacity =
      localIdx === undefined ? undefined : local.capacities[localIdx];
    const remoteCapacity =
      remoteIdx === undefined ? undefined : remote.capacities[remoteIdx];
    hasDiff =
      recordValueDiff(diff, 'capacity', localCapacity, remoteCapacity) || hasDiff;

    const localUnlocked =
      localIdx === undefined ? undefined : local.unlocked?.[localIdx];
    const remoteUnlocked =
      remoteIdx === undefined ? undefined : remote.unlocked?.[remoteIdx];
    hasDiff =
      recordValueDiff(diff, 'unlocked', localUnlocked, remoteUnlocked) ||
      hasDiff;

    const localVisible =
      localIdx === undefined ? undefined : local.visible?.[localIdx];
    const remoteVisible =
      remoteIdx === undefined ? undefined : remote.visible?.[remoteIdx];
    hasDiff =
      recordValueDiff(diff, 'visible', localVisible, remoteVisible) || hasDiff;

    const localFlags =
      localIdx === undefined ? undefined : local.flags[localIdx];
    const remoteFlags =
      remoteIdx === undefined ? undefined : remote.flags[remoteIdx];
    hasDiff =
      recordValueDiff(diff, 'flags', localFlags, remoteFlags) || hasDiff;

    if (hasDiff) {
      diffs.set(id, diff);
    }
  }

  const definitionDigest = valuesEqual(
    local.definitionDigest,
    remote.definitionDigest,
  )
    ? undefined
    : {
        local: local.definitionDigest,
        remote: remote.definitionDigest,
      };

  return { diffs, definitionDigest };
};

const compareGenerators = (
  local: readonly SerializedProgressionGeneratorStateV1[],
  remote: readonly SerializedProgressionGeneratorStateV1[],
): ReadonlyMap<string, GeneratorDiff> => {
  const diffs = new Map<string, GeneratorDiff>();
  const localMap = mapById(local);
  const remoteMap = mapById(remote);
  const ids = collectSortedIds(
    Array.from(localMap.keys()),
    Array.from(remoteMap.keys()),
  );

  for (const id of ids) {
    const localEntry = localMap.get(id);
    const remoteEntry = remoteMap.get(id);
    const diff: Mutable<GeneratorDiff> = { id };
    let hasDiff = false;

    hasDiff =
      recordMissingDiff(
        diff,
        localEntry !== undefined,
        remoteEntry !== undefined,
      ) || hasDiff;
    hasDiff =
      recordValueDiff(diff, 'owned', localEntry?.owned, remoteEntry?.owned) ||
      hasDiff;
    hasDiff =
      recordValueDiff(
        diff,
        'enabled',
        localEntry?.enabled,
        remoteEntry?.enabled,
      ) || hasDiff;
    hasDiff =
      recordValueDiff(
        diff,
        'isUnlocked',
        localEntry?.isUnlocked,
        remoteEntry?.isUnlocked,
      ) || hasDiff;
    hasDiff =
      recordValueDiff(
        diff,
        'nextPurchaseReadyAtStep',
        localEntry?.nextPurchaseReadyAtStep,
        remoteEntry?.nextPurchaseReadyAtStep,
      ) || hasDiff;

    if (hasDiff) {
      diffs.set(id, diff);
    }
  }

  return diffs;
};

const compareUpgrades = (
  local: readonly SerializedProgressionUpgradeStateV1[],
  remote: readonly SerializedProgressionUpgradeStateV1[],
): ReadonlyMap<string, UpgradeDiff> => {
  const diffs = new Map<string, UpgradeDiff>();
  const localMap = mapById(local);
  const remoteMap = mapById(remote);
  const ids = collectSortedIds(
    Array.from(localMap.keys()),
    Array.from(remoteMap.keys()),
  );

  for (const id of ids) {
    const localEntry = localMap.get(id);
    const remoteEntry = remoteMap.get(id);
    const diff: Mutable<UpgradeDiff> = { id };
    let hasDiff = false;

    hasDiff =
      recordMissingDiff(
        diff,
        localEntry !== undefined,
        remoteEntry !== undefined,
      ) || hasDiff;
    hasDiff =
      recordValueDiff(
        diff,
        'purchases',
        localEntry?.purchases,
        remoteEntry?.purchases,
      ) || hasDiff;

    if (hasDiff) {
      diffs.set(id, diff);
    }
  }

  return diffs;
};

const compareAchievements = (
  local: readonly SerializedProgressionAchievementStateV2[],
  remote: readonly SerializedProgressionAchievementStateV2[],
): ReadonlyMap<string, AchievementDiff> => {
  const diffs = new Map<string, AchievementDiff>();
  const localMap = mapById(local);
  const remoteMap = mapById(remote);
  const ids = collectSortedIds(
    Array.from(localMap.keys()),
    Array.from(remoteMap.keys()),
  );

  for (const id of ids) {
    const localEntry = localMap.get(id);
    const remoteEntry = remoteMap.get(id);
    const diff: Mutable<AchievementDiff> = { id };
    let hasDiff = false;

    hasDiff =
      recordMissingDiff(
        diff,
        localEntry !== undefined,
        remoteEntry !== undefined,
      ) || hasDiff;
    hasDiff =
      recordValueDiff(
        diff,
        'completions',
        localEntry?.completions,
        remoteEntry?.completions,
      ) || hasDiff;
    hasDiff =
      recordValueDiff(
        diff,
        'progress',
        localEntry?.progress,
        remoteEntry?.progress,
      ) || hasDiff;
    hasDiff =
      recordValueDiff(
        diff,
        'nextRepeatableAtStep',
        localEntry?.nextRepeatableAtStep,
        remoteEntry?.nextRepeatableAtStep,
      ) || hasDiff;
    hasDiff =
      recordValueDiff(
        diff,
        'lastCompletedStep',
        localEntry?.lastCompletedStep,
        remoteEntry?.lastCompletedStep,
      ) || hasDiff;

    if (hasDiff) {
      diffs.set(id, diff);
    }
  }

  return diffs;
};

const compareProductionAccumulators = (
  local: SerializedProductionAccumulators | undefined,
  remote: SerializedProductionAccumulators | undefined,
): ReadonlyMap<string, ProductionAccumulatorDiff> => {
  const diffs = new Map<string, ProductionAccumulatorDiff>();
  const localAccumulators = local?.accumulators ?? {};
  const remoteAccumulators = remote?.accumulators ?? {};
  const ids = collectSortedIds(
    Object.keys(localAccumulators),
    Object.keys(remoteAccumulators),
  );

  for (const key of ids) {
    const diff: Mutable<ProductionAccumulatorDiff> = { key };
    let hasDiff = false;
    const localHasKey = hasOwn(localAccumulators, key);
    const remoteHasKey = hasOwn(remoteAccumulators, key);

    hasDiff = recordMissingDiff(diff, localHasKey, remoteHasKey) || hasDiff;
    hasDiff =
      recordValueDiff(
        diff,
        'value',
        localAccumulators[key],
        remoteAccumulators[key],
      ) || hasDiff;

    if (hasDiff) {
      diffs.set(key, diff);
    }
  }

  return diffs;
};

const compareProgression = (
  local: SerializedProgressionCoordinatorStateV2,
  remote: SerializedProgressionCoordinatorStateV2,
): ProgressionDiff | undefined => {
  const diff: Mutable<ProgressionDiff> = {};
  let hasDiff = false;

  hasDiff =
    recordValueDiff(
      diff,
      'schemaVersion',
      local.schemaVersion,
      remote.schemaVersion,
    ) || hasDiff;
  hasDiff = recordValueDiff(diff, 'step', local.step, remote.step) || hasDiff;

  const resourceDiff = compareResourceState(local.resources, remote.resources);
  if (resourceDiff.definitionDigest) {
    diff.resourceDefinitionDigest = resourceDiff.definitionDigest;
    hasDiff = true;
  }
  if (resourceDiff.diffs.size > 0) {
    diff.resources = resourceDiff.diffs;
    hasDiff = true;
  }

  const generatorDiffs = compareGenerators(local.generators, remote.generators);
  if (generatorDiffs.size > 0) {
    diff.generators = generatorDiffs;
    hasDiff = true;
  }

  const upgradeDiffs = compareUpgrades(local.upgrades, remote.upgrades);
  if (upgradeDiffs.size > 0) {
    diff.upgrades = upgradeDiffs;
    hasDiff = true;
  }

  const achievementDiffs = compareAchievements(
    local.achievements,
    remote.achievements,
  );
  if (achievementDiffs.size > 0) {
    diff.achievements = achievementDiffs;
    hasDiff = true;
  }

  const localHasAccumulators = local.productionAccumulators !== undefined;
  const remoteHasAccumulators = remote.productionAccumulators !== undefined;
  if (localHasAccumulators !== remoteHasAccumulators) {
    diff.productionAccumulatorsDefined = {
      local: localHasAccumulators,
      remote: remoteHasAccumulators,
    };
    hasDiff = true;
  }

  const accumulatorDiffs = compareProductionAccumulators(
    local.productionAccumulators,
    remote.productionAccumulators,
  );
  if (accumulatorDiffs.size > 0) {
    diff.productionAccumulators = accumulatorDiffs;
    hasDiff = true;
  }

  return hasDiff ? diff : undefined;
};

const compareAutomation = (
  local: readonly SerializedAutomationState[],
  remote: readonly SerializedAutomationState[],
): ReadonlyMap<string, AutomationDiff> => {
  const diffs = new Map<string, AutomationDiff>();
  const localMap = mapById(local);
  const remoteMap = mapById(remote);
  const ids = collectSortedIds(
    Array.from(localMap.keys()),
    Array.from(remoteMap.keys()),
  );

  for (const id of ids) {
    const localEntry = localMap.get(id);
    const remoteEntry = remoteMap.get(id);
    const diff: Mutable<AutomationDiff> = { id };
    let hasDiff = false;

    hasDiff =
      recordMissingDiff(
        diff,
        localEntry !== undefined,
        remoteEntry !== undefined,
      ) || hasDiff;
    hasDiff =
      recordValueDiff(
        diff,
        'enabled',
        localEntry?.enabled,
        remoteEntry?.enabled,
      ) || hasDiff;
    hasDiff =
      recordValueDiff(
        diff,
        'lastFiredStep',
        localEntry?.lastFiredStep,
        remoteEntry?.lastFiredStep,
      ) || hasDiff;
    hasDiff =
      recordValueDiff(
        diff,
        'cooldownExpiresStep',
        localEntry?.cooldownExpiresStep,
        remoteEntry?.cooldownExpiresStep,
      ) || hasDiff;
    hasDiff =
      recordValueDiff(
        diff,
        'unlocked',
        localEntry?.unlocked,
        remoteEntry?.unlocked,
      ) || hasDiff;
    hasDiff =
      recordValueDiff(
        diff,
        'lastThresholdSatisfied',
        localEntry?.lastThresholdSatisfied,
        remoteEntry?.lastThresholdSatisfied,
      ) || hasDiff;

    if (hasDiff) {
      diffs.set(id, diff);
    }
  }

  return diffs;
};

const compareTransformOutputs = (
  local: readonly { resourceId: string; amount: number }[],
  remote: readonly { resourceId: string; amount: number }[],
): readonly TransformBatchOutputDiff[] | undefined => {
  const diffs: TransformBatchOutputDiff[] = [];
  const maxLength = Math.max(local.length, remote.length);

  for (let index = 0; index < maxLength; index += 1) {
    const localEntry = local[index];
    const remoteEntry = remote[index];
    const diff: Mutable<TransformBatchOutputDiff> = { index };
    let hasDiff = false;

    hasDiff =
      recordMissingDiff(
        diff,
        localEntry !== undefined,
        remoteEntry !== undefined,
      ) || hasDiff;
    hasDiff =
      recordValueDiff(
        diff,
        'resourceId',
        localEntry?.resourceId,
        remoteEntry?.resourceId,
      ) || hasDiff;
    hasDiff =
      recordValueDiff(
        diff,
        'amount',
        localEntry?.amount,
        remoteEntry?.amount,
      ) || hasDiff;

    if (hasDiff) {
      diffs.push(diff);
    }
  }

  return diffs.length > 0 ? diffs : undefined;
};

const compareTransformBatches = (
  local: readonly {
    completeAtStep: number;
    outputs: readonly { resourceId: string; amount: number }[];
  }[],
  remote: readonly {
    completeAtStep: number;
    outputs: readonly { resourceId: string; amount: number }[];
  }[],
): readonly TransformBatchDiff[] | undefined => {
  const diffs: TransformBatchDiff[] = [];
  const maxLength = Math.max(local.length, remote.length);

  for (let index = 0; index < maxLength; index += 1) {
    const localBatch = local[index];
    const remoteBatch = remote[index];
    const diff: Mutable<TransformBatchDiff> = { index };
    let hasDiff = false;

    hasDiff =
      recordMissingDiff(
        diff,
        localBatch !== undefined,
        remoteBatch !== undefined,
      ) || hasDiff;
    hasDiff =
      recordValueDiff(
        diff,
        'completeAtStep',
        localBatch?.completeAtStep,
        remoteBatch?.completeAtStep,
      ) || hasDiff;

    const outputDiffs = compareTransformOutputs(
      localBatch?.outputs ?? [],
      remoteBatch?.outputs ?? [],
    );
    if (outputDiffs) {
      diff.outputs = outputDiffs;
      hasDiff = true;
    }

    if (hasDiff) {
      diffs.push(diff);
    }
  }

  return diffs.length > 0 ? diffs : undefined;
};

const compareTransforms = (
  local: readonly SerializedTransformState[],
  remote: readonly SerializedTransformState[],
): ReadonlyMap<string, TransformDiff> => {
  const diffs = new Map<string, TransformDiff>();
  const localMap = mapById(local);
  const remoteMap = mapById(remote);
  const ids = collectSortedIds(
    Array.from(localMap.keys()),
    Array.from(remoteMap.keys()),
  );

  for (const id of ids) {
    const localEntry = localMap.get(id);
    const remoteEntry = remoteMap.get(id);
    const diff: Mutable<TransformDiff> = { id };
    let hasDiff = false;

    hasDiff =
      recordMissingDiff(
        diff,
        localEntry !== undefined,
        remoteEntry !== undefined,
      ) || hasDiff;
    hasDiff =
      recordValueDiff(
        diff,
        'unlocked',
        localEntry?.unlocked,
        remoteEntry?.unlocked,
      ) || hasDiff;
    hasDiff =
      recordValueDiff(
        diff,
        'cooldownExpiresStep',
        localEntry?.cooldownExpiresStep,
        remoteEntry?.cooldownExpiresStep,
      ) || hasDiff;

    const localHasBatches = localEntry?.batches !== undefined;
    const remoteHasBatches = remoteEntry?.batches !== undefined;
    if (localHasBatches !== remoteHasBatches) {
      diff.batchesDefined = {
        local: localHasBatches,
        remote: remoteHasBatches,
      };
      hasDiff = true;
    }

    const batchDiffs = compareTransformBatches(
      localEntry?.batches ?? [],
      remoteEntry?.batches ?? [],
    );
    if (batchDiffs) {
      diff.batches = batchDiffs;
      hasDiff = true;
    }

    if (hasDiff) {
      diffs.set(id, diff);
    }
  }

  return diffs;
};

const compareCommandQueue = (
  local: SerializedCommandQueueV1,
  remote: SerializedCommandQueueV1,
): CommandQueueDiff | undefined => {
  const missingInLocal: string[] = [];
  const missingInRemote: string[] = [];
  const entryDiffs: CommandQueueEntryDiff[] = [];
  let hasDiff = false;

  const diff: Mutable<CommandQueueDiff> = {
    entryCountDiff: {
      local: local.entries.length,
      remote: remote.entries.length,
    },
    missingInLocal,
    missingInRemote,
  };

  if (!valuesEqual(local.schemaVersion, remote.schemaVersion)) {
    diff.schemaVersion = {
      local: local.schemaVersion,
      remote: remote.schemaVersion,
    };
    hasDiff = true;
  }

  if (local.entries.length !== remote.entries.length) {
    hasDiff = true;
  }

  const maxLength = Math.max(local.entries.length, remote.entries.length);
  for (let index = 0; index < maxLength; index += 1) {
    const localEntry = local.entries[index];
    const remoteEntry = remote.entries[index];
    const entryDiff: Mutable<CommandQueueEntryDiff> = { index };
    let entryHasDiff = false;

    entryHasDiff =
      recordMissingDiff(
        entryDiff,
        localEntry !== undefined,
        remoteEntry !== undefined,
      ) || entryHasDiff;
    entryHasDiff =
      recordValueDiff(
        entryDiff,
        'type',
        localEntry?.type,
        remoteEntry?.type,
      ) || entryHasDiff;
    entryHasDiff =
      recordValueDiff(
        entryDiff,
        'priority',
        localEntry?.priority,
        remoteEntry?.priority,
      ) || entryHasDiff;
    entryHasDiff =
      recordValueDiff(
        entryDiff,
        'timestamp',
        localEntry?.timestamp,
        remoteEntry?.timestamp,
      ) || entryHasDiff;
    entryHasDiff =
      recordValueDiff(
        entryDiff,
        'step',
        localEntry?.step,
        remoteEntry?.step,
      ) || entryHasDiff;
    entryHasDiff =
      recordValueDiff(
        entryDiff,
        'payload',
        localEntry?.payload,
        remoteEntry?.payload,
        valuesEqual,
      ) || entryHasDiff;

    if (entryHasDiff) {
      entryDiffs.push(entryDiff);
      hasDiff = true;
      if (!localEntry && remoteEntry) {
        missingInLocal.push(remoteEntry.type);
      } else if (localEntry && !remoteEntry) {
        missingInRemote.push(localEntry.type);
      }
    }
  }

  if (entryDiffs.length > 0) {
    diff.entryDiffs = entryDiffs;
  }

  return hasDiff ? diff : undefined;
};

/**
 * Compare two snapshots and return detailed differences.
 * Useful for debugging desync issues.
 *
 * @example
 * ```typescript
 * const diff = compareStates(localSnapshot, remoteSnapshot);
 * if (!diff.identical) {
 *   console.log('Divergence detected:', diff);
 * }
 * ```
 */
export function compareStates(
  local: GameStateSnapshot,
  remote: GameStateSnapshot,
): StateDiff {
  const result: Mutable<Omit<StateDiff, 'identical'>> = {};
  let identical = true;

  if (!valuesEqual(local.version, remote.version)) {
    result.version = { local: local.version, remote: remote.version };
    identical = false;
  }

  const runtimeDiff = compareRuntime(local.runtime, remote.runtime);
  if (runtimeDiff) {
    result.runtime = runtimeDiff;
    identical = false;
  }

  const resourceDiff = compareResourceState(local.resources, remote.resources);
  if (resourceDiff.definitionDigest) {
    result.resourceDefinitionDigest = resourceDiff.definitionDigest;
    identical = false;
  }
  if (resourceDiff.diffs.size > 0) {
    result.resources = resourceDiff.diffs;
    identical = false;
  }

  const progressionDiff = compareProgression(local.progression, remote.progression);
  if (progressionDiff) {
    result.progression = progressionDiff;
    identical = false;
  }

  const automationDiff = compareAutomation(local.automation, remote.automation);
  if (automationDiff.size > 0) {
    result.automation = automationDiff;
    identical = false;
  }

  const transformDiff = compareTransforms(local.transforms, remote.transforms);
  if (transformDiff.size > 0) {
    result.transforms = transformDiff;
    identical = false;
  }

  const commandQueueDiff = compareCommandQueue(
    local.commandQueue,
    remote.commandQueue,
  );
  if (commandQueueDiff) {
    result.commandQueue = commandQueueDiff;
    identical = false;
  }

  return { identical, ...result };
}

/**
 * Quick divergence check using checksums only.
 * Use this for periodic sync checks; fall back to compareStates() for debugging.
 *
 * @example
 * ```typescript
 * if (hasStateDiverged(localSnapshot, remoteSnapshot)) {
 *   const diff = compareStates(localSnapshot, remoteSnapshot);
 *   console.warn('Desync details:', diff);
 * }
 * ```
 */
export function hasStateDiverged(
  local: GameStateSnapshot,
  remote: GameStateSnapshot,
): boolean {
  return computeStateChecksum(local) !== computeStateChecksum(remote);
}
