import { useEffect, useRef } from 'react';

import type {
  DiagnosticTimelineResult,
  SerializedCommandQueue,
  SerializedResourceState,
  ResourceDefinitionDigest,
} from '@idle-engine/core';

import {
  CommandSource,
  WORKER_MESSAGE_SCHEMA_VERSION,
  type RuntimeEventSnapshot as WorkerRuntimeEventSnapshot,
  type RuntimeStatePayload,
  type RuntimeWorkerCommand,
  type RuntimeWorkerDiagnosticsSubscribe,
  type RuntimeWorkerDiagnosticsUnsubscribe,
  type RuntimeWorkerErrorDetails,
  type RuntimeWorkerInboundMessage,
  type RuntimeWorkerOutboundMessage,
  type RuntimeWorkerRequestSessionSnapshot,
  type RuntimeWorkerRestoreSession,
  type RuntimeWorkerSocialCommand,
  type RuntimeWorkerSocialCommandResult,
  type SocialCommandPayloads,
  type SocialCommandResults,
  type SocialCommandType,
  type RuntimeWorkerSocialCommandFailure,
  SOCIAL_COMMAND_TYPES,
  type OfflineProgressSnapshot,
} from '@idle-engine/runtime-bridge-contracts';
import { isSocialCommandsEnabled } from './social-config.js';
import { isWorkerBridgeEnabled } from './worker-bridge-config.js';
import type { WorkerBridgeWorker } from './worker-bridge-worker.js';
import { createInlineRuntimeWorker } from './inline-runtime-worker.js';
import { installShellTelemetryFacade } from './shell-analytics.js';

installShellTelemetryFacade();

export interface WorkerRestoreSessionPayload {
  readonly state?: SerializedResourceState;
  readonly commandQueue?: SerializedCommandQueue;
  readonly elapsedMs?: number;
  readonly maxElapsedMs?: number;
  readonly maxSteps?: number;
  readonly resourceDeltas?: Readonly<Record<string, number>>;
  readonly offlineProgression?: OfflineProgressSnapshot;
  /**
   * Optional: worker step recorded in the save snapshot. If provided, the
   * worker rebases absolute step fields (like automation cooldowns) to the
   * new timeline to avoid long post-restore cooldowns.
   */
  readonly savedWorkerStep?: number;
}

interface WorkerBridgeRestoreError extends Error {
  details?: Record<string, unknown>;
}

type TelemetryFacadeLike = {
  recordError?: (
    event: string,
    data?: Record<string, unknown>,
  ) => void;
};

function recordTelemetryError(
  event: string,
  data: Record<string, unknown>,
): void {
  const telemetry = (globalThis as {
    __IDLE_ENGINE_TELEMETRY__?: TelemetryFacadeLike;
  }).__IDLE_ENGINE_TELEMETRY__;

  telemetry?.recordError?.(event, data);
}

interface WorkerBridgeSocialCommandError extends Error {
  code: RuntimeWorkerSocialCommandFailure['error']['code'];
  details?: Record<string, unknown>;
  kind?: SocialCommandType;
  requestId?: string;
}

interface PendingSocialRequest {
  readonly kind: SocialCommandType;
  readonly resolve: (
    value: SocialCommandResults[SocialCommandType],
  ) => void;
  readonly reject: (error: Error) => void;
}

interface PendingSnapshotRequest {
  readonly resolve: (snapshot: SessionSnapshotPayload) => void;
  readonly reject: (error: Error) => void;
}

const SUPPORTED_SOCIAL_COMMAND_KINDS = new Set<SocialCommandType>([
  SOCIAL_COMMAND_TYPES.FETCH_LEADERBOARD,
  SOCIAL_COMMAND_TYPES.SUBMIT_LEADERBOARD_SCORE,
  SOCIAL_COMMAND_TYPES.FETCH_GUILD_PROFILE,
  SOCIAL_COMMAND_TYPES.CREATE_GUILD,
]);

