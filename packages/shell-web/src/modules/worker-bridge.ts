import { useEffect, useRef } from 'react';

import type { DiagnosticTimelineResult } from '@idle-engine/core';

import {
  CommandSource,
  WORKER_MESSAGE_SCHEMA_VERSION,
  type RuntimeEventSnapshot as WorkerRuntimeEventSnapshot,
  type RuntimeStatePayload,
  type RuntimeWorkerCommand,
  type RuntimeWorkerDiagnosticsSubscribe,
  type RuntimeWorkerErrorDetails,
  type RuntimeWorkerInboundMessage,
  type RuntimeWorkerOutboundMessage,
} from './runtime-worker-protocol.js';

export interface WorkerBridge<TState = unknown> {
  awaitReady(): Promise<void>;
  sendCommand<TPayload = unknown>(type: string, payload: TPayload): void;
  onStateUpdate(callback: (state: TState) => void): void;
  offStateUpdate(callback: (state: TState) => void): void;
  enableDiagnostics(): void;
  onDiagnosticsUpdate(
    callback: (diagnostics: DiagnosticTimelineResult) => void,
  ): void;
  offDiagnosticsUpdate(
    callback: (diagnostics: DiagnosticTimelineResult) => void,
  ): void;
  onError(callback: (error: RuntimeWorkerErrorDetails) => void): void;
  offError(callback: (error: RuntimeWorkerErrorDetails) => void): void;
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
  private readonly readyPromise: Promise<void>;
  private resolveReady: (() => void) | null = null;
  private disposed = false;
  private ready = false;
  private nextRequestId = 0;

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

    if (envelope.type === 'ERROR') {
      this.emitError(envelope.error);
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
    for (const message of this.pendingMessages) {
      this.worker.postMessage(message);
    }
    this.pendingMessages.length = 0;
  }

  private emitError(error: RuntimeWorkerErrorDetails): void {
    console.error('[WorkerBridge] Worker error received', error);
    for (const callback of this.errorCallbacks) {
      callback(error);
    }
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

  private postOrQueue(message: RuntimeWorkerInboundMessage): void {
    if (this.disposed) {
      throw new Error('WorkerBridge has been disposed');
    }

    if (!this.ready) {
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
  }
}

export type RuntimeEventSnapshot = WorkerRuntimeEventSnapshot;

export type RuntimeStateSnapshot = RuntimeStatePayload;

export type WorkerBridgeErrorDetails = RuntimeWorkerErrorDetails;

export { CommandSource };

export function useWorkerBridge<TState = RuntimeStateSnapshot>(): WorkerBridgeImpl<TState> {
  const bridgeRef = useRef<WorkerBridgeImpl<TState>>();

  if (!bridgeRef.current) {
    const worker = new Worker(
      new URL('../runtime.worker.ts', import.meta.url),
      { type: 'module' },
    );
    bridgeRef.current = new WorkerBridgeImpl<TState>(worker);
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
