import type { NormalizedContentPack } from '@idle-engine/content-schema';

import { createProgressionCoordinator } from '../progression-coordinator.js';
import { hydrateProgressionCoordinatorState } from '../progression-coordinator-save.js';
import type { ProgressionAuthoritativeState } from '../progression.js';
import type { ResourceDefinition } from '../resource-state.js';
import {
  wireGameRuntime,
  type GameRuntimeWiring,
  type RuntimeWiringRuntime,
} from '../game-runtime-wiring.js';
import { restoreFromSnapshot } from './restore.js';
import type { GameStateSnapshot } from './types.js';

export type RestoreGameRuntimeFromSnapshotOptions = Readonly<{
  readonly content: NormalizedContentPack;
  readonly snapshot: GameStateSnapshot;
  readonly enableProduction?: boolean;
  readonly enableAutomation?: boolean;
  readonly enableTransforms?: boolean;
}>;

const buildResourceDefinitions = (
  content: NormalizedContentPack,
): ResourceDefinition[] =>
  content.resources.map((resource) => ({
    id: resource.id,
    startAmount: resource.startAmount ?? 0,
    capacity:
      resource.capacity === null || resource.capacity === undefined
        ? undefined
        : resource.capacity,
    unlocked: resource.unlocked ?? false,
    visible: resource.visible ?? true,
    dirtyTolerance: resource.dirtyTolerance ?? undefined,
  }));

/**
 * Restore a fully wired runtime from a snapshot and content pack.
 */
export function restoreGameRuntimeFromSnapshot(
  options: RestoreGameRuntimeFromSnapshotOptions,
): GameRuntimeWiring {
  const { content, snapshot } = options;

  const resourceDefinitions = buildResourceDefinitions(content);
  const hasGenerators = content.generators.length > 0;
  const enableProduction = options.enableProduction ?? hasGenerators;
  const applyViaFinalizeTick = true;
  const maxStepsPerFrame =
    applyViaFinalizeTick && enableProduction && hasGenerators ? 1 : undefined;

  const restored = restoreFromSnapshot({
    snapshot,
    resourceDefinitions,
    ...(maxStepsPerFrame === undefined
      ? {}
      : { runtimeOptions: { maxStepsPerFrame } }),
  });

  const stepDurationMs = snapshot.runtime.stepSizeMs;
  const initialState: ProgressionAuthoritativeState = {
    stepDurationMs,
    resources: {
      state: restored.resources,
    },
  };

  const coordinator = createProgressionCoordinator({
    content,
    stepDurationMs,
    initialState,
  });

  const wiring = wireGameRuntime({
    content,
    runtime: restored.runtime as RuntimeWiringRuntime,
    coordinator,
    enableProduction,
    enableAutomation: options.enableAutomation,
    enableTransforms: options.enableTransforms,
    production: { applyViaFinalizeTick },
  });

  hydrateProgressionCoordinatorState(
    snapshot.progression,
    coordinator,
    wiring.productionSystem,
    { skipResources: true },
  );

  const currentStep = wiring.runtime.getCurrentStep();
  if (wiring.automationSystem) {
    wiring.automationSystem.restoreState(snapshot.automation, {
      savedWorkerStep: snapshot.runtime.step,
      currentStep,
    });
  }

  if (wiring.transformSystem) {
    wiring.transformSystem.restoreState(snapshot.transforms, {
      savedWorkerStep: snapshot.runtime.step,
      currentStep,
    });
  }

  return wiring;
}
