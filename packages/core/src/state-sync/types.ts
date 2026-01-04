import type { SerializedAutomationState } from '../automation-system.js';
import type { SerializedCommandQueueV1 } from '../command-queue.js';
import type { SerializedEntitySystemState } from '../entity-system.js';
import type { SerializedProgressionCoordinatorStateV2 } from '../progression-coordinator-save.js';
import type { SerializedResourceState } from '../resource-state.js';
import type { SerializedPRDRegistryState } from '../rng.js';
import type { SerializedTransformState } from '../transform-system.js';

/**
 * Unified snapshot payload for state synchronization workflows.
 */
export interface GameStateSnapshot {
  /** Schema version for forward compatibility. */
  readonly version: 1;

  /** Capture timestamp (wall clock, for diagnostics only; excluded from checksums). */
  readonly capturedAt: number;

  /** Runtime metadata. */
  readonly runtime: {
    /** Current deterministic step. */
    readonly step: number;

    /** Step duration in milliseconds. */
    readonly stepSizeMs: number;

    /** Original RNG seed captured from runtime, not the current RNG position. */
    readonly rngSeed: number | undefined;

    /** RNG state for restore-and-continue workflows. */
    readonly rngState?: number;
  };

  /** Serialized resource state. */
  readonly resources: SerializedResourceState;

  /** Serialized progression coordinator state. */
  readonly progression: SerializedProgressionCoordinatorStateV2;

  /** Serialized automation states. */
  readonly automation: readonly SerializedAutomationState[];

  /** Serialized transform states. */
  readonly transforms: readonly SerializedTransformState[];

  /** Serialized entity system state. */
  readonly entities: SerializedEntitySystemState;

  /** Serialized PRD registry state. */
  readonly prd?: SerializedPRDRegistryState;

  /** Serialized command queue. */
  readonly commandQueue: SerializedCommandQueueV1;
}
