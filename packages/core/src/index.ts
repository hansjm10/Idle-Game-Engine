import {
  EventBus,
  type EventBusOptions,
  type EventDispatchContext,
  type EventHandler,
  type EventPublisher,
  type EventSubscription,
  type EventSubscriptionOptions,
  type BackPressureSnapshot,
  type PublishMetadata,
  type PublishResult,
} from './events/event-bus.js';
import type {
  RuntimeEventPayload,
  RuntimeEventType,
} from './events/runtime-event.js';
import { DEFAULT_EVENT_BUS_OPTIONS } from './events/runtime-event-catalog.js';
import type { Command } from './command.js';
import { CommandDispatcher } from './command-dispatcher.js';
import { CommandQueue } from './command-queue.js';
import { telemetry } from './telemetry.js';
import {
  createRuntimeDiagnosticsController,
  type IdleEngineRuntimeDiagnosticsOptions,
  type RuntimeDiagnosticsTimelineOptions,
  type RuntimeDiagnosticsController,
} from './diagnostics/runtime-diagnostics-controller.js';
import type {
  DiagnosticTimelineRecorder,
  DiagnosticTimelineResult,
  DiagnosticTimelineEventMetrics,
} from './diagnostics/diagnostic-timeline.js';
import {
  FixedTimestepScheduler,
  type OfflineCatchUpResult,
  type SchedulerStepExecutionContext,
} from './tick-scheduler.js';
import type {
  System,
  SystemRegistrationContext,
  TickContext,
  SystemDefinition,
} from './systems/system-types.js';
import {
  registerSystems as registerSystemDefinitions,
  type RegisterSystemsResult,
} from './systems/system-registry.js';

export interface EngineOptions {
  readonly stepSizeMs?: number;
  readonly maxStepsPerFrame?: number;
}

export interface BackgroundSchedulerOptions {
  readonly maxStepsPerFrame?: number;
}

export interface OfflineCatchUpOptions {
  readonly maxElapsedMs?: number;
  readonly maxBatchSteps?: number;
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
  readonly diagnostics?: IdleEngineRuntimeDiagnosticsOptions;
  readonly background?: BackgroundSchedulerOptions;
  readonly offlineCatchUp?: OfflineCatchUpOptions;
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
  private readonly stepSizeMs: number;
  private readonly commandQueue: CommandQueue;
  private readonly commandDispatcher: CommandDispatcher;
  private readonly eventBus: EventBus;
  private readonly eventPublisher: EventPublisher;
  private currentStep = 0;
  private nextExecutableStep = 0;
  private readonly diagnostics: RuntimeDiagnosticsController;
  private readonly scheduler: FixedTimestepScheduler;
  private offlineCatchUpResetPending = false;

  constructor(options: IdleEngineRuntimeOptions = {}) {
    this.stepSizeMs = options.stepSizeMs ?? DEFAULT_STEP_MS;
    this.commandQueue = options.commandQueue ?? new CommandQueue();
    this.commandDispatcher =
      options.commandDispatcher ?? new CommandDispatcher();

    const eventBusOptions = options.eventBusOptions ?? DEFAULT_EVENT_BUS_OPTIONS;
    this.eventBus = options.eventBus ?? new EventBus(eventBusOptions);
    this.eventPublisher = createEventPublisher(this.eventBus);

    this.commandDispatcher.setEventPublisher(this.eventPublisher);

    this.diagnostics = createRuntimeDiagnosticsController(
      options.diagnostics,
      {
        stepSizeMs: this.stepSizeMs,
      },
    );

    const backgroundOptions = options.background ?? {};
    const offlineOptions = options.offlineCatchUp ?? {};

    this.scheduler = new FixedTimestepScheduler(
      (context) => {
        this.runStep(context);
      },
      {
        stepSizeMs: this.stepSizeMs,
        maxForegroundStepsPerFrame:
          options.maxStepsPerFrame ?? DEFAULT_MAX_STEPS,
        maxBackgroundStepsPerFrame:
          backgroundOptions.maxStepsPerFrame,
        maxOfflineCatchUpMs: offlineOptions.maxElapsedMs,
        maxOfflineBatchSteps: offlineOptions.maxBatchSteps,
      },
    );
  }

