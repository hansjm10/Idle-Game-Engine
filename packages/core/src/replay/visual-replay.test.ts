import { describe, expect, it } from 'vitest';

import type { GameRuntimeWiring } from '../game-runtime-wiring.js';
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
  runCombinedReplay,
} from './sim-replay.js';

import {
  RENDERER_CONTRACT_SCHEMA_VERSION,
  hashRenderCommandBuffer,
  hashViewModel,
} from '@idle-engine/renderer-contract';
import type {
  RenderCommandBuffer,
  ViewModel,
} from '@idle-engine/renderer-contract';
import type { IdleEngineRuntime } from '../index.js';
import type {
  SimReplayRenderCommandBufferFrameV2,
  SimReplayViewModelFrameV2,
} from './sim-replay.js';

describe('visual replay', () => {
  const createGoldContentPack = () =>
    createContentPack({
      resources: [createResourceDefinition('resource.gold')],
      digest: { version: 1, hash: 'fnv1a-00000000' },
    });

  const getGoldAmount = (wiring: GameRuntimeWiring<IdleEngineRuntime>): number => {
    const index = wiring.coordinator.resourceState.requireIndex('resource.gold');
    return wiring.coordinator.resourceState.getAmount(index);
  };

  const buildViewModel = (options: {
    readonly step: number;
    readonly simTimeMs: number;
    readonly contentHash: string;
    readonly goldAmount: number;
  }): ViewModel => ({
    frame: {
      schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
      step: options.step,
      simTimeMs: options.simTimeMs,
      contentHash: options.contentHash,
    },
    scene: {
      camera: { x: 0, y: 0, zoom: 1 },
      sprites: [],
    },
    ui: {
      nodes: [
        {
          kind: 'text',
          id: 'gold',
          x: 8,
          y: 8,
          width: 200,
          height: 24,
          text: `Gold: ${options.goldAmount}`,
          colorRgba: 0xff_ff_ff_ff,
          fontSizePx: 16,
        },
      ],
    },
  });

  const buildRcb = (options: {
    readonly step: number;
    readonly simTimeMs: number;
    readonly renderFrame: number;
    readonly contentHash: string;
    readonly goldAmount: number;
  }): RenderCommandBuffer => ({
    frame: {
      schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
      step: options.step,
      simTimeMs: options.simTimeMs,
      renderFrame: options.renderFrame,
      contentHash: options.contentHash,
    },
    passes: [{ id: 'world' }, { id: 'ui' }],
    draws: [
      {
        kind: 'clear',
        passId: 'world',
        sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
        colorRgba: 0x10_10_10_ff,
      },
      {
        kind: 'rect',
        passId: 'ui',
        sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
        x: 8,
        y: 40,
        width: Math.max(0, Math.min(240, Math.floor(options.goldAmount) * 12)),
        height: 16,
        colorRgba: 0x2a_4f_8a_ff,
      },
    ],
  });

  it('records, encodes, decodes, and validates visual frame hashes', async () => {
    resetRNG();
    setRNGSeed(4242);

    const content = createGoldContentPack();
    const wiring = createGameRuntime({ content, stepSizeMs: 100 });
    const stepSizeMs = wiring.runtime.getStepSizeMs();

    const recorder = new SimReplayRecorder({ content, wiring, recordedAt: 0, capturedAt: 0 });

    const viewModelFrames: SimReplayViewModelFrameV2[] = [];
    const rcbFrames: SimReplayRenderCommandBufferFrameV2[] = [];

    const recordVisualFramesForLastStep = async (): Promise<void> => {
      const step = wiring.runtime.getCurrentStep() - 1;
      const simTimeMs = step * stepSizeMs;
      const goldAmount = getGoldAmount(wiring);
      const contentHash = content.digest.hash;

      const viewModel = buildViewModel({ step, simTimeMs, contentHash, goldAmount });
      viewModelFrames.push({
        step,
        hash: await hashViewModel(viewModel),
        viewModel,
      });

      const rcb = buildRcb({
        step,
        simTimeMs,
        renderFrame: step,
        contentHash,
        goldAmount,
      });
      rcbFrames.push({
        renderFrame: step,
        step,
        hash: await hashRenderCommandBuffer(rcb),
        rcb,
      });
    };

    const enqueueCollect = (amount: number): void => {
      const step = wiring.runtime.getNextExecutableStep();
      const timestamp = wiring.runtime.getCurrentStep() * stepSizeMs;
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

    enqueueCollect(2);
    wiring.runtime.tick(stepSizeMs);
    await recordVisualFramesForLastStep();

    wiring.runtime.tick(stepSizeMs);
    await recordVisualFramesForLastStep();

    enqueueCollect(1);
    wiring.runtime.tick(stepSizeMs);
    await recordVisualFramesForLastStep();

    const replay = recorder.export({ capturedAt: 0 });

    const replayWithFrames = {
      ...replay,
      frames: {
        viewModels: viewModelFrames,
        rcbs: rcbFrames,
      },
    };

    const decoded = decodeSimReplayJsonLines(encodeSimReplayJsonLines(replayWithFrames));

    const result = await runCombinedReplay({
      content,
      replay: decoded,
      buildViewModel: ({ wiring: replayWiring, step, simTimeMs }) =>
        buildViewModel({
          step,
          simTimeMs,
          contentHash: content.digest.hash,
          goldAmount: getGoldAmount(replayWiring),
        }),
      buildRenderCommandBuffers: ({ wiring: replayWiring, step, simTimeMs }) => [
        buildRcb({
          step,
          simTimeMs,
          renderFrame: step,
          contentHash: content.digest.hash,
          goldAmount: getGoldAmount(replayWiring),
        }),
      ],
    });

    expect(result.checksum).toBe(replay.sim.endStateChecksum);
    expect(result.viewModelFramesValidated).toBe(viewModelFrames.length);
    expect(result.rcbFramesValidated).toBe(rcbFrames.length);
  });

  it('reports a diffable mismatch summary on hash mismatch', async () => {
    resetRNG();
    setRNGSeed(4242);

    const content = createGoldContentPack();
    const wiring = createGameRuntime({ content, stepSizeMs: 100 });
    const stepSizeMs = wiring.runtime.getStepSizeMs();

    const recorder = new SimReplayRecorder({ content, wiring, recordedAt: 0, capturedAt: 0 });

    const viewModelFrames: SimReplayViewModelFrameV2[] = [];

    wiring.runtime.tick(stepSizeMs);

    const step = wiring.runtime.getCurrentStep() - 1;
    const simTimeMs = step * stepSizeMs;
    const goldAmount = getGoldAmount(wiring);
    const contentHash = content.digest.hash;

    const viewModel = buildViewModel({ step, simTimeMs, contentHash, goldAmount });
    viewModelFrames.push({
      step,
      hash: await hashViewModel(viewModel),
      viewModel,
    });

    const replay = recorder.export({ capturedAt: 0 });
    const replayWithFrames = {
      ...replay,
      frames: {
        viewModels: viewModelFrames.map((frame) => ({
          ...frame,
          hash: `${frame.hash.slice(0, 62)}00`,
        })),
        rcbs: [],
      },
    };

    const decoded = decodeSimReplayJsonLines(encodeSimReplayJsonLines(replayWithFrames));

    await expect(
      runCombinedReplay({
        content,
        replay: decoded,
        buildViewModel: ({ wiring: replayWiring, step: replayStep, simTimeMs: replaySimTimeMs }) =>
          buildViewModel({
            step: replayStep,
            simTimeMs: replaySimTimeMs,
            contentHash: content.digest.hash,
            goldAmount: getGoldAmount(replayWiring),
          }),
      }),
    ).rejects.toThrow(/"event":"visual_replay_mismatch"/);
  });

  it('replays schemaVersion 1 streams without visual builders', async () => {
    resetRNG();
    setRNGSeed(4242);

    const content = createGoldContentPack();
    const wiring = createGameRuntime({ content, stepSizeMs: 100 });
    const recorder = new SimReplayRecorder({ content, wiring, recordedAt: 0, capturedAt: 0 });

    wiring.runtime.tick(wiring.runtime.getStepSizeMs());
    wiring.runtime.tick(wiring.runtime.getStepSizeMs());

    const replayV2 = recorder.export({ capturedAt: 0 });
    const replayV1 = {
      ...replayV2,
      header: { ...replayV2.header, schemaVersion: 1 as const },
    };

    const decoded = decodeSimReplayJsonLines(encodeSimReplayJsonLines(replayV1));
    const result = await runCombinedReplay({ content, replay: decoded });

    expect(result.checksum).toBe(replayV2.sim.endStateChecksum);
    expect(result.viewModelFramesValidated).toBe(0);
    expect(result.rcbFramesValidated).toBe(0);
  });

  it('requires buildViewModel when replay includes ViewModel frames', async () => {
    resetRNG();
    setRNGSeed(4242);

    const content = createGoldContentPack();
    const wiring = createGameRuntime({ content, stepSizeMs: 100 });
    const stepSizeMs = wiring.runtime.getStepSizeMs();

    const recorder = new SimReplayRecorder({ content, wiring, recordedAt: 0, capturedAt: 0 });

    wiring.runtime.tick(stepSizeMs);

    const step = wiring.runtime.getCurrentStep() - 1;
    const simTimeMs = step * stepSizeMs;
    const goldAmount = getGoldAmount(wiring);
    const contentHash = content.digest.hash;

    const viewModel = buildViewModel({ step, simTimeMs, contentHash, goldAmount });
    const replay = recorder.export({ capturedAt: 0 });
    const replayWithFrames = {
      ...replay,
      frames: {
        viewModels: [
          {
            step,
            hash: await hashViewModel(viewModel),
            viewModel,
          },
        ],
        rcbs: [],
      },
    };

    const decoded = decodeSimReplayJsonLines(encodeSimReplayJsonLines(replayWithFrames));

    await expect(runCombinedReplay({ content, replay: decoded })).rejects.toThrow(
      /buildViewModel was not provided/i,
    );
  });

  it('requires buildRenderCommandBuffers when replay includes RenderCommandBuffer frames', async () => {
    resetRNG();
    setRNGSeed(4242);

    const content = createGoldContentPack();
    const wiring = createGameRuntime({ content, stepSizeMs: 100 });
    const stepSizeMs = wiring.runtime.getStepSizeMs();

    const recorder = new SimReplayRecorder({ content, wiring, recordedAt: 0, capturedAt: 0 });

    wiring.runtime.tick(stepSizeMs);

    const step = wiring.runtime.getCurrentStep() - 1;
    const simTimeMs = step * stepSizeMs;
    const goldAmount = getGoldAmount(wiring);
    const contentHash = content.digest.hash;

    const rcb = buildRcb({ step, simTimeMs, renderFrame: step, contentHash, goldAmount });
    const replay = recorder.export({ capturedAt: 0 });
    const replayWithFrames = {
      ...replay,
      frames: {
        viewModels: [],
        rcbs: [
          {
            renderFrame: step,
            step,
            hash: await hashRenderCommandBuffer(rcb),
            rcb,
          },
        ],
      },
    };

    const decoded = decodeSimReplayJsonLines(encodeSimReplayJsonLines(replayWithFrames));

    await expect(runCombinedReplay({ content, replay: decoded })).rejects.toThrow(
      /buildRenderCommandBuffers was not provided/i,
    );
  });

  it('fails when replay is missing recorded ViewModel frames', async () => {
    resetRNG();
    setRNGSeed(4242);

    const content = createGoldContentPack();
    const wiring = createGameRuntime({ content, stepSizeMs: 100 });
    const stepSizeMs = wiring.runtime.getStepSizeMs();

    const recorder = new SimReplayRecorder({ content, wiring, recordedAt: 0, capturedAt: 0 });

    wiring.runtime.tick(stepSizeMs);

    const step = wiring.runtime.getCurrentStep() - 1;
    const simTimeMs = step * stepSizeMs;
    const goldAmount = getGoldAmount(wiring);
    const contentHash = content.digest.hash;

    const viewModel = buildViewModel({ step, simTimeMs, contentHash, goldAmount });
    const viewModelFrames: SimReplayViewModelFrameV2[] = [
      {
        step,
        hash: await hashViewModel(viewModel),
        viewModel,
      },
    ];

    wiring.runtime.tick(stepSizeMs);

    const replay = recorder.export({ capturedAt: 0 });
    const replayWithFrames = {
      ...replay,
      frames: { viewModels: viewModelFrames, rcbs: [] },
    };

    const decoded = decodeSimReplayJsonLines(encodeSimReplayJsonLines(replayWithFrames));

    await expect(
      runCombinedReplay({
        content,
        replay: decoded,
        buildViewModel: ({ wiring: replayWiring, step: replayStep, simTimeMs: replaySimTimeMs }) =>
          buildViewModel({
            step: replayStep,
            simTimeMs: replaySimTimeMs,
            contentHash: content.digest.hash,
            goldAmount: getGoldAmount(replayWiring),
          }),
      }),
    ).rejects.toThrow(/missing recorded ViewModel frames/i);
  });

  it('throws when buildRenderCommandBuffers does not return an array', async () => {
    resetRNG();
    setRNGSeed(4242);

    const content = createGoldContentPack();
    const wiring = createGameRuntime({ content, stepSizeMs: 100 });
    const stepSizeMs = wiring.runtime.getStepSizeMs();

    const recorder = new SimReplayRecorder({ content, wiring, recordedAt: 0, capturedAt: 0 });

    wiring.runtime.tick(stepSizeMs);

    const step = wiring.runtime.getCurrentStep() - 1;
    const simTimeMs = step * stepSizeMs;
    const goldAmount = getGoldAmount(wiring);
    const contentHash = content.digest.hash;

    const rcb = buildRcb({ step, simTimeMs, renderFrame: step, contentHash, goldAmount });
    const replay = recorder.export({ capturedAt: 0 });
    const replayWithFrames = {
      ...replay,
      frames: {
        viewModels: [],
        rcbs: [
          {
            renderFrame: step,
            step,
            hash: 'not-validated',
            rcb,
          },
        ],
      },
    };

    const decoded = decodeSimReplayJsonLines(encodeSimReplayJsonLines(replayWithFrames));

    await expect(
      runCombinedReplay({
        content,
        replay: decoded,
        buildRenderCommandBuffers: () => ({}) as unknown as RenderCommandBuffer[],
      }),
    ).rejects.toThrow(/must return an array/i);
  });

  it('fails when replay produces more RenderCommandBuffer frames than were recorded', async () => {
    resetRNG();
    setRNGSeed(4242);

    const content = createGoldContentPack();
    const wiring = createGameRuntime({ content, stepSizeMs: 100 });
    const stepSizeMs = wiring.runtime.getStepSizeMs();

    const recorder = new SimReplayRecorder({ content, wiring, recordedAt: 0, capturedAt: 0 });

    wiring.runtime.tick(stepSizeMs);

    const step = wiring.runtime.getCurrentStep() - 1;
    const simTimeMs = step * stepSizeMs;
    const goldAmount = getGoldAmount(wiring);
    const contentHash = content.digest.hash;

    const rcb = buildRcb({ step, simTimeMs, renderFrame: step, contentHash, goldAmount });
    const replay = recorder.export({ capturedAt: 0 });
    const replayWithFrames = {
      ...replay,
      frames: {
        viewModels: [],
        rcbs: [
          {
            renderFrame: step,
            step,
            hash: await hashRenderCommandBuffer(rcb),
            rcb,
          },
        ],
      },
    };

    const decoded = decodeSimReplayJsonLines(encodeSimReplayJsonLines(replayWithFrames));

    await expect(
      runCombinedReplay({
        content,
        replay: decoded,
        buildRenderCommandBuffers: () => [rcb, rcb],
      }),
    ).rejects.toThrow(/more RenderCommandBuffer frames than were recorded/i);
  });

  it('validates that RenderCommandBuffer.frame.renderFrame is a non-negative integer', async () => {
    resetRNG();
    setRNGSeed(4242);

    const content = createGoldContentPack();
    const wiring = createGameRuntime({ content, stepSizeMs: 100 });
    const stepSizeMs = wiring.runtime.getStepSizeMs();

    const recorder = new SimReplayRecorder({ content, wiring, recordedAt: 0, capturedAt: 0 });

    wiring.runtime.tick(stepSizeMs);

    const step = wiring.runtime.getCurrentStep() - 1;
    const simTimeMs = step * stepSizeMs;
    const goldAmount = getGoldAmount(wiring);
    const contentHash = content.digest.hash;

    const recorded = buildRcb({ step, simTimeMs, renderFrame: step, contentHash, goldAmount });
    const replay = recorder.export({ capturedAt: 0 });
    const replayWithFrames = {
      ...replay,
      frames: {
        viewModels: [],
        rcbs: [
          {
            renderFrame: step,
            step,
            hash: 'not-validated',
            rcb: recorded,
          },
        ],
      },
    };

    const decoded = decodeSimReplayJsonLines(encodeSimReplayJsonLines(replayWithFrames));

    await expect(
      runCombinedReplay({
        content,
        replay: decoded,
        buildRenderCommandBuffers: () => [
          buildRcb({ step, simTimeMs, renderFrame: -1, contentHash, goldAmount }),
        ],
      }),
    ).rejects.toThrow(/renderFrame must be a non-negative integer/i);
  });

  it('fails when replay RenderCommandBuffer frames are misaligned', async () => {
    resetRNG();
    setRNGSeed(4242);

    const content = createGoldContentPack();
    const wiring = createGameRuntime({ content, stepSizeMs: 100 });
    const stepSizeMs = wiring.runtime.getStepSizeMs();

    const recorder = new SimReplayRecorder({ content, wiring, recordedAt: 0, capturedAt: 0 });

    wiring.runtime.tick(stepSizeMs);

    const step = wiring.runtime.getCurrentStep() - 1;
    const simTimeMs = step * stepSizeMs;
    const goldAmount = getGoldAmount(wiring);
    const contentHash = content.digest.hash;

    const recorded = buildRcb({ step, simTimeMs, renderFrame: step, contentHash, goldAmount });
    const replay = recorder.export({ capturedAt: 0 });
    const replayWithFrames = {
      ...replay,
      frames: {
        viewModels: [],
        rcbs: [
          {
            renderFrame: step,
            step,
            hash: 'not-validated',
            rcb: recorded,
          },
        ],
      },
    };

    const decoded = decodeSimReplayJsonLines(encodeSimReplayJsonLines(replayWithFrames));

    await expect(
      runCombinedReplay({
        content,
        replay: decoded,
        buildRenderCommandBuffers: () => [
          buildRcb({ step: step + 1, simTimeMs, renderFrame: step, contentHash, goldAmount }),
        ],
      }),
    ).rejects.toThrow(/frame alignment mismatch/i);
  });

  it('fails when replay contains unvalidated recorded ViewModel frames', async () => {
    resetRNG();
    setRNGSeed(4242);

    const content = createGoldContentPack();
    const wiring = createGameRuntime({ content, stepSizeMs: 100 });
    const stepSizeMs = wiring.runtime.getStepSizeMs();

    const recorder = new SimReplayRecorder({ content, wiring, recordedAt: 0, capturedAt: 0 });

    const step = wiring.runtime.getCurrentStep();
    const simTimeMs = step * stepSizeMs;
    const goldAmount = getGoldAmount(wiring);
    const contentHash = content.digest.hash;

    const viewModel = buildViewModel({ step, simTimeMs, contentHash, goldAmount });
    const replay = recorder.export({ capturedAt: 0 });
    const replayWithFrames = {
      ...replay,
      frames: {
        viewModels: [
          {
            step,
            hash: 'not-validated',
            viewModel,
          },
        ],
        rcbs: [],
      },
    };

    const decoded = decodeSimReplayJsonLines(encodeSimReplayJsonLines(replayWithFrames));

    await expect(
      runCombinedReplay({
        content,
        replay: decoded,
        buildViewModel: () => viewModel,
      }),
    ).rejects.toThrow(/did not validate all recorded ViewModel frames/i);
  });

  it('fails when replay contains unvalidated recorded RenderCommandBuffer frames', async () => {
    resetRNG();
    setRNGSeed(4242);

    const content = createGoldContentPack();
    const wiring = createGameRuntime({ content, stepSizeMs: 100 });
    const stepSizeMs = wiring.runtime.getStepSizeMs();

    const recorder = new SimReplayRecorder({ content, wiring, recordedAt: 0, capturedAt: 0 });

    const step = wiring.runtime.getCurrentStep();
    const simTimeMs = step * stepSizeMs;
    const goldAmount = getGoldAmount(wiring);
    const contentHash = content.digest.hash;

    const rcb = buildRcb({ step, simTimeMs, renderFrame: step, contentHash, goldAmount });
    const replay = recorder.export({ capturedAt: 0 });
    const replayWithFrames = {
      ...replay,
      frames: {
        viewModels: [],
        rcbs: [
          {
            renderFrame: step,
            step,
            hash: 'not-validated',
            rcb,
          },
        ],
      },
    };

    const decoded = decodeSimReplayJsonLines(encodeSimReplayJsonLines(replayWithFrames));

    await expect(
      runCombinedReplay({
        content,
        replay: decoded,
        buildRenderCommandBuffers: () => [rcb],
      }),
    ).rejects.toThrow(/did not validate all recorded RenderCommandBuffer frames/i);
  });
});
