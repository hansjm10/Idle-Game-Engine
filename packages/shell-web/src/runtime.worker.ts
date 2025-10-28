/// <reference lib="webworker" />

import {
  CommandPriority,
  CommandQueue,
  CommandDispatcher,
  IdleEngineRuntime,
  RUNTIME_COMMAND_TYPES,
  setGameState,
  type DiagnosticTimelineResult,
  type EventBus,
  type SerializedResourceState,
} from '@idle-engine/core';

export type {
  RuntimeEventSnapshot,
  RuntimeStatePayload,
} from './modules/runtime-worker-protocol.js';

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
  type RuntimeWorkerSocialCommand,
  type RuntimeWorkerSocialCommandResult,
  type RuntimeWorkerSocialCommandFailure,
  SOCIAL_COMMAND_TYPES,
  type SocialCommandType,
  type SocialCommandPayloads,
  type SocialCommandResults,
} from './modules/runtime-worker-protocol.js';
import {
  getSocialServiceBaseUrl,
  isSocialCommandsEnabled,
} from './modules/social-config.js';

const RAF_INTERVAL_MS = 16;

export interface RuntimeWorkerOptions {
  readonly context?: DedicatedWorkerGlobalScope;
  readonly now?: () => number;
  readonly scheduleTick?: (callback: () => void) => () => void;
  readonly handshakeId?: string;
  readonly fetch?: typeof fetch;
}

export interface RuntimeWorkerHarness {
  readonly runtime: IdleEngineRuntime;
  readonly handleMessage: (message: unknown) => void;
  readonly tick: () => void;
  readonly dispose: () => void;
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

  const commandQueue = new CommandQueue();
  const commandDispatcher = new CommandDispatcher();
  const runtime = new IdleEngineRuntime({
    commandQueue,
    commandDispatcher,
  });

  let diagnosticsEnabled = false;
  let diagnosticsHead: number | undefined;
  let diagnosticsConfiguration:
    | DiagnosticTimelineResult['configuration']
    | undefined;
  let restoreInProgress = false;
  let sessionRestored = false;
  const queuedCommandsDuringRestore: Array<{
    readonly message: Record<string, unknown>;
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

  let lastTimestamp = now();
  const tick = () => {
    if (restoreInProgress) {
      return;
    }

    const current = now();
    const delta = current - lastTimestamp;
    lastTimestamp = current;

    const before = runtime.getCurrentStep();
    runtime.tick(delta);
    const after = runtime.getCurrentStep();

    if (after > before) {
      const eventBus = runtime.getEventBus();
      const events = collectOutboundEvents(eventBus);
      const backPressure = eventBus.getBackPressureSnapshot();

      const message: RuntimeWorkerStateUpdate = {
        type: 'STATE_UPDATE',
        schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
        state: {
          currentStep: after,
          events,
          backPressure,
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
    const execute = async <TResult>(
      path: string,
      init: RequestInit,
    ): Promise<TResult> => {
      const url = new URL(path, baseUrl);
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
        setGameState<SerializedResourceState>(message.state);
      }

      const offlineElapsedMs = message.elapsedMs ?? 0;
      const offlineResourceDeltas =
        message.resourceDeltas !== undefined
          ? { ...message.resourceDeltas }
          : {};
      const hasOfflineCatchup =
        offlineElapsedMs > 0 || Object.keys(offlineResourceDeltas).length > 0;

      if (hasOfflineCatchup) {
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

  const handleCommandMessage = (
    raw: Record<string, unknown>,
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
      handleCommandMessage(message, requestId);
      return;
    }

    if (type === 'SOCIAL_COMMAND') {
      void handleSocialCommandMessage(
        message as RuntimeWorkerSocialCommand,
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
        message as RuntimeWorkerRestoreSession,
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
  initializeRuntimeWorker();
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
