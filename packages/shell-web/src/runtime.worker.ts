/// <reference lib="webworker" />

import {
  CommandPriority,
  CommandQueue,
  CommandDispatcher,
  IdleEngineRuntime,
  RUNTIME_COMMAND_TYPES,
  RUNTIME_VERSION,
  PERSISTENCE_SCHEMA_VERSION,
  setGameState,
  getGameState,
  buildProgressionSnapshot,
  applyOfflineProgress,
  registerResourceCommandHandlers,
  registerAutomationCommandHandlers,
  registerOfflineCatchupCommandHandler,
  createAutomationSystem,
  createTransformSystem,
  createResourceStateAdapter,
  createProgressionCoordinator,
  telemetry,
  registerTransformCommandHandlers,
  type ProgressionAuthoritativeState,
  type ProgressionResourceState,
  type DiagnosticTimelineResult,
  type EventBus,
  type OfflineProgressFastPathPreconditions,
  type ResourceCommandHandlerOptions,
} from '@idle-engine/core';
import type { NormalizedContentPack } from '@idle-engine/content-schema';
import { sampleContent } from '@idle-engine/content-sample';

declare global {
  interface ImportMeta {
    readonly vitest?: {
      worker?: Worker;
    };
  }
}

export type {
  RuntimeEventSnapshot,
  RuntimeStatePayload,
} from '@idle-engine/runtime-bridge-contracts';

import {
  WORKER_MESSAGE_SCHEMA_VERSION,
  CommandSource,
  type RuntimeWorkerInboundMessage,
  type RuntimeWorkerCommand,
  type RuntimeWorkerDiagnosticsUpdate,
  type RuntimeWorkerStateUpdate,
  type RuntimeWorkerReady,
  type RuntimeWorkerErrorDetails,
  type RuntimeWorkerError,
  type RuntimeEventSnapshot,
  type RuntimeWorkerRestoreSession,
  type RuntimeWorkerSessionRestored,
  type RuntimeWorkerRequestSessionSnapshot,
  type RuntimeWorkerSessionSnapshot,
  type OfflineProgressSnapshot,
  type RuntimeWorkerSocialCommand,
  type RuntimeWorkerSocialCommandResult,
  type RuntimeWorkerSocialCommandFailure,
  SOCIAL_COMMAND_TYPES,
  type SocialCommandType,
  type SocialCommandPayloads,
  type SocialCommandResults,
} from '@idle-engine/runtime-bridge-contracts';
import {
  getSocialServiceBaseUrl,
  isSocialCommandsEnabled,
} from './modules/social-config.js';
import { extractErrorDetails } from './modules/error-utils.js';

const RAF_INTERVAL_MS = 16;

export interface RuntimeWorkerOptions {
  readonly context?: DedicatedWorkerGlobalScope;
  readonly now?: () => number;
  readonly scheduleTick?: (callback: () => void) => () => void;
  readonly handshakeId?: string;
  readonly fetch?: typeof fetch;
  readonly stepSizeMs?: number;
  readonly content?: NormalizedContentPack;
}

interface WorkerGameState {
  progression: ProgressionAuthoritativeState;
  [key: string]: unknown;
}

type Mutable<T> = {
  -readonly [K in keyof T]: T[K];
};

export interface RuntimeWorkerHarness {
  readonly runtime: IdleEngineRuntime;
  readonly handleMessage: (message: unknown) => void;
  readonly tick: () => void;
  readonly dispose: () => void;
  readonly getAutomationSystem: () => ReturnType<typeof createAutomationSystem>;
  readonly getTransformSystem: () => ReturnType<typeof createTransformSystem>;
}

export function isDedicatedWorkerScope(
  value: unknown,
): value is DedicatedWorkerGlobalScope {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (typeof DedicatedWorkerGlobalScope !== 'undefined') {
    return value instanceof DedicatedWorkerGlobalScope;
  }
  const candidate = value as {
    importScripts?: unknown;
  };
  return typeof candidate.importScripts === 'function';
}

