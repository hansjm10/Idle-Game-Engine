import { useEffect, useRef } from 'react';

import type {
  DiagnosticTimelineResult,
  SerializedResourceState,
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
  type RuntimeWorkerRestoreSession,
  type RuntimeWorkerSocialCommand,
  type RuntimeWorkerSocialCommandResult,
  type SocialCommandPayloads,
  type SocialCommandResults,
  type SocialCommandType,
  type RuntimeWorkerSocialCommandFailure,
  SOCIAL_COMMAND_TYPES,
} from './runtime-worker-protocol.js';
import { isSocialCommandsEnabled } from './social-config.js';

export interface WorkerRestoreSessionPayload {
  readonly state?: SerializedResourceState;
  readonly elapsedMs?: number;
  readonly resourceDeltas?: Readonly<Record<string, number>>;
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

const SUPPORTED_SOCIAL_COMMAND_KINDS = new Set<SocialCommandType>([
  SOCIAL_COMMAND_TYPES.FETCH_LEADERBOARD,
  SOCIAL_COMMAND_TYPES.SUBMIT_LEADERBOARD_SCORE,
  SOCIAL_COMMAND_TYPES.FETCH_GUILD_PROFILE,
  SOCIAL_COMMAND_TYPES.CREATE_GUILD,
]);

function isSupportedSocialCommandKind(
  value: unknown,
): value is SocialCommandType {
  return typeof value === 'string' && SUPPORTED_SOCIAL_COMMAND_KINDS.has(value as SocialCommandType);
}

export interface WorkerBridge<TState = unknown> {
  awaitReady(): Promise<void>;
  restoreSession(
    payload?: WorkerRestoreSessionPayload,
  ): Promise<void>;
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

export class WorkerBridgeImpl<TState = unknown>
  implements WorkerBridge<TState>
{
  private readonly worker: Worker;
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

  private readonly handleMessage = (
    event: MessageEvent<RuntimeWorkerOutboundMessage<TState>>,
  ) => {
    const envelope = event.data as RuntimeWorkerOutboundMessage<TState> | null;
    if (!envelope || typeof envelope !== 'object') {
      return;
    }

    if (envelope.schemaVersion !== WORKER_MESSAGE_SCHEMA_VERSION) {
      console.error('[WorkerBridge] Ignoring message with unknown schema', {
        expected: WORKER_MESSAGE_SCHEMA_VERSION,
        received: envelope.schemaVersion,
        type: envelope.type,
      });
      return;
    }

    if (envelope.type === 'READY') {
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
      if (envelope.error.requestId) {
        const bridgeError: WorkerBridgeSocialCommandError = Object.assign(
          new Error(envelope.error.message),
          {
            name: 'WorkerBridgeSocialCommandError',
            code: envelope.error.code,
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

    if (envelope.type === 'DIAGNOSTICS_UPDATE') {
      for (const callback of this.diagnosticsUpdateCallbacks) {
        callback(envelope.diagnostics);
      }
      return;
    }

    if (envelope.type === 'STATE_UPDATE') {
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

  constructor(worker: Worker) {
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
      ...(payload.elapsedMs !== undefined && {
        elapsedMs: payload.elapsedMs,
      }),
      ...(payload.resourceDeltas !== undefined && {
        resourceDeltas: payload.resourceDeltas,
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
    this.worker.removeEventListener('message', this.handleMessage);
    const terminate: RuntimeWorkerInboundMessage = {
      type: 'TERMINATE',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
    };
    try {
      this.worker.postMessage(terminate);
    } catch (error) {
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
    if (this.restoreDeferred) {
      const deferred = this.restoreDeferred;
      this.restoreDeferred = null;
      deferred.reject(new Error('WorkerBridge has been disposed'));
    }
    const bridgeGlobal = globalThis as typeof globalThis & {
      __IDLE_WORKER_BRIDGE__?: WorkerBridge<unknown>;
    };
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

export function useWorkerBridge<TState = RuntimeStateSnapshot>(): WorkerBridgeImpl<TState> {
  const bridgeRef = useRef<WorkerBridgeImpl<TState>>();

  if (!bridgeRef.current) {
    const worker = new Worker(
      new URL('../runtime.worker.ts', import.meta.url),
      { type: 'module' },
    );
    bridgeRef.current = new WorkerBridgeImpl<TState>(worker);
    const bridgeGlobal = globalThis as typeof globalThis & {
      __IDLE_WORKER_BRIDGE__?: WorkerBridge<unknown>;
    };
    bridgeGlobal.__IDLE_WORKER_BRIDGE__ = bridgeRef.current;
  }

  const bridge = bridgeRef.current;

  useEffect(() => {
    return () => {
      bridge?.dispose();
      bridgeRef.current = undefined;
    };
  }, [bridge]);

  return bridge!;
}
