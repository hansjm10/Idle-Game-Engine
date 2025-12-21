import type { AutomationState } from '../automation-system.js';
import { serializeAutomationState } from '../automation-system.js';
import type { CommandQueue } from '../command-queue.js';
import type { IdleEngineRuntime } from '../index.js';
import type { SerializedProductionAccumulators } from '../production-system.js';
import type { ProgressionCoordinator } from '../progression-coordinator.js';
import { serializeProgressionCoordinatorState } from '../progression-coordinator-save.js';
import { getCurrentRNGSeed, getRNGState } from '../rng.js';
import type { TransformState } from '../transform-system.js';
import { serializeTransformState } from '../transform-system.js';
import type { GameStateSnapshot } from './types.js';

export interface CaptureSnapshotOptions {
  /** Runtime instance to capture. */
  readonly runtime: IdleEngineRuntime;
  /** Progression coordinator to capture. */
  readonly progressionCoordinator: ProgressionCoordinator;
  /** Optional timestamp override (wall clock, diagnostic only). */
  readonly capturedAt?: number;
  /** Automation system state extractor. */
  readonly getAutomationState: () => ReadonlyMap<string, AutomationState>;
  /** Transform system state extractor. */
  readonly getTransformState: () => ReadonlyMap<string, TransformState>;
  /** Command queue to capture. */
  readonly commandQueue: CommandQueue;
  /** Optional production system for accumulators. */
  readonly productionSystem?: {
    exportAccumulators: () => SerializedProductionAccumulators;
  };
}

/**
 * Capture a unified snapshot of runtime state for synchronization or persistence.
 *
 * The snapshot bundles runtime metadata (including RNG seed/state), resources,
 * progression, automation, transforms, and the command queue. Use `capturedAt`
 * when you need a deterministic timestamp for tests or diffing; it is
 * diagnostic only.
 *
 * @example
 * ```typescript
 * const snapshot = captureGameStateSnapshot({
 *   runtime,
 *   progressionCoordinator,
 *   commandQueue: runtime.getCommandQueue(),
 *   getAutomationState: () => getAutomationState(automationSystem),
 *   getTransformState: () => getTransformState(transformSystem),
 *   capturedAt: 0,
 * });
 * ```
 */
export function captureGameStateSnapshot(
  options: CaptureSnapshotOptions,
): GameStateSnapshot {
  const {
    runtime,
    progressionCoordinator,
    capturedAt,
    getAutomationState,
    getTransformState,
    commandQueue,
    productionSystem,
  } = options;

  const automationState = getAutomationState();
  const transformState = getTransformState();

  return {
    version: 1,
    capturedAt: capturedAt ?? Date.now(),
    runtime: {
      step: runtime.getCurrentStep(),
      stepSizeMs: runtime.getStepSizeMs(),
      rngSeed: getCurrentRNGSeed(),
      rngState: getRNGState(),
    },
    resources: progressionCoordinator.resourceState.exportForSave(),
    progression: serializeProgressionCoordinatorState(
      progressionCoordinator,
      productionSystem,
    ),
    automation: serializeAutomationState(automationState),
    transforms: serializeTransformState(transformState),
    commandQueue: commandQueue.exportForSave(),
  };
}