export function initializeRuntimeWorker(
  options: RuntimeWorkerOptions = {},
): RuntimeWorkerHarness {
  const context =
    options.context ?? (self as DedicatedWorkerGlobalScope);
  const now = options.now ?? (() => performance.now());
  const scheduleTick =
    options.scheduleTick ??
    ((callback: () => void) => {
      const id = setInterval(callback, RAF_INTERVAL_MS);
      return () => clearInterval(id);
    });

  const stepDurationMs = options.stepSizeMs ?? 100;
  const commandQueue = new CommandQueue();
  const commandDispatcher = new CommandDispatcher();
  const runtime = new IdleEngineRuntime({
    commandQueue,
    commandDispatcher,
    stepSizeMs: stepDurationMs,
  });

  let existingState: WorkerGameState | undefined;
  let initialProgression: ProgressionAuthoritativeState | undefined;

  try {
    const existing = getGameState<WorkerGameState>();
    if (existing && typeof existing === 'object') {
      existingState = existing;
      const candidate = (existing as { progression?: unknown }).progression;
      if (candidate && typeof candidate === 'object') {
        initialProgression = candidate as ProgressionAuthoritativeState;
      }
    }
  } catch {
    existingState = undefined;
    initialProgression = undefined;
  }

  const content = options.content ?? sampleContent;
  const offlineProgressionConfig = content.metadata.offlineProgression;

  const progressionCoordinator = createProgressionCoordinator({
    content,
    stepDurationMs,
    initialState: initialProgression,
  });

  let gameState: WorkerGameState;
  if (existingState) {
    const updated = existingState as Mutable<WorkerGameState>;
    updated.progression = progressionCoordinator.state;
    gameState = setGameState<WorkerGameState>(updated);
  } else {
    gameState = setGameState<WorkerGameState>({
      progression: progressionCoordinator.state,
    });
  }

  const commandHandlerOptions: ResourceCommandHandlerOptions = {
    dispatcher: runtime.getCommandDispatcher(),
    resources: progressionCoordinator.resourceState,
    generatorPurchases: progressionCoordinator.generatorEvaluator,
    generatorToggles: progressionCoordinator,
    ...(progressionCoordinator.upgradeEvaluator
      ? {
          upgradePurchases: progressionCoordinator.upgradeEvaluator,
        }
      : {}),
    ...(progressionCoordinator.prestigeEvaluator
      ? {
          prestigeSystem: progressionCoordinator.prestigeEvaluator,
        }
      : {}),
  };
  registerResourceCommandHandlers(commandHandlerOptions);

  registerOfflineCatchupCommandHandler({
    dispatcher: runtime.getCommandDispatcher(),
    coordinator: progressionCoordinator,
    runtime,
  });

  // Create and register AutomationSystem + TransformSystem.
  // Wrap resourceState with adapter to map getIndex -> getResourceIndex.
  const resourceStateAdapter = createResourceStateAdapter(
    progressionCoordinator.resourceState,
  );
  const automationSystem = createAutomationSystem({
    automations: content.automations,
    commandQueue: runtime.getCommandQueue(),
    resourceState: resourceStateAdapter,
    stepDurationMs,
    conditionContext: progressionCoordinator.getConditionContext(),
    isAutomationUnlocked: (automationId) =>
      progressionCoordinator.getGrantedAutomationIds().has(automationId),
  });

  const transformSystem = createTransformSystem({
    transforms: content.transforms,
    stepDurationMs,
    resourceState: resourceStateAdapter,
    conditionContext: progressionCoordinator.getConditionContext(),
  });

  runtime.addSystem(automationSystem);
  runtime.addSystem(transformSystem);

  runtime.addSystem({
    id: 'progression-coordinator',
    tick: ({ step, events }) => {
      progressionCoordinator.updateForStep(step + 1, { events });
    },
  });

  // Register automation command handlers
  registerAutomationCommandHandlers({
    dispatcher: runtime.getCommandDispatcher(),
    automationSystem,
  });

  registerTransformCommandHandlers({
    dispatcher: runtime.getCommandDispatcher(),
    transformSystem,
  });

  let diagnosticsEnabled = false;
  let diagnosticsHead: number | undefined;
  let diagnosticsConfiguration:
    | DiagnosticTimelineResult['configuration']
    | undefined;
  let restoreInProgress = false;
  let sessionRestored = false;
  const queuedCommandsDuringRestore: Array<{
    readonly message: RuntimeWorkerCommand<unknown>;
    readonly requestId?: string;
  }> = [];

  const postDiagnosticsUpdate = (result: DiagnosticTimelineResult) => {
    diagnosticsHead = result.head;
    diagnosticsConfiguration = result.configuration;

    const message: RuntimeWorkerDiagnosticsUpdate = {
      type: 'DIAGNOSTICS_UPDATE',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      diagnostics: result,
    };
    context.postMessage(message);
  };

  const emitDiagnosticsDelta = (force = false) => {
    if (!diagnosticsEnabled) {
      return;
    }

    const result = runtime.readDiagnosticsDelta(diagnosticsHead);
    const hasUpdates =
      force ||
      result.entries.length > 0 ||
      result.dropped > 0 ||
      diagnosticsConfiguration !== result.configuration;

    if (!hasUpdates) {
      return;
    }

    postDiagnosticsUpdate(result);
  };

  const monotonicClock = createMonotonicClock(now);

  let lastTimestamp = now() - stepDurationMs;
  let lastResourceNetRates: Record<string, number> | null = null;

  const captureResourceNetRates = (
    resources: readonly { id: string; perSecond: number }[],
  ): void => {
    const netRates: Record<string, number> = {};
    for (const resource of resources) {
      if (typeof resource.id !== 'string' || resource.id.length === 0) {
        lastResourceNetRates = null;
        return;
      }
      const rate = resource.perSecond;
      if (!Number.isFinite(rate)) {
        lastResourceNetRates = null;
        return;
      }
      netRates[resource.id] = rate;
    }
    lastResourceNetRates = netRates;
  };

  const emitCommandFailures = () => {
    const commandFailures = runtime.drainCommandFailures();
    for (const failure of commandFailures) {
      if (failure.priority !== CommandPriority.PLAYER) {
        continue;
      }
      postError({
        code: 'COMMAND_FAILED',
        message: failure.error.message,
        requestId: failure.requestId,
        details: {
          command: {
            type: failure.type,
            step: failure.step,
            priority: failure.priority,
            timestamp: failure.timestamp,
          },
          error: failure.error,
        },
      });
    }
  };

  const tick = () => {
    emitCommandFailures();
    if (restoreInProgress) {
      return;
    }

    const current = now();
    const delta = current - lastTimestamp;
    lastTimestamp = current;

    const stepsProcessed = runtime.tick(delta);

    emitCommandFailures();

    if (stepsProcessed > 0) {
      const currentStep = runtime.getCurrentStep();
      const eventBus = runtime.getEventBus();
      const events = collectOutboundEvents(eventBus);
      const backPressure = eventBus.getBackPressureSnapshot();
      const publishedAt = monotonicClock.now();
      const conditionContext = progressionCoordinator.getConditionContext();
      const automationState = automationSystem.getState();
      const transformState = transformSystem.getState();
      const progression = buildProgressionSnapshot(
        currentStep,
        publishedAt,
        {
          ...progressionCoordinator.state,
          automations: {
            definitions: content.automations,
            state: automationState,
            conditionContext,
          },
          transforms: {
            definitions: content.transforms,
            state: transformState,
            resourceState: resourceStateAdapter,
            conditionContext,
          },
        },
      );
      if (
        offlineProgressionConfig &&
        areFastPathPreconditionsMet(
          offlineProgressionConfig.preconditions,
        )
      ) {
        captureResourceNetRates(progression.resources);
      }
      const transforms = Object.freeze({
        step: currentStep,
        publishedAt,
        transforms: progression.transforms,
      });

      const message: RuntimeWorkerStateUpdate = {
        type: 'STATE_UPDATE',
        schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
        state: {
          currentStep,
          events,
          backPressure,
          progression,
          transforms,
        },
      };
      context.postMessage(message);
      emitDiagnosticsDelta();
    }
  };

  let stopTick: () => void = () => {};

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

  let lastAcceptedCommandIssuedAt = Number.NEGATIVE_INFINITY;

  const postError = (details: RuntimeWorkerErrorDetails) => {
    // eslint-disable-next-line no-console
    console.warn('[runtime.worker] %s', details.message, {
      code: details.code,
      requestId: details.requestId,
      details: details.details,
    });
    const envelope: RuntimeWorkerError = {
      type: 'ERROR',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      error: details,
    };
    context.postMessage(envelope);
  };

  const socialConfig = {
    enabled: isSocialCommandsEnabled(),
    baseUrl: getSocialServiceBaseUrl(),
  };

  const fetchImpl: typeof fetch | undefined =
    options.fetch ??
    (typeof (context as unknown as { fetch?: typeof fetch }).fetch ===
    'function'
      ? (context as unknown as { fetch: typeof fetch }).fetch.bind(context)
      : typeof fetch === 'function'
        ? fetch.bind(context)
        : undefined);

  const postSocialCommandResult = (
    envelope: RuntimeWorkerSocialCommandResult,
  ) => {
    context.postMessage(envelope);
  };

  const isSupportedSocialCommand = (
    value: unknown,
  ): value is SocialCommandType =>
    value === SOCIAL_COMMAND_TYPES.FETCH_LEADERBOARD ||
    value === SOCIAL_COMMAND_TYPES.SUBMIT_LEADERBOARD_SCORE ||
    value === SOCIAL_COMMAND_TYPES.FETCH_GUILD_PROFILE ||
    value === SOCIAL_COMMAND_TYPES.CREATE_GUILD;

  const isValidCommandSource = (value: unknown): value is CommandSource =>
    value === CommandSource.PLAYER ||
    value === CommandSource.AUTOMATION ||
    value === CommandSource.SYSTEM;

  const flushQueuedCommands = () => {
    if (queuedCommandsDuringRestore.length === 0) {
      return;
    }

    for (const pending of queuedCommandsDuringRestore.splice(0)) {
      handleCommandMessage(pending.message, pending.requestId);
    }
  };

  const validateString = (
    value: unknown,
    message: string,
    details: Record<string, unknown>,
  ): string => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw Object.assign(new Error(message), { details });
    }
    return value.trim();
  };

  const postSocialCommandFailure = (
    requestId: string,
    message: string,
    code: RuntimeWorkerSocialCommandFailure['error']['code'],
    kind?: SocialCommandType,
    details?: Record<string, unknown>,
  ) => {
    postSocialCommandResult({
      type: 'SOCIAL_COMMAND_RESULT',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      requestId,
      status: 'error',
      kind,
      error: {
        code,
        message,
        ...(details ? { details } : {}),
      },
    });
  };

  const handleSocialCommandMessage = async (
    message: RuntimeWorkerSocialCommand,
  ) => {
    const requestId = validateString(
      message.requestId,
      'Social command requestId must be a non-empty string',
      { requestId: message.requestId },
    );

    if (!socialConfig.enabled) {
      postSocialCommandFailure(
        requestId,
        'Social commands are disabled',
        'SOCIAL_COMMANDS_DISABLED',
      );
      return;
    }

    if (!fetchImpl) {
      postSocialCommandFailure(
        requestId,
        'Fetch API is not available in this worker context',
        'SOCIAL_COMMAND_FAILED',
      );
      return;
    }

    if (!isRecord(message.command)) {
      postSocialCommandFailure(
        requestId,
        'Social command payload is missing',
        'INVALID_SOCIAL_COMMAND_PAYLOAD',
        undefined,
        { command: message.command },
      );
      return;
    }

    const kind = message.command.kind;
    if (!isSupportedSocialCommand(kind)) {
      postSocialCommandFailure(
        requestId,
        `Unsupported social command: ${String(kind)}`,
        'SOCIAL_COMMAND_UNSUPPORTED',
        undefined,
        { kind },
      );
      return;
    }

    const payload = message.command.payload;

    try {
      const data = await dispatchSocialCommand(
        fetchImpl,
        socialConfig.baseUrl,
        kind,
        payload,
      );

      postSocialCommandResult({
        type: 'SOCIAL_COMMAND_RESULT',
        schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
        requestId,
        status: 'success',
        kind,
        data,
      });
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : String(error);
      const details =
        error && typeof error === 'object' && 'details' in error
          ? (error as { details?: Record<string, unknown> }).details
          : undefined;

      postSocialCommandFailure(
        requestId,
        `Social command failed: ${reason}`,
        'SOCIAL_COMMAND_FAILED',
        kind,
        details,
      );
    }
  };

  async function dispatchSocialCommand<TCommand extends SocialCommandType>(
    fetchFn: typeof fetch,
    baseUrl: string,
    kind: TCommand,
    payload: SocialCommandPayloads[TCommand],
  ): Promise<SocialCommandResults[TCommand]> {
    const normalizedBase = new URL(baseUrl);
    if (!normalizedBase.pathname.endsWith('/')) {
      normalizedBase.pathname = `${normalizedBase.pathname}/`;
    }
    const baseWithTrailingSlash = normalizedBase.toString();
    const buildSocialUrl = (path: string) => {
      const relativePath = path.startsWith('/') ? path.slice(1) : path;
      const resolved = new URL(relativePath, baseWithTrailingSlash);
      const finalUrl = new URL(baseWithTrailingSlash);
      finalUrl.pathname = resolved.pathname;
      finalUrl.hash = resolved.hash;
      if (resolved.search) {
        const mergedSearch = new URLSearchParams(finalUrl.search);
        resolved.searchParams.forEach((value, key) => {
          if (!mergedSearch.getAll(key).includes(value)) {
            mergedSearch.append(key, value);
          }
        });
        finalUrl.search = mergedSearch.toString();
      }
      return finalUrl;
    };

    const execute = async <TResult>(
      path: string,
      init: RequestInit,
    ): Promise<TResult> => {
      const url = buildSocialUrl(path);
      const response = await fetchFn(url.toString(), init);
      const bodyText = await response.text();
      const parseJson = () => {
        if (!bodyText) {
          return null;
        }
        try {
          return JSON.parse(bodyText) as TResult;
        } catch {
          throw Object.assign(
            new Error('Failed to parse social-service response as JSON'),
            {
              details: {
                path: url.toString(),
                status: response.status,
                body: bodyText,
              },
            },
          );
        }
      };

      if (!response.ok) {
        throw Object.assign(
          new Error(
            `Social service responded with HTTP ${response.status}`,
          ),
          {
            details: {
              path: url.toString(),
              status: response.status,
              body: bodyText,
            },
          },
        );
      }

      const parsed = parseJson();
      if (parsed === null) {
        throw Object.assign(
          new Error('Social-service response was empty'),
          {
            details: {
              path: url.toString(),
              status: response.status,
            },
          },
        );
      }
      return parsed;
    };

    switch (kind) {
      case SOCIAL_COMMAND_TYPES.FETCH_LEADERBOARD: {
        const rawPayload =
          payload as SocialCommandPayloads['fetchLeaderboard'];
        const leaderboardId = validateString(
          rawPayload.leaderboardId,
          'leaderboardId must be a non-empty string',
          { leaderboardId: rawPayload.leaderboardId },
        );
        const accessToken = validateString(
          rawPayload.accessToken,
          'accessToken must be provided',
          { accessToken: rawPayload.accessToken },
        );
        const result = await execute(
          `/leaderboard/${encodeURIComponent(leaderboardId)}`,
          {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
          },
        );
        return result as SocialCommandResults[TCommand];
      }
      case SOCIAL_COMMAND_TYPES.SUBMIT_LEADERBOARD_SCORE: {
        const submitPayload =
          payload as SocialCommandPayloads['submitLeaderboardScore'];
        const leaderboardId = validateString(
          submitPayload.leaderboardId,
          'leaderboardId must be a non-empty string',
          { leaderboardId: submitPayload.leaderboardId },
        );
        if (
          typeof submitPayload.score !== 'number' ||
          !Number.isFinite(submitPayload.score) ||
          submitPayload.score < 0
        ) {
          throw Object.assign(
            new Error('score must be a non-negative finite number'),
            {
              details: { score: submitPayload.score },
            },
          );
        }
        const accessToken = validateString(
          submitPayload.accessToken,
          'accessToken must be provided',
          { accessToken: submitPayload.accessToken },
        );

        const body: Record<string, unknown> = {
          leaderboardId,
          score: submitPayload.score,
        };
        if (submitPayload.metadata) {
          body.metadata = submitPayload.metadata;
        }

        const result = await execute('/leaderboard/submit', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });
        return result as SocialCommandResults[TCommand];
      }
      case SOCIAL_COMMAND_TYPES.FETCH_GUILD_PROFILE: {
        const guildPayload =
          payload as SocialCommandPayloads['fetchGuildProfile'];
        const accessToken = validateString(
          guildPayload.accessToken,
          'accessToken must be provided',
          { accessToken: guildPayload.accessToken },
        );
        const result = await execute('/guilds/mine', {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });
        return result as SocialCommandResults[TCommand];
      }
      case SOCIAL_COMMAND_TYPES.CREATE_GUILD: {
        const createPayload =
          payload as SocialCommandPayloads['createGuild'];
        const name = validateString(
          createPayload.name,
          'Guild name must be at least one character',
          { name: createPayload.name },
        );
        const accessToken = validateString(
          createPayload.accessToken,
          'accessToken must be provided',
          { accessToken: createPayload.accessToken },
        );
        if (
          createPayload.description !== undefined &&
          typeof createPayload.description !== 'string'
        ) {
          throw Object.assign(
            new Error('description must be a string when provided'),
            {
              details: { description: createPayload.description },
            },
          );
        }

        const result = await execute('/guilds', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name,
            ...(createPayload.description
              ? { description: createPayload.description }
              : {}),
          }),
        });
        return result as SocialCommandResults[TCommand];
      }
      default:
        throw Object.assign(
          new Error(`Unhandled social command: ${String(kind)}`),
          {
            details: { kind },
          },
        );
    }
  }

  function areFastPathPreconditionsMet(
    preconditions: OfflineProgressFastPathPreconditions,
  ): boolean {
    return (
      preconditions.constantRates &&
      preconditions.noUnlocks &&
      preconditions.noAchievements &&
      preconditions.noAutomation &&
      preconditions.modeledResourceBounds
    );
  }

  const parseOfflineProgression = (
    value: RuntimeWorkerRestoreSession['offlineProgression'],
  ): OfflineProgressSnapshot | undefined => {
    if (!isRecord(value)) {
      return undefined;
    }

    const mode = value.mode;
    if (mode !== 'constant-rates') {
      return undefined;
    }

    const resourceNetRates = value.resourceNetRates;
    if (
      !isRecord(resourceNetRates) ||
      Array.isArray(resourceNetRates)
    ) {
      return undefined;
    }

    for (const rate of Object.values(resourceNetRates)) {
      if (typeof rate !== 'number' || !Number.isFinite(rate)) {
        return undefined;
      }
    }

    const preconditions = value.preconditions;
    if (!isRecord(preconditions)) {
      return undefined;
    }

    const {
      constantRates,
      noUnlocks,
      noAchievements,
      noAutomation,
      modeledResourceBounds,
    } = preconditions;

    if (
      typeof constantRates !== 'boolean' ||
      typeof noUnlocks !== 'boolean' ||
      typeof noAchievements !== 'boolean' ||
      typeof noAutomation !== 'boolean' ||
      typeof modeledResourceBounds !== 'boolean'
    ) {
      return undefined;
    }

    return {
      mode,
      resourceNetRates: resourceNetRates as Record<string, number>,
      preconditions: {
        constantRates,
        noUnlocks,
        noAchievements,
        noAutomation,
        modeledResourceBounds,
      },
    };
  };

  const handleRestoreSessionMessage = (
    message: RuntimeWorkerRestoreSession,
  ) => {
    if (
      sessionRestored &&
      message.state === undefined &&
      message.elapsedMs === undefined &&
      message.resourceDeltas === undefined
    ) {
      const restoredEnvelope: RuntimeWorkerSessionRestored = {
        type: 'SESSION_RESTORED',
        schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      };
      context.postMessage(restoredEnvelope);
      return;
    }

    restoreInProgress = true;

    try {
      if (
        Object.prototype.hasOwnProperty.call(message, 'elapsedMs') &&
        message.elapsedMs !== undefined &&
        (typeof message.elapsedMs !== 'number' ||
          !Number.isFinite(message.elapsedMs) ||
          message.elapsedMs < 0)
      ) {
        throw Object.assign(
          new Error('elapsedMs must be a non-negative finite number'),
          {
            code: 'INVALID_RESTORE_ELAPSED_MS' as const,
            details: { elapsedMs: message.elapsedMs },
          },
        );
      }

      if (
        message.resourceDeltas !== undefined &&
        (typeof message.resourceDeltas !== 'object' ||
          message.resourceDeltas === null)
      ) {
        throw Object.assign(
          new Error('resourceDeltas must be an object when provided'),
          {
            code: 'INVALID_RESTORE_RESOURCE_DELTAS' as const,
            details: { resourceDeltas: message.resourceDeltas },
          },
        );
      }

      if (message.resourceDeltas !== undefined) {
        for (const [resourceId, delta] of Object.entries(
          message.resourceDeltas,
        )) {
          if (typeof delta !== 'number' || !Number.isFinite(delta)) {
            throw Object.assign(
              new Error(
                'resource delta values must be finite numbers when provided',
              ),
              {
                code: 'INVALID_RESTORE_RESOURCE_DELTAS' as const,
                details: { resourceId, delta },
              },
            );
          }
        }
      }

      if (
        message.state !== undefined &&
        (typeof message.state !== 'object' || message.state === null)
      ) {
        throw Object.assign(
          new Error('Serialized resource state must be an object'),
          {
            code: 'INVALID_RESTORE_STATE' as const,
            details: { state: message.state },
          },
        );
      }

      if (message.state !== undefined) {
        const progression =
          gameState.progression as Mutable<ProgressionAuthoritativeState>;
        const coordinatorResources =
          progressionCoordinator.state
            .resources as Mutable<ProgressionResourceState> | undefined;
        const resources =
          (progression.resources as Mutable<ProgressionResourceState> | undefined) ??
          (progression.resources =
            (coordinatorResources ??
              ({} as Mutable<ProgressionResourceState>)));
        if (coordinatorResources?.metadata) {
          resources.metadata = coordinatorResources.metadata;
        }
        resources.serialized = message.state;
        resources.state = progressionCoordinator.resourceState;
        progressionCoordinator.hydrateResources(message.state);

        // Restore automation state if present in the snapshot
        if (message.state.automationState) {
          automationSystem.restoreState(message.state.automationState, {
            savedWorkerStep: message.savedWorkerStep,
            currentStep: runtime.getCurrentStep(),
          });
        }

        if (message.state.transformState) {
          transformSystem.restoreState(message.state.transformState, {
            savedWorkerStep: message.savedWorkerStep,
            currentStep: runtime.getCurrentStep(),
          });
        }

        setGameState(gameState);
      }

      if (message.commandQueue) {
        const currentStep = runtime.getCurrentStep();
        const savedStep = message.savedWorkerStep;
        const rebaseStep =
          typeof savedStep === 'number' && Number.isFinite(savedStep)
            ? { savedStep, currentStep }
            : undefined;

        commandQueue.restoreFromSave(message.commandQueue, {
          isCommandTypeSupported: (type) =>
            commandDispatcher.getHandler(type) !== undefined,
          ...(rebaseStep ? { rebaseStep } : {}),
        });
      }

      const offlineElapsedMs = message.elapsedMs ?? 0;
      const offlineResourceDeltas =
        message.resourceDeltas !== undefined
          ? { ...message.resourceDeltas }
          : {};
      const hasOfflineCatchup =
        offlineElapsedMs > 0 || Object.keys(offlineResourceDeltas).length > 0;

      const offlineProgression = parseOfflineProgression(
        message.offlineProgression,
      );
      if (message.offlineProgression !== undefined && !offlineProgression) {
        telemetry.recordWarning('OfflineProgressionSnapshotInvalid', {
          reason: 'invalid_payload',
        });
      }

      const shouldApplyFastPath =
        offlineElapsedMs > 0 &&
        offlineProgression !== undefined &&
        areFastPathPreconditionsMet(offlineProgression.preconditions) &&
        typeof runtime.fastForward === 'function';

      if (shouldApplyFastPath) {
        applyOfflineProgress({
          elapsedMs: offlineElapsedMs,
          coordinator: progressionCoordinator,
          runtime,
          resourceDeltas: offlineResourceDeltas,
          fastPath: offlineProgression,
        });
      } else if (hasOfflineCatchup) {
        commandQueue.enqueue({
          type: RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP,
          payload: {
            elapsedMs: offlineElapsedMs,
            resourceDeltas: offlineResourceDeltas,
          },
          priority: CommandPriority.SYSTEM,
          timestamp: monotonicClock.now(),
          step: runtime.getNextExecutableStep(),
        });
      }

      sessionRestored = true;
      const restoredEnvelope: RuntimeWorkerSessionRestored = {
        type: 'SESSION_RESTORED',
        schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      };
      context.postMessage(restoredEnvelope);
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : String(error);
      const details =
        error && typeof error === 'object' && 'details' in error
          ? (error as { details?: Record<string, unknown> }).details
          : undefined;
      postError({
        code: 'RESTORE_FAILED',
        message: `Failed to restore session: ${reason}`,
        details,
      });
    } finally {
      restoreInProgress = false;
      // Resume ticks from current wall-clock so we do not fast-forward after restore.
      lastTimestamp = now();
      flushQueuedCommands();
    }
  };

  const handleSessionSnapshotRequest = (
    message: RuntimeWorkerRequestSessionSnapshot,
  ) => {
    const requestId = message.requestId;

    // Block snapshots during restoration to avoid capturing inconsistent state.
    // During restoration, the runtime is replaying commands and rebuilding state,
    // which means the snapshot metadata (step, timestamp) wouldn't match the
    // actual runtime state. Wait for SESSION_RESTORED before requesting snapshots.
    if (restoreInProgress) {
      const currentStep = runtime.getCurrentStep();

      // Record telemetry for blocked snapshot attempts
      telemetry.recordWarning('worker.session_snapshot_blocked', {
        reason: 'RESTORE_IN_PROGRESS',
        workerStep: currentStep,
        requestId: requestId ?? 'none',
      });

      postError({
        code: 'SNAPSHOT_FAILED',
        message: 'Cannot capture snapshot during session restoration. Wait for restoration to complete.',
        requestId,
        details: {
          reason: 'RESTORE_IN_PROGRESS',
          workerStep: currentStep,
        },
      });
      return;
    }

    try {
      const automationStateMap = automationSystem.getState();
      const transformStateMap = transformSystem.getState();
      const state = progressionCoordinator.resourceState.exportForSave(
        automationStateMap,
        transformStateMap,
      );
      const commandQueueSnapshot = commandQueue.exportForSave();
      const currentStep = runtime.getCurrentStep();
      const monotonicMs = monotonicClock.now();
      const capturedAt = new Date().toISOString();
      const contentDigest = progressionCoordinator.resourceState.getDefinitionDigest();
      const offlineProgression =
        offlineProgressionConfig &&
        areFastPathPreconditionsMet(
          offlineProgressionConfig.preconditions,
        ) &&
        lastResourceNetRates !== null
          ? {
              mode:
                offlineProgressionConfig.mode ?? 'constant-rates',
              resourceNetRates: { ...lastResourceNetRates },
              preconditions: offlineProgressionConfig.preconditions,
            }
          : undefined;

      const snapshotEnvelope: RuntimeWorkerSessionSnapshot = {
        type: 'SESSION_SNAPSHOT',
        schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
        requestId,
        snapshot: {
          persistenceSchemaVersion: PERSISTENCE_SCHEMA_VERSION,
          slotId: 'default',
          capturedAt,
          workerStep: currentStep,
          monotonicMs,
          state,
          commandQueue: commandQueueSnapshot,
          runtimeVersion: RUNTIME_VERSION,
          contentDigest,
          ...(offlineProgression ? { offlineProgression } : {}),
        },
      };

      // Telemetry: Record snapshot size and capture metadata for monitoring
      const snapshotBytes = JSON.stringify({
        state,
        commandQueue: commandQueueSnapshot,
        offlineProgression,
      }).length;
      const snapshotKB = (snapshotBytes / 1024).toFixed(2);

      // Record snapshot event with metadata for production monitoring
      telemetry.recordProgress('worker.session_snapshot_captured', {
        snapshotBytes,
        snapshotKB,
        workerStep: currentStep,
        reason: message.reason ?? 'unspecified',
        requestId: requestId ?? 'none',
        resourceCount: state.ids.length,
      });

      // Record snapshot size metrics for aggregation and alerting
      telemetry.recordCounters('worker.session_snapshot', {
        capture_count: 1,
        total_bytes: snapshotBytes,
      });

      // eslint-disable-next-line no-console
      console.debug(
        `[Worker] Session snapshot captured: ${snapshotKB} KB, step=${currentStep}, reason=${message.reason ?? 'unspecified'}`,
      );

      context.postMessage(snapshotEnvelope);
    } catch (error) {
      const currentStep = runtime.getCurrentStep();
      const reason =
        error instanceof Error ? error.message : String(error);

      // Record telemetry for snapshot export failures
      telemetry.recordError('worker.session_snapshot_failed', {
        reason: 'EXPORT_FAILED',
        errorMessage: reason,
        workerStep: currentStep,
        requestId: requestId ?? 'none',
      });

      postError({
        code: 'SNAPSHOT_FAILED',
        message: `Failed to capture session snapshot: ${reason}`,
        requestId,
        details: {
          ...extractErrorDetails(error),
          reason: 'EXPORT_FAILED',
          workerStep: currentStep,
        },
      });
    }
  };

  const handleCommandMessage = (
    raw: RuntimeWorkerCommand<unknown>,
    requestId?: string,
  ) => {
    if (restoreInProgress) {
      queuedCommandsDuringRestore.push({
        message: raw,
        requestId,
      });
      return;
    }

    const source = raw.source;
    if (!isValidCommandSource(source)) {
      postError({
        code: 'INVALID_COMMAND_PAYLOAD',
        message: 'Command source must be a known string identifier',
        requestId,
        details: { source },
      });
      return;
    }

    if (!('command' in raw) || !isRecord(raw.command)) {
      postError({
        code: 'INVALID_COMMAND_PAYLOAD',
        message: 'Command envelope is missing the command payload',
        requestId,
        details: { command: raw.command },
      });
      return;
    }

    const command = raw.command as Record<string, unknown>;
    const type = command.type;
    if (typeof type !== 'string' || type.trim().length === 0) {
      postError({
        code: 'INVALID_COMMAND_PAYLOAD',
        message: 'Command type must be a non-empty string',
        requestId,
        details: { type },
      });
      return;
    }

    if (!Object.prototype.hasOwnProperty.call(command, 'payload')) {
      postError({
        code: 'INVALID_COMMAND_PAYLOAD',
        message: 'Command payload is required',
        requestId,
        details: { hasPayload: false },
      });
      return;
    }

    const issuedAt = command.issuedAt;
    if (typeof issuedAt !== 'number' || !Number.isFinite(issuedAt)) {
      postError({
        code: 'INVALID_COMMAND_PAYLOAD',
        message: 'Command issuedAt must be a finite number',
        requestId,
        details: { issuedAt },
      });
      return;
    }

    if (issuedAt < lastAcceptedCommandIssuedAt) {
      // eslint-disable-next-line no-console
      console.warn('[runtime.worker] Dropping stale command', {
        type,
        issuedAt,
        lastAcceptedCommandIssuedAt,
        requestId,
      });
      postError({
        code: 'STALE_COMMAND',
        message: 'Command issuedAt is not monotonic',
        requestId,
        details: {
          issuedAt,
          lastAcceptedCommandIssuedAt,
        },
      });
      return;
    }

    lastAcceptedCommandIssuedAt = issuedAt;

    const commandMessage = raw as RuntimeWorkerCommand<unknown>;
    commandQueue.enqueue({
      type,
      payload: commandMessage.command.payload,
      priority: CommandPriority.PLAYER,
      timestamp: monotonicClock.now(),
      step: runtime.getNextExecutableStep(),
      requestId,
    });
  };

  const handleMessage = (message: unknown) => {
    if (!isRecord(message)) {
      return;
    }

    const type = message.type;
    const schemaVersion = message.schemaVersion;
    const requestId =
      typeof message.requestId === 'string' ? message.requestId : undefined;

    if (schemaVersion !== WORKER_MESSAGE_SCHEMA_VERSION) {
      postError({
        code: 'SCHEMA_VERSION_MISMATCH',
        message: 'Unsupported worker message schema version',
        requestId,
        details: {
          expected: WORKER_MESSAGE_SCHEMA_VERSION,
          received: schemaVersion,
          type,
        },
      });
      return;
    }

    if (type === 'COMMAND') {
      handleCommandMessage(
        message as unknown as RuntimeWorkerCommand<unknown>,
        requestId,
      );
      return;
    }

    if (type === 'SOCIAL_COMMAND') {
      void handleSocialCommandMessage(
        message as unknown as RuntimeWorkerSocialCommand,
      );
      return;
    }

    if (type === 'DIAGNOSTICS_SUBSCRIBE') {
      diagnosticsEnabled = true;
      diagnosticsHead = undefined;
      diagnosticsConfiguration = undefined;
      runtime.enableDiagnostics();
      emitDiagnosticsDelta(true);
      return;
    }

    if (type === 'DIAGNOSTICS_UNSUBSCRIBE') {
      diagnosticsEnabled = false;
      diagnosticsHead = undefined;
      diagnosticsConfiguration = undefined;
      runtime.enableDiagnostics(false);
      return;
    }

    if (type === 'RESTORE_SESSION') {
      handleRestoreSessionMessage(
        message as unknown as RuntimeWorkerRestoreSession,
      );
      return;
    }

    if (type === 'REQUEST_SESSION_SNAPSHOT') {
      handleSessionSnapshotRequest(
        message as unknown as RuntimeWorkerRequestSessionSnapshot,
      );
      return;
    }

    if (type === 'TERMINATE') {
      stopTick();
      context.removeEventListener('message', messageListener);
      context.close();
      return;
    }

    postError({
      code: 'UNSUPPORTED_MESSAGE',
      message: 'Unsupported worker message type received',
      requestId,
      details: { type },
    });
  };

  const messageListener = (
    event: MessageEvent<RuntimeWorkerInboundMessage | unknown>,
  ) => {
    handleMessage(event.data);
  };

  context.addEventListener('message', messageListener);

  const readyMessage: RuntimeWorkerReady = {
    type: 'READY',
    schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
    handshakeId: options.handshakeId,
  };
  context.postMessage(readyMessage);

  stopTick = scheduleTick(tick);

  const dispose = () => {
    stopTick();
    context.removeEventListener('message', messageListener);
  };

  return {
    runtime,
    handleMessage,
    tick,
    dispose,
    getAutomationSystem: () => automationSystem,
    getTransformSystem: () => transformSystem,
  };
}

