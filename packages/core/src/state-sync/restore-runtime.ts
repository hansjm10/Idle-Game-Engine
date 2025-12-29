import type { NormalizedContentPack } from '@idle-engine/content-schema';

import type { IdleEngineRuntimeOptions } from '../index.js';
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
  readonly production?: {
    readonly applyViaFinalizeTick?: boolean;
  };
  readonly runtimeOptions?: Readonly<
    Pick<IdleEngineRuntimeOptions, 'initialStep' | 'maxStepsPerFrame'>
  >;
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
  const applyViaFinalizeTick =
    options.production?.applyViaFinalizeTick ?? true;
  const maxStepsPerFrame =
    options.runtimeOptions?.maxStepsPerFrame ??
    (applyViaFinalizeTick && enableProduction && hasGenerators ? 1 : undefined);
  const productionOptions =
    options.production === undefined
      ? { applyViaFinalizeTick }
      : { ...options.production, applyViaFinalizeTick };

  const runtimeOptions =
    options.runtimeOptions?.initialStep === undefined &&
    maxStepsPerFrame === undefined
      ? undefined
      : {
          ...(options.runtimeOptions?.initialStep === undefined
            ? {}
            : { initialStep: options.runtimeOptions.initialStep }),
          ...(maxStepsPerFrame === undefined ? {} : { maxStepsPerFrame }),
        };

  const restored = restoreFromSnapshot({
    snapshot,
    resourceDefinitions,
    ...(runtimeOptions ? { runtimeOptions } : {}),
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
    production: productionOptions,
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
