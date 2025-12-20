import type { SerializedAutomationState } from '../automation-system.js';
import type { SerializedCommandQueueV1 } from '../command-queue.js';
import type { SerializedProgressionCoordinatorStateV2 } from '../progression-coordinator-save.js';
import type { SerializedResourceState } from '../resource-state.js';
import type { SerializedTransformState } from '../transform-system.js';

/**
 * Unified snapshot payload for state synchronization workflows.
 */
export interface GameStateSnapshot {
  /** Schema version for forward compatibility. */
  readonly version: 1;

  /** Capture timestamp (wall clock, for diagnostics only). */
  readonly capturedAt: number;

  /** Runtime metadata. */
  readonly runtime: {
    /** Current deterministic step. */
    readonly step: number;

    /** Step duration in milliseconds. */
    readonly stepSizeMs: number;

    /** RNG seed captured from runtime, if any. */
    readonly rngSeed: number | undefined;
  };

  /** Serialized resource state. */
  readonly resources: SerializedResourceState;

  /** Serialized progression coordinator state. */
  readonly progression: SerializedProgressionCoordinatorStateV2;

  /** Serialized automation states. */
  readonly automation: readonly SerializedAutomationState[];

  /** Serialized transform states. */
  readonly transforms: readonly SerializedTransformState[];

  /** Serialized command queue. */
  readonly commandQueue: SerializedCommandQueueV1;
}
