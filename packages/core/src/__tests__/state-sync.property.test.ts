import { afterEach, describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import type { JsonValue } from '../command-queue.js';
import type {
  SerializedProgressionAchievementStateV2,
  SerializedProgressionCoordinatorStateV2,
  SerializedProgressionGeneratorStateV1,
  SerializedProgressionUpgradeStateV1,
} from '../progression-coordinator-save.js';
import type { ResourceDefinition } from '../resource-state.js';
import type { GameStateSnapshot } from '../state-sync/types.js';

import { CommandPriority, RUNTIME_COMMAND_TYPES } from '../command.js';
import {
  captureGameStateSnapshot,
  compareStates,
  computeStateChecksum,
  createProgressionCoordinator,
  IdleEngineRuntime,
  restoreFromSnapshot,
} from '../index.js';
import {
  createAchievementDefinition,
  createContentPack,
  createGeneratorDefinition,
  createResourceDefinition,
  createUpgradeDefinition,
  literalOne,
} from '../content-test-helpers.js';
import { hydrateProgressionCoordinatorState } from '../progression-coordinator-save.js';
import { resetRNG, setRNGSeed } from '../rng.js';

const STEP_SIZE_MS = 100;
const PROPERTY_SEED = 579000;
const PROPERTY_RUNS = 1000;
const MAX_RESOURCE_COUNT = 100;
const MAX_STEP = 5000;
const MAX_AMOUNT = 1_000_000;
const MAX_CAPACITY = 1_000_000;
const MAX_GENERATORS = 20;
const MAX_UPGRADES = 20;
const MAX_ACHIEVEMENTS = 20;
const MAX_COMMANDS = 20;

const propertyConfig = (offset: number): fc.Parameters<unknown> => ({
  seed: PROPERTY_SEED + offset,
  numRuns: PROPERTY_RUNS,
  endOnFailure: true,
});

type ResourceEntry = Readonly<{
  amount: number;
  capacity: number | null;
  unlocked: boolean;
  visible: boolean;
}>;

type GeneratorEntry = Readonly<{
  owned: number;
  enabled: boolean;
  isUnlocked: boolean;
  nextPurchaseReadyAtStep?: number;
}>;

type UpgradeEntry = Readonly<{
  purchases: number;
}>;

type AchievementEntry = Readonly<{
  completions: number;
  progress: number;
  nextRepeatableAtStep?: number;
  lastCompletedStep?: number;
}>;

type CommandEntry = Readonly<{
  type: string;
  priority: CommandPriority;
  timestamp: number;
  step: number;
  payload: JsonValue;
}>;

type StateSeed = Readonly<{
  step: number;
  rngSeed: number;
  resources: readonly ResourceEntry[];
  generators: readonly GeneratorEntry[];
  upgrades: readonly UpgradeEntry[];
  achievements: readonly AchievementEntry[];
  commands: readonly CommandEntry[];
}>;

const jsonPrimitiveArb = fc.oneof(
  fc.boolean(),
  fc.double({
    min: -MAX_AMOUNT,
    max: MAX_AMOUNT,
    noNaN: true,
    noDefaultInfinity: true,
  }),
  fc.string({ maxLength: 12 }),
  fc.constant(null),
);

const jsonValueArb = fc.letrec((tie) => ({
  json: fc.oneof(
    jsonPrimitiveArb,
    fc.array(tie('json'), { maxLength: 4 }),
    fc.dictionary(fc.string({ maxLength: 8 }), tie('json'), { maxKeys: 4 }),
  ),
})).json as fc.Arbitrary<JsonValue>;

const resourceEntryArb: fc.Arbitrary<ResourceEntry> = fc
  .record({
    amount: fc.double({
      min: 0,
      max: MAX_AMOUNT,
      noNaN: true,
      noDefaultInfinity: true,
    }),
    capacity: fc.option(
      fc.double({
        min: 0,
        max: MAX_CAPACITY,
        noNaN: true,
        noDefaultInfinity: true,
      }),
      { nil: null },
    ),
    unlocked: fc.boolean(),
    visible: fc.boolean(),
  })
  .map((entry) => ({
    ...entry,
    amount:
      entry.capacity === null
        ? entry.amount
        : Math.min(entry.amount, entry.capacity),
  }));

const generatorEntryArb: fc.Arbitrary<GeneratorEntry> = fc.record({
  owned: fc.nat({ max: 2000 }),
  enabled: fc.boolean(),
  isUnlocked: fc.boolean(),
  nextPurchaseReadyAtStep: fc.option(fc.nat({ max: MAX_STEP }), {
    nil: undefined,
  }),
});

const upgradeEntryArb: fc.Arbitrary<UpgradeEntry> = fc.record({
  purchases: fc.nat({ max: 500 }),
});

const achievementEntryArb: fc.Arbitrary<AchievementEntry> = fc.record({
  completions: fc.nat({ max: 500 }),
  progress: fc.double({
    min: 0,
    max: MAX_AMOUNT,
    noNaN: true,
    noDefaultInfinity: true,
  }),
  nextRepeatableAtStep: fc.option(fc.nat({ max: MAX_STEP }), {
    nil: undefined,
  }),
  lastCompletedStep: fc.option(fc.nat({ max: MAX_STEP }), {
    nil: undefined,
  }),
});

const commandTypeValues = Object.values(RUNTIME_COMMAND_TYPES);

const commandEntryArb: fc.Arbitrary<CommandEntry> = fc.record({
  type: fc.constantFrom(...commandTypeValues),
  priority: fc.constantFrom(
    CommandPriority.SYSTEM,
    CommandPriority.PLAYER,
    CommandPriority.AUTOMATION,
  ),
  timestamp: fc.integer({ min: 0, max: MAX_AMOUNT }),
  step: fc.nat({ max: MAX_STEP }),
  payload: jsonValueArb,
});

const stateSeedArb: fc.Arbitrary<StateSeed> = fc
  .record({
    step: fc.nat({ max: MAX_STEP }),
    rngSeed: fc.nat({ max: 2_000_000_000 }),
    resourceCount: fc.integer({ min: 1, max: MAX_RESOURCE_COUNT }),
    generatorCount: fc.integer({ min: 0, max: MAX_GENERATORS }),
    upgradeCount: fc.integer({ min: 0, max: MAX_UPGRADES }),
    achievementCount: fc.integer({ min: 0, max: MAX_ACHIEVEMENTS }),
    commandCount: fc.integer({ min: 0, max: MAX_COMMANDS }),
  })
  .chain((counts) =>
    fc.record({
      step: fc.constant(counts.step),
      rngSeed: fc.constant(counts.rngSeed),
      resources: fc.array(resourceEntryArb, {
        minLength: counts.resourceCount,
        maxLength: counts.resourceCount,
      }),
      generators: fc.array(generatorEntryArb, {
        minLength: counts.generatorCount,
        maxLength: counts.generatorCount,
      }),
      upgrades: fc.array(upgradeEntryArb, {
        minLength: counts.upgradeCount,
        maxLength: counts.upgradeCount,
      }),
      achievements: fc.array(achievementEntryArb, {
        minLength: counts.achievementCount,
        maxLength: counts.achievementCount,
      }),
      commands: fc.array(commandEntryArb, {
        minLength: counts.commandCount,
        maxLength: counts.commandCount,
      }),
    }),
  );

const buildResourceIds = (count: number): string[] => {
  if (count === 0) {
    return [];
  }

  const ids = ['resource.energy'];
  for (let index = 1; index < count; index += 1) {
    ids.push(`resource.generated.${index}`);
  }
  return ids;
};

const createResourceDefinitions = (
  resources: readonly {
    readonly id: string;
    readonly startAmount?: number;
    readonly capacity?: number | null;
    readonly unlocked?: boolean;
    readonly visible?: boolean;
    readonly dirtyTolerance?: number;
  }[],
): ResourceDefinition[] =>
  resources.map((resource) => ({
    id: resource.id,
    startAmount: resource.startAmount ?? 0,
    capacity:
      resource.capacity === null || resource.capacity === undefined
        ? undefined
        : resource.capacity,
    unlocked: resource.unlocked ?? false,
    visible: resource.visible ?? true,
    dirtyTolerance: resource.dirtyTolerance ?? undefined,
  }));

const buildSnapshotFromSeed = (
  seed: StateSeed,
): {
  snapshot: GameStateSnapshot;
  content: ReturnType<typeof createContentPack>;
  resourceDefinitions: ResourceDefinition[];
} => {
  const resourceIds = buildResourceIds(seed.resources.length);
  const resources = resourceIds.map((id, index) =>
    createResourceDefinition(id, {
      startAmount: seed.resources[index]?.amount ?? 0,
      capacity: seed.resources[index]?.capacity ?? null,
      unlocked: seed.resources[index]?.unlocked ?? false,
      visible: seed.resources[index]?.visible ?? true,
    }),
  );

  const generators = seed.generators.map((_, index) =>
    createGeneratorDefinition(`generator.test.${index}`, {
      purchase: {
        currencyId: resourceIds[0] ?? 'resource.energy',
        baseCost: 1,
        costCurve: literalOne,
      },
    }),
  );

  const upgrades = seed.upgrades.map((_, index) =>
    createUpgradeDefinition(`upgrade.test.${index}`, {
      cost: {
        currencyId: resourceIds[0] ?? 'resource.energy',
        baseCost: 1,
        costCurve: literalOne,
      },
    }),
  );

  const achievements = seed.achievements.map((_, index) =>
    createAchievementDefinition(`achievement.test.${index}`),
  );

  const content = createContentPack({
    resources,
    generators,
    upgrades,
    achievements,
  });

  const resourceDefinitions = createResourceDefinitions(content.resources);

  const coordinator = createProgressionCoordinator({
    content,
    stepDurationMs: STEP_SIZE_MS,
  });

  const generatorStates: SerializedProgressionGeneratorStateV1[] =
    seed.generators.map((entry, index) => ({
      id: `generator.test.${index}`,
      owned: entry.owned,
      enabled: entry.enabled,
      isUnlocked: entry.isUnlocked,
      nextPurchaseReadyAtStep: entry.nextPurchaseReadyAtStep,
    }));

  const upgradeStates: SerializedProgressionUpgradeStateV1[] =
    seed.upgrades.map((entry, index) => ({
      id: `upgrade.test.${index}`,
      purchases: entry.purchases,
    }));

  const achievementStates: SerializedProgressionAchievementStateV2[] =
    seed.achievements.map((entry, index) => ({
      id: `achievement.test.${index}`,
      completions: entry.completions,
      progress: entry.progress,
      nextRepeatableAtStep: entry.nextRepeatableAtStep,
      lastCompletedStep: entry.lastCompletedStep,
    }));

  const progressionState: SerializedProgressionCoordinatorStateV2 = {
    schemaVersion: 2,
    step: seed.step,
    resources: coordinator.resourceState.exportForSave(),
    generators: generatorStates,
    upgrades: upgradeStates,
    achievements: achievementStates,
  };

  hydrateProgressionCoordinatorState(progressionState, coordinator, undefined, {
    skipResources: true,
  });

  const runtime = new IdleEngineRuntime({
    stepSizeMs: STEP_SIZE_MS,
    initialStep: seed.step,
  });

  const commandQueue = runtime.getCommandQueue();
  for (const command of seed.commands) {
    commandQueue.enqueue({
      type: command.type,
      priority: command.priority,
      payload: command.payload,
      timestamp: command.timestamp,
      step: command.step,
    });
  }

  const emptyAutomationState = new Map();
  const emptyTransformState = new Map();

  setRNGSeed(seed.rngSeed);

  const snapshot = captureGameStateSnapshot({
    runtime,
    progressionCoordinator: coordinator,
    capturedAt: 0,
    getAutomationState: () => emptyAutomationState,
    getTransformState: () => emptyTransformState,
    commandQueue,
  });

  return { snapshot, content, resourceDefinitions };
};

const roundTripSnapshot = (
  snapshot: GameStateSnapshot,
  content: ReturnType<typeof createContentPack>,
  resourceDefinitions: ResourceDefinition[],
): GameStateSnapshot => {
  const seed = snapshot.runtime.rngSeed ?? 0;
  setRNGSeed(seed + 1);

  const restored = restoreFromSnapshot({
    snapshot,
    resourceDefinitions,
  });

  const restoredCoordinator = createProgressionCoordinator({
    content,
    stepDurationMs: STEP_SIZE_MS,
    initialState: {
      stepDurationMs: STEP_SIZE_MS,
      resources: {
        state: restored.resources,
      },
    },
  });

  hydrateProgressionCoordinatorState(
    snapshot.progression,
    restoredCoordinator,
    undefined,
    { skipResources: true },
  );

  const emptyAutomationState = new Map();
  const emptyTransformState = new Map();

  return captureGameStateSnapshot({
    runtime: restored.runtime as IdleEngineRuntime,
    progressionCoordinator: restoredCoordinator,
    capturedAt: 0,
    getAutomationState: () => emptyAutomationState,
    getTransformState: () => emptyTransformState,
    commandQueue: restored.commandQueue,
  });
};

const buildEmptySnapshot = (): {
  snapshot: GameStateSnapshot;
  content: ReturnType<typeof createContentPack>;
  resourceDefinitions: ResourceDefinition[];
} => {
  const content = createContentPack({
    resources: [],
    generators: [],
    upgrades: [],
    achievements: [],
  });

  const resourceDefinitions: ResourceDefinition[] = [];
  const coordinator = createProgressionCoordinator({
    content,
    stepDurationMs: STEP_SIZE_MS,
  });

  const progressionState: SerializedProgressionCoordinatorStateV2 = {
    schemaVersion: 2,
    step: 0,
    resources: coordinator.resourceState.exportForSave(),
    generators: [],
    upgrades: [],
    achievements: [],
  };

  hydrateProgressionCoordinatorState(progressionState, coordinator, undefined, {
    skipResources: true,
  });

  const runtime = new IdleEngineRuntime({
    stepSizeMs: STEP_SIZE_MS,
    initialStep: 0,
  });

  const emptyAutomationState = new Map();
  const emptyTransformState = new Map();

  setRNGSeed(0);

  const snapshot = captureGameStateSnapshot({
    runtime,
    progressionCoordinator: coordinator,
    capturedAt: 0,
    getAutomationState: () => emptyAutomationState,
    getTransformState: () => emptyTransformState,
    commandQueue: runtime.getCommandQueue(),
  });

  return { snapshot, content, resourceDefinitions };
};

describe('state sync property suites', () => {
  afterEach(() => {
    resetRNG();
  });

  it('round-trips snapshots across random states', () => {
    fc.assert(
      fc.property(stateSeedArb, (seed) => {
        const { snapshot, content, resourceDefinitions } = buildSnapshotFromSeed(seed);
        const roundTrip = roundTripSnapshot(
          snapshot,
          content,
          resourceDefinitions,
        );

        expect(roundTrip).toEqual(snapshot);
      }),
      propertyConfig(0),
    );
  });

  it('produces deterministic and unique checksums', () => {
    fc.assert(
      fc.property(stateSeedArb, (seed) => {
        const { snapshot } = buildSnapshotFromSeed(seed);
        const checksum = computeStateChecksum(snapshot);

        expect(computeStateChecksum(snapshot)).toBe(checksum);

        const mutated: GameStateSnapshot = {
          ...snapshot,
          runtime: {
            ...snapshot.runtime,
            step: snapshot.runtime.step + 1,
          },
        };

        expect(computeStateChecksum(mutated)).not.toBe(checksum);
      }),
      propertyConfig(1),
    );
  });

  it('compares snapshots symmetrically', () => {
    fc.assert(
      fc.property(stateSeedArb, (seed) => {
        const { snapshot } = buildSnapshotFromSeed(seed);
        const mutated: GameStateSnapshot = {
          ...snapshot,
          runtime: {
            ...snapshot.runtime,
            step: snapshot.runtime.step + 1,
          },
        };

        const forward = compareStates(snapshot, mutated);
        const reverse = compareStates(mutated, snapshot);

        expect(compareStates(snapshot, snapshot).identical).toBe(true);
        expect(forward.identical).toBe(false);
        expect(reverse.identical).toBe(false);
        expect(forward.runtime?.step).toEqual({
          local: snapshot.runtime.step,
          remote: mutated.runtime.step,
        });
        expect(reverse.runtime?.step).toEqual({
          local: mutated.runtime.step,
          remote: snapshot.runtime.step,
        });
      }),
      propertyConfig(2),
    );
  });
});

describe('state sync edge cases', () => {
  afterEach(() => {
    resetRNG();
  });

  it('round-trips an empty snapshot', () => {
    const { snapshot, content, resourceDefinitions } = buildEmptySnapshot();
    const roundTrip = roundTripSnapshot(snapshot, content, resourceDefinitions);

    expect(roundTrip).toEqual(snapshot);
  });

  it('round-trips a max-sized snapshot', () => {
    const maxSeed: StateSeed = {
      step: MAX_STEP,
      rngSeed: 424242,
      resources: Array.from({ length: MAX_RESOURCE_COUNT }, () => ({
        amount: MAX_AMOUNT,
        capacity: MAX_CAPACITY,
        unlocked: true,
        visible: true,
      })),
      generators: Array.from({ length: MAX_GENERATORS }, () => ({
        owned: 2000,
        enabled: true,
        isUnlocked: true,
        nextPurchaseReadyAtStep: MAX_STEP,
      })),
      upgrades: Array.from({ length: MAX_UPGRADES }, () => ({
        purchases: 500,
      })),
      achievements: Array.from({ length: MAX_ACHIEVEMENTS }, () => ({
        completions: 500,
        progress: MAX_AMOUNT,
        nextRepeatableAtStep: MAX_STEP,
        lastCompletedStep: MAX_STEP,
      })),
      commands: Array.from({ length: MAX_COMMANDS }, (_, index) => ({
        type: commandTypeValues[index % commandTypeValues.length],
        priority: CommandPriority.PLAYER,
        timestamp: MAX_AMOUNT - index,
        step: MAX_STEP,
        payload: { value: index },
      })),
    };

    const { snapshot, content, resourceDefinitions } = buildSnapshotFromSeed(maxSeed);
    const roundTrip = roundTripSnapshot(snapshot, content, resourceDefinitions);

    expect(roundTrip).toEqual(snapshot);
  });
});
