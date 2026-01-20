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
import { DEFAULT_MAX_QUEUE_SIZE } from '../command-queue.js';
import {
  SimReplayRecorder,
  decodeSimReplayJsonLines,
  encodeSimReplayJsonLines,
  runSimReplay,
} from './sim-replay.js';

describe('sim replay', () => {
  const createGoldContentPack = () =>
    createContentPack({
      resources: [createResourceDefinition('resource.gold')],
      digest: { version: 1, hash: 'fnv1a-00000000' },
    });

  const createEncodedReplayLines = (records: readonly unknown[]): string =>
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;

  const createMinimalSnapshot = () => ({
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
  });

  it('records, encodes, decodes, and replays deterministically', () => {
    resetRNG();
    setRNGSeed(4242);

    const content = createGoldContentPack();

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

    const content = createGoldContentPack();

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

  it(
    'replays command streams larger than the default command queue size',
    { timeout: 20_000 },
    () => {
      resetRNG();
      setRNGSeed(4242);

      const content = createGoldContentPack();

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

      const steps = 10_050;
      const stepSizeMs = wiring.runtime.getStepSizeMs();

      for (let index = 0; index < steps; index += 1) {
        const step = wiring.runtime.getNextExecutableStep();
        const timestamp = wiring.runtime.getCurrentStep() * stepSizeMs;
        const command = {
          type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
          priority: CommandPriority.PLAYER,
          payload: { resourceId: 'resource.gold', amount: 1 },
          timestamp,
          step,
        };
        expect(wiring.commandQueue.enqueue(command)).toBe(true);
        recorder.recordCommand(command);
        wiring.runtime.tick(stepSizeMs);
      }

      const replay = recorder.export({ capturedAt: 0 });
      const result = runSimReplay({ content, replay });
      expect(result.checksum).toBe(replay.sim.endStateChecksum);
    },
  );

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
    const snapshot = createMinimalSnapshot();
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
        initialSnapshot: snapshot,
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

  it('rejects invalid encode options', () => {
    resetRNG();
    setRNGSeed(4242);

    const content = createGoldContentPack();
    const wiring = createGameRuntime({ content, stepSizeMs: 100 });
    const recorder = new SimReplayRecorder({ content, wiring, recordedAt: 0, capturedAt: 0 });
    const replay = recorder.export({ capturedAt: 0 });

    expect(() => encodeSimReplayJsonLines(replay, { maxCommandsPerChunk: 0 })).toThrow(
      /maxCommandsPerChunk must be a positive integer/i,
    );
  });

  it('guards against invalid JSON payloads while recording commands', () => {
    resetRNG();
    setRNGSeed(4242);

    const content = createGoldContentPack();
    const wiring = createGameRuntime({ content, stepSizeMs: 100 });
    const recorder = new SimReplayRecorder({ content, wiring, recordedAt: 0, capturedAt: 0 });

    expect(() =>
      recorder.recordCommand({
        type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
        priority: CommandPriority.PLAYER,
        timestamp: 0,
        step: 0,
        payload: null,
      }),
    ).not.toThrow();

    expect(() =>
      recorder.recordCommand({
        type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
        priority: CommandPriority.PLAYER,
        timestamp: 0,
        step: 0,
        payload: [1, 2, 3],
      }),
    ).not.toThrow();

    const circularArray: unknown[] = [];
    circularArray.push(circularArray);
    expect(() =>
      recorder.recordCommand({
        type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
        priority: CommandPriority.PLAYER,
        timestamp: 0,
        step: 0,
        payload: circularArray,
      }),
    ).toThrow(/circular reference/i);

    const circularObject: Record<string, unknown> = {};
    circularObject.self = circularObject;
    expect(() =>
      recorder.recordCommand({
        type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
        priority: CommandPriority.PLAYER,
        timestamp: 0,
        step: 0,
        payload: circularObject,
      }),
    ).toThrow(/circular reference/i);

    expect(() =>
      recorder.recordCommand({
        type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
        priority: CommandPriority.PLAYER,
        timestamp: 0,
        step: 0,
        payload: { value: Number.NaN },
      }),
    ).toThrow(/non-finite number/i);

    expect(() =>
      recorder.recordCommand({
        type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
        priority: CommandPriority.PLAYER,
        timestamp: 0,
        step: 0,
        payload: () => undefined,
      }),
    ).toThrow(/unsupported JSON type/i);

    expect(() =>
      recorder.recordCommand({
        type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
        priority: CommandPriority.PLAYER,
        timestamp: 0,
        step: 0,
        payload: new Date(),
      }),
    ).toThrow(/plain JSON object/i);

    const symbolKey = Symbol('key');
    expect(() =>
      recorder.recordCommand({
        type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
        priority: CommandPriority.PLAYER,
        timestamp: 0,
        step: 0,
        payload: { [symbolKey]: true } as unknown as Record<string, unknown>,
      }),
    ).toThrow(/symbol keys/i);

    expect(() =>
      recorder.recordCommand({
        type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
        priority: CommandPriority.PLAYER,
        timestamp: 0,
        step: 0,
        payload: { value: undefined },
      }),
    ).toThrow(/undefined value/i);

    expect(() => recorder.recordCommand(null as unknown as never)).toThrow(/must be an object/i);

    expect(() =>
      recorder.recordCommand({
        type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
        priority: 123 as unknown as CommandPriority,
        timestamp: 0,
        step: 0,
        payload: { resourceId: 'resource.gold', amount: 1 },
      }),
    ).toThrow(/command\.priority must be a valid CommandPriority value/i);

    expect(() =>
      recorder.recordCommand({
        type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
        priority: CommandPriority.PLAYER,
        requestId: '',
        timestamp: 0,
        step: 0,
        payload: { resourceId: 'resource.gold', amount: 1 },
      }),
    ).toThrow(/command\.requestId must be a non-empty string/i);
  });

  it('rejects malformed replay inputs while decoding', () => {
    expect(() => decodeSimReplayJsonLines(123 as unknown as string)).toThrow(
      /Replay input must be a string/i,
    );

    expect(() => decodeSimReplayJsonLines('\n')).toThrow(/Replay input is empty/i);

    expect(() => decodeSimReplayJsonLines('a\nb\nc\n', { maxLines: 2 })).toThrow(
      /exceeds configured line limit/i,
    );

    expect(() => decodeSimReplayJsonLines('123\n')).toThrow(/Replay record must be an object/i);

    const baseHeader = {
      type: 'header',
      fileType: 'idle-engine-sim-replay',
      schemaVersion: 1,
      recordedAt: 0,
      runtimeVersion: '0.0.0',
    };

    expect(() => decodeSimReplayJsonLines(createEncodedReplayLines([baseHeader]))).toThrow(
      /Replay content record must appear second/i,
    );

    expect(
      () =>
        decodeSimReplayJsonLines(
          createEncodedReplayLines([baseHeader, { type: 'assets', manifestHash: null }]),
        ),
    ).toThrow(/Replay content record must appear second/i);

    const snapshot = createMinimalSnapshot();

    const baseContent = {
      type: 'content',
      packId: 'pack.test',
      packVersion: '1.0.0',
      digest: { version: 1, hash: 'fnv1a-00000000' },
    };

    const baseAssets = { type: 'assets', manifestHash: 'manifest-123' };

    const baseSim = {
      type: 'sim',
      wiring: {
        enableProduction: false,
        enableAutomation: false,
        enableTransforms: false,
        enableEntities: false,
      },
      stepSizeMs: 100,
      startStep: 0,
      initialSnapshot: snapshot,
    };

    const baseEnd = { type: 'end', endStep: 0, endStateChecksum: '00000000', commandCount: 0 };

    expect(() =>
      decodeSimReplayJsonLines(
        createEncodedReplayLines([{ ...baseHeader, schemaVersion: 2 }, baseContent, baseAssets, baseSim, baseEnd]),
      ),
    ).toThrow(/schemaVersion is not supported/i);

    expect(() =>
      decodeSimReplayJsonLines(
        createEncodedReplayLines([
          baseHeader,
          { ...baseContent, digest: null },
          baseAssets,
          baseSim,
          baseEnd,
        ]),
      ),
    ).toThrow(/content\.digest must be an object/i);

    expect(() =>
      decodeSimReplayJsonLines(
        createEncodedReplayLines([
          baseHeader,
          {
            ...baseContent,
            digest: { version: true, hash: 'fnv1a-00000000' },
          },
          baseAssets,
          baseSim,
          baseEnd,
        ]),
      ),
    ).toThrow(/content\.digest\.version must be a number or string/i);

    expect(() =>
      decodeSimReplayJsonLines(
        createEncodedReplayLines([
          { ...baseHeader, recordedAt: '0' },
          baseContent,
          baseAssets,
          baseSim,
          baseEnd,
        ]),
      ),
    ).toThrow(/header\.recordedAt must be a finite number/i);

    expect(() =>
      decodeSimReplayJsonLines(
        createEncodedReplayLines([
          { ...baseHeader, runtimeVersion: ' ' },
          baseContent,
          baseAssets,
          baseSim,
          baseEnd,
        ]),
      ),
    ).toThrow(/header\.runtimeVersion must be a non-empty string/i);

    expect(() =>
      decodeSimReplayJsonLines(
        createEncodedReplayLines([
          baseHeader,
          baseContent,
          baseAssets,
          { ...baseSim, wiring: null },
          baseEnd,
        ]),
      ),
    ).toThrow(/sim\.wiring must be an object/i);

    expect(() =>
      decodeSimReplayJsonLines(
        createEncodedReplayLines([
          baseHeader,
          baseContent,
          baseAssets,
          { ...baseSim, initialSnapshot: null },
          baseEnd,
        ]),
      ),
    ).toThrow(/sim\.initialSnapshot must be an object/i);

    expect(() =>
      decodeSimReplayJsonLines(
        createEncodedReplayLines([
          baseHeader,
          baseContent,
          baseAssets,
          { ...baseSim, stepSizeMs: 0 },
          baseEnd,
        ]),
      ),
    ).toThrow(/sim\.stepSizeMs must be a positive number/i);

    expect(() =>
      decodeSimReplayJsonLines(
        createEncodedReplayLines([
          baseHeader,
          baseContent,
          baseAssets,
          { ...baseSim, startStep: -1 },
          baseEnd,
        ]),
      ),
    ).toThrow(/sim\.startStep must be a non-negative integer/i);

    expect(() =>
      decodeSimReplayJsonLines(
        createEncodedReplayLines([
          baseHeader,
          baseContent,
          baseAssets,
          baseSim,
          { type: 'commands', chunkIndex: 0, commands: {} },
          baseEnd,
        ]),
      ),
    ).toThrow(/command chunk must contain commands array/i);

    const oneCommand = {
      type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
      priority: CommandPriority.PLAYER,
      timestamp: 0,
      step: 0,
      payload: { resourceId: 'resource.gold', amount: 1 },
    };

    expect(() =>
      decodeSimReplayJsonLines(
        createEncodedReplayLines([
          baseHeader,
          baseContent,
          baseAssets,
          baseSim,
          { type: 'commands', chunkIndex: 0, commands: [oneCommand, oneCommand] },
          { ...baseEnd, commandCount: 2 },
        ]),
        { maxCommands: 1 },
      ),
    ).toThrow(/exceeds configured command limit/i);

    expect(() =>
      decodeSimReplayJsonLines(
        createEncodedReplayLines([
          baseHeader,
          baseContent,
          baseAssets,
          baseSim,
          { type: 'commands', chunkIndex: 0, commands: [oneCommand] },
          { ...baseEnd, commandCount: 0 },
        ]),
      ),
    ).toThrow(/command count does not match footer/i);

    expect(() =>
      decodeSimReplayJsonLines(
        createEncodedReplayLines([baseHeader, baseContent, baseAssets, baseSim, baseAssets, baseEnd]),
      ),
    ).toThrow(/Unexpected replay record type/i);

    expect(() =>
      decodeSimReplayJsonLines(
        createEncodedReplayLines([baseHeader, baseContent, baseAssets, baseSim, { type: 'commands', chunkIndex: 0, commands: [] }]),
      ),
    ).toThrow(/missing end record/i);

    const decoded = decodeSimReplayJsonLines(
      createEncodedReplayLines([baseHeader, baseContent, baseAssets, baseSim, baseEnd]),
    );
    expect(decoded.assets.manifestHash).toBe('manifest-123');
  });

  it('validates replay simulation preconditions and scheduling', () => {
    resetRNG();
    setRNGSeed(4242);

    const content = createGoldContentPack();
    const wiring = createGameRuntime({ content, stepSizeMs: 100 });
    for (let i = 0; i < 5; i += 1) {
      wiring.runtime.tick(wiring.runtime.getStepSizeMs());
    }
    const recorder = new SimReplayRecorder({ content, wiring, recordedAt: 0, capturedAt: 0 });

    const baseCommand = {
      type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
      priority: CommandPriority.PLAYER,
      payload: { resourceId: 'resource.gold', amount: 1 },
      timestamp: 0,
      step: wiring.runtime.getNextExecutableStep(),
    };

    expect(wiring.commandQueue.enqueue(baseCommand)).toBe(true);
    recorder.recordCommand(baseCommand);
    wiring.runtime.tick(wiring.runtime.getStepSizeMs());

    const replay = recorder.export({ capturedAt: 0 });

    expect(() =>
      runSimReplay({
        content,
        replay: {
          ...replay,
          sim: {
            ...replay.sim,
            initialSnapshot: { ...replay.sim.initialSnapshot, version: 2 } as unknown as typeof replay.sim.initialSnapshot,
          },
        },
      }),
    ).toThrow(/snapshot version is not supported/i);

    expect(() =>
      runSimReplay({
        content,
        replay: { ...replay, sim: { ...replay.sim, startStep: -1 } },
      }),
    ).toThrow(/startStep must be a non-negative integer/i);

    expect(() =>
      runSimReplay({
        content,
        replay: { ...replay, sim: { ...replay.sim, endStep: -1 } },
      }),
    ).toThrow(/endStep must be a non-negative integer/i);

    expect(() =>
      runSimReplay({
        content,
        replay: { ...replay, sim: { ...replay.sim, stepSizeMs: 0 } },
      }),
    ).toThrow(/stepSizeMs must be a positive, finite number/i);

    expect(() =>
      runSimReplay({
        content,
        replay: {
          ...replay,
          sim: { ...replay.sim, startStep: replay.sim.startStep + 1 },
        },
      }),
    ).toThrow(/startStep does not match the initial snapshot/i);

    expect(() =>
      runSimReplay({
        content,
        replay: {
          ...replay,
          sim: { ...replay.sim, stepSizeMs: replay.sim.stepSizeMs + 1 },
        },
      }),
    ).toThrow(/stepSizeMs does not match the initial snapshot/i);

    expect(() =>
      runSimReplay({
        content,
        replay: {
          ...replay,
          sim: {
            ...replay.sim,
            endStep: replay.sim.startStep - 1,
          },
        },
      }),
    ).toThrow(/endStep must be greater than or equal to the restored runtime step/i);

    const commandScheduledBeforeStart = { ...replay.sim.commands[0]!, step: replay.sim.startStep - 1 };
    expect(() =>
      runSimReplay({
        content,
        replay: {
          ...replay,
          sim: {
            ...replay.sim,
            commands: [commandScheduledBeforeStart],
          },
        },
      }),
    ).toThrow(/command step must be greater than or equal to the replay startStep/i);
  });

  it('replays multiple commands scheduled for the same step', () => {
    resetRNG();
    setRNGSeed(4242);

    const content = createGoldContentPack();
    const wiring = createGameRuntime({ content, stepSizeMs: 100 });
    const recorder = new SimReplayRecorder({ content, wiring, recordedAt: 0, capturedAt: 0 });

    const step = wiring.runtime.getNextExecutableStep();
    const timestamp = wiring.runtime.getCurrentStep() * wiring.runtime.getStepSizeMs();

    const commandA = {
      type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
      priority: CommandPriority.PLAYER,
      payload: { resourceId: 'resource.gold', amount: 1 },
      timestamp,
      step,
    };
    const commandB = {
      type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
      priority: CommandPriority.PLAYER,
      payload: { resourceId: 'resource.gold', amount: 2 },
      timestamp,
      step,
    };

    expect(wiring.commandQueue.enqueue(commandA)).toBe(true);
    recorder.recordCommand(commandA);
    expect(wiring.commandQueue.enqueue(commandB)).toBe(true);
    recorder.recordCommand(commandB);

    wiring.runtime.tick(wiring.runtime.getStepSizeMs());

    const replay = recorder.export({ capturedAt: 0 });
    const result = runSimReplay({ content, replay });
    expect(result.checksum).toBe(replay.sim.endStateChecksum);
  });

  it('throws when the replay end-state checksum differs from the recorded value', () => {
    resetRNG();
    setRNGSeed(4242);

    const content = createGoldContentPack();
    const wiring = createGameRuntime({ content, stepSizeMs: 100 });
    const recorder = new SimReplayRecorder({ content, wiring, recordedAt: 0, capturedAt: 0 });

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
    expect(() =>
      runSimReplay({
        content,
        replay: { ...replay, sim: { ...replay.sim, endStateChecksum: 'deadbeef' } },
      }),
    ).toThrow(/checksum mismatch/i);
  });

  it('fails when replay enqueues more commands than the restored command queue can accept', () => {
    resetRNG();
    setRNGSeed(4242);

    const content = createGoldContentPack();
    const wiring = createGameRuntime({ content, stepSizeMs: 100 });
    const recorder = new SimReplayRecorder({ content, wiring, recordedAt: 0, capturedAt: 0 });
    const replay = recorder.export({ capturedAt: 0 });

    const startStep = replay.sim.startStep;
    const timestamp = startStep * replay.sim.stepSizeMs;
    const step = replay.sim.endStep;

    const playerCommands = Array.from({ length: DEFAULT_MAX_QUEUE_SIZE }, () => ({
      type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
      priority: CommandPriority.PLAYER,
      payload: { resourceId: 'resource.gold', amount: 1 },
      timestamp,
      step,
    }));

    const rejected = {
      type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
      priority: CommandPriority.AUTOMATION,
      payload: { resourceId: 'resource.gold', amount: 1 },
      timestamp,
      step,
    };

    expect(() =>
      runSimReplay({
        content,
        replay: { ...replay, sim: { ...replay.sim, commands: [...playerCommands, rejected] } },
      }),
    ).toThrow(/Replay command rejected/i);
  });
});
