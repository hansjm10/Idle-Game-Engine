import type { Command } from './command.js';
import { CommandDispatcher } from './command-dispatcher.js';
import { CommandQueue } from './command-queue.js';
import { telemetry } from './telemetry.js';

export interface TickContext {
  readonly deltaMs: number;
  readonly step: number;
}

export type System = {
  readonly id: string;
  readonly tick: (context: TickContext) => void;
};

export interface EngineOptions {
  readonly stepSizeMs?: number;
  readonly maxStepsPerFrame?: number;
}

export interface RuntimeDependencies {
  readonly commandQueue?: CommandQueue;
  readonly commandDispatcher?: CommandDispatcher;
}

export type IdleEngineRuntimeOptions = EngineOptions & RuntimeDependencies;

const DEFAULT_STEP_MS = 100;
const DEFAULT_MAX_STEPS = 50;

/**
 * Runtime implementation that integrates the command queue and dispatcher with
 * the deterministic fixed-step tick loop described in
 * docs/runtime-command-queue-design.md §4.3.
 */
export class IdleEngineRuntime {
  private readonly systems: System[] = [];
  private accumulator = 0;
  private readonly stepSizeMs: number;
  private readonly maxStepsPerFrame: number;
  private readonly commandQueue: CommandQueue;
  private readonly commandDispatcher: CommandDispatcher;
  private currentStep = 0;
  private nextExecutableStep = 0;

  constructor(options: IdleEngineRuntimeOptions = {}) {
    this.stepSizeMs = options.stepSizeMs ?? DEFAULT_STEP_MS;
    this.maxStepsPerFrame = options.maxStepsPerFrame ?? DEFAULT_MAX_STEPS;
    this.commandQueue = options.commandQueue ?? new CommandQueue();
    this.commandDispatcher =
      options.commandDispatcher ?? new CommandDispatcher();
  }

  addSystem(system: System): void {
    this.systems.push(system);
  }

  getCommandQueue(): CommandQueue {
    return this.commandQueue;
  }

  getCommandDispatcher(): CommandDispatcher {
    return this.commandDispatcher;
  }

  getCurrentStep(): number {
    return this.currentStep;
  }

  getNextExecutableStep(): number {
    return this.nextExecutableStep;
  }

  /**
   * Advance the simulation by `deltaMs`, clamping the number of processed
   * steps to avoid spiral of death scenarios.
   */
  tick(deltaMs: number): void {
    if (deltaMs <= 0) {
      return;
    }

    this.accumulator += deltaMs;
    const availableSteps = Math.floor(this.accumulator / this.stepSizeMs);
    const steps = Math.min(availableSteps, this.maxStepsPerFrame);

    if (steps === 0) {
      return;
    }

    this.accumulator -= steps * this.stepSizeMs;

    for (let i = 0; i < steps; i += 1) {
      // Accept commands for the current step until the batch is captured.
      this.nextExecutableStep = this.currentStep;
      const commands =
        this.commandQueue.dequeueUpToStep(this.currentStep);

      // Commands enqueued during execution target the next tick.
      this.nextExecutableStep = this.currentStep + 1;

      for (const command of commands) {
        if (command.step !== this.currentStep) {
          telemetry.recordError('CommandStepMismatch', {
            expectedStep: this.currentStep,
            commandStep: command.step,
            type: command.type,
          });
          continue;
        }

        this.commandDispatcher.execute(command as Command);
      }

      const context: TickContext = {
        deltaMs: this.stepSizeMs,
        step: this.currentStep,
      };

      for (const system of this.systems) {
        try {
          system.tick(context);
        } catch (error) {
          telemetry.recordError('SystemExecutionFailed', {
            systemId: system.id,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      }

      this.currentStep += 1;
      this.nextExecutableStep = this.currentStep;
      telemetry.recordTick();
    }
  }
}

export {
  Command,
  CommandPriority,
  COMMAND_PRIORITY_ORDER,
  CommandQueueEntry,
  CommandSnapshot,
  CommandSnapshotPayload,
  ImmutablePayload,
  RUNTIME_COMMAND_TYPES,
  type RuntimeCommandType,
  type PurchaseGeneratorPayload,
  type ToggleGeneratorPayload,
  type CollectResourcePayload,
  type PrestigeResetPayload,
  type OfflineCatchupPayload,
  type MigrationStep,
  type ApplyMigrationPayload,
  type RuntimeCommandPayloads,
  type RuntimeCommand,
  type CommandAuthorizationPolicy,
  COMMAND_AUTHORIZATIONS,
} from './command.js';
export {
  authorizeCommand,
  DEFAULT_UNAUTHORIZED_EVENT,
} from './command-authorization.js';
export { CommandQueue, deepFreezeInPlace } from './command-queue.js';
export {
  CommandDispatcher,
  type CommandHandler,
  type ExecutionContext,
} from './command-dispatcher.js';
export {
  CommandRecorder,
  restoreState,
  type CommandLog,
  type RuntimeReplayContext,
  type StateSnapshot,
} from './command-recorder.js';
export type {
  ImmutableArrayBufferSnapshot,
  ImmutableSharedArrayBufferSnapshot,
} from './immutable-snapshots.js';
export {
  getCurrentRNGSeed,
  setRNGSeed,
  seededRandom,
  resetRNG,
} from './rng.js';
export {
  getGameState,
  setGameState,
  clearGameState,
} from './runtime-state.js';
export {
  createResourceState,
  type ResourceDefinition,
  type ResourceDefinitionDigest,
  type ResourceSpendAttemptContext,
  type ResourceState,
  type ResourceStateSnapshot,
  type SerializedResourceState,
} from './resource-state.js';
export {
  TransportBufferPool,
  type LeaseReleaseContext,
  type TransportBufferLease,
  type TransportBufferPoolOptions,
} from './transport-buffer-pool.js';
export {
  buildResourcePublishTransport,
  createResourcePublishTransport,
  type ResourcePublishTransport,
  type ResourcePublishTransportBuildOptions,
  type ResourcePublishTransportBuildResult,
  type ResourcePublishTransportReleaseOptions,
  type TransportBufferDescriptor,
  type TransportComponent,
  type TransportConstructorName,
} from './resource-publish-transport.js';
export {
  telemetry,
  type TelemetryEventData,
  type TelemetryFacade,
  resetTelemetry,
  setTelemetry,
} from './telemetry.js';
export { createReadOnlyProxy } from './read-only-proxy.js';