const SOCIAL_ERROR_CODES = new Set<
  WorkerBridgeSocialCommandError['code']
>([
  'SOCIAL_COMMANDS_DISABLED',
  'INVALID_SOCIAL_COMMAND_PAYLOAD',
  'SOCIAL_COMMAND_UNSUPPORTED',
  'SOCIAL_COMMAND_FAILED',
]);

function isSupportedSocialCommandKind(
  value: unknown,
): value is SocialCommandType {
  return typeof value === 'string' && SUPPORTED_SOCIAL_COMMAND_KINDS.has(value as SocialCommandType);
}

export interface SessionSnapshotPayload {
  readonly persistenceSchemaVersion: number;
  readonly slotId: string;
  readonly capturedAt: string;
  readonly workerStep: number;
  readonly monotonicMs: number;
  readonly state: SerializedResourceState;
  readonly commandQueue?: SerializedCommandQueue;
  readonly runtimeVersion: string;
  readonly contentDigest: ResourceDefinitionDigest;
  readonly offlineProgression?: OfflineProgressSnapshot;
  readonly flags?: {
    readonly pendingMigration?: boolean;
    readonly abortedRestore?: boolean;
  };
}

export interface WorkerBridge<TState = unknown> {
  awaitReady(): Promise<void>;
  restoreSession(
    payload?: WorkerRestoreSessionPayload,
  ): Promise<void>;
  requestSessionSnapshot(
    reason?: string,
  ): Promise<SessionSnapshotPayload>;
  sendCommand<TPayload = unknown>(type: string, payload: TPayload): void;
  sendSocialCommand<TCommand extends SocialCommandType>(
    kind: TCommand,
    payload: SocialCommandPayloads[TCommand],
  ): Promise<SocialCommandResults[TCommand]>;
  onStateUpdate(callback: (state: TState) => void): void;
  offStateUpdate(callback: (state: TState) => void): void;
  enableDiagnostics(): void;
  disableDiagnostics(): void;
  onDiagnosticsUpdate(
    callback: (diagnostics: DiagnosticTimelineResult) => void,
  ): void;
  offDiagnosticsUpdate(
    callback: (diagnostics: DiagnosticTimelineResult) => void,
  ): void;
  onError(callback: (error: RuntimeWorkerErrorDetails) => void): void;
  offError(callback: (error: RuntimeWorkerErrorDetails) => void): void;
  isSocialFeatureEnabled(): boolean;
}

declare global {
  interface Window {
    __IDLE_WORKER_BRIDGE__?: WorkerBridge<unknown>;
  }
}

type WorkerBridgeDebugGlobal = typeof globalThis & {
  __ENABLE_IDLE_DEBUG__?: unknown;
  __IDLE_WORKER_BRIDGE__?: WorkerBridge<unknown>;
};

function coerceDebugOptIn(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1';
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  return false;
}

function shouldExposeWorkerBridgeDebugHandle(
  target: WorkerBridgeDebugGlobal,
): boolean {
  if (coerceDebugOptIn(target.__ENABLE_IDLE_DEBUG__)) {
    return true;
  }

  const nodeEnv =
    typeof process !== 'undefined' ? process.env?.NODE_ENV : undefined;
  if (typeof nodeEnv === 'string') {
    const normalized = nodeEnv.toLowerCase();
    if (normalized === 'production') {
      return false;
    }
    return true;
  }

  if (typeof import.meta !== 'undefined') {
    const devFlag = Boolean(import.meta.env?.DEV);
    const mode =
      typeof import.meta.env?.MODE === 'string'
        ? import.meta.env.MODE.toLowerCase()
        : undefined;
    if (devFlag || mode === 'development' || mode === 'test') {
      return true;
    }
  }

  return false;
}

function registerWorkerBridgeDebugHandle(
  target: WorkerBridgeDebugGlobal,
  bridge: WorkerBridge<unknown>,
): void {
  if (shouldExposeWorkerBridgeDebugHandle(target)) {
    target.__IDLE_WORKER_BRIDGE__ = bridge;
    return;
  }

  if ('__IDLE_WORKER_BRIDGE__' in target) {
    delete target.__IDLE_WORKER_BRIDGE__;
  }
}

