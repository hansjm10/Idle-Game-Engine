import { parentPort } from 'node:worker_threads';
import { RUNTIME_COMMAND_TYPES } from '@idle-engine/core';
import { createSimRuntime } from './sim/sim-runtime.js';
import type { SimRuntime } from './sim/sim-runtime.js';
import type { SimWorkerOutboundMessage } from './sim/worker-protocol.js';
import { encodeGameStateSave, loadGameStateSaveFormat } from './runtime-harness.js';

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

const isFiniteAtLeastOne = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 1;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

const isValidRequestId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length >= 1 &&
  value.length <= 64 &&
  REQUEST_ID_PATTERN.test(value);

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

      const canSerialize = typeof runtime.serialize === 'function' && typeof runtime.hydrate === 'function';
      const canOfflineCatchup = runtime.hasCommandHandler(RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP);

      emit({
        kind: 'ready',
        protocolVersion: 2,
        stepSizeMs: runtime.getStepSizeMs(),
        nextStep: runtime.getNextStep(),
        capabilities: {
          canSerialize,
          canOfflineCatchup,
        },
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
      return;
    }

    if (kind === 'serialize') {
      const msg = message as { requestId?: unknown };

      if (!isValidRequestId(msg.requestId)) {
        const actual = typeof msg.requestId === 'string' ? `"${msg.requestId}"` : String(msg.requestId);
        emit({
          kind: 'saveData',
          requestId: typeof msg.requestId === 'string' ? msg.requestId : '',
          ok: false,
          error: {
            code: 'PROTOCOL_VALIDATION_FAILED',
            message: `Invalid serialize.requestId: expected 1-64 chars matching ^[A-Za-z0-9_-]+$, received ${actual}.`,
            retriable: false,
          },
        });
        return;
      }

      const activeRuntime = ensureRuntime();
      if (typeof activeRuntime.serialize !== 'function') {
        emit({
          kind: 'saveData',
          requestId: msg.requestId,
          ok: false,
          error: {
            code: 'CAPABILITY_UNAVAILABLE',
            message: 'Runtime does not support serialize.',
            retriable: false,
          },
        });
        return;
      }

      // Capture narrowed values before async boundary
      const serializeFn = activeRuntime.serialize;
      const reqId = msg.requestId;

      void (async () => {
        try {
          const saveFormat = serializeFn();
          const data = await encodeGameStateSave(saveFormat);

          if (data.byteLength === 0) {
            emit({
              kind: 'saveData',
              requestId: reqId,
              ok: false,
              error: {
                code: 'SERIALIZE_FAILED',
                message: 'Serialization produced empty data.',
                retriable: true,
              },
            });
            return;
          }

          emit({
            kind: 'saveData',
            requestId: reqId,
            ok: true,
            data,
          });
        } catch (serializeError: unknown) {
          emit({
            kind: 'saveData',
            requestId: reqId,
            ok: false,
            error: {
              code: 'SERIALIZE_FAILED',
              message: serializeError instanceof Error ? serializeError.message : String(serializeError),
              retriable: true,
            },
          });
        }
      })();
      return;
    }

    if (kind === 'hydrate') {
      const msg = message as { requestId?: unknown; save?: unknown };

      if (!isValidRequestId(msg.requestId)) {
        const actual = typeof msg.requestId === 'string' ? `"${msg.requestId}"` : String(msg.requestId);
        emit({
          kind: 'hydrateResult',
          requestId: typeof msg.requestId === 'string' ? msg.requestId : '',
          ok: false,
          error: {
            code: 'PROTOCOL_VALIDATION_FAILED',
            message: `Invalid hydrate.requestId: expected 1-64 chars matching ^[A-Za-z0-9_-]+$, received ${actual}.`,
            retriable: false,
          },
        });
        return;
      }

      // Validate save payload through core load-format path
      let validatedSave: ReturnType<typeof loadGameStateSaveFormat>;
      try {
        validatedSave = loadGameStateSaveFormat(msg.save);
      } catch {
        emit({
          kind: 'hydrateResult',
          requestId: msg.requestId,
          ok: false,
          error: {
            code: 'INVALID_SAVE_DATA',
            message: 'Invalid hydrate.save: expected GameStateSaveFormat that resolves to version 1.',
            retriable: false,
          },
        });
        return;
      }

      const activeRuntime = ensureRuntime();
      if (typeof activeRuntime.hydrate !== 'function') {
        emit({
          kind: 'hydrateResult',
          requestId: msg.requestId,
          ok: false,
          error: {
            code: 'CAPABILITY_UNAVAILABLE',
            message: 'Runtime does not support hydrate.',
            retriable: false,
          },
        });
        return;
      }

      try {
        activeRuntime.hydrate(validatedSave);
        emit({
          kind: 'hydrateResult',
          requestId: msg.requestId,
          ok: true,
          nextStep: activeRuntime.getNextStep(),
        });
      } catch (hydrateError: unknown) {
        emit({
          kind: 'hydrateResult',
          requestId: msg.requestId,
          ok: false,
          error: {
            code: 'HYDRATE_FAILED',
            message: hydrateError instanceof Error ? hydrateError.message : String(hydrateError),
            retriable: true,
          },
        });
      }
      return;
    }
  } catch (error: unknown) {
    emit({ kind: 'error', error: error instanceof Error ? error.message : String(error) });
  }
});
