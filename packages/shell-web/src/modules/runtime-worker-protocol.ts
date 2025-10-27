import type {
  BackPressureSnapshot,
  DiagnosticTimelineResult,
} from '@idle-engine/core';

export const WORKER_MESSAGE_SCHEMA_VERSION = 1;

export enum CommandSource {
  PLAYER = 'PLAYER',
  AUTOMATION = 'AUTOMATION',
  SYSTEM = 'SYSTEM',
}

export interface RuntimeEventSnapshot {
  readonly channel: number;
  readonly type: string;
  readonly tick: number;
  readonly issuedAt: number;
  readonly dispatchOrder: number;
  readonly payload: unknown;
}

export interface RuntimeStatePayload {
  readonly currentStep: number;
  readonly events: readonly RuntimeEventSnapshot[];
  readonly backPressure: BackPressureSnapshot;
}

export interface RuntimeWorkerCommand<TPayload = unknown> {
  readonly type: 'COMMAND';
  readonly schemaVersion: number;
  readonly requestId?: string;
  readonly source: CommandSource;
  readonly command: {
    readonly type: string;
    readonly payload: TPayload;
    readonly issuedAt: number;
  };
}

export interface RuntimeWorkerTerminate {
  readonly type: 'TERMINATE';
  readonly schemaVersion: number;
}

export interface RuntimeWorkerDiagnosticsSubscribe {
  readonly type: 'DIAGNOSTICS_SUBSCRIBE';
  readonly schemaVersion: number;
}

export type RuntimeWorkerInboundMessage<TPayload = unknown> =
  | RuntimeWorkerCommand<TPayload>
  | RuntimeWorkerTerminate
  | RuntimeWorkerDiagnosticsSubscribe;

export interface RuntimeWorkerReady {
  readonly type: 'READY';
  readonly schemaVersion: number;
  readonly handshakeId?: string;
}

export interface RuntimeWorkerErrorDetails {
  readonly code:
    | 'SCHEMA_VERSION_MISMATCH'
    | 'INVALID_COMMAND_PAYLOAD'
    | 'STALE_COMMAND'
    | 'UNSUPPORTED_MESSAGE';
  readonly message: string;
  readonly requestId?: string;
  readonly details?: Record<string, unknown>;
}

export interface RuntimeWorkerError {
  readonly type: 'ERROR';
  readonly schemaVersion: number;
  readonly error: RuntimeWorkerErrorDetails;
}

export interface RuntimeWorkerStateUpdate<TState = RuntimeStatePayload> {
  readonly type: 'STATE_UPDATE';
  readonly schemaVersion: number;
  readonly state: TState;
}

export interface RuntimeWorkerDiagnosticsUpdate {
  readonly type: 'DIAGNOSTICS_UPDATE';
  readonly schemaVersion: number;
  readonly diagnostics: DiagnosticTimelineResult;
}

export type RuntimeWorkerOutboundMessage<TState = RuntimeStatePayload> =
  | RuntimeWorkerReady
  | RuntimeWorkerError
  | RuntimeWorkerStateUpdate<TState>
  | RuntimeWorkerDiagnosticsUpdate;