export class WorkerBridgeImpl<TState = unknown>
  implements WorkerBridge<TState>
{
  private readonly worker: WorkerBridgeWorker;
  private readonly pendingMessages: RuntimeWorkerInboundMessage[] = [];
  private readonly stateUpdateCallbacks: Array<(state: TState) => void> = [];
  private readonly diagnosticsUpdateCallbacks: Array<
    (diagnostics: DiagnosticTimelineResult) => void
  > = [];
  private readonly errorCallbacks = new Set<
    (error: RuntimeWorkerErrorDetails) => void
  >();
  private readonly pendingSocialRequests = new Map<
    string,
    PendingSocialRequest
  >();
  private readonly pendingSnapshotRequests = new Map<
    string,
    PendingSnapshotRequest
  >();
  private readonly socialEnabled = isSocialCommandsEnabled();
  private readonly readyPromise: Promise<void>;
  private resolveReady: (() => void) | null = null;
  private disposed = false;
  private ready = false;
  private nextRequestId = 0;
  private sessionReady = true;
  private restoreDeferred:
    | {
        resolve: () => void;
        reject: (error: Error) => void;
      }
    | null = null;

  private readonly handleMessage = (event: MessageEvent<unknown>) => {
    const envelope = event.data as RuntimeWorkerOutboundMessage<TState> | null;
    if (!envelope || typeof envelope !== 'object') {
      return;
    }

    if (envelope.schemaVersion !== WORKER_MESSAGE_SCHEMA_VERSION) {
      // eslint-disable-next-line no-console
      console.error('[WorkerBridge] Ignoring message with unknown schema', {
        expected: WORKER_MESSAGE_SCHEMA_VERSION,
        received: envelope.schemaVersion,
        type: envelope.type,
      });
      return;
    }

    if (envelope.type === 'READY') {
      // eslint-disable-next-line no-console
      console.debug('[WorkerBridge] READY message received');
      this.markReady();
      return;
    }

    if (envelope.type === 'SESSION_RESTORED') {
      this.sessionReady = true;
      const deferred = this.restoreDeferred;
      this.restoreDeferred = null;
      deferred?.resolve();
      this.flushPendingMessages();
      return;
    }

    if (envelope.type === 'ERROR') {
      if (
        envelope.error.code === 'RESTORE_FAILED' &&
        this.restoreDeferred
      ) {
        const deferred = this.restoreDeferred;
        this.restoreDeferred = null;
        const error: WorkerBridgeRestoreError = new Error(
          envelope.error.message,
        );
        error.name = 'WorkerRestoreError';
        if (envelope.error.details) {
          error.details = envelope.error.details;
        }
        deferred.reject(error);
        this.sessionReady = true;
        this.flushPendingMessages();
      }
      this.emitError(envelope.error);
      if (
        envelope.error.requestId &&
        SOCIAL_ERROR_CODES.has(
          envelope.error.code as WorkerBridgeSocialCommandError['code'],
        )
      ) {
        const bridgeError: WorkerBridgeSocialCommandError = Object.assign(
          new Error(envelope.error.message),
          {
            name: 'WorkerBridgeSocialCommandError',
            code: envelope.error.code as WorkerBridgeSocialCommandError['code'],
            details: envelope.error.details,
            requestId: envelope.error.requestId,
          },
        );
        this.rejectPendingSocialRequest(
          envelope.error.requestId,
          bridgeError,
        );
      }
      return;
    }

    if (envelope.type === 'SOCIAL_COMMAND_RESULT') {
      this.handleSocialCommandResult(envelope);
      return;
    }

    if (envelope.type === 'SESSION_SNAPSHOT') {
      this.handleSessionSnapshot(envelope);
      return;
    }

    if (envelope.type === 'DIAGNOSTICS_UPDATE') {
      for (const callback of this.diagnosticsUpdateCallbacks) {
        callback(envelope.diagnostics);
      }
      return;
    }

    if (envelope.type === 'STATE_UPDATE') {
      // eslint-disable-next-line no-console
      console.debug('[WorkerBridge] STATE_UPDATE received');
      for (const callback of this.stateUpdateCallbacks) {
        callback(envelope.state);
      }
    }
  };

  private markReady(): void {
    if (this.ready) {
      return;
    }
    this.ready = true;
    this.resolveReady?.();
    this.resolveReady = null;
    this.flushPendingMessages();
  }

  private flushPendingMessages(): void {
    if (!this.ready || this.disposed || this.pendingMessages.length === 0) {
      return;
    }
    const stillQueued: RuntimeWorkerInboundMessage[] = [];
    for (const message of this.pendingMessages) {
      if (!this.sessionReady && message.type !== 'RESTORE_SESSION') {
        stillQueued.push(message);
        continue;
      }
      this.worker.postMessage(message);
    }
    this.pendingMessages.length = 0;
    if (stillQueued.length > 0) {
      this.pendingMessages.push(...stillQueued);
    }
  }

  private emitError(error: RuntimeWorkerErrorDetails): void {
    // eslint-disable-next-line no-console
    console.error('[WorkerBridge] Worker error received', error);
    recordTelemetryError('WorkerBridgeError', {
      code: error.code,
      message: error.message,
      requestId: error.requestId ?? null,
    });
    for (const callback of this.errorCallbacks) {
      callback(error);
    }
  }

  private rejectPendingSocialRequest(requestId: string, error: Error): void {
    const pending = this.pendingSocialRequests.get(requestId);
    if (!pending) {
      return;
    }
    this.pendingSocialRequests.delete(requestId);
    pending.reject(error);
  }

  private handleSocialCommandResult(
    envelope: RuntimeWorkerSocialCommandResult,
  ): void {
    const pending = this.pendingSocialRequests.get(envelope.requestId);
    if (!pending) {
      // eslint-disable-next-line no-console
      console.warn('[WorkerBridge] Received social result for unknown request', {
        requestId: envelope.requestId,
        status: envelope.status,
      });
      return;
    }
    this.pendingSocialRequests.delete(envelope.requestId);

    if (envelope.status === 'success') {
      pending.resolve(
        envelope.data as SocialCommandResults[SocialCommandType],
      );
      return;
    }

    const error: WorkerBridgeSocialCommandError = Object.assign(
      new Error(envelope.error.message),
      {
        name: 'WorkerBridgeSocialCommandError',
        code: envelope.error.code,
        details: envelope.error.details,
        kind: envelope.kind,
        requestId: envelope.requestId,
      },
    );

    recordTelemetryError('SocialCommandFailed', {
      code: envelope.error.code,
      kind: envelope.kind ?? null,
      requestId: envelope.requestId,
    });

    pending.reject(error);
  }

  private handleSessionSnapshot(
    envelope: { type: 'SESSION_SNAPSHOT'; requestId?: string; snapshot: SessionSnapshotPayload },
  ): void {
    const requestId = envelope.requestId;
    if (!requestId) {
      // eslint-disable-next-line no-console
      console.warn('[WorkerBridge] Received session snapshot without requestId');
      return;
    }

    const pending = this.pendingSnapshotRequests.get(requestId);
    if (!pending) {
      // eslint-disable-next-line no-console
      console.warn('[WorkerBridge] Received session snapshot for unknown request', {
        requestId,
      });
      return;
    }

    this.pendingSnapshotRequests.delete(requestId);
    pending.resolve(envelope.snapshot);
  }

  constructor(worker: WorkerBridgeWorker) {
    this.worker = worker;
    this.readyPromise = new Promise<void>((resolve) => {
      this.resolveReady = resolve;
    });
    this.worker.addEventListener('message', this.handleMessage);
  }

  awaitReady(): Promise<void> {
    if (this.ready) {
      return Promise.resolve();
    }
    return this.readyPromise;
  }

  restoreSession(
    payload: WorkerRestoreSessionPayload = {},
  ): Promise<void> {
    if (this.disposed) {
      return Promise.reject(
        new Error('WorkerBridge has been disposed'),
      );
    }

    if (this.restoreDeferred) {
      return Promise.reject(
        new Error('A session restore is already in progress'),
      );
    }

    if (
      payload.elapsedMs !== undefined &&
      (!Number.isFinite(payload.elapsedMs) || payload.elapsedMs < 0)
    ) {
      return Promise.reject(
        new Error('elapsedMs must be a non-negative finite number'),
      );
    }

    if (
      payload.maxElapsedMs !== undefined &&
      (!Number.isFinite(payload.maxElapsedMs) || payload.maxElapsedMs < 0)
    ) {
      return Promise.reject(
        new Error('maxElapsedMs must be a non-negative finite number'),
      );
    }

    if (
      payload.maxSteps !== undefined &&
      (!Number.isFinite(payload.maxSteps) ||
        payload.maxSteps < 0 ||
        !Number.isInteger(payload.maxSteps))
    ) {
      return Promise.reject(
        new Error('maxSteps must be a non-negative finite integer'),
      );
    }

    if (
      payload.resourceDeltas !== undefined &&
      (typeof payload.resourceDeltas !== 'object' ||
        payload.resourceDeltas === null)
    ) {
      return Promise.reject(
        new Error('resourceDeltas must be an object when provided'),
      );
    }

    this.sessionReady = false;

    const envelope: RuntimeWorkerRestoreSession = {
      type: 'RESTORE_SESSION',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      ...(payload.state !== undefined && { state: payload.state }),
      ...(payload.commandQueue !== undefined && {
        commandQueue: payload.commandQueue,
      }),
      ...(payload.elapsedMs !== undefined && {
        elapsedMs: payload.elapsedMs,
      }),
      ...(payload.maxElapsedMs !== undefined && {
        maxElapsedMs: payload.maxElapsedMs,
      }),
      ...(payload.maxSteps !== undefined && {
        maxSteps: payload.maxSteps,
      }),
      ...(payload.resourceDeltas !== undefined && {
        resourceDeltas: payload.resourceDeltas,
      }),
      ...(payload.offlineProgression !== undefined && {
        offlineProgression: payload.offlineProgression,
      }),
      ...(payload.savedWorkerStep !== undefined && {
        savedWorkerStep: payload.savedWorkerStep,
      }),
    };

    const restorePromise = new Promise<void>((resolve, reject) => {
      this.restoreDeferred = {
        resolve: () => {
          this.restoreDeferred = null;
          resolve();
        },
        reject: (error) => {
          this.restoreDeferred = null;
          reject(error);
        },
      };
    });

    this.postOrQueue(envelope);
    this.flushPendingMessages();

    return restorePromise;
  }

  requestSessionSnapshot(reason?: string): Promise<SessionSnapshotPayload> {
    if (this.disposed) {
      return Promise.reject(
        new Error('WorkerBridge has been disposed'),
      );
    }

    const requestId = `snapshot:${this.nextRequestId++}`;
    const envelope: RuntimeWorkerRequestSessionSnapshot = {
      type: 'REQUEST_SESSION_SNAPSHOT',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      requestId,
      ...(reason !== undefined && { reason }),
    };

    return new Promise<SessionSnapshotPayload>((resolve, reject) => {
      this.pendingSnapshotRequests.set(requestId, {
        resolve,
        reject,
      });

      try {
        this.postOrQueue(envelope);
        this.flushPendingMessages();
      } catch (error) {
        this.pendingSnapshotRequests.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private postOrQueue(message: RuntimeWorkerInboundMessage): void {
    if (this.disposed) {
      throw new Error('WorkerBridge has been disposed');
    }

    if (
      !this.ready ||
      (!this.sessionReady && message.type !== 'RESTORE_SESSION')
    ) {
      this.pendingMessages.push(message);
      return;
    }

    this.worker.postMessage(message);
  }

  sendCommand<TPayload>(type: string, payload: TPayload): void {
    if (this.disposed) {
      throw new Error('WorkerBridge has been disposed');
    }

    if (typeof type !== 'string' || type.trim().length === 0) {
      throw new Error('Command type must be a non-empty string');
    }

    const envelope: RuntimeWorkerCommand<TPayload> = {
      type: 'COMMAND',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      requestId: `command:${this.nextRequestId++}`,
      source: CommandSource.PLAYER,
      command: {
        type,
        payload,
        issuedAt: performance.now(),
      },
    };
    this.postOrQueue(envelope);
  }

  sendSocialCommand<TCommand extends SocialCommandType>(
    kind: TCommand,
    payload: SocialCommandPayloads[TCommand],
  ): Promise<SocialCommandResults[TCommand]> {
    if (this.disposed) {
      return Promise.reject(
        new Error('WorkerBridge has been disposed'),
      );
    }

    if (!this.socialEnabled) {
      return Promise.reject(
        new Error('Social commands are disabled in this shell'),
      );
    }

    if (!isSupportedSocialCommandKind(kind)) {
      return Promise.reject(
        new Error(`Unsupported social command kind: ${String(kind)}`),
      );
    }

    const requestId = `social:${this.nextRequestId++}`;
    const envelope: RuntimeWorkerSocialCommand<TCommand> = {
      type: 'SOCIAL_COMMAND',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      requestId,
      command: {
        kind,
        payload,
      },
    };

    return new Promise<SocialCommandResults[TCommand]>((resolve, reject) => {
      this.pendingSocialRequests.set(requestId, {
        kind,
        resolve: resolve as (
          value: SocialCommandResults[SocialCommandType],
        ) => void,
        reject,
      });
      try {
        this.postOrQueue(envelope);
        this.flushPendingMessages();
      } catch (error) {
        this.pendingSocialRequests.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  onStateUpdate(callback: (state: TState) => void): void {
    this.stateUpdateCallbacks.push(callback);
  }

  offStateUpdate(callback: (state: TState) => void): void {
    const index = this.stateUpdateCallbacks.indexOf(callback);
    if (index !== -1) {
      this.stateUpdateCallbacks.splice(index, 1);
    }
  }

  enableDiagnostics(): void {
    if (this.disposed) {
      throw new Error('WorkerBridge has been disposed');
    }

    const envelope: RuntimeWorkerDiagnosticsSubscribe = {
      type: 'DIAGNOSTICS_SUBSCRIBE',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
    };
    this.postOrQueue(envelope);
  }

  disableDiagnostics(): void {
    if (this.disposed) {
      throw new Error('WorkerBridge has been disposed');
    }

    const envelope: RuntimeWorkerDiagnosticsUnsubscribe = {
      type: 'DIAGNOSTICS_UNSUBSCRIBE',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
    };
    this.postOrQueue(envelope);
  }

  onDiagnosticsUpdate(
    callback: (diagnostics: DiagnosticTimelineResult) => void,
  ): void {
    this.diagnosticsUpdateCallbacks.push(callback);
  }

  offDiagnosticsUpdate(
    callback: (diagnostics: DiagnosticTimelineResult) => void,
  ): void {
    const index = this.diagnosticsUpdateCallbacks.indexOf(callback);
    if (index !== -1) {
      this.diagnosticsUpdateCallbacks.splice(index, 1);
    }
  }

  onError(callback: (error: RuntimeWorkerErrorDetails) => void): void {
    this.errorCallbacks.add(callback);
  }

  offError(callback: (error: RuntimeWorkerErrorDetails) => void): void {
    this.errorCallbacks.delete(callback);
  }

  isSocialFeatureEnabled(): boolean {
    return this.socialEnabled;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    // eslint-disable-next-line no-console
    console.debug('[WorkerBridge] Disposing worker bridge');
    this.worker.removeEventListener('message', this.handleMessage);
    const terminate: RuntimeWorkerInboundMessage = {
      type: 'TERMINATE',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
    };
    try {
      this.worker.postMessage(terminate);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('[WorkerBridge] Failed to post terminate message', error);
    }
    this.worker.terminate();
    this.pendingMessages.length = 0;
    this.stateUpdateCallbacks.length = 0;
    this.diagnosticsUpdateCallbacks.length = 0;
    this.errorCallbacks.clear();
    for (const [requestId, pending] of this.pendingSocialRequests) {
      pending.reject(
        new Error(
          'WorkerBridge has been disposed before the social command completed',
        ),
      );
      this.pendingSocialRequests.delete(requestId);
    }
    this.pendingSocialRequests.clear();
    for (const [requestId, pending] of this.pendingSnapshotRequests) {
      pending.reject(
        new Error(
          'WorkerBridge has been disposed before the snapshot request completed',
        ),
      );
      this.pendingSnapshotRequests.delete(requestId);
    }
    this.pendingSnapshotRequests.clear();
    if (this.restoreDeferred) {
      const deferred = this.restoreDeferred;
      this.restoreDeferred = null;
      deferred.reject(new Error('WorkerBridge has been disposed'));
    }
    const bridgeGlobal = globalThis as WorkerBridgeDebugGlobal;
    if (bridgeGlobal.__IDLE_WORKER_BRIDGE__ === this) {
      bridgeGlobal.__IDLE_WORKER_BRIDGE__ = undefined;
    }
    this.sessionReady = true;
  }
}

export type RuntimeEventSnapshot = WorkerRuntimeEventSnapshot;

export type RuntimeStateSnapshot = RuntimeStatePayload;

export type WorkerBridgeErrorDetails = RuntimeWorkerErrorDetails;

export { CommandSource };
export {
  SOCIAL_COMMAND_TYPES,
  type SocialCommandType,
  type SocialCommandPayloads,
  type SocialCommandResults,
};
export type { WorkerBridgeWorker } from './worker-bridge-worker.js';
export {
  registerWorkerBridgeDebugHandle as registerWorkerBridgeDebugHandleForTesting,
  shouldExposeWorkerBridgeDebugHandle as shouldExposeWorkerBridgeDebugHandleForTesting,
};

let sharedWorkerBridge: WorkerBridgeImpl<unknown> | null = null;

export function useWorkerBridge<TState = RuntimeStateSnapshot>(): WorkerBridgeImpl<TState> {
  const bridgeRef = useRef<WorkerBridgeImpl<TState> | null>(null);

  if (!bridgeRef.current) {
    if (!sharedWorkerBridge) {
      // Feature flag keeps the worker bridge opt-in during rollout (docs/runtime-react-worker-bridge-design.md §12).
      const workerBridgeEnabled = isWorkerBridgeEnabled();
      const worker: WorkerBridgeWorker = workerBridgeEnabled
        ? (new Worker(
            new URL('../runtime.worker.ts', import.meta.url),
            { type: 'module' },
          ) as unknown as WorkerBridgeWorker)
        : createInlineRuntimeWorker();

      // eslint-disable-next-line no-console
      console.debug(
        '[WorkerBridge] Initialising',
        workerBridgeEnabled
          ? 'dedicated runtime worker'
          : 'inline runtime worker',
      );

      sharedWorkerBridge = new WorkerBridgeImpl(worker);
      registerWorkerBridgeDebugHandle(
        globalThis as WorkerBridgeDebugGlobal,
        sharedWorkerBridge,
      );
    }

    bridgeRef.current = sharedWorkerBridge as WorkerBridgeImpl<TState>;
  }

  const bridge = bridgeRef.current;

  useEffect(() => {
    return () => {
      bridgeRef.current = null;
    };
  }, [bridge]);

  if (!bridge) {
    throw new Error('Worker bridge failed to initialize');
  }
  return bridge;
}
