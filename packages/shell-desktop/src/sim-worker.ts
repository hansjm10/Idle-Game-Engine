import { parentPort } from 'node:worker_threads';
import { RUNTIME_COMMAND_TYPES } from '@idle-engine/core';
import { createSimRuntime, loadSerializedSimRuntimeState } from './sim/sim-runtime.js';
import type { SimRuntime } from './sim/sim-runtime.js';
import {
  DEFAULT_SIM_RUNTIME_CAPABILITIES,
  type SimRuntimeCapabilities,
  type SimWorkerOutboundMessage,
} from './sim/worker-protocol.js';

if (!parentPort) {
  throw new Error('shell-desktop sim worker requires parentPort');
}

let runtime: SimRuntime | undefined;
let runtimeConfig = {
  stepSizeMs: 16,
  maxStepsPerFrame: 50,
};

const ensureRuntime = (options?: { readonly stepSizeMs?: number; readonly maxStepsPerFrame?: number }): SimRuntime => {
  if (runtime) {
    return runtime;
  }
  runtime = createSimRuntime({
    stepSizeMs: options?.stepSizeMs ?? runtimeConfig.stepSizeMs,
    maxStepsPerFrame: options?.maxStepsPerFrame ?? runtimeConfig.maxStepsPerFrame,
  });
  return runtime;
};

const emit = (message: SimWorkerOutboundMessage): void => {
  parentPort?.postMessage(message);
};

const isFiniteAtLeastOne = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 1;

const getRuntimeCapabilities = (activeRuntime: SimRuntime): SimRuntimeCapabilities => {
  const explicitCapabilities = activeRuntime.getCapabilities?.();
  const resolvedCapabilities = explicitCapabilities === undefined
    ? { ...DEFAULT_SIM_RUNTIME_CAPABILITIES }
    : { ...DEFAULT_SIM_RUNTIME_CAPABILITIES, ...explicitCapabilities };

  return {
    ...resolvedCapabilities,
    canSerialize:
      explicitCapabilities?.canSerialize ?? typeof activeRuntime.serialize === 'function',
    canHydrate:
      explicitCapabilities?.canHydrate
      ?? explicitCapabilities?.canSerialize
      ?? typeof activeRuntime.serialize === 'function',
    supportsOfflineCatchup:
      explicitCapabilities?.supportsOfflineCatchup
      ?? activeRuntime.hasCommandHandler?.(RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP)
      ?? false,
  };
};

const emitRequestError = (requestId: string, error: string): void => {
  emit({ kind: 'requestError', requestId, error });
};

parentPort.on('message', (message: unknown) => {
  try {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      return;
    }

    const kind = (message as { kind?: unknown }).kind;
    if (kind === 'init') {
      const init = message as { stepSizeMs?: unknown; maxStepsPerFrame?: unknown };

      // Validate stepSizeMs
      if (!isFiniteAtLeastOne(init.stepSizeMs)) {
        emit({ kind: 'error', error: 'protocol:init invalid stepSizeMs' });
        return;
      }

      // Validate maxStepsPerFrame
      if (!isFiniteAtLeastOne(init.maxStepsPerFrame)) {
        emit({ kind: 'error', error: 'protocol:init invalid maxStepsPerFrame' });
        return;
      }

      runtime = createSimRuntime({
        stepSizeMs: init.stepSizeMs,
        maxStepsPerFrame: init.maxStepsPerFrame,
      });
      runtimeConfig = {
        stepSizeMs: init.stepSizeMs,
        maxStepsPerFrame: init.maxStepsPerFrame,
      };
      emit({
        kind: 'ready',
        stepSizeMs: runtime.getStepSizeMs(),
        nextStep: runtime.getNextStep(),
        capabilities: getRuntimeCapabilities(runtime),
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
      const droppedFrames = result.droppedFrames ?? Math.max(0, result.frames.length - 1);
      const frame = result.frame ?? result.frames.at(-1);
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

    if (kind === 'serialize') {
      const request = message as { requestId?: unknown };
      if (typeof request.requestId !== 'string' || request.requestId.trim().length === 0) {
        emit({ kind: 'error', error: 'protocol:serialize invalid requestId' });
        return;
      }

      try {
        const activeRuntime = ensureRuntime();
        if (typeof activeRuntime.serialize !== 'function') {
          emitRequestError(request.requestId, 'Simulation runtime does not support serialization.');
          return;
        }

        emit({
          kind: 'serialized',
          requestId: request.requestId,
          state: activeRuntime.serialize(),
        });
      } catch (error: unknown) {
        emitRequestError(
          request.requestId,
          error instanceof Error ? error.message : String(error),
        );
      }
      return;
    }

    if (kind === 'hydrate') {
      const request = message as { requestId?: unknown; state?: unknown };
      if (typeof request.requestId !== 'string' || request.requestId.trim().length === 0) {
        emit({ kind: 'error', error: 'protocol:hydrate invalid requestId' });
        return;
      }

      try {
        const activeRuntime = ensureRuntime();
        const capabilities = getRuntimeCapabilities(activeRuntime);
        if (!capabilities.canHydrate) {
          emitRequestError(request.requestId, 'Simulation runtime does not support hydration.');
          return;
        }

        const savedState = loadSerializedSimRuntimeState(request.state);
        runtime = createSimRuntime({
          stepSizeMs: runtimeConfig.stepSizeMs,
          maxStepsPerFrame: runtimeConfig.maxStepsPerFrame,
          initialSerializedState: savedState,
        });

        emit({
          kind: 'hydrated',
          requestId: request.requestId,
          nextStep: runtime.getNextStep(),
          capabilities: getRuntimeCapabilities(runtime),
          frame: runtime.renderCurrentFrame?.(),
        });
      } catch (error: unknown) {
        emitRequestError(
          request.requestId,
          error instanceof Error ? error.message : String(error),
        );
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
