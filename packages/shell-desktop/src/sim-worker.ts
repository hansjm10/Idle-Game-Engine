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

type WorkerSerializeMessage = Readonly<{
  kind: 'serialize';
  requestId: string;
}>;

type WorkerHydrateMessage = Readonly<{
  kind: 'hydrate';
  requestId: string;
  save: unknown;
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

type WorkerSerializedMessage = Readonly<{
  kind: 'serialized';
  requestId: string;
  save?: unknown;
  error?: string;
}>;

type WorkerHydratedMessage = Readonly<{
  kind: 'hydrated';
  requestId: string;
  success: boolean;
  nextStep?: number;
  stepSizeMs?: number;
  error?: string;
}>;

type WorkerOutboundMessage =
  | WorkerReadyMessage
  | WorkerFrameMessage
  | WorkerSerializedMessage
  | WorkerHydratedMessage
  | WorkerErrorMessage;

if (!parentPort) {
  throw new Error('shell-desktop sim worker requires parentPort');
}

let runtime: SimRuntime | undefined;
let runtimeOptions:
  | Readonly<{ stepSizeMs?: number; maxStepsPerFrame?: number }>
  | undefined;

const ensureRuntime = (
  options?: Readonly<{ stepSizeMs?: number; maxStepsPerFrame?: number }>,
): SimRuntime => {
  if (runtime) {
    return runtime;
  }
  runtime = createSimRuntime(options ?? runtimeOptions);
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
      runtimeOptions = {
        stepSizeMs: init.stepSizeMs,
        maxStepsPerFrame: init.maxStepsPerFrame,
      };
      runtime = createSimRuntime(runtimeOptions);
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
      const frame = result.frames.at(-1);
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

    if (kind === 'serialize') {
      const request = message as WorkerSerializeMessage;
      const requestId = request.requestId;
      if (typeof requestId !== 'string' || requestId.length === 0) {
        return;
      }

      const activeRuntime = ensureRuntime();
      if (typeof activeRuntime.serialize !== 'function') {
        emit({ kind: 'serialized', requestId, error: 'Serialize is not supported by this runtime.' });
        return;
      }

      try {
        emit({ kind: 'serialized', requestId, save: activeRuntime.serialize() });
      } catch (error: unknown) {
        emit({ kind: 'serialized', requestId, error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (kind === 'hydrate') {
      const request = message as WorkerHydrateMessage;
      const requestId = request.requestId;
      if (typeof requestId !== 'string' || requestId.length === 0) {
        return;
      }

      const activeRuntime = ensureRuntime();
      if (typeof activeRuntime.hydrate !== 'function') {
        emit({ kind: 'hydrated', requestId, success: false, error: 'Hydrate is not supported by this runtime.' });
        return;
      }

      const previousRuntime = runtime;
      const replacement = createSimRuntime(runtimeOptions);
      runtime = replacement;

      try {
        if (typeof replacement.hydrate !== 'function') {
          throw new Error('Hydrate is not supported by this runtime.');
        }
        replacement.hydrate(request.save);
        emit({
          kind: 'hydrated',
          requestId,
          success: true,
          stepSizeMs: replacement.getStepSizeMs(),
          nextStep: replacement.getNextStep(),
        });
      } catch (error: unknown) {
        runtime = previousRuntime;
        emit({
          kind: 'hydrated',
          requestId,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (kind === 'shutdown') {
      parentPort?.close();
    }
  } catch (error: unknown) {
    emit({ kind: 'error', error: error instanceof Error ? error.message : String(error) });
  }
});
