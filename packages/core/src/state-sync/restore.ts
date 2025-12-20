import type { IdleEngineRuntimeOptions } from '../index.js';
import { CommandQueue } from '../command-queue.js';
import { setRNGSeed } from '../rng.js';
import {
  createResourceState,
  reconcileSaveAgainstDefinitions,
  type ResourceDefinition,
  type ResourceDefinitionReconciliation,
  type ResourceState,
  type SerializedResourceState,
} from '../resource-state.js';
import type { GameStateSnapshot } from './types.js';

export interface RuntimeLike {
  getCurrentStep(): number;
}

type RuntimeFactory = (options: IdleEngineRuntimeOptions) => RuntimeLike;

let runtimeFactory: RuntimeFactory | undefined;

export function setRestoreRuntimeFactory(factory: RuntimeFactory): void {
  runtimeFactory = factory;
}

const resolveRuntimeFactory = (): RuntimeFactory => {
  if (!runtimeFactory) {
    throw new Error(
      'restoreFromSnapshot requires a runtime factory; call setRestoreRuntimeFactory first.',
    );
  }
  return runtimeFactory;
};

export interface RestoreSnapshotOptions {
  /** Snapshot to restore from */
  readonly snapshot: GameStateSnapshot;

  /** Resource definitions for hydration */
  readonly resourceDefinitions: readonly ResourceDefinition[];

  /** Runtime options (overrides snapshot values if provided) */
  readonly runtimeOptions?: Partial<IdleEngineRuntimeOptions>;

  /** Whether to apply RNG seed from snapshot (default: true) */
  readonly applyRngSeed?: boolean;
}

export interface RestoredRuntime<TRuntime extends RuntimeLike = RuntimeLike> {
  /** Hydrated runtime instance */
  readonly runtime: TRuntime;

  /** Hydrated resource state */
  readonly resources: ResourceState;

  /** Reconciliation metadata (added/removed resources) */
  readonly reconciliation: ResourceDefinitionReconciliation;

  /** Restored command queue */
  readonly commandQueue: CommandQueue;
}

const buildRemapFromResources = (
  resources: ResourceState,
  serialized: SerializedResourceState,
): readonly (number | undefined)[] =>
  serialized.ids.map((id) => resources.getIndex(id));

const applySerializedResourceState = (
  resources: ResourceState,
  serialized: SerializedResourceState,
  remap: readonly (number | undefined)[],
): void => {
  const unlocked = serialized.unlocked ?? [];
  const visible = serialized.visible ?? [];

  for (let savedIndex = 0; savedIndex < remap.length; savedIndex += 1) {
    const liveIndex = remap[savedIndex];
    if (liveIndex === undefined) {
      continue;
    }

    const resolvedCapacity = serialized.capacities[savedIndex];
    const capacity =
      resolvedCapacity === null || resolvedCapacity === undefined
        ? Number.POSITIVE_INFINITY
        : resolvedCapacity;
    resources.setCapacity(liveIndex, capacity);

    const targetAmount = serialized.amounts[savedIndex] ?? 0;
    const currentAmount = resources.getAmount(liveIndex);
    if (targetAmount > currentAmount) {
      resources.addAmount(liveIndex, targetAmount - currentAmount);
    } else if (targetAmount < currentAmount) {
      const delta = currentAmount - targetAmount;
      if (delta > 0) {
        resources.spendAmount(liveIndex, delta);
      }
    }

    if (unlocked[savedIndex]) {
      resources.unlock(liveIndex);
    }
    if (visible[savedIndex]) {
      resources.grantVisibility(liveIndex);
    }
  }

  resources.snapshot({ mode: 'publish' });
};

const hydrateResourceStateFromSerialized = (
  serialized: SerializedResourceState,
  definitions: readonly ResourceDefinition[],
): {
  resources: ResourceState;
  reconciliation: ResourceDefinitionReconciliation;
} => {
  const resources = createResourceState(definitions);
  const reconciliation = reconcileSaveAgainstDefinitions(
    serialized,
    definitions,
  );

  applySerializedResourceState(
    resources,
    serialized,
    reconciliation.remap,
  );

  return { resources, reconciliation };
};

export function restoreFromSnapshot(
  options: RestoreSnapshotOptions,
): RestoredRuntime {
  const {
    snapshot,
    resourceDefinitions,
    runtimeOptions,
    applyRngSeed = true,
  } = options;

  const { resources, reconciliation } = hydrateResourceStateFromSerialized(
    snapshot.resources,
    resourceDefinitions,
  );

  const commandQueue = runtimeOptions?.commandQueue ?? new CommandQueue();
  const runtime = resolveRuntimeFactory()({
    ...runtimeOptions,
    commandQueue,
    stepSizeMs: runtimeOptions?.stepSizeMs ?? snapshot.runtime.stepSizeMs,
    initialStep: runtimeOptions?.initialStep ?? snapshot.runtime.step,
  });

  if (applyRngSeed && snapshot.runtime.rngSeed !== undefined) {
    setRNGSeed(snapshot.runtime.rngSeed);
  }

  const currentStep = runtime.getCurrentStep();
  const rebaseStep =
    currentStep !== snapshot.runtime.step
      ? { savedStep: snapshot.runtime.step, currentStep }
      : undefined;

  commandQueue.restoreFromSave(
    snapshot.commandQueue,
    rebaseStep ? { rebaseStep } : undefined,
  );

  return { runtime, resources, reconciliation, commandQueue };
}

/**
 * Restore only specific components for bandwidth optimization.
 */
export type RestoreMode = 'full' | 'resources' | 'commands';

export function restorePartial(
  snapshot: GameStateSnapshot,
  mode: RestoreMode,
  target: {
    resources?: ResourceState;
    commandQueue?: CommandQueue;
  },
): void {
  const applyResources = () => {
    if (!target.resources) {
      return;
    }
    const remap = buildRemapFromResources(
      target.resources,
      snapshot.resources,
    );
    applySerializedResourceState(
      target.resources,
      snapshot.resources,
      remap,
    );
  };

  const restoreCommands = () => {
    if (!target.commandQueue) {
      return;
    }
    target.commandQueue.restoreFromSave(snapshot.commandQueue);
  };

  switch (mode) {
    case 'full':
      applyResources();
      restoreCommands();
      break;
    case 'resources':
      applyResources();
      break;
    case 'commands':
      restoreCommands();
      break;
  }
}
