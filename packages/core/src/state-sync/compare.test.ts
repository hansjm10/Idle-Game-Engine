import { describe, expect, it } from 'vitest';

import type { SerializedAutomationState } from '../automation-system.js';
import { CommandPriority } from '../command.js';
import type { SerializedCommandQueueV1 } from '../command-queue.js';
import type { SerializedEntitySystemState } from '../entity-system.js';
import type { SerializedProductionAccumulators } from '../production-system.js';
import type { SerializedProgressionCoordinatorStateV2 } from '../progression-coordinator-save.js';
import type {
  ResourceDefinitionDigest,
  SerializedResourceState,
} from '../resource-state.js';
import type { SerializedTransformState } from '../transform-system.js';
import type { GameStateSnapshot } from './types.js';

import { compareStates, hasStateDiverged } from './compare.js';

const definitionDigest: ResourceDefinitionDigest = {
  ids: ['resource.energy'],
  version: 1,
  hash: 'digest-energy',
};

const baseResources: SerializedResourceState = {
  ids: ['resource.energy'],
  amounts: [10],
  capacities: [null],
  unlocked: [true],
  visible: [true],
  flags: [3],
  definitionDigest,
};

const baseAccumulators: SerializedProductionAccumulators = {
  accumulators: {
    'generator.energy:produce:resource.energy': 0.25,
  },
};

const baseProgression: SerializedProgressionCoordinatorStateV2 = {
  schemaVersion: 2,
  step: 5,
  resources: baseResources,
  generators: [
    {
      id: 'generator.energy',
      owned: 1,
      enabled: true,
      isUnlocked: true,
      nextPurchaseReadyAtStep: 3,
    },
  ],
  upgrades: [
    {
      id: 'upgrade.energy',
      purchases: 1,
    },
  ],
  achievements: [
    {
      id: 'achievement.energy',
      completions: 1,
      progress: 0.5,
      nextRepeatableAtStep: 10,
      lastCompletedStep: 5,
    },
  ],
  productionAccumulators: baseAccumulators,
};

const baseAutomation: SerializedAutomationState[] = [
  {
    id: 'automation.energy',
    enabled: true,
    lastFiredStep: 1,
    cooldownExpiresStep: 2,
    unlocked: true,
    lastThresholdSatisfied: true,
  },
];

const baseTransforms: SerializedTransformState[] = [
  {
    id: 'transform.energy',
    unlocked: true,
    cooldownExpiresStep: 10,
    batches: [
      {
        completeAtStep: 11,
        outputs: [
          {
            resourceId: 'resource.energy',
            amount: 2,
          },
        ],
      },
    ],
  },
];

const baseEntities: SerializedEntitySystemState = {
  entities: [],
  instances: [],
  entityInstances: [],
};

const baseCommandQueue: SerializedCommandQueueV1 = {
  schemaVersion: 1,
  entries: [
    {
      type: 'command.test',
      priority: CommandPriority.PLAYER,
      timestamp: 100,
      step: 5,
      payload: { value: 1 },
    },
  ],
};

const clone = <T>(value: T): T => structuredClone(value);

const createSnapshot = (): GameStateSnapshot => {
  const resources = clone(baseResources);
  const progression: SerializedProgressionCoordinatorStateV2 = {
    ...clone(baseProgression),
    resources,
  };

  return {
    version: 1,
    capturedAt: 1000,
    runtime: {
      step: 5,
      stepSizeMs: 100,
      rngSeed: 42,
      rngState: 1337,
    },
    resources,
    progression,
    automation: clone(baseAutomation),
    transforms: clone(baseTransforms),
    entities: clone(baseEntities),
    prd: {},
    commandQueue: clone(baseCommandQueue),
  };
};

const createSnapshotWithQueue = (
  entries: SerializedCommandQueueV1['entries'],
): GameStateSnapshot => ({
  ...createSnapshot(),
  commandQueue: {
    ...clone(baseCommandQueue),
    entries: clone(entries),
  },
});

const createQueueEntry = (
  overrides: Partial<SerializedCommandQueueV1['entries'][number]> = {},
): SerializedCommandQueueV1['entries'][number] => ({
  ...clone(baseCommandQueue.entries[0]),
  ...overrides,
});

