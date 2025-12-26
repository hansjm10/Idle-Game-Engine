import {
  RUNTIME_COMMAND_TYPES,
  type OfflineCatchupPayload,
} from './command.js';
import type { CommandDispatcher, CommandHandler } from './command-dispatcher.js';
import { applyOfflineResourceDeltas } from './offline-resource-deltas.js';
import { resolveOfflineProgressTotals } from './offline-progress-limits.js';
import type { ProgressionCoordinator } from './progression-coordinator.js';
import { telemetry } from './telemetry.js';

export type OfflineCatchupRuntime = Readonly<{
  getStepSizeMs(): number;
  creditTime(deltaMs: number): void;
}>;

export interface OfflineCatchupCommandHandlerOptions {
  readonly dispatcher: CommandDispatcher;
  readonly coordinator: ProgressionCoordinator;
  readonly runtime: OfflineCatchupRuntime;
}

export function registerOfflineCatchupCommandHandler(
  options: OfflineCatchupCommandHandlerOptions,
): void {
  const { dispatcher, coordinator, runtime } = options;

  dispatcher.register<OfflineCatchupPayload>(
    RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP,
    createOfflineCatchupHandler({ coordinator, runtime }),
  );
}

function createOfflineCatchupHandler(options: {
  readonly coordinator: ProgressionCoordinator;
  readonly runtime: OfflineCatchupRuntime;
}): CommandHandler<OfflineCatchupPayload> {
  const { coordinator, runtime } = options;

  return (payload, context) => {
    if (typeof payload !== 'object' || payload === null) {
      telemetry.recordError('OfflineCatchupInvalidPayload', {
        payloadType: typeof payload,
        step: context.step,
        priority: context.priority,
      });
      return;
    }

    if (
      payload.resourceDeltas !== undefined &&
      (typeof payload.resourceDeltas !== 'object' ||
        payload.resourceDeltas === null ||
        Array.isArray(payload.resourceDeltas))
    ) {
      telemetry.recordError('OfflineCatchupInvalidResourceDeltas', {
        resourceDeltas: payload.resourceDeltas,
        step: context.step,
        priority: context.priority,
      });
      return;
    }

    const resourceDeltas = payload.resourceDeltas ?? {};
    applyOfflineResourceDeltas(coordinator, resourceDeltas);

    const elapsedMs = payload.elapsedMs;
    if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs <= 0) {
      return;
    }

    const stepSizeMs = runtime.getStepSizeMs();
    if (!Number.isFinite(stepSizeMs) || stepSizeMs <= 0) {
      return;
    }

    const { totalMs } = resolveOfflineProgressTotals(elapsedMs, stepSizeMs, {
      maxElapsedMs: payload.maxElapsedMs,
      maxSteps: payload.maxSteps,
    });
    if (totalMs <= 0) {
      return;
    }

    const remainingMs = totalMs - stepSizeMs;
    if (remainingMs > 0) {
      runtime.creditTime(remainingMs);
    }
  };
}