function createMonotonicClock(now: () => number) {
  let last = 0;
  return {
    now(): number {
      const raw = now();
      if (raw <= last) {
        last += 0.0001;
        return last;
      }
      last = raw;
      return raw;
    },
  };
}

if (!import.meta.vitest) {
  const bootstrapScope =
    typeof self !== 'undefined' ? (self as unknown) : globalThis;
  if (isDedicatedWorkerScope(bootstrapScope)) {
    initializeRuntimeWorker();
  }
}

function collectOutboundEvents(bus: EventBus): RuntimeEventSnapshot[] {
  const manifest = bus.getManifest();
  const events: RuntimeEventSnapshot[] = [];

  for (let channelIndex = 0; channelIndex < manifest.entries.length; channelIndex += 1) {
    const buffer = bus.getOutboundBuffer(channelIndex);
    for (let bufferIndex = 0; bufferIndex < buffer.length; bufferIndex += 1) {
      const record = buffer.at(bufferIndex);
      events.push({
        channel: channelIndex,
        type: record.type,
        tick: record.tick,
        issuedAt: record.issuedAt,
        dispatchOrder: record.dispatchOrder,
        payload: record.payload,
      });
    }
  }

  events.sort((left, right) => {
    if (left.tick !== right.tick) {
      return left.tick - right.tick;
    }
    return left.dispatchOrder - right.dispatchOrder;
  });

  return events;
}