  addSystem(system: System): void {
    if (this.systems.some((entry) => entry.system.id === system.id)) {
      throw new Error(`System "${system.id}" is already registered.`);
    }
    const subscriptions: EventSubscription[] = [];

    if (typeof system.setup === 'function') {
      const registrationContext: SystemRegistrationContext = {
        events: {
          on: <TType extends RuntimeEventType>(
            eventType: TType,
            handler: EventHandler<TType>,
            options?: EventSubscriptionOptions,
          ): EventSubscription => {
            const subscription = this.eventBus.on(eventType, handler, {
              ...options,
              label: options?.label ?? `system:${system.id}`,
            });
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

  hasSystem(systemId: string): boolean {
    return this.systems.some((entry) => entry.system.id === systemId);
  }

  addSystems(definitions: readonly SystemDefinition[]): RegisterSystemsResult {
    if (!Array.isArray(definitions) || definitions.length === 0) {
      return { order: [] };
    }
    return registerSystemDefinitions(this, definitions);
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

  getDiagnosticTimeline(): DiagnosticTimelineRecorder {
    return this.diagnostics.timeline;
  }

  getDiagnosticTimelineSnapshot(): DiagnosticTimelineResult {
    return this.diagnostics.snapshot();
  }

  readDiagnosticsDelta(sinceHead?: number): DiagnosticTimelineResult {
    return this.diagnostics.readDelta(sinceHead);
  }

  enableDiagnostics(
    options?: RuntimeDiagnosticsTimelineOptions | false,
  ): void {
    if (options === false) {
      this.diagnostics.disable();
      return;
    }
    this.diagnostics.enable(options);
  }

  setBackgroundThrottled(throttled: boolean): void {
    this.scheduler.setThrottled(throttled);
  }

  runOfflineCatchUp(elapsedMs: number): OfflineCatchUpResult {
    this.offlineCatchUpResetPending = true;
    try {
      return this.scheduler.catchUp(elapsedMs);
    } finally {
      this.offlineCatchUpResetPending = false;
    }
  }

  getAccumulatorBacklogMs(): number {
    return this.scheduler.getAccumulatorMs();
  }

  getStepSizeMs(): number {
    return this.scheduler.getStepSizeMs();
  }

  /**
   * Advance the simulation by `deltaMs`, clamping the number of processed
   * steps to avoid spiral of death scenarios.
   */
  tick(deltaMs: number): void {
    const result = this.scheduler.advance(deltaMs);
    if (result.executedSteps === 0) {
      return;
    }
  }
  private runStep(context: SchedulerStepExecutionContext): void {
    const tickDiagnostics = this.diagnostics.beginTick(this.currentStep);

    const queueSizeBefore = this.commandQueue.size;
    let queueSizeAfter = queueSizeBefore;
    let capturedCommands = 0;
    let executedCommands = 0;
    let skippedCommands = 0;

    try {
      if (context.isCatchUp) {
        tickDiagnostics.addPhase('mode.offline', 0);
      }

      const resetOutbound = context.isCatchUp
        ? this.offlineCatchUpResetPending && context.isFirstInBatch
        : context.isFirstInBatch;

      this.eventBus.beginTick(this.currentStep, {
        resetOutbound,
      });

      if (
        context.isCatchUp &&
        context.isFirstInBatch &&
        this.offlineCatchUpResetPending
      ) {
        this.offlineCatchUpResetPending = false;
      }

      const commandPhaseStart = getMonotonicTimeMs();

      this.nextExecutableStep = this.currentStep;
      const commands =
        this.commandQueue.dequeueUpToStep(this.currentStep);
      capturedCommands = commands.length;

      this.nextExecutableStep = this.currentStep + 1;

      for (const command of commands) {
        if (command.step !== this.currentStep) {
          skippedCommands += 1;
          telemetry.recordError('CommandStepMismatch', {
            expectedStep: this.currentStep,
            commandStep: command.step,
            type: command.type,
          });
          continue;
        }

        this.commandDispatcher.execute(command as Command);
        executedCommands += 1;
      }

      const dispatchContext: EventDispatchContext = {
        tick: this.currentStep,
      };

      this.eventBus.dispatch(dispatchContext);

      const commandPhaseEnd = getMonotonicTimeMs();
      tickDiagnostics.addPhase(
        'commands.capture',
        commandPhaseEnd - commandPhaseStart,
      );

      const systemsPhaseStart = commandPhaseEnd;

      const tickContext: TickContext = {
        deltaMs: this.stepSizeMs,
        step: this.currentStep,
        events: this.eventPublisher,
      };

      for (const { system } of this.systems) {
        const systemSpan = tickDiagnostics.startSystem(system.id);
        try {
          system.tick(tickContext);
          systemSpan.end();
        } catch (error) {
          try {
            systemSpan.fail(error);
          } catch (annotatedError) {
            telemetry.recordError('SystemExecutionFailed', {
              systemId: system.id,
              error:
                annotatedError instanceof Error
                  ? annotatedError
                  : new Error(String(annotatedError)),
            });
          }
        }

        this.eventBus.dispatch(dispatchContext);
      }

      const systemsPhaseEnd = getMonotonicTimeMs();
      tickDiagnostics.addPhase(
        'systems.execute',
        systemsPhaseEnd - systemsPhaseStart,
      );

      queueSizeAfter = this.commandQueue.size;

      const backPressure = this.eventBus.getBackPressureSnapshot();

      const diagnosticsPhaseStart = getMonotonicTimeMs();

      tickDiagnostics.recordEventMetrics(
        toDiagnosticTimelineEventMetrics(backPressure),
      );
      tickDiagnostics.recordQueueMetrics({
        sizeBefore: queueSizeBefore,
        sizeAfter: queueSizeAfter,
        captured: capturedCommands,
        executed: executedCommands,
        skipped: skippedCommands,
      });
      tickDiagnostics.setAccumulatorBacklogMs(context.backlogMs);

      recordBackPressureTelemetry(backPressure);

      const diagnosticsPhaseEnd = getMonotonicTimeMs();
      tickDiagnostics.addPhase(
        'diagnostics.emit',
        diagnosticsPhaseEnd - diagnosticsPhaseStart,
      );

      this.currentStep += 1;
      this.nextExecutableStep = this.currentStep;
      telemetry.recordTick();

      tickDiagnostics.complete();
    } catch (error) {
      tickDiagnostics.fail(error);
    }
  }
}

function createEventPublisher(bus: EventBus): EventPublisher {
  return {
    publish<TType extends RuntimeEventType>(
      eventType: TType,
      payload: RuntimeEventPayload<TType>,
      metadata?: PublishMetadata,
    ): PublishResult<TType> {
      const result = bus.publish(eventType, payload, metadata);
      // Allow callers to inspect rejected publishes (e.g. due to channel
      // overflow) and implement their own retry logic. The bus already emits
      // telemetry for overflow scenarios, so the runtime should not rethrow here.
      return result;
    },
  };
}

function recordBackPressureTelemetry(
  snapshot: BackPressureSnapshot,
): void {
  telemetry.recordCounters('events', {
    published: snapshot.counters.published,
    softLimited: snapshot.counters.softLimited,
    overflowed: snapshot.counters.overflowed,
    subscribers: snapshot.counters.subscribers,
  });

  const cooldownCounters: Record<string, number> = {};
  for (const channel of snapshot.channels) {
    cooldownCounters[`channel:${channel.channel}`] =
      channel.cooldownTicksRemaining;
  }
  telemetry.recordCounters('events.cooldown_ticks', cooldownCounters);
}

const getMonotonicTimeMs =
  typeof globalThis !== 'undefined' &&
  typeof globalThis.performance !== 'undefined' &&
  typeof globalThis.performance.now === 'function'
    ? () => globalThis.performance.now()
    : () => Date.now();

function toDiagnosticTimelineEventMetrics(
  snapshot: BackPressureSnapshot,
): DiagnosticTimelineEventMetrics {
  return {
    counters: {
      published: snapshot.counters.published,
      softLimited: snapshot.counters.softLimited,
      overflowed: snapshot.counters.overflowed,
      subscribers: snapshot.counters.subscribers,
    },
    channels: snapshot.channels.map((channel) => ({
      channel: channel.channel,
      subscribers: channel.subscribers,
      remainingCapacity: channel.remainingCapacity,
      cooldownTicksRemaining: channel.cooldownTicksRemaining,
      softLimitBreaches: channel.softLimitBreaches,
      eventsPerSecond: channel.eventsPerSecond,
      softLimitActive: channel.softLimitActive,
    })),
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
  type BackPressureCounters,
  type BackPressureSnapshot,
  type EventBusOptions,
  type EventDispatchContext,
  type EventHandler,
  type EventChannelConfigMap,
  type EventChannelConfigOverride,
  type EventChannelDiagnosticsOptions,
  type EventPublisher,
  type EventSubscription,
  type PublishResult,
  type PublishState,
  type ChannelBackPressureSnapshot,
} from './events/event-bus.js';
export {
  DEFAULT_EVENT_BUS_OPTIONS,
  RUNTIME_EVENT_CHANNELS,
  type AutomationToggledEventPayload,
  type PrestigeResetEventPayload,
  type ResourceThresholdReachedEventPayload,
  type SocialIntentQueuedEventPayload,
  type SocialIntentResolvedEventPayload,
  type TaskCompletedEventPayload,
} from './events/runtime-event-catalog.js';
export {
  FixedTimestepScheduler,
  type FixedTimestepSchedulerOptions,
  type SchedulerStepExecutionContext,
  type OfflineCatchUpResult,
} from './tick-scheduler.js';
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
  type RuntimeEventObjectArrayFrame,
  type RuntimeEventObjectRecord,
  type RuntimeEventStructOfArraysFrame,
  type RuntimeEventFrameBuildOptions,
  type RuntimeEventFrameBuildResult,
} from './events/runtime-event-frame.js';
export {
  type RuntimeEventFrameDiagnostics,
  type RuntimeEventFrameExportOptions,
  type RuntimeEventFrameExportState,
  type RuntimeEventFrameFormat,
} from './events/runtime-event-frame-format.js';
export {
  CONTENT_EVENT_CHANNELS,
  CONTENT_EVENT_DEFINITIONS,
  GENERATED_RUNTIME_EVENT_DEFINITIONS,
  GENERATED_RUNTIME_EVENT_MANIFEST,
  type ContentEventDefinition,
  type ContentRuntimeEventType,
  type GeneratedRuntimeEventDefinition,
} from './events/runtime-event-manifest.generated.js';
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
  type ResourceStateView,
  type SerializedResourceState,
  type NormalizedResourceRecord,
} from './resource-state.js';
export {
  createGeneratorState,
  type GeneratorDefinition,
  type GeneratorState,
  type GeneratorStateSnapshot,
  type GeneratorStateView,
  type SerializedGeneratorState,
  type NormalizedGeneratorRecord,
} from './generator-state.js';
export {
  createUpgradeState,
  type UpgradeDefinition,
  type UpgradeState,
  type UpgradeStateSnapshot,
  type UpgradeStateView,
  type SerializedUpgradeState,
  type NormalizedUpgradeRecord,
} from './upgrade-state.js';
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
export {
  RuntimeChangeJournal,
  type RuntimeChangeJournalOptions,
  type ChangeJournalCaptureInput,
  type RuntimeStateDelta,
  type RuntimeResourceDelta,
  type RuntimeGeneratorDelta,
  type RuntimeUpgradeDelta,
} from './runtime-change-journal.js';
export {
  createModifierPipeline,
  additiveModifier,
  multiplicativeModifier,
  exponentialModifier,
  clampModifier,
  type ModifierPipeline,
  type ModifierStage,
  type ModifierAccumulator,
} from './modifiers/modifier-pipeline.js';
export {
  registerSystems,
  type SystemHost,
  type RegisterSystemsResult,
} from './systems/system-registry.js';
export {
  GeneratorModifierLedger,
  type ModifierVector,
} from './systems/modifier-ledger.js';
export {
  createProductionSystem,
  type ProductionSystemOptions,
  type ProductionGeneratorDefinition,
  type ProductionOutputDefinition,
  type ProductionModifierContext,
} from './systems/production-system.js';
export {
  createUpgradeSystem,
  type UpgradeSystemOptions,
  type UpgradeRuntimeDefinition,
  type UpgradeEffectDefinition,
  type UpgradeEffectContext,
  type UpgradeModifierMode,
  type UpgradeRequirement,
} from './systems/upgrade-system.js';
export {
  createPrestigeSystem,
  PrestigeResetQueue,
  type PrestigeSystemOptions,
  type PrestigeResetRequest,
} from './systems/prestige-system.js';
export {
  createEventSystem,
  type EventSystemOptions,
} from './systems/event-system.js';
export {
  registerCoreSystems,
  type CoreSystemsOptions,
  type CoreSystemsResult,
} from './systems/core-systems.js';
export {
  createTaskSystem,
  TaskSchedulerState,
  type TaskSystemOptions,
  type TaskDefinition,
  type TaskRecord,
  type TaskStatus,
} from './systems/task-system.js';
export {
  createSocialSystem,
  SocialIntentQueue,
  type SocialSystemOptions,
  type SocialIntentDefinition,
  type SocialIntentRecord,
  type SocialIntentStatus,
  type SocialConfirmation,
  type SocialProvider,
} from './systems/social-system.js';
export {
  type System,
  type SystemDefinition,
  type SystemRegistrationContext,
  type TickContext,
} from './systems/system-types.js';
export {
  createRuntimeStateView,
  type RuntimeStateView,
  type RuntimeStateViewOptions,
} from './runtime-state-view.js';
export {
  createDiagnosticTimelineRecorder,
  createNoopDiagnosticTimelineRecorder,
  getDefaultHighResolutionClock,
  toErrorLike,
  type CompleteTickOptions,
  type DiagnosticTickHandle,
  type DiagnosticTimelineEntry,
  type DiagnosticTimelineEventChannelSnapshot,
  type DiagnosticTimelineEventMetrics,
  type DiagnosticTimelineMetadata,
  type DiagnosticTimelineQueueMetrics,
  type DiagnosticTimelineRecorder,
  type DiagnosticTimelineResult,
  type DiagnosticTimelinePhase,
  type DiagnosticTimelineSystemHistory,
  type DiagnosticTimelineSystemSpan,
  type ErrorLike,
  type HighResolutionClock,
  type ResolvedDiagnosticTimelineOptions,
  type StartTickOptions,
} from './diagnostics/diagnostic-timeline.js';
export type {
  IdleEngineRuntimeDiagnosticsOptions,
  RuntimeDiagnosticsTimelineOptions,
} from './diagnostics/runtime-diagnostics-controller.js';
export {
  createPrometheusTelemetry,
  type PrometheusTelemetryOptions,
  type PrometheusTelemetryFacade,
} from './telemetry-prometheus.js';
export { createReadOnlyProxy } from './read-only-proxy.js';
