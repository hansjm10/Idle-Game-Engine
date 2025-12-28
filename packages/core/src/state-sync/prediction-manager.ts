import type { Command } from '../command.js';
import type { GameStateSnapshot } from './types.js';

export interface PredictionManager {
  recordLocalCommand(command: Command, atStep?: number): void;
  recordPredictedStep(step?: number): void;
  applyServerState(snapshot: GameStateSnapshot, confirmedStep: number): RollbackResult;
  getPendingCommands(): readonly Command[];
  getPredictionWindow(): PredictionWindow;
}

export type PredictionWindow = Readonly<{
  readonly maxPredictionSteps: number;
  readonly maxPendingCommands: number;
  readonly checksumIntervalSteps: number;
  readonly snapshotHistorySteps: number;
  readonly maxReplayStepsPerTick: number;
}>;

export type RollbackResult = Readonly<{
  readonly status: 'confirmed' | 'rolled-back' | 'resynced' | 'ignored';
  readonly confirmedStep: number;
  readonly localStep: number;
  readonly replayedSteps: number;
  readonly pendingCommands: number;
  readonly checksumMatch?: boolean;
  readonly reason?:
    | 'checksum-match'
    | 'checksum-mismatch'
    | 'stale-snapshot'
    | 'prediction-window-exceeded';
}>;
