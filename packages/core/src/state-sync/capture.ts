import type { AutomationState } from '../automation-system.js';
import { serializeAutomationState } from '../automation-system.js';
import type { CommandQueue } from '../command-queue.js';
import type { IdleEngineRuntime } from '../index.js';
import type { SerializedProductionAccumulators } from '../production-system.js';
import type { ProgressionCoordinator } from '../progression-coordinator.js';
import { serializeProgressionCoordinatorState } from '../progression-coordinator-save.js';
import type { ResourceState } from '../resource-state.js';
import { getCurrentRNGSeed } from '../rng.js';
import type { TransformState } from '../transform-system.js';
import { serializeTransformState } from '../transform-system.js';
import type { GameStateSnapshot } from './types.js';

export interface CaptureSnapshotOptions {
  /** Runtime instance to capture. */
  readonly runtime: IdleEngineRuntime;
  /** Resource state to capture. */
  readonly resources: ResourceState;
  /** Progression coordinator to capture. */
  readonly progressionCoordinator: ProgressionCoordinator;
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

export function captureGameStateSnapshot(
  options: CaptureSnapshotOptions,
): GameStateSnapshot {
  const {
    runtime,
    resources,
    progressionCoordinator,
    getAutomationState,
    getTransformState,
    commandQueue,
    productionSystem,
  } = options;

  const automationState = getAutomationState();
  const transformState = getTransformState();

  return {
    version: 1,
    capturedAt: Date.now(),
    runtime: {
      step: runtime.getCurrentStep(),
      stepSizeMs: runtime.getStepSizeMs(),
      rngSeed: getCurrentRNGSeed(),
    },
    resources: resources.exportForSave(automationState, transformState),
    progression: serializeProgressionCoordinatorState(
      progressionCoordinator,
      productionSystem,
    ),
    automation: serializeAutomationState(automationState),
    transforms: serializeTransformState(transformState),
    commandQueue: commandQueue.exportForSave(),
  };
}
