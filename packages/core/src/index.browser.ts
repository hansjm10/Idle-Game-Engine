/**
 * Browser-safe entry point for @idle-engine/core.
 *
 * This module exports everything from the main index except for
 * Prometheus telemetry, which requires Node.js APIs (prom-client).
 *
 * For Node.js environments that need Prometheus metrics, import from
 * '@idle-engine/core' directly or use:
 *   import { createPrometheusTelemetry } from '@idle-engine/core/prometheus';
 */

// ---------------------------------------------------------------------------
// Internal imports (same as index.ts but without telemetry-prometheus)
// ---------------------------------------------------------------------------

import {
  EventBus,
  type Clock,
  type EventBusOptions,
  type EventDispatchContext,
  type EventHandler,
  type EventPublisher,
  type EventSubscription,
  type EventSubscriptionOptions,
  type BackPressureSnapshot,
} from './events/event-bus.js';
import type { RuntimeEventType } from './events/runtime-event.js';
import { DEFAULT_EVENT_BUS_OPTIONS } from './events/runtime-event-catalog.js';
import type { Command } from './command.js';
import {
  CommandDispatcher,
  type CommandExecutionOutcome,
  type CommandFailure,
} from './command-dispatcher.js';
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
  createResourceState,
  reconcileSaveAgainstDefinitions,
  type ResourceDefinition,
  type ResourceDefinitionDigest,
  type ResourceDefinitionReconciliation,
  type ResourceState,
  type SerializedResourceState,
} from './resource-state.js';
import { getCurrentRNGSeed, setRNGSeed } from './rng.js';
import {
  restoreFromSnapshot as restoreFromSnapshotInternal,
  restorePartial,
  setRestoreRuntimeFactory,
  type RestoreMode,
  type RestorePartialOptions,
  type RestoreSnapshotOptions,
  type RestoredRuntime as BaseRestoredRuntime,
} from './state-sync/restore.js';
import type { NormalizedContentPack } from '@idle-engine/content-schema';
import {
  wireGameRuntime,
  type GameRuntimeHydrateOptions as GameRuntimeHydrateOptionsBase,
  type GameRuntimeSerializeOptions as GameRuntimeSerializeOptionsBase,
  type GameRuntimeWiring as GameRuntimeWiringBase,
  type WireGameRuntimeOptions as WireGameRuntimeOptionsBase,
} from './game-runtime-wiring.js';
import { createProgressionCoordinator } from './progression-coordinator.js';
import { type ProgressionAuthoritativeState } from './progression.js';
import {
  restoreGameRuntimeFromSnapshot as restoreGameRuntimeFromSnapshotInternal,
  type RestoreGameRuntimeFromSnapshotOptions,
} from './state-sync/restore-runtime.js';

// ---------------------------------------------------------------------------
// Runtime class and related interfaces
// ---------------------------------------------------------------------------

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
      options?: EventSubscriptionOptions,
    ): EventSubscription;
  };
}

export interface System {
  readonly id: string;
  readonly tick: (context: TickContext) => void;
  readonly setup?: (context: SystemRegistrationContext) => void;
}

export interface EngineOptions {
  readonly stepSizeMs?: number;
  readonly maxStepsPerFrame?: number;
}

export interface RuntimeDependencies {
  readonly commandQueue?: CommandQueue;
  readonly commandDispatcher?: CommandDispatcher;
  readonly eventBus?: EventBus;
  readonly eventPublisher?: EventPublisher;
}

export interface IdleEngineRuntimeOptions
  extends EngineOptions,
    RuntimeDependencies {
  readonly eventBusOptions?: EventBusOptions;
  readonly diagnostics?: IdleEngineRuntimeDiagnosticsOptions;
  readonly initialStep?: number;
}

const DEFAULT_STEP_MS = 100;
const DEFAULT_MAX_STEPS = 50;

interface RegisteredSystem {
  readonly system: System;
  readonly subscriptions: EventSubscription[];
}

class DeterministicTickClock implements Clock {
  private tick = 0;

  constructor(private readonly stepSizeMs: number) {}

  setTick(tick: number): void {
    this.tick = tick;
  }

