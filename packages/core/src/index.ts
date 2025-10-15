import {
  EventBus,
  type EventBusOptions,
  type EventDispatchContext,
  type EventHandler,
  type EventPublisher,
  type EventSubscription,
} from './events/event-bus.js';
import type { RuntimeEventType } from './events/runtime-event.js';
import { DEFAULT_EVENT_BUS_OPTIONS } from './events/runtime-event-catalog.js';
import type { Command } from './command.js';
import { CommandDispatcher } from './command-dispatcher.js';
import { CommandQueue } from './command-queue.js';
import { telemetry } from './telemetry.js';

export interface TickContext {
  readonly deltaMs: number;
  readonly step: number;
  readonly events: EventPublisher;
}

export interface SystemRegistrationContext {
  readonly events: {
    on<TType extends RuntimeEventType>(
      eventType: TType,
      handler: EventHandler<TType>,
    ): EventSubscription;
  };
}

export type System = {
  readonly id: string;
  readonly tick: (context: TickContext) => void;
  readonly setup?: (context: SystemRegistrationContext) => void;
};

export interface EngineOptions {
  readonly stepSizeMs?: number;
  readonly maxStepsPerFrame?: number;
}

export interface RuntimeDependencies {
  readonly commandQueue?: CommandQueue;
  readonly commandDispatcher?: CommandDispatcher;
  readonly eventBus?: EventBus;
}

export interface IdleEngineRuntimeOptions
  extends EngineOptions,
    RuntimeDependencies {
  readonly eventBusOptions?: EventBusOptions;
}

const DEFAULT_STEP_MS = 100;
const DEFAULT_MAX_STEPS = 50;

type RegisteredSystem = {
  readonly system: System;
  readonly subscriptions: EventSubscription[];
};

/**
 * Runtime implementation that integrates the command queue and dispatcher with
 * the deterministic fixed-step tick loop described in
 * docs/runtime-command-queue-design.md §4.3.
 */
export class IdleEngineRuntime {
  private readonly systems: RegisteredSystem[] = [];
  private accumulator = 0;
  private readonly stepSizeMs: number;
  private readonly maxStepsPerFrame: number;
  private readonly commandQueue: CommandQueue;
  private readonly commandDispatcher: CommandDispatcher;
  private readonly eventBus: EventBus;
  private readonly eventPublisher: EventPublisher;
  private currentStep = 0;
  private nextExecutableStep = 0;

  constructor(options: IdleEngineRuntimeOptions = {}) {
    this.stepSizeMs = options.stepSizeMs ?? DEFAULT_STEP_MS;
    this.maxStepsPerFrame = options.maxStepsPerFrame ?? DEFAULT_MAX_STEPS;
    this.commandQueue = options.commandQueue ?? new CommandQueue();
    this.commandDispatcher =
      options.commandDispatcher ?? new CommandDispatcher();

    const eventBusOptions = options.eventBusOptions ?? DEFAULT_EVENT_BUS_OPTIONS;
    this.eventBus = options.eventBus ?? new EventBus(eventBusOptions);
    this.eventPublisher = createEventPublisher(this.eventBus);

    this.commandDispatcher.setEventPublisher(this.eventPublisher);
  }

  addSystem(system: System): void {
    const subscriptions: EventSubscription[] = [];

    if (typeof system.setup === 'function') {
      const registrationContext: SystemRegistrationContext = {
        events: {
          on: <TType extends RuntimeEventType>(
            eventType: TType,
            handler: EventHandler<TType>,
          ): EventSubscription => {
            const subscription = this.eventBus.on(eventType, handler);
            subscriptions.push(subscription);
            return subscription;
          },
        },
      };

      try {
        system.setup(registrationContext);
      } catch (error) {
        for (const subscription of subscriptions) {
          subscription.unsubscribe();
        }

        throw new Error(
          `System "${system.id}" failed to register event subscriptions: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    this.systems.push({
      system,
      subscriptions,
    });
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

  getEventBus(): EventBus {
    return this.eventBus;
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
      this.eventBus.beginTick(this.currentStep);

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

      const dispatchContext: EventDispatchContext = {
        tick: this.currentStep,
      };

      this.eventBus.dispatch(dispatchContext);

      const context: TickContext = {
        deltaMs: this.stepSizeMs,
        step: this.currentStep,
        events: this.eventPublisher,
      };

      for (const { system } of this.systems) {
        try {
          system.tick(context);
        } catch (error) {
          telemetry.recordError('SystemExecutionFailed', {
            systemId: system.id,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }

        this.eventBus.dispatch(dispatchContext);
      }

      this.currentStep += 1;
      this.nextExecutableStep = this.currentStep;
      telemetry.recordTick();
    }
  }
}

function createEventPublisher(bus: EventBus): EventPublisher {
  return {
    publish: bus.publish.bind(bus),
  };
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
  type RecordedRuntimeEvent,
  type RecordedRuntimeEventFrame,
  type RuntimeReplayContext,
  type StateSnapshot,
} from './command-recorder.js';
export {
  EventBus,
  type EventBusOptions,
  type EventDispatchContext,
  type EventHandler,
  type EventPublisher,
  type EventSubscription,
} from './events/event-bus.js';
export {
  DEFAULT_EVENT_BUS_OPTIONS,
  RUNTIME_EVENT_CHANNELS,
  type AutomationToggledEventPayload,
  type ResourceThresholdReachedEventPayload,
} from './events/runtime-event-catalog.js';
export {
  computeRuntimeEventManifestHash,
  createRuntimeEvent,
  type RuntimeEventManifest,
  type RuntimeEventPayload,
  type RuntimeEventType,
} from './events/runtime-event.js';
export {
  buildRuntimeEventFrame,
  type RuntimeEventFrame,
  type RuntimeEventFrameBuildOptions,
  type RuntimeEventFrameBuildResult,
} from './events/runtime-event-frame.js';
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
  reconcileSaveAgainstDefinitions,
  type ResourceDefinition,
  type ResourceDefinitionDigest,
  type ResourceDefinitionReconciliation,
  type ResourceSpendAttemptContext,
  type ResourceState,
  type ResourceStateSnapshot,
  type SerializedResourceState,
} from './resource-state.js';
export {
  registerResourceCommandHandlers,
  type ResourceCommandHandlerOptions,
  type GeneratorPurchaseEvaluator,
  type GeneratorPurchaseQuote,
  type GeneratorResourceCost,
} from './resource-command-handlers.js';
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
