import type {
  BackPressureSnapshot,
  DiagnosticTimelineResult,
  SerializedResourceState,
  ProgressionSnapshot,
  ResourceDefinitionDigest,
} from '@idle-engine/core';

export const WORKER_MESSAGE_SCHEMA_VERSION = 3;

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
  readonly progression: ProgressionSnapshot;
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

export const SOCIAL_COMMAND_TYPES = Object.freeze({
  FETCH_LEADERBOARD: 'fetchLeaderboard',
  SUBMIT_LEADERBOARD_SCORE: 'submitLeaderboardScore',
  FETCH_GUILD_PROFILE: 'fetchGuildProfile',
  CREATE_GUILD: 'createGuild',
} as const);

export type SocialCommandType =
  (typeof SOCIAL_COMMAND_TYPES)[keyof typeof SOCIAL_COMMAND_TYPES];

export interface FetchLeaderboardPayload {
  readonly leaderboardId: string;
  readonly accessToken: string;
}

export interface SubmitLeaderboardScorePayload {
  readonly leaderboardId: string;
  readonly score: number;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly accessToken: string;
}

export interface FetchGuildProfilePayload {
  readonly accessToken: string;
}

export interface CreateGuildPayload {
  readonly name: string;
  readonly description?: string;
  readonly accessToken: string;
}

export interface SocialCommandPayloads {
  readonly fetchLeaderboard: FetchLeaderboardPayload;
  readonly submitLeaderboardScore: SubmitLeaderboardScorePayload;
  readonly fetchGuildProfile: FetchGuildProfilePayload;
  readonly createGuild: CreateGuildPayload;
}

export interface LeaderboardEntry {
  readonly userId: string;
  readonly username: string;
  readonly score: number;
  readonly rank: number;
}

export interface FetchLeaderboardResult {
  readonly leaderboardId: string;
  readonly entries: readonly LeaderboardEntry[];
}

export interface SubmitLeaderboardScoreResult {
  readonly status: string;
  readonly leaderboardId: string;
  readonly score: number;
  readonly userId: string;
}

export interface FetchGuildProfileResult {
  readonly userId: string;
  readonly guild: unknown;
}

export interface CreateGuildResult {
  readonly status: string;
  readonly guildId: string;
  readonly ownerId: string;
}

export interface SocialCommandResults {
  readonly fetchLeaderboard: FetchLeaderboardResult;
  readonly submitLeaderboardScore: SubmitLeaderboardScoreResult;
  readonly fetchGuildProfile: FetchGuildProfileResult;
  readonly createGuild: CreateGuildResult;
}

export interface RuntimeWorkerSocialCommand<
  TCommand extends SocialCommandType = SocialCommandType,
> {
  readonly type: 'SOCIAL_COMMAND';
  readonly schemaVersion: number;
  readonly requestId: string;
  readonly command: {
    readonly kind: TCommand;
    readonly payload: SocialCommandPayloads[TCommand];
  };
}

export interface RuntimeWorkerSocialCommandSuccess<
  TCommand extends SocialCommandType = SocialCommandType,
> {
  readonly type: 'SOCIAL_COMMAND_RESULT';
  readonly schemaVersion: number;
  readonly requestId: string;
  readonly status: 'success';
  readonly kind: TCommand;
  readonly data: SocialCommandResults[TCommand];
}

export interface RuntimeWorkerSocialCommandFailure {
  readonly type: 'SOCIAL_COMMAND_RESULT';
  readonly schemaVersion: number;
  readonly requestId: string;
  readonly status: 'error';
  readonly kind?: SocialCommandType;
  readonly error: {
    readonly code:
      | 'SOCIAL_COMMANDS_DISABLED'
      | 'INVALID_SOCIAL_COMMAND_PAYLOAD'
      | 'SOCIAL_COMMAND_UNSUPPORTED'
      | 'SOCIAL_COMMAND_FAILED';
    readonly message: string;
    readonly details?: Record<string, unknown>;
  };
}

export type RuntimeWorkerSocialCommandResult<
  TCommand extends SocialCommandType = SocialCommandType,
> =
  | RuntimeWorkerSocialCommandSuccess<TCommand>
  | RuntimeWorkerSocialCommandFailure;

export interface RuntimeWorkerTerminate {
  readonly type: 'TERMINATE';
  readonly schemaVersion: number;
}

export interface RuntimeWorkerDiagnosticsSubscribe {
  readonly type: 'DIAGNOSTICS_SUBSCRIBE';
  readonly schemaVersion: number;
}

export interface RuntimeWorkerDiagnosticsUnsubscribe {
  readonly type: 'DIAGNOSTICS_UNSUBSCRIBE';
  readonly schemaVersion: number;
}

export interface RuntimeWorkerRestoreSession {
  readonly type: 'RESTORE_SESSION';
  readonly schemaVersion: number;
  readonly state?: SerializedResourceState;
  readonly elapsedMs?: number;
  readonly resourceDeltas?: Readonly<Record<string, number>>;
  /**
   * Optional: worker step when the snapshot was captured.
   * When provided, the worker rebases any absolute step fields (e.g., automation
   * cooldowns) into the new timeline to avoid artificially long cooldowns after
   * restore.
   */
  readonly savedWorkerStep?: number;
}

export interface RuntimeWorkerRequestSessionSnapshot {
  readonly type: 'REQUEST_SESSION_SNAPSHOT';
  readonly schemaVersion: number;
  readonly requestId?: string;
  readonly reason?: string;
}

export type RuntimeWorkerInboundMessage<TPayload = unknown> =
  | RuntimeWorkerCommand<TPayload>
  | RuntimeWorkerTerminate
  | RuntimeWorkerDiagnosticsSubscribe
  | RuntimeWorkerDiagnosticsUnsubscribe
  | RuntimeWorkerRestoreSession
  | RuntimeWorkerRequestSessionSnapshot
  | RuntimeWorkerSocialCommand;

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
    | 'UNSUPPORTED_MESSAGE'
    | 'RESTORE_FAILED'
    | 'SNAPSHOT_FAILED';
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

export interface RuntimeWorkerSessionRestored {
  readonly type: 'SESSION_RESTORED';
  readonly schemaVersion: number;
}

export interface RuntimeWorkerSessionSnapshot {
  readonly type: 'SESSION_SNAPSHOT';
  readonly schemaVersion: number;
  readonly requestId?: string;
  readonly snapshot: {
    readonly persistenceSchemaVersion: number;
    readonly slotId: string;
    readonly capturedAt: string;
    readonly workerStep: number;
    readonly monotonicMs: number;
    readonly state: SerializedResourceState;
    readonly runtimeVersion: string;
    readonly contentDigest: ResourceDefinitionDigest;
    readonly flags?: {
      readonly pendingMigration?: boolean;
      readonly abortedRestore?: boolean;
    };
  };
}

export type RuntimeWorkerOutboundMessage<TState = RuntimeStatePayload> =
  | RuntimeWorkerReady
  | RuntimeWorkerError
  | RuntimeWorkerStateUpdate<TState>
  | RuntimeWorkerDiagnosticsUpdate
  | RuntimeWorkerSessionRestored
  | RuntimeWorkerSessionSnapshot
  | RuntimeWorkerSocialCommandResult;