  now(): number {
    return this.tick * this.stepSizeMs;
  }
}

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
  private readonly eventBusClock: DeterministicTickClock | null;
  private readonly eventPublisher: EventPublisher;
  private readonly commandFailures: CommandFailure[] = [];
  private readonly commandOutcomes: CommandExecutionOutcome[] = [];
  private currentStep = 0;
  private nextExecutableStep = 0;
  private readonly diagnostics: RuntimeDiagnosticsController;

  constructor(options: IdleEngineRuntimeOptions = {}) {
    this.stepSizeMs = options.stepSizeMs ?? DEFAULT_STEP_MS;
    this.maxStepsPerFrame = options.maxStepsPerFrame ?? DEFAULT_MAX_STEPS;
    this.commandQueue = options.commandQueue ?? new CommandQueue();
    this.commandDispatcher =
      options.commandDispatcher ?? new CommandDispatcher();

    const eventBusOptions = options.eventBusOptions ?? DEFAULT_EVENT_BUS_OPTIONS;
    let resolvedEventBusOptions: EventBusOptions = eventBusOptions;
    let eventBusClock: DeterministicTickClock | null = null;

    if (!eventBusOptions.clock) {
      eventBusClock = new DeterministicTickClock(this.stepSizeMs);
      resolvedEventBusOptions = {
        ...eventBusOptions,
        clock: eventBusClock,
      };
    }

    this.eventBusClock = eventBusClock;
    this.eventBus = options.eventBus ?? new EventBus(resolvedEventBusOptions);
    this.eventPublisher =
      options.eventPublisher ?? createEventPublisher(this.eventBus);

    this.commandDispatcher.setEventPublisher(this.eventPublisher);

    this.diagnostics = createRuntimeDiagnosticsController(
      options.diagnostics,
      {
        stepSizeMs: this.stepSizeMs,
      },
    );

    const initialStep = options.initialStep ?? 0;
    if (Number.isFinite(initialStep) && initialStep >= 0) {
      this.currentStep = initialStep;
      this.nextExecutableStep = initialStep;
    }
  }

  addSystem(system: System): void {
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

  getCommandQueue(): CommandQueue {
    return this.commandQueue;
  }

  getCommandDispatcher(): CommandDispatcher {
    return this.commandDispatcher;
  }

  drainCommandFailures(): CommandFailure[] {
    if (this.commandFailures.length === 0) {
      return [];
    }

    return this.commandFailures.splice(0, this.commandFailures.length);
  }

  drainCommandOutcomes(): CommandExecutionOutcome[] {
    if (this.commandOutcomes.length === 0) {
      return [];
    }

    return this.commandOutcomes.splice(0, this.commandOutcomes.length);
  }

  getCurrentStep(): number {
    return this.currentStep;
  }

  getNextExecutableStep(): number {
    return this.nextExecutableStep;
  }

  getStepSizeMs(): number {
    return this.stepSizeMs;
  }

  getMaxStepsPerFrame(): number {
    return this.maxStepsPerFrame;
  }

  creditTime(deltaMs: number): void {
    if (typeof deltaMs !== 'number' || !Number.isFinite(deltaMs) || deltaMs <= 0) {
      return;
    }
    this.accumulator += deltaMs;
  }

  fastForward(deltaMs: number): number {
    if (typeof deltaMs !== 'number' || !Number.isFinite(deltaMs) || deltaMs <= 0) {
      return 0;
    }

    this.accumulator += deltaMs;
    const steps = Math.floor(this.accumulator / this.stepSizeMs);
    if (steps <= 0) {
      return 0;
    }

    this.accumulator -= steps * this.stepSizeMs;
    this.currentStep += steps;
    this.nextExecutableStep = this.currentStep;
    return steps;
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

  /**
   * Advance the simulation by `deltaMs`, clamping the number of processed
   * steps to avoid spiral of death scenarios.
   */
  tick(deltaMs: number): number {
    if (deltaMs <= 0) {
      return 0;
    }

    let processedSteps = 0;
    this.accumulator += deltaMs;
    let remainingStepBudget = this.maxStepsPerFrame;

    while (remainingStepBudget > 0) {
      const availableSteps = Math.floor(this.accumulator / this.stepSizeMs);
      const steps = Math.min(availableSteps, remainingStepBudget);

      if (steps === 0) {
        return processedSteps;
      }

      this.accumulator -= steps * this.stepSizeMs;
      let resetOutbound = true;

      for (let i = 0; i < steps; i += 1) {
        const tickDiagnostics = this.diagnostics.beginTick(this.currentStep);

        const queueSizeBefore = this.commandQueue.size;
        let queueSizeAfter = queueSizeBefore;
        let capturedCommands = 0;
        let executedCommands = 0;
        let skippedCommands = 0;

        try {
          this.eventBusClock?.setTick(this.currentStep);
          this.eventBus.beginTick(this.currentStep, {
            resetOutbound,
          });
          resetOutbound = false;

          // Accept commands for the current step until the batch is captured.
          this.nextExecutableStep = this.currentStep;
          const commands =
            this.commandQueue.dequeueUpToStep(this.currentStep);
          capturedCommands = commands.length;

          // Commands enqueued during execution target the next tick.
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

            const result = this.commandDispatcher.executeWithResult(
              command as Command,
            );
            executedCommands += 1;

            if (result instanceof Promise) {
              void result.then((resolved) => {
                if (resolved.success) {
                  this.commandOutcomes.push({
                    success: true,
                    requestId: command.requestId,
                    serverStep: command.step,
                  });
                  return;
                }

                this.commandFailures.push({
                  requestId: command.requestId,
                  type: command.type,
                  priority: command.priority,
                  timestamp: command.timestamp,
                  step: command.step,
                  error: resolved.error,
                });
                this.commandOutcomes.push({
                  success: false,
                  requestId: command.requestId,
                  serverStep: command.step,
                  error: resolved.error,
                });
              });
            } else if (!result.success) {
              this.commandFailures.push({
                requestId: command.requestId,
                type: command.type,
                priority: command.priority,
                timestamp: command.timestamp,
                step: command.step,
                error: result.error,
              });
              this.commandOutcomes.push({
                success: false,
                requestId: command.requestId,
                serverStep: command.step,
                error: result.error,
              });
            } else {
              this.commandOutcomes.push({
                success: true,
                requestId: command.requestId,
                serverStep: command.step,
              });
            }
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
            const systemSpan = tickDiagnostics.startSystem(system.id);
            try {
              system.tick(context);
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

          queueSizeAfter = this.commandQueue.size;

          const backPressure = this.eventBus.getBackPressureSnapshot();

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
        tickDiagnostics.setAccumulatorBacklogMs(this.accumulator);

        recordBackPressureTelemetry(backPressure);

        this.currentStep += 1;
        processedSteps += 1;
        this.nextExecutableStep = this.currentStep;
        telemetry.recordTick();

          tickDiagnostics.complete();
        } catch (error) {
          tickDiagnostics.fail(error);
        }
      }

      remainingStepBudget -= steps;
    }

    return processedSteps;
  }
}

setRestoreRuntimeFactory((options) => new IdleEngineRuntime(options));

function createEventPublisher(bus: EventBus): EventPublisher {
  return {
    publish: bus.publish.bind(bus),
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

// ---------------------------------------------------------------------------
// Economy types and functions
// ---------------------------------------------------------------------------

export interface EconomyResourceSnapshot {
  readonly id: string;
  readonly amount: number;
  readonly capacity: number | null;
  readonly unlocked: boolean;
  readonly visible: boolean;
  readonly rates: Readonly<{
    incomePerSecond: number;
    expensePerSecond: number;
    netPerSecond: number;
  }>;
}

export interface EconomyStateSummary {
  readonly step: number;
  readonly stepSizeMs: number;
  readonly publishedAt: number;
  readonly definitionDigest: ResourceDefinitionDigest;
  readonly rngSeed?: number;
  readonly resources: readonly EconomyResourceSnapshot[];
}

export interface EconomyResourceDelta {
  readonly id: string;
  readonly startAmount: number;
  readonly endAmount: number;
  readonly delta: number;
}

export interface EconomyVerificationResult {
  readonly start: EconomyStateSummary;
  readonly end: EconomyStateSummary;
  readonly deltas: readonly EconomyResourceDelta[];
  readonly diagnostics?: DiagnosticTimelineResult;
}

export interface EconomyStateSummaryOptions {
  readonly runtime: IdleEngineRuntime;
  readonly resources: ResourceState;
  readonly publishedAt?: number;
  readonly rngSeed?: number;
}

export interface CreateVerificationRuntimeOptions {
  readonly summary: EconomyStateSummary;
  readonly definitions: readonly ResourceDefinition[];
  readonly runtimeOptions?: IdleEngineRuntimeOptions;
  readonly applyRngSeed?: boolean;
}

export interface VerificationRuntime {
  readonly runtime: IdleEngineRuntime;
  readonly resources: ResourceState;
  readonly reconciliation: ResourceDefinitionReconciliation;
}

export interface VerificationRunOptions {
  readonly ticks: number;
  readonly includeDiagnostics?: boolean;
}

/**
 * Build a deterministic, JSON-friendly economy snapshot for verification or replay.
 */
export function buildEconomyStateSummary(
  options: EconomyStateSummaryOptions,
): EconomyStateSummary {
  const { runtime, resources } = options;
  const publishedAt = options.publishedAt ?? Date.now();
  const rngSeed = options.rngSeed ?? getCurrentRNGSeed();
  const snapshot = resources.snapshot({ mode: 'recorder' });
  const saveState = resources.exportForSave();
  const summaryResources: EconomyResourceSnapshot[] = [];

  for (let index = 0; index < saveState.ids.length; index += 1) {
    const incomePerSecond = saveState.ids[index]
      ? snapshot.incomePerSecond[index] ?? 0
      : 0;
    const expensePerSecond = saveState.ids[index]
      ? snapshot.expensePerSecond[index] ?? 0
      : 0;
    const netPerSecond = incomePerSecond - expensePerSecond;

    summaryResources.push({
      id: saveState.ids[index],
      amount: saveState.amounts[index] ?? 0,
      capacity: saveState.capacities[index] ?? null,
      unlocked: saveState.unlocked?.[index] ?? false,
      visible: saveState.visible?.[index] ?? false,
      rates: {
        incomePerSecond,
        expensePerSecond,
        netPerSecond,
      },
    });
  }

  return {
    step: runtime.getCurrentStep(),
    stepSizeMs: runtime.getStepSizeMs(),
    publishedAt,
    definitionDigest: resources.getDefinitionDigest(),
    rngSeed,
    resources: summaryResources,
  };
}

function toSerializedResourceState(
  summary: EconomyStateSummary,
): SerializedResourceState {
  return {
    ids: summary.resources.map((resource) => resource.id),
    amounts: summary.resources.map((resource) => resource.amount),
    capacities: summary.resources.map(
      (resource) => resource.capacity ?? null,
    ),
    unlocked: summary.resources.map((resource) => resource.unlocked),
    visible: summary.resources.map((resource) => resource.visible),
    flags: summary.resources.map(() => 0),
    definitionDigest: summary.definitionDigest,
  };
}

function hydrateResourceStateFromSummary(
  summary: EconomyStateSummary,
  definitions: readonly ResourceDefinition[],
): {
  resources: ResourceState;
  reconciliation: ResourceDefinitionReconciliation;
} {
  const resources = createResourceState(definitions);
  const serialized = toSerializedResourceState(summary);
  const reconciliation = reconcileSaveAgainstDefinitions(
    serialized,
    definitions,
  );

  const { remap } = reconciliation;

  for (let savedIndex = 0; savedIndex < remap.length; savedIndex += 1) {
    const liveIndex = remap[savedIndex];
    if (liveIndex === undefined) {
      continue;
    }

    const resource = summary.resources[savedIndex];
    const capacity =
      resource.capacity ?? Number.POSITIVE_INFINITY;
    resources.setCapacity(liveIndex, capacity);

    const targetAmount = resource.amount ?? 0;
    const currentAmount = resources.getAmount(liveIndex);

    if (targetAmount > currentAmount) {
      resources.addAmount(liveIndex, targetAmount - currentAmount);
    } else if (targetAmount < currentAmount) {
      resources.spendAmount(liveIndex, currentAmount - targetAmount);
    }

    if (resource.unlocked) {
      resources.unlock(liveIndex);
    }

    if (resource.visible) {
      resources.grantVisibility(liveIndex);
    }

    const incomePerSecond = Number.isFinite(
      resource.rates.incomePerSecond,
    )
      ? resource.rates.incomePerSecond
      : 0;

    const expensePerSecond = Number.isFinite(
      resource.rates.expensePerSecond,
    )
      ? resource.rates.expensePerSecond
      : 0;

    if (incomePerSecond > 0) {
      resources.applyIncome(liveIndex, incomePerSecond);
    }

    if (expensePerSecond > 0) {
      resources.applyExpense(liveIndex, expensePerSecond);
    }
  }

  resources.snapshot({ mode: 'publish' });

  return { resources, reconciliation };
}

function createEconomyProjectionSystem(
  resources: ResourceState,
  netRates: ReadonlyMap<number, number>,
): System {
  return {
    id: 'economy-verification',
    tick: ({ deltaMs }) => {
      const deltaSeconds = deltaMs / 1000;
      for (const [index, netPerSecond] of netRates) {
        if (!Number.isFinite(netPerSecond) || netPerSecond === 0) {
          continue;
        }

        const delta = netPerSecond * deltaSeconds;
        if (delta > 0) {
          resources.addAmount(index, delta);
          continue;
        }

        const spendable = Math.min(
          resources.getAmount(index),
          Math.abs(delta),
        );

        if (spendable > 0) {
          resources.spendAmount(index, spendable, {
            systemId: 'verification',
            commandId: 'economy-projection',
          });
        }
      }
    },
  };
}

function calculateResourceDeltas(
  start: EconomyStateSummary,
  end: EconomyStateSummary,
): EconomyResourceDelta[] {
  const startAmounts = new Map(
    start.resources.map((resource) => [resource.id, resource.amount]),
  );

  return end.resources.map((resource) => {
    const startAmount = startAmounts.get(resource.id) ?? 0;
    return {
      id: resource.id,
      startAmount,
      endAmount: resource.amount,
      delta: resource.amount - startAmount,
    };
  });
}

export type GameRuntimeWiring = GameRuntimeWiringBase<IdleEngineRuntime>;
export type WireGameRuntimeOptions =
  WireGameRuntimeOptionsBase<IdleEngineRuntime>;
export type GameRuntimeSerializeOptions = GameRuntimeSerializeOptionsBase;
export type GameRuntimeHydrateOptions = GameRuntimeHydrateOptionsBase;

export type CreateGameRuntimeOptions = Readonly<{
  readonly content: NormalizedContentPack;
  readonly stepSizeMs?: number;
  readonly maxStepsPerFrame?: number;
  readonly initialStep?: number;
  readonly initialProgressionState?: ProgressionAuthoritativeState;
  readonly enableProduction?: boolean;
  readonly enableAutomation?: boolean;
  readonly enableTransforms?: boolean;
  readonly production?: {
    readonly applyViaFinalizeTick?: boolean;
  };
  readonly registerOfflineCatchup?: boolean;
}>;

export function createGameRuntime(
  options: CreateGameRuntimeOptions,
): GameRuntimeWiring {
  const stepSizeMs = options.stepSizeMs ?? DEFAULT_STEP_MS;
  const hasGenerators = options.content.generators.length > 0;
  const enableProduction = options.enableProduction ?? hasGenerators;
  const applyViaFinalizeTick = options.production?.applyViaFinalizeTick ?? true;
  const maxStepsPerFrame =
    options.maxStepsPerFrame ??
    (applyViaFinalizeTick && enableProduction && hasGenerators ? 1 : undefined);
  const productionOptions =
    options.production === undefined
      ? { applyViaFinalizeTick }
      : { ...options.production, applyViaFinalizeTick };

  const commandQueue = new CommandQueue();
  const commandDispatcher = new CommandDispatcher();
  const runtime = new IdleEngineRuntime({
    stepSizeMs,
    ...(maxStepsPerFrame === undefined ? {} : { maxStepsPerFrame }),
    ...(options.initialStep === undefined ? {} : { initialStep: options.initialStep }),
    commandQueue,
    commandDispatcher,
  });

  const coordinator = createProgressionCoordinator({
    content: options.content,
    stepDurationMs: stepSizeMs,
    ...(options.initialProgressionState
      ? { initialState: options.initialProgressionState }
      : {}),
  });

  return wireGameRuntime({
    content: options.content,
    runtime,
    coordinator,
    enableProduction,
    enableAutomation: options.enableAutomation,
    enableTransforms: options.enableTransforms,
    production: productionOptions,
    registerOfflineCatchup: options.registerOfflineCatchup,
  });
}

export { wireGameRuntime };


/**
 * Hydrate resources and a runtime from an economy summary so server-side validation can tick deterministically.
 */
export function createVerificationRuntime(
  options: CreateVerificationRuntimeOptions,
): VerificationRuntime {
  const {
    summary,
    definitions,
    runtimeOptions,
    applyRngSeed = true,
  } = options;
  const { resources, reconciliation } = hydrateResourceStateFromSummary(
    summary,
    definitions,
  );

  const netRates = new Map<number, number>();
  for (let savedIndex = 0; savedIndex < reconciliation.remap.length; savedIndex += 1) {
    const liveIndex = reconciliation.remap[savedIndex];
    if (liveIndex === undefined) {
      continue;
    }
    const rate = summary.resources[savedIndex]?.rates.netPerSecond ?? 0;
    netRates.set(liveIndex, rate);
  }

  const runtime = new IdleEngineRuntime({
    ...runtimeOptions,
    stepSizeMs: runtimeOptions?.stepSizeMs ?? summary.stepSizeMs,
    initialStep: runtimeOptions?.initialStep ?? summary.step,
  });

  if (applyRngSeed && summary.rngSeed !== undefined) {
    setRNGSeed(summary.rngSeed);
  }

  runtime.addSystem(
    createEconomyProjectionSystem(resources, netRates),
  );

  return { runtime, resources, reconciliation };
}

/**
 * Execute a bounded number of ticks against a verification runtime and return the expected deltas.
 */
export function runVerificationTicks(
  context: VerificationRuntime,
  options: VerificationRunOptions,
): EconomyVerificationResult {
  const { runtime, resources } = context;
  const { ticks, includeDiagnostics } = options;

  if (!Number.isInteger(ticks) || ticks < 0) {
    throw new Error('ticks must be a non-negative integer.');
  }

  const startSummary = buildEconomyStateSummary({
    runtime,
    resources,
  });

  const stepSizeMs = runtime.getStepSizeMs();
  for (let remaining = 0; remaining < ticks; remaining += 1) {
    runtime.tick(stepSizeMs);
  }

  const endSummary = buildEconomyStateSummary({
    runtime,
    resources,
  });

  const deltas = calculateResourceDeltas(startSummary, endSummary);
  const diagnostics = includeDiagnostics
    ? runtime.getDiagnosticTimelineSnapshot()
    : undefined;

  return {
    start: startSummary,
    end: endSummary,
    deltas,
    diagnostics,
  };
}

export type RestoredRuntime = BaseRestoredRuntime<IdleEngineRuntime>;

export const restoreFromSnapshot = (
  options: RestoreSnapshotOptions,
): RestoredRuntime =>
  restoreFromSnapshotInternal(options) as RestoredRuntime;

export const restoreGameRuntimeFromSnapshot = (
  options: RestoreGameRuntimeFromSnapshotOptions,
): GameRuntimeWiring =>
  restoreGameRuntimeFromSnapshotInternal(options) as GameRuntimeWiring;

// ---------------------------------------------------------------------------
// Re-exports from individual modules (excluding telemetry-prometheus)
// ---------------------------------------------------------------------------

export {
  type Command,
  CommandPriority,
  COMMAND_PRIORITY_ORDER,
  type CommandQueueEntry,
  type CommandSnapshot,
  type CommandSnapshotPayload,
  type ImmutablePayload,
  RUNTIME_COMMAND_TYPES,
  type RuntimeCommandType,
  type PurchaseGeneratorPayload,
  type PurchaseUpgradePayload,
  type ToggleGeneratorPayload,
  type ToggleAutomationPayload,
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
export {
  CommandQueue,
  deepFreezeInPlace,
  COMMAND_QUEUE_SAVE_SCHEMA_VERSION,
  type JsonPrimitive,
  type JsonValue,
  type RestoreCommandQueueOptions,
  type SerializedCommandQueueEntryV1,
  type SerializedCommandQueueV1,
  type SerializedCommandQueue,
} from './command-queue.js';
export type {
  SerializedCommand,
  CommandResponseError,
  CommandEnvelope,
  CommandResponse,
} from './command-transport.js';
export {
  DEFAULT_IDEMPOTENCY_TTL_MS,
  DEFAULT_PENDING_COMMAND_TIMEOUT_MS,
} from './command-transport.js';
export type { IdempotencyRegistry } from './idempotency-registry.js';
export { InMemoryIdempotencyRegistry } from './idempotency-registry.js';
export type {
  PendingCommandTracker,
  PendingCommandTrackerOptions,
} from './pending-command-tracker.js';
export {
  InMemoryPendingCommandTracker,
} from './pending-command-tracker.js';
export {
  createCommandTransportServer,
  type CommandTransportServer,
  type CommandTransportServerOptions,
} from './command-transport-server.js';
export {
  CommandDispatcher,
  type CommandHandler,
  type CommandHandlerResult,
  type CommandResult,
  type CommandResultFailure,
  type CommandResultSuccess,
  type CommandError,
  type CommandExecutionOutcome,
  type CommandFailure,
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
  EventBroadcastBatcher,
  EventBroadcastDeduper,
  applyEventBroadcastBatch,
  applyEventBroadcastFrame,
  computeEventBroadcastChecksum,
  createEventBroadcastFrame,
  createEventTypeFilter,
  type EventBroadcastBatch,
  type EventBroadcastBatcherOptions,
  type EventBroadcastDeduperOptions,
  type EventBroadcastFrame,
  type EventBroadcastFrameOptions,
  type EventBroadcastHydrateOptions,
  type EventCoalescingOptions,
  type EventFilter,
  type SerializedRuntimeEvent,
} from './events/event-broadcast.js';
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
  getRNGState,
  setRNGSeed,
  setRNGState,
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
  createDefinitionDigest,
  computeStableDigest,
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
  type GeneratorToggleEvaluator,
  type GeneratorPurchaseQuote,
  type GeneratorResourceCost,
  type UpgradePurchaseEvaluator,
  type UpgradePurchaseQuote,
  type UpgradeResourceCost,
  type UpgradeStatus,
} from './resource-command-handlers.js';
export {
  buildProgressionSnapshot,
  type ProgressionAuthoritativeState,
  type ProgressionResourceState,
  type ResourceProgressionMetadata,
  type ProgressionGeneratorState,
  type ProgressionUpgradeState,
  type ProgressionAutomationState,
  type ProgressionTransformState,
  type ProgressionAchievementState,
  type ProgressionPrestigeLayerState,
  type ProgressionSnapshot,
  type ResourceView,
  type GeneratorView,
  type GeneratorCostView,
  type GeneratorRateView,
  type UpgradeCostView,
  type UpgradeView,
  type AutomationView,
  type AchievementCategory,
  type AchievementTier,
  type AchievementProgressMode,
  type AchievementView,
  type PrestigeLayerView,
  type PrestigeRewardPreview,
  type PrestigeRewardContribution,
  type PrestigeQuote,
  type PrestigeSystemEvaluator,
} from './progression.js';
export {
  selectAvailableUpgrades,
  selectLockedUpgradesWithHints,
  selectPurchasableGenerators,
  selectPurchasableUpgrades,
  selectTopNActionables,
  selectUnlockedGenerators,
  selectVisibleGenerators,
  selectVisibleUpgrades,
  type ProgressionActionableItem,
  type ProgressionSelectorOptions,
} from './progression-selectors.js';
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
  createConsoleTelemetry,
  createContextualTelemetry,
  resetTelemetry,
  setTelemetry,
  silentTelemetry,
  telemetry,
  type TelemetryEventData,
  type TelemetryFacade,
} from './telemetry.js';
export {
  RUNTIME_VERSION,
  PERSISTENCE_SCHEMA_VERSION,
} from './version.js';
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
  summarizeDiagnostics,
  evaluateDiagnostics,
  type DiagnosticsSummary,
  type DiagnosticsThresholds,
  type DiagnosticsEvaluation,
} from './diagnostics/format.js';
// NOTE: createPrometheusTelemetry is NOT exported from the browser build
// as prom-client requires Node.js APIs. Use '@idle-engine/core/prometheus' for Node.js.
export { createReadOnlyProxy } from './read-only-proxy.js';
export {
  createAutomationSystem,
  getAutomationState,
  isCooldownActive,
  evaluateIntervalTrigger,
  evaluateCommandQueueEmptyTrigger,
  evaluateEventTrigger,
  evaluateResourceThresholdTrigger,
  enqueueAutomationCommand,
  serializeAutomationState,
  type AutomationSystemOptions,
  type AutomationState,
  type SerializedAutomationState,
  type ResourceStateAccessor,
  type ResourceStateReader,
} from './automation-system.js';
export {
  createResourceStateAdapter,
  type ResourceStateSource,
} from './automation-resource-state-adapter.js';
export {
  SYSTEM_AUTOMATION_TARGET_MAPPING,
  mapSystemTargetToCommandType,
} from './system-automation-target-mapping.js';
export {
  registerAutomationCommandHandlers,
  type AutomationCommandHandlerOptions,
} from './automation-command-handlers.js';
export {
  createTransformSystem,
  buildTransformSnapshot,
  getTransformState,
  isTransformCooldownActive,
  serializeTransformState,
  type TransformSystemOptions,
  type TransformState,
  type SerializedTransformState,
  type TransformExecutionResult,
  type TransformResourceState,
  type TransformEndpointView,
  type TransformView,
  type TransformSnapshot,
} from './transform-system.js';
export {
  registerTransformCommandHandlers,
  type TransformCommandHandlerOptions,
} from './transform-command-handlers.js';
export {
  applyPrestigeReset,
  type PrestigeResetContext,
  type PrestigeResetTarget,
  type PrestigeRetentionTarget,
} from './prestige-reset.js';
export {
  createProductionSystem,
  validateRates,
  type ProductionSystem,
  type ProductionSystemOptions,
  type ProductionResourceState,
  type SerializedProductionAccumulators,
  type GeneratorProductionRate,
  type GeneratorProductionState,
  type ValidatedRate,
} from './production-system.js';
export {
  createProgressionCoordinator,
  type ProgressionCoordinator,
  type ProgressionCoordinatorOptions,
} from './progression-coordinator.js';
export {
  PROGRESSION_COORDINATOR_SAVE_SCHEMA_VERSION,
  serializeProgressionCoordinatorState,
  hydrateProgressionCoordinatorState,
  type SerializedProgressionCoordinatorState,
  type SerializedProgressionCoordinatorStateV1,
  type SerializedProgressionCoordinatorStateV2,
  type SerializedProgressionGeneratorStateV1,
  type SerializedProgressionUpgradeStateV1,
  type SerializedProgressionAchievementStateV2,
} from './progression-coordinator-save.js';
export {
  applyOfflineProgress,
  type ApplyOfflineProgressOptions,
  type OfflineProgressFastPathMode,
  type OfflineProgressFastPathOptions,
  type OfflineProgressFastPathPreconditions,
  type OfflineProgressLimits,
  type OfflineProgressResult,
  type OfflineProgressUpdate,
} from './offline-progress.js';
export {
  registerOfflineCatchupCommandHandler,
  type OfflineCatchupCommandHandlerOptions,
  type OfflineCatchupRuntime,
} from './offline-catchup-command-handlers.js';
export {
  combineConditions,
  compareWithComparator,
  describeCondition,
  evaluateCondition,
  formatComparator,
  formatNumber,
  type ConditionContext,
} from './condition-evaluator.js';
export {
  GAME_STATE_SAVE_SCHEMA_VERSION,
  DEFAULT_GAME_STATE_SAVE_MIGRATIONS,
  decodeGameStateSave,
  encodeGameStateSave,
  hydrateGameStateSaveFormat,
  loadGameStateSaveFormat,
  serializeGameStateSaveFormat,
  type GameStateSaveCompression,
  type GameStateSaveFormat,
  type GameStateSaveFormatV1,
  type GameStateSaveRuntime,
  type SchemaMigration,
} from './game-state-save.js';
export {
  captureGameStateSnapshot,
  type CaptureSnapshotOptions,
} from './state-sync/capture.js';
export {
  computePartialChecksum,
  computeStateChecksum,
  fnv1a32,
} from './state-sync/checksum.js';
export {
  createPredictionManager,
  TELEMETRY_BUFFER_OVERFLOW,
  TELEMETRY_CHECKSUM_MATCH,
  TELEMETRY_CHECKSUM_MISMATCH,
  TELEMETRY_RESYNC,
  TELEMETRY_ROLLBACK,
} from './state-sync/prediction-manager.js';
export { compareStates, hasStateDiverged } from './state-sync/compare.js';
export type {
  AchievementDiff,
  AutomationDiff,
  CommandQueueDiff,
  CommandQueueEntryDiff,
  GeneratorDiff,
  ProductionAccumulatorDiff,
  ProgressionDiff,
  ResourceDiff,
  RuntimeDiff,
  StateDiff,
  TransformBatchDiff,
  TransformBatchOutputDiff,
  TransformDiff,
  UpgradeDiff,
} from './state-sync/compare.js';
export type {
  PredictionCompatibilityMetadata,
  PredictionManager,
  PredictionManagerOptions,
  PredictionReplayOptions,
  PredictionReplayRuntime,
  PredictionReplayRuntimeFactoryOptions,
  PredictionReplayWiring,
  PredictionWindow,
  RollbackResult,
} from './state-sync/prediction-manager.js';
export {
  restorePartial,
  type RestoreMode,
  type RestorePartialOptions,
  type RestoreSnapshotOptions,
};
export type { RestoreGameRuntimeFromSnapshotOptions } from './state-sync/restore-runtime.js';
export type { GameStateSnapshot } from './state-sync/types.js';
// Test utilities - useful for consumers writing tests for their game logic
export { createTickContext, createMockEventPublisher } from './test-utils.js';
