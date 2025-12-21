import { describe, expect, it } from 'vitest';

import { CommandPriority } from '../command.js';
import type { SerializedCommandQueueV1 } from '../command-queue.js';
import type { SerializedProgressionCoordinatorStateV2 } from '../progression-coordinator-save.js';
import type { SerializedResourceState } from '../resource-state.js';
import type { GameStateSnapshot } from './types.js';

import { computePartialChecksum, computeStateChecksum, fnv1a32 } from './checksum.js';

const resourcesA: SerializedResourceState = {
  ids: ['resource.energy'],
  amounts: [10],
  capacities: [null],
  flags: [0],
};

const resourcesB: SerializedResourceState = {
  amounts: [10],
  flags: [0],
  capacities: [null],
  ids: ['resource.energy'],
};

const progressionA: SerializedProgressionCoordinatorStateV2 = {
  schemaVersion: 2,
  step: 10,
  resources: resourcesA,
  generators: [],
  upgrades: [],
  achievements: [],
};

const progressionB: SerializedProgressionCoordinatorStateV2 = {
  upgrades: [],
  achievements: [],
  generators: [],
  resources: resourcesB,
  step: 10,
  schemaVersion: 2,
};

const commandQueueA: SerializedCommandQueueV1 = {
  schemaVersion: 1,
  entries: [],
};

const commandQueueB: SerializedCommandQueueV1 = {
  entries: [],
  schemaVersion: 1,
};

const snapshotA: GameStateSnapshot = {
  version: 1,
  capturedAt: 111,
  runtime: {
    step: 5,
    stepSizeMs: 100,
    rngSeed: 42,
    rngState: 1337,
  },
  resources: resourcesA,
  progression: progressionA,
  automation: [],
  transforms: [],
  commandQueue: commandQueueA,
};

const snapshotB: GameStateSnapshot = {
  capturedAt: 222,
  version: 1,
  runtime: {
    rngSeed: 42,
    stepSizeMs: 100,
    step: 5,
    rngState: 1337,
  },
  resources: resourcesB,
  progression: progressionB,
  automation: [],
  transforms: [],
  commandQueue: commandQueueB,
};

describe('fnv1a32', () => {
  it('hashes known input to expected 32-bit hex string', () => {
    const bytes = new TextEncoder().encode('hello');
    expect(fnv1a32(bytes)).toBe('4f9f2cab');
  });
});

describe('computeStateChecksum', () => {
  it('is deterministic across key ordering and ignores capturedAt', () => {
    expect(computeStateChecksum(snapshotA)).toBe(computeStateChecksum(snapshotB));
  });

  it('changes when snapshot contents change', () => {
    const changed: GameStateSnapshot = {
      ...snapshotA,
      runtime: {
        ...snapshotA.runtime,
        step: snapshotA.runtime.step + 1,
      },
    };

    expect(computeStateChecksum(snapshotA)).not.toBe(computeStateChecksum(changed));
  });

  it('changes when rngState changes', () => {
    const changed: GameStateSnapshot = {
      ...snapshotA,
      runtime: {
        ...snapshotA.runtime,
        rngState: 1338,
      },
    };

    expect(computeStateChecksum(snapshotA)).not.toBe(computeStateChecksum(changed));
  });
});

describe('computePartialChecksum', () => {
  it('is order-independent and ignores omitted keys', () => {
    const withCommands: GameStateSnapshot = {
      ...snapshotA,
      commandQueue: {
        schemaVersion: 1,
        entries: [
          {
            type: 'command.test',
            priority: CommandPriority.PLAYER,
            timestamp: 123,
            step: 5,
            payload: { amount: 2 },
          },
        ],
      },
    };

    const checksumA = computePartialChecksum(snapshotA, ['resources', 'runtime']);
    const checksumB = computePartialChecksum(snapshotA, ['runtime', 'resources']);
    const checksumC = computePartialChecksum(withCommands, ['resources', 'runtime']);

    expect(checksumA).toBe(checksumB);
    expect(checksumA).toBe(checksumC);
  });
});
