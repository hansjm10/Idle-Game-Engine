import { useEffect, useRef } from 'react';

import type {
  BackPressureSnapshot,
  DiagnosticTimelineResult,
  OfflineCatchUpResult,
} from '@idle-engine/core';

export enum CommandSource {
  PLAYER = 'PLAYER',
  AUTOMATION = 'AUTOMATION',
  SYSTEM = 'SYSTEM',
}

export interface WorkerBridge<TState = unknown> {
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
  setVisibilityState(visible: boolean): void;
  requestOfflineCatchUp(elapsedMs: number): void;
  onOfflineCatchUpResult(
    callback: (result: OfflineCatchUpSummary) => void,
  ): void;
  offOfflineCatchUpResult(
    callback: (result: OfflineCatchUpSummary) => void,
  ): void;
}

interface CommandEnvelope<TPayload> {
  readonly type: 'COMMAND';
  readonly source: CommandSource;
  readonly command: {
    readonly type: string;
    readonly payload: TPayload;
    readonly timestamp: number;
  };
}

interface TerminateEnvelope {
  readonly type: 'TERMINATE';
}

interface StateUpdateEnvelope<TState> {
  readonly type: 'STATE_UPDATE';
  readonly state: TState;
}

interface DiagnosticsSubscribeEnvelope {
  readonly type: 'DIAGNOSTICS_SUBSCRIBE';
}

interface DiagnosticsUpdateEnvelope {
  readonly type: 'DIAGNOSTICS_UPDATE';
  readonly diagnostics: DiagnosticTimelineResult;
}

interface VisibilityChangeEnvelope {
  readonly type: 'VISIBILITY_CHANGE';
  readonly visible: boolean;
}

interface OfflineCatchUpEnvelope {
  readonly type: 'OFFLINE_CATCH_UP';
  readonly elapsedMs: number;
}

interface OfflineCatchUpResultEnvelope {
  readonly type: 'OFFLINE_CATCH_UP_RESULT';
  readonly result: OfflineCatchUpResult & {
    readonly remainingMs: number;
  };
}

type OutboundEnvelope<TPayload> =
  | CommandEnvelope<TPayload>
  | TerminateEnvelope
  | DiagnosticsSubscribeEnvelope
  | VisibilityChangeEnvelope
  | OfflineCatchUpEnvelope;
type InboundEnvelope<TState> =
  | StateUpdateEnvelope<TState>
  | DiagnosticsUpdateEnvelope
  | OfflineCatchUpResultEnvelope;

export interface OfflineCatchUpSummary {
  readonly requestedMs: number;
  readonly simulatedMs: number;
  readonly executedSteps: number;
  readonly overflowMs: number;
  readonly backlogMs: number;
  readonly remainingMs: number;
}

export class WorkerBridgeImpl<TState = unknown>
  implements WorkerBridge<TState>
{
  private readonly worker: Worker;
  private readonly stateUpdateCallbacks: Array<(state: TState) => void> = [];
  private readonly diagnosticsUpdateCallbacks: Array<
    (diagnostics: DiagnosticTimelineResult) => void
  > = [];
  private readonly offlineCatchUpCallbacks: Array<
    (result: OfflineCatchUpSummary) => void
  > = [];
  private disposed = false;

  private readonly handleMessage = (event: MessageEvent<InboundEnvelope<TState>>) => {
    const { data } = event;
    if (!data) {
      return;
    }

    if (data.type === 'DIAGNOSTICS_UPDATE') {
      for (const callback of this.diagnosticsUpdateCallbacks) {
        callback(data.diagnostics);
      }
      return;
    }

    if (data.type === 'STATE_UPDATE') {
      for (const callback of this.stateUpdateCallbacks) {
        callback(data.state);
      }
      return;
    }

    if (data.type === 'OFFLINE_CATCH_UP_RESULT') {
      const summary: OfflineCatchUpSummary = {
        requestedMs: data.result.requestedMs,
        simulatedMs: data.result.simulatedMs,
        executedSteps: data.result.executedSteps,
        overflowMs: data.result.overflowMs,
        backlogMs: data.result.backlogMs,
        remainingMs: data.result.remainingMs,
      };
      for (const callback of this.offlineCatchUpCallbacks) {
        callback(summary);
      }
      return;
    }
  };

  constructor(worker: Worker) {
    this.worker = worker;
    this.worker.addEventListener('message', this.handleMessage);
  }

  sendCommand<TPayload>(type: string, payload: TPayload): void {
    if (this.disposed) {
      throw new Error('WorkerBridge has been disposed');
    }

    const envelope: CommandEnvelope<TPayload> = {
      type: 'COMMAND',
      source: CommandSource.PLAYER,
      command: {
        type,
        payload,
        timestamp: performance.now(),
      },
    };
    this.worker.postMessage(envelope as OutboundEnvelope<TPayload>);
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

    const envelope: DiagnosticsSubscribeEnvelope = {
      type: 'DIAGNOSTICS_SUBSCRIBE',
    };
    this.worker.postMessage(envelope as OutboundEnvelope<never>);
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

  setVisibilityState(visible: boolean): void {
    if (this.disposed) {
      throw new Error('WorkerBridge has been disposed');
    }

    const envelope: VisibilityChangeEnvelope = {
      type: 'VISIBILITY_CHANGE',
      visible,
    };
    this.worker.postMessage(envelope as OutboundEnvelope<never>);
  }

  requestOfflineCatchUp(elapsedMs: number): void {
    if (this.disposed) {
      throw new Error('WorkerBridge has been disposed');
    }

    const envelope: OfflineCatchUpEnvelope = {
      type: 'OFFLINE_CATCH_UP',
      elapsedMs,
    };
    this.worker.postMessage(envelope as OutboundEnvelope<never>);
  }

  onOfflineCatchUpResult(
    callback: (result: OfflineCatchUpSummary) => void,
  ): void {
    this.offlineCatchUpCallbacks.push(callback);
  }

  offOfflineCatchUpResult(
    callback: (result: OfflineCatchUpSummary) => void,
  ): void {
    const index = this.offlineCatchUpCallbacks.indexOf(callback);
    if (index !== -1) {
      this.offlineCatchUpCallbacks.splice(index, 1);
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.worker.removeEventListener('message', this.handleMessage);
    const envelope: TerminateEnvelope = { type: 'TERMINATE' };
    this.worker.postMessage(envelope as OutboundEnvelope<never>);
    this.worker.terminate();
    this.stateUpdateCallbacks.length = 0;
    this.diagnosticsUpdateCallbacks.length = 0;
    this.offlineCatchUpCallbacks.length = 0;
  }
}

export interface RuntimeEventSnapshot {
  readonly channel: number;
  readonly type: string;
  readonly tick: number;
  readonly issuedAt: number;
  readonly dispatchOrder: number;
  readonly payload: unknown;
}

export interface RuntimeStateSnapshot {
  readonly currentStep: number;
  readonly events: readonly RuntimeEventSnapshot[];
  readonly backPressure: BackPressureSnapshot;
}

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
