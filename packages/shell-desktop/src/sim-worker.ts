import { parentPort } from 'node:worker_threads';
import { createSimRuntime } from './sim/sim-runtime.js';
import type { Command } from '@idle-engine/core';
import type { RenderCommandBuffer } from '@idle-engine/renderer-contract';
import type { SimRuntime } from './sim/sim-runtime.js';

type WorkerInitMessage = Readonly<{
  kind: 'init';
  stepSizeMs?: number;
  maxStepsPerFrame?: number;
}>;

type WorkerTickMessage = Readonly<{
  kind: 'tick';
  deltaMs: number;
}>;

type WorkerEnqueueCommandsMessage = Readonly<{
  kind: 'enqueueCommands';
  commands: readonly Command[];
}>;

type WorkerReadyMessage = Readonly<{
  kind: 'ready';
  stepSizeMs: number;
  nextStep: number;
}>;

type WorkerFrameMessage = Readonly<{
  kind: 'frame';
  frame?: RenderCommandBuffer;
  droppedFrames: number;
  nextStep: number;
}>;

type WorkerErrorMessage = Readonly<{
  kind: 'error';
  error: string;
}>;

type WorkerOutboundMessage = WorkerReadyMessage | WorkerFrameMessage | WorkerErrorMessage;

if (!parentPort) {
  throw new Error('shell-desktop sim worker requires parentPort');
}

let runtime: SimRuntime | undefined;

const ensureRuntime = (options?: { readonly stepSizeMs?: number; readonly maxStepsPerFrame?: number }): SimRuntime => {
  if (runtime) {
    return runtime;
  }
  runtime = createSimRuntime(options);
  return runtime;
};

const emit = (message: WorkerOutboundMessage): void => {
  parentPort?.postMessage(message);
};

parentPort.on('message', (message: unknown) => {
  try {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      return;
    }

    const kind = (message as { kind?: unknown }).kind;
    if (kind === 'init') {
      const init = message as WorkerInitMessage;
      runtime = createSimRuntime({
        stepSizeMs: init.stepSizeMs,
        maxStepsPerFrame: init.maxStepsPerFrame,
      });
      emit({
        kind: 'ready',
        stepSizeMs: runtime.getStepSizeMs(),
        nextStep: runtime.getNextStep(),
      });
      return;
    }

    if (kind === 'tick') {
      const tick = message as WorkerTickMessage;
      if (!Number.isFinite(tick.deltaMs)) {
        return;
      }
      const activeRuntime = ensureRuntime();
      const result = activeRuntime.tick(tick.deltaMs);
      const droppedFrames = Math.max(0, result.frames.length - 1);
      const frame = result.frames.slice(-1)[0];
      if (frame) {
        emit({ kind: 'frame', frame, droppedFrames, nextStep: result.nextStep });
      } else {
        emit({ kind: 'frame', droppedFrames, nextStep: result.nextStep });
      }
      return;
    }

    if (kind === 'enqueueCommands') {
      const payload = message as WorkerEnqueueCommandsMessage;
      ensureRuntime().enqueueCommands(payload.commands);
      return;
    }

    if (kind === 'shutdown') {
      parentPort?.close();
    }
  } catch (error: unknown) {
    emit({ kind: 'error', error: error instanceof Error ? error.message : String(error) });
  }
});
