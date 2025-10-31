import type {
  BackPressureSnapshot,
  DiagnosticTimelineResult,
} from '@idle-engine/core';

import type {
  RuntimeEventSnapshot,
  RuntimeStateSnapshot,
  SocialCommandPayloads,
  SocialCommandResults,
  SocialCommandType,
  WorkerBridgeErrorDetails,
  WorkerRestoreSessionPayload,
} from './worker-bridge.js';

export interface ShellRuntimeState {
  readonly currentStep: number;
  readonly events: readonly RuntimeEventSnapshot[];
  readonly backPressure: BackPressureSnapshot | null;
  readonly lastSnapshot?: RuntimeStateSnapshot;
}

export interface ShellBridgeErrorEntry {
  readonly error: WorkerBridgeErrorDetails;
  readonly occurredAt: number;
}

export interface ShellBridgeState {
  readonly isReady: boolean;
  readonly isRestoring: boolean;
  readonly lastUpdateAt: number | null;
  readonly errors: readonly ShellBridgeErrorEntry[];
}

export interface ShellSocialRequestState {
  readonly kind: SocialCommandType;
  readonly issuedAt: number;
}

export interface ShellSocialFailure {
  readonly requestId: string;
  readonly kind: SocialCommandType;
  readonly occurredAt: number;
  readonly message: string;
}

export interface ShellSocialState {
  readonly pendingRequests: ReadonlyMap<string, ShellSocialRequestState>;
  readonly lastFailure: ShellSocialFailure | null;
}

export interface ShellDiagnosticsState {
  readonly timeline: DiagnosticTimelineResult | null;
  readonly lastUpdateAt: number | null;
  readonly subscriberCount: number;
}

export interface ShellState {
  readonly runtime: ShellRuntimeState;
  readonly bridge: ShellBridgeState;
  readonly social: ShellSocialState;
  readonly diagnostics: ShellDiagnosticsState;
}

export interface ShellStateProviderConfig {
  readonly maxEventHistory?: number;
  readonly maxErrorHistory?: number;
}

export interface ShellBridgeApi {
  awaitReady(): Promise<void>;
  sendCommand<TPayload>(type: string, payload: TPayload): void;
  sendSocialCommand<TCommand extends SocialCommandType>(
    kind: TCommand,
    payload: SocialCommandPayloads[TCommand],
  ): Promise<SocialCommandResults[TCommand]>;
  restoreSession(
    payload?: WorkerRestoreSessionPayload,
  ): Promise<void>;
  isSocialFeatureEnabled(): boolean;
}

export type DiagnosticsSubscriber = (
  timeline: DiagnosticTimelineResult,
) => void;

export interface ShellDiagnosticsApi {
  readonly latest: DiagnosticTimelineResult | null;
  readonly isEnabled: boolean;
  subscribe(subscriber: DiagnosticsSubscriber): () => void;
}