describe('compareStates', () => {
  it('returns identical for matching snapshots and ignores capturedAt', () => {
    const local = createSnapshot();
    const remote = {
      ...local,
      capturedAt: local.capturedAt + 1,
    };

    const diff = compareStates(local, remote);

    expect(diff.identical).toBe(true);
    expect(diff.runtime).toBeUndefined();
    expect(diff.resources).toBeUndefined();
    expect(diff.progression).toBeUndefined();
  });

  it('reports runtime, resource, and progression differences', () => {
    const local = createSnapshot();
    const updatedResources: SerializedResourceState = {
      ...local.resources,
      amounts: [20],
    };
    const remoteProgression: SerializedProgressionCoordinatorStateV2 = {
      ...local.progression,
      resources: updatedResources,
      generators: [
        {
          ...local.progression.generators[0],
          owned: 2,
        },
      ],
    };
    const remote: GameStateSnapshot = {
      ...local,
      runtime: {
        ...local.runtime,
        step: local.runtime.step + 1,
        rngState: (local.runtime.rngState ?? 0) + 1,
      },
      resources: updatedResources,
      progression: remoteProgression,
    };

    const diff = compareStates(local, remote);

    expect(diff.identical).toBe(false);
    expect(diff.runtime?.step).toEqual({ local: 5, remote: 6 });
    expect(diff.runtime?.rngState).toEqual({ local: 1337, remote: 1338 });
    expect(diff.resources?.get('resource.energy')?.amount).toEqual({
      local: 10,
      remote: 20,
    });
    expect(
      diff.progression?.generators?.get('generator.energy')?.owned,
    ).toEqual({ local: 1, remote: 2 });
  });

  it('reports automation, transform, and command queue differences', () => {
    const local = createSnapshot();
    const updatedAutomation: SerializedAutomationState[] = [
      {
        ...local.automation[0],
        lastFiredStep: 2,
      },
    ];
    const baseBatch = local.transforms[0].batches?.[0];
    const updatedBatch = baseBatch
      ? {
          ...baseBatch,
          outputs: [
            {
              resourceId: 'resource.energy',
              amount: 3,
            },
          ],
        }
      : {
          completeAtStep: 0,
          outputs: [
            {
              resourceId: 'resource.energy',
              amount: 3,
            },
          ],
        };
    const updatedTransforms: SerializedTransformState[] = [
      {
        ...local.transforms[0],
        batches: [updatedBatch],
      },
    ];
    const updatedCommandQueue: SerializedCommandQueueV1 = {
      ...local.commandQueue,
      entries: [
        {
          ...local.commandQueue.entries[0],
          payload: { value: 2 },
        },
      ],
    };
    const remote: GameStateSnapshot = {
      ...local,
      automation: updatedAutomation,
      transforms: updatedTransforms,
      commandQueue: updatedCommandQueue,
    };

    const diff = compareStates(local, remote);

    expect(
      diff.automation?.get('automation.energy')?.lastFiredStep,
    ).toEqual({ local: 1, remote: 2 });
    expect(
      diff.transforms
        ?.get('transform.energy')
        ?.batches?.[0]
        .outputs?.[0]
        .amount,
    ).toEqual({ local: 2, remote: 3 });
    expect(diff.commandQueue?.entryDiffs?.[0].payload).toEqual({
      local: { value: 1 },
      remote: { value: 2 },
    });
  });

  it.each([
    {
      label: 'missing local entries',
      localEntries: [createQueueEntry()],
      remoteEntries: [
        createQueueEntry(),
        createQueueEntry({ type: 'command.extra', timestamp: 200, step: 6 }),
      ],
      expectedMissingInLocal: ['command.extra'],
      expectedMissingInRemote: [],
    },
    {
      label: 'missing remote entries',
      localEntries: [
        createQueueEntry(),
        createQueueEntry({ type: 'command.extra', timestamp: 200, step: 6 }),
      ],
      remoteEntries: [createQueueEntry()],
      expectedMissingInLocal: [],
      expectedMissingInRemote: ['command.extra'],
    },
  ])('reports $label in command queue diff', ({
    localEntries,
    remoteEntries,
    expectedMissingInLocal,
    expectedMissingInRemote,
  }) => {
    const local = createSnapshotWithQueue(localEntries);
    const remote = createSnapshotWithQueue(remoteEntries);

    const diff = compareStates(local, remote);

    expect(diff.identical).toBe(false);
    expect(diff.commandQueue?.entryCountDiff).toEqual({
      local: localEntries.length,
      remote: remoteEntries.length,
    });
    expect(diff.commandQueue?.missingInLocal).toEqual(expectedMissingInLocal);
    expect(diff.commandQueue?.missingInRemote).toEqual(expectedMissingInRemote);
  });

  it('reports entity instance list differences', () => {
    const local = createSnapshot();
    const localEntities: SerializedEntitySystemState = {
      entities: [
        {
          id: 'entity.worker',
          count: 2,
          availableCount: 2,
          unlocked: true,
          visible: true,
        },
      ],
      instances: [
        {
          instanceId: 'worker-1',
          entityId: 'entity.worker',
          level: 1,
          experience: 0,
          stats: {},
          assignment: null,
        },
        {
          instanceId: 'worker-2',
          entityId: 'entity.worker',
          level: 1,
          experience: 0,
          stats: {},
          assignment: null,
        },
      ],
      entityInstances: [
        {
          entityId: 'entity.worker',
          instanceIds: ['worker-1', 'worker-2'],
        },
      ],
    };
    const remoteEntities: SerializedEntitySystemState = {
      ...localEntities,
      entityInstances: [
        {
          entityId: 'entity.worker',
          instanceIds: ['worker-2', 'worker-1'],
        },
      ],
    };
    const remote: GameStateSnapshot = {
      ...local,
      entities: remoteEntities,
    };

    const diff = compareStates(
      { ...local, entities: localEntities },
      remote,
    );

    expect(diff.identical).toBe(false);
    expect(
      diff.entityInstanceLists?.get('entity.worker')?.instanceIds,
    ).toEqual({
      local: ['worker-1', 'worker-2'],
      remote: ['worker-2', 'worker-1'],
    });
    expect(diff.entityInstances).toBeUndefined();
  });
});

describe('hasStateDiverged', () => {
  it('detects checksum mismatches', () => {
    const local = createSnapshot();
    const remote = createSnapshot();

    expect(hasStateDiverged(local, remote)).toBe(false);

    const updatedRemote: GameStateSnapshot = {
      ...remote,
      runtime: { ...remote.runtime, step: remote.runtime.step + 1 },
    };

    expect(hasStateDiverged(local, updatedRemote)).toBe(true);
  });
});
