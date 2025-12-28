/**
 * Prediction manager API types.
 * See docs/runtime-client-prediction-rollback-design-issue-546.md (Section 6.2).
 */
import type { Command } from '../command.js';
import type { GameStateSnapshot } from './types.js';

/**
 * Tracks client prediction state and reconciliation inputs.
 */
export interface PredictionManager {
  /**
   * Record a locally-issued command, optionally at a specific step.
   */
  recordLocalCommand(command: Command, atStep?: number): void;
  /**
   * Record a predicted step advance, optionally specifying the step.
   */
  recordPredictedStep(step?: number): void;
  /**
   * Apply an authoritative server snapshot and return reconciliation details.
   */
  applyServerState(snapshot: GameStateSnapshot, confirmedStep: number): RollbackResult;
  /**
   * Return commands still awaiting confirmation.
   */
  getPendingCommands(): readonly Command[];
  /**
   * Return the configured prediction window limits.
   */
  getPredictionWindow(): PredictionWindow;
}

/**
 * Configuration limits that bound prediction and rollback bookkeeping.
 */
export type PredictionWindow = Readonly<{
  /**
   * Maximum number of predicted steps to retain.
   */
  readonly maxPredictionSteps: number;
  /**
   * Maximum number of pending commands to retain.
   */
  readonly maxPendingCommands: number;
  /**
   * Number of steps between checksum calculations.
   */
  readonly checksumIntervalSteps: number;
  /**
   * Number of steps to keep in snapshot history.
   */
  readonly snapshotHistorySteps: number;
  /**
   * Maximum steps to replay per tick when reconciling.
   */
  readonly maxReplayStepsPerTick: number;
}>;

/**
 * Outcome details after applying server state reconciliation.
 */
export type RollbackResult = Readonly<{
  /**
   * Reconciliation outcome status.
   */
  readonly status: 'confirmed' | 'rolled-back' | 'resynced' | 'ignored';
  /**
   * Step confirmed by the server snapshot.
   */
  readonly confirmedStep: number;
  /**
   * Local step value after reconciliation.
   */
  readonly localStep: number;
  /**
   * Number of steps replayed to reconcile state.
   */
  readonly replayedSteps: number;
  /**
   * Count of commands still pending after reconciliation.
   */
  readonly pendingCommands: number;
  /**
   * Whether a checksum comparison matched, when available.
   */
  readonly checksumMatch?: boolean;
  /**
   * Optional reason describing the outcome.
   */
  readonly reason?:
    | 'checksum-match'
    | 'checksum-mismatch'
    | 'stale-snapshot'
    | 'prediction-window-exceeded';
}>;
