import { describe, expect, it } from 'vitest';

import {
  CommandPriority,
  RUNTIME_COMMAND_TYPES,
  createGameRuntime,
  resetRNG,
  setRNGSeed,
} from '../internals.js';
import {
  createContentPack,
  createResourceDefinition,
} from '../content-test-helpers.js';
import {
  SimReplayRecorder,
  decodeSimReplayJsonLines,
  encodeSimReplayJsonLines,
  runSimReplay,
} from './sim-replay.js';

describe('sim replay', () => {
  it('records, encodes, decodes, and replays deterministically', () => {
    resetRNG();
    setRNGSeed(4242);

    const content = createContentPack({
      resources: [createResourceDefinition('resource.gold')],
      digest: { version: 1, hash: 'fnv1a-00000000' },
    });

    const wiring = createGameRuntime({
      content,
      stepSizeMs: 100,
    });

    const recorder = new SimReplayRecorder({
      content,
      wiring,
      recordedAt: 0,
      capturedAt: 0,
    });

    const enqueueCollect = (amount: number): void => {
      const step = wiring.runtime.getNextExecutableStep();
      const timestamp = wiring.runtime.getCurrentStep() * wiring.runtime.getStepSizeMs();
      const command = {
        type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
        priority: CommandPriority.PLAYER,
        payload: { resourceId: 'resource.gold', amount },
        timestamp,
        step,
      };
      expect(wiring.commandQueue.enqueue(command)).toBe(true);
      recorder.recordCommand(command);
    };

    enqueueCollect(5);
    wiring.runtime.tick(wiring.runtime.getStepSizeMs());

    wiring.runtime.tick(wiring.runtime.getStepSizeMs());

    enqueueCollect(3);
    wiring.runtime.tick(wiring.runtime.getStepSizeMs());

    wiring.runtime.tick(wiring.runtime.getStepSizeMs());
    wiring.runtime.tick(wiring.runtime.getStepSizeMs());

    const replay = recorder.export({ capturedAt: 0 });
    const encoded = encodeSimReplayJsonLines(replay, { maxCommandsPerChunk: 1 });
    const decoded = decodeSimReplayJsonLines(encoded);

    const result = runSimReplay({ content, replay: decoded });
    expect(result.checksum).toBe(replay.sim.endStateChecksum);
  });

  it('fails fast when content digest mismatches', () => {
    resetRNG();
    setRNGSeed(4242);

    const content = createContentPack({
      resources: [createResourceDefinition('resource.gold')],
      digest: { version: 1, hash: 'fnv1a-00000000' },
    });

    const wiring = createGameRuntime({
      content,
      stepSizeMs: 100,
    });

    const recorder = new SimReplayRecorder({
      content,
      wiring,
      recordedAt: 0,
      capturedAt: 0,
    });

    const step = wiring.runtime.getNextExecutableStep();
    const timestamp = wiring.runtime.getCurrentStep() * wiring.runtime.getStepSizeMs();
    const command = {
      type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
      priority: CommandPriority.PLAYER,
      payload: { resourceId: 'resource.gold', amount: 1 },
      timestamp,
      step,
    };
    expect(wiring.commandQueue.enqueue(command)).toBe(true);
    recorder.recordCommand(command);

    wiring.runtime.tick(wiring.runtime.getStepSizeMs());

    const replay = recorder.export({ capturedAt: 0 });
    const decoded = decodeSimReplayJsonLines(encodeSimReplayJsonLines(replay));

    const mismatchedContent = createContentPack({
      resources: [createResourceDefinition('resource.gold')],
      digest: { version: 1, hash: 'fnv1a-deadbeef' },
    });

    expect(() => runSimReplay({ content: mismatchedContent, replay: decoded })).toThrow(
      /Content digest mismatch/i,
    );
  });

  it('rejects invalid replay file headers', () => {
    const encoded = [
      JSON.stringify({
        type: 'header',
        fileType: 'not-a-replay',
        schemaVersion: 1,
        recordedAt: 0,
        runtimeVersion: '0.0.0',
      }),
      JSON.stringify({
        type: 'content',
        packId: 'pack.test',
        packVersion: '1.0.0',
        digest: { version: 1, hash: 'fnv1a-00000000' },
      }),
      JSON.stringify({ type: 'assets', manifestHash: null }),
      JSON.stringify({
        type: 'sim',
        wiring: {
          enableProduction: false,
          enableAutomation: false,
          enableTransforms: false,
          enableEntities: false,
          registerOfflineCatchup: true,
        },
        stepSizeMs: 100,
        startStep: 0,
        initialSnapshot: {
          version: 1,
          capturedAt: 0,
          runtime: { step: 0, stepSizeMs: 100, rngSeed: 0 },
          resources: { ids: [], amounts: [], capacities: [], unlocked: [], visible: [], flags: [] },
          progression: {},
          automation: [],
          transforms: [],
          entities: { entities: [], instances: [], entityInstances: [] },
          prd: {},
          commandQueue: { schemaVersion: 1, entries: [] },
        },
      }),
      JSON.stringify({ type: 'end', endStep: 0, endStateChecksum: '00000000', commandCount: 0 }),
      '',
    ].join('\n');

    expect(() => decodeSimReplayJsonLines(encoded)).toThrow(/fileType is not supported/i);
  });

  it('normalizes and validates replay commands as JSON payloads', () => {
    const encoded = [
      JSON.stringify({
        type: 'header',
        fileType: 'idle-engine-sim-replay',
        schemaVersion: 1,
        recordedAt: 0,
        runtimeVersion: '0.0.0',
      }),
      JSON.stringify({
        type: 'content',
        packId: 'pack.test',
        packVersion: '1.0.0',
        digest: { version: 1, hash: 'fnv1a-00000000' },
      }),
      JSON.stringify({ type: 'assets', manifestHash: null }),
      JSON.stringify({
        type: 'sim',
        wiring: {
          enableProduction: false,
          enableAutomation: false,
          enableTransforms: false,
          enableEntities: false,
          registerOfflineCatchup: true,
        },
        stepSizeMs: 100,
        startStep: 0,
        initialSnapshot: {
          version: 1,
          capturedAt: 0,
          runtime: { step: 0, stepSizeMs: 100, rngSeed: 0 },
          resources: { ids: [], amounts: [], capacities: [], unlocked: [], visible: [], flags: [] },
          progression: {},
          automation: [],
          transforms: [],
          entities: { entities: [], instances: [], entityInstances: [] },
          prd: {},
          commandQueue: { schemaVersion: 1, entries: [] },
        },
      }),
      JSON.stringify({
        type: 'commands',
        chunkIndex: 0,
        commands: [
          {
            type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
            priority: CommandPriority.PLAYER,
            timestamp: 0,
            step: 0,
            payload: { resourceId: 'resource.gold', amount: 1 },
          },
        ],
      }),
      JSON.stringify({ type: 'end', endStep: 0, endStateChecksum: '00000000', commandCount: 1 }),
      '',
    ].join('\n');

    const replay = decodeSimReplayJsonLines(encoded);
    expect(replay.sim.commands).toHaveLength(1);
    expect(replay.sim.commands[0]?.type).toBe(RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE);
  });
});

