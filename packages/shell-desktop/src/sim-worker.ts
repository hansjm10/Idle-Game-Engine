import { parentPort } from 'node:worker_threads';
import { createSimRuntime } from './sim/sim-runtime.js';
import type { SimRuntime } from './sim/sim-runtime.js';
import type { SimWorkerOutboundMessage } from './sim/worker-protocol.js';

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

const emit = (message: SimWorkerOutboundMessage): void => {
  parentPort?.postMessage(message);
};

const isFinitePositive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

parentPort.on('message', (message: unknown) => {
  try {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      return;
    }

    const kind = (message as { kind?: unknown }).kind;
    if (kind === 'init') {
      const init = message as { stepSizeMs?: unknown; maxStepsPerFrame?: unknown };

      // Validate stepSizeMs
      if (!isFinitePositive(init.stepSizeMs)) {
        emit({ kind: 'error', error: 'protocol:init invalid stepSizeMs' });
        return;
      }

      // Validate maxStepsPerFrame
      if (!isFinitePositive(init.maxStepsPerFrame)) {
        emit({ kind: 'error', error: 'protocol:init invalid maxStepsPerFrame' });
        return;
      }

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
      const tick = message as { deltaMs?: unknown };
      if (typeof tick.deltaMs !== 'number' || !Number.isFinite(tick.deltaMs)) {
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
      const payload = message as { commands?: unknown };
      if (Array.isArray(payload.commands)) {
        ensureRuntime().enqueueCommands(payload.commands);
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
