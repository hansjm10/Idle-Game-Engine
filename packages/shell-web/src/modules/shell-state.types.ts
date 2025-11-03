import type {
  BackPressureSnapshot,
  DiagnosticTimelineResult,
  ProgressionSnapshot,
  ResourceView,
  GeneratorView,
  UpgradeView,
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

/**
 * Pending progression state changes awaiting authoritative worker snapshot.
 * Used for optimistic UI staging before confirmation from the runtime.
 *
 * Infrastructure for optimistic updates during generator/upgrade purchases.
 * Will be populated when purchase commands are dispatched in #299.
 */
export interface ShellProgressionPendingDelta {
  readonly resourceId: string;
  readonly delta: number;
  readonly stagedAt: number;
}

/**
 * Progression-related runtime state.
 * Includes the latest progression snapshot from the worker and
 * optimistic staging for pending purchase deltas.
 *
 * The pendingDeltas array supports optimistic UI updates and will be
 * populated by generator/upgrade purchase flows implemented in #299.
 */
export interface ShellProgressionState {
  readonly snapshot: ProgressionSnapshot | null;
  readonly pendingDeltas: readonly ShellProgressionPendingDelta[];
  readonly schemaVersion: number;
  /** Expected schema version when mismatch occurs (for better error messaging). */
  readonly expectedSchemaVersion?: number;
  /** Received schema version when mismatch occurs (for better error messaging). */
  readonly receivedSchemaVersion?: number;
}

/**
 * Memoized selector for resources from progression state.
 * Returns null if progression is not available.
 */
export type ProgressionResourcesSelector = () => readonly ResourceView[] | null;

/**
 * Memoized selector for generators from progression state.
 * Returns null if progression is not available.
 */
export type ProgressionGeneratorsSelector = () => readonly GeneratorView[] | null;

/**
 * Memoized selector for upgrades from progression state.
 * Returns null if progression is not available.
 */
export type ProgressionUpgradesSelector = () => readonly UpgradeView[] | null;

/**
 * Memoized selector for optimistically updated resources.
 * Applies pending deltas to current snapshot resources.
 *
 * Enables optimistic UI updates during generator/upgrade purchases.
 * Will be fully utilized when purchase commands are wired in #299.
 */
export type ProgressionOptimisticResourcesSelector = () => readonly ResourceView[] | null;

export interface ShellRuntimeState {
  readonly currentStep: number;
  readonly events: readonly RuntimeEventSnapshot[];
  readonly backPressure: BackPressureSnapshot | null;
  readonly lastSnapshot?: RuntimeStateSnapshot;
  readonly progression: ShellProgressionState;
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

/**
 * Progression state API for consuming progression data and selectors.
 */
export interface ShellProgressionApi {
  /** Check if progression UI is enabled via feature flag. */
  readonly isEnabled: boolean;
  /** Get the current progression schema version (negative indicates mismatch). */
  readonly schemaVersion: number;
  /** Expected schema version when mismatch occurs (for displaying actionable error messages). */
  readonly expectedSchemaVersion?: number;
  /** Received schema version when mismatch occurs (for displaying actionable error messages). */
  readonly receivedSchemaVersion?: number;
  /** Get memoized selector for resources. */
  readonly selectResources: ProgressionResourcesSelector;
  /** Get memoized selector for generators. */
  readonly selectGenerators: ProgressionGeneratorsSelector;
  /** Get memoized selector for upgrades. */
  readonly selectUpgrades: ProgressionUpgradesSelector;
  /** Get memoized selector for optimistically updated resources with pending deltas applied. */
  readonly selectOptimisticResources: ProgressionOptimisticResourcesSelector;
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
