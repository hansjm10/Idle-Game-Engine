import { useEffect, useRef } from 'react';

export enum CommandSource {
  PLAYER = 'PLAYER',
  AUTOMATION = 'AUTOMATION',
  SYSTEM = 'SYSTEM',
}

export interface WorkerBridge<TState = unknown> {
  sendCommand<TPayload = unknown>(type: string, payload: TPayload): void;
  onStateUpdate(callback: (state: TState) => void): void;
  offStateUpdate(callback: (state: TState) => void): void;
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

type OutboundEnvelope<TPayload> = CommandEnvelope<TPayload> | TerminateEnvelope;
type InboundEnvelope<TState> = StateUpdateEnvelope<TState>;

export class WorkerBridgeImpl<TState = unknown>
  implements WorkerBridge<TState>
{
  private readonly worker: Worker;
  private readonly stateUpdateCallbacks: Array<(state: TState) => void> = [];
  private disposed = false;

  private readonly handleMessage = (event: MessageEvent<InboundEnvelope<TState>>) => {
    const { data } = event;
    if (!data) {
      return;
    }

    if (data.type === 'STATE_UPDATE') {
      for (const callback of this.stateUpdateCallbacks) {
        callback(data.state);
      }
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
  }
}

export interface RuntimeStateSnapshot {
  readonly currentStep: number;
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
