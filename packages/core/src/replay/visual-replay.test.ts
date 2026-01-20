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
});

