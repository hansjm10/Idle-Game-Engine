import type { Condition, NormalizedResource } from '@idle-engine/content-schema';

import type { EngineConfigOverrides } from '../config.js';
/**
 * ResourceManager owns the authoritative {@link ResourceState} used by the
 * progression system.
 *
 * Responsibilities:
 * - Build initial resource definitions + metadata from content
 * - Hydrate/reconcile saves into the current definition set
 * - Evaluate per-step unlock/visibility conditions for resources
 *
 * It intentionally does not handle generator/upgrade logic; those live in
 * dedicated managers and consume {@link ResourceState} via the coordinator.
 */
import {
  createResourceState,
  reconcileSaveAgainstDefinitions,
  type ResourceDefinition,
  type ResourceState,
  type SerializedResourceState,
} from '../resource-state.js';
import { evaluateCondition, type ConditionContext } from '../condition-evaluator.js';
import type { ResourceProgressionMetadata } from '../progression.js';

import { getDisplayName } from './progression-utils.js';

type ResourceConditionRecord = {
  readonly id: string;
  readonly unlockCondition?: Condition;
  readonly visibilityCondition?: Condition;
};

function buildResourceMetadata(
  resources: readonly NormalizedResource[],
): ReadonlyMap<string, ResourceProgressionMetadata> {
  const metadata = new Map<string, ResourceProgressionMetadata>();
  for (const resource of resources) {
    metadata.set(resource.id, {
      displayName: getDisplayName(resource.name, resource.id),
    });
  }
  return metadata;
}

function hydrateResourceState(
  state: ResourceState,
  serialized: SerializedResourceState,
  definitions: readonly ResourceDefinition[],
): void {
  const reconciliation = reconcileSaveAgainstDefinitions(
    serialized,
    definitions,
  );

  const { remap } = reconciliation;
  const unlocked = serialized.unlocked ?? [];
  const visible = serialized.visible ?? [];

  for (let savedIndex = 0; savedIndex < remap.length; savedIndex += 1) {
    const liveIndex = remap[savedIndex];
    if (liveIndex === undefined) {
      continue;
    }

    const resolvedCapacity = serialized.capacities[savedIndex];
    const capacity = resolvedCapacity ?? Number.POSITIVE_INFINITY;
    state.setCapacity(liveIndex, capacity);

    const targetAmount = serialized.amounts[savedIndex] ?? 0;
    const currentAmount = state.getAmount(liveIndex);
    if (targetAmount > currentAmount) {
      state.addAmount(liveIndex, targetAmount - currentAmount);
    } else if (targetAmount < currentAmount) {
      const delta = currentAmount - targetAmount;
      if (delta > 0) {
        state.spendAmount(liveIndex, delta);
      }
    }

    if (unlocked[savedIndex]) {
      state.unlock(liveIndex);
    }
    if (visible[savedIndex]) {
      state.grantVisibility(liveIndex);
    }
  }

  state.snapshot({ mode: 'publish' });
}

export class ResourceManager {
  public readonly resourceState: ResourceState;
  public readonly resourceDefinitions: readonly ResourceDefinition[];
  public readonly resourceMetadata: ReadonlyMap<string, ResourceProgressionMetadata>;

  private readonly resourceConditions: readonly ResourceConditionRecord[];
  private readonly resourceDefinitionsById: ReadonlyMap<string, ResourceDefinition>;
  private readonly baseCapacityByIndex: Float64Array;
  private readonly capacityOverrideIds = new Set<string>();
  private readonly baseDirtyToleranceByIndex: Float64Array;
  private readonly dirtyToleranceOverrideIds = new Set<string>();

  constructor(options: {
    readonly resources: readonly NormalizedResource[];
    readonly initialResourceState?: ResourceState;
    readonly initialSerializedState?: SerializedResourceState;
    readonly config?: EngineConfigOverrides;
  }) {
    const resourceDefinitions = options.resources.map(
      (resource): ResourceDefinition => ({
        id: resource.id,
        startAmount: resource.startAmount ?? 0,
        capacity: resource.capacity ?? undefined,
        unlocked: resource.unlocked ?? false,
        visible: resource.visible ?? true,
        dirtyTolerance: resource.dirtyTolerance ?? undefined,
      }),
    );

    this.resourceDefinitions = resourceDefinitions;
    this.resourceMetadata = buildResourceMetadata(options.resources);
    this.resourceConditions = options.resources.map((resource) => ({
      id: resource.id,
      unlockCondition: resource.unlockCondition,
      visibilityCondition: resource.visibilityCondition,
    }));
    this.resourceDefinitionsById = new Map(
      resourceDefinitions.map((definition) => [definition.id, definition]),
    );

    this.resourceState =
      options.initialResourceState ??
      createResourceState(resourceDefinitions, { config: options.config });
    this.hydrateResources(options.initialSerializedState);

    this.baseCapacityByIndex = new Float64Array(resourceDefinitions.length);
    for (let index = 0; index < resourceDefinitions.length; index += 1) {
      const capacity = resourceDefinitions[index]?.capacity;
      this.baseCapacityByIndex[index] =
        capacity ?? Number.POSITIVE_INFINITY;
    }

    this.baseDirtyToleranceByIndex = new Float64Array(resourceDefinitions.length);
    for (let index = 0; index < resourceDefinitions.length; index += 1) {
      this.baseDirtyToleranceByIndex[index] = this.resourceState.getDirtyTolerance(
        index,
      );
    }
  }

  hydrateResources(serialized: SerializedResourceState | undefined): void {
    if (!serialized) {
      return;
    }

    hydrateResourceState(
      this.resourceState,
      serialized,
      this.resourceDefinitions,
    );
  }

  updateUnlockVisibility(conditionContext: ConditionContext): void {
    for (let index = 0; index < this.resourceConditions.length; index += 1) {
      const record = this.resourceConditions[index];

      if (record.unlockCondition && !this.resourceState.isUnlocked(index)) {
        if (evaluateCondition(record.unlockCondition, conditionContext)) {
          this.resourceState.unlock(index);
        }
      }

      if (record.visibilityCondition && !this.resourceState.isVisible(index)) {
        if (evaluateCondition(record.visibilityCondition, conditionContext)) {
          this.resourceState.grantVisibility(index);
        }
      } else if (
        record.unlockCondition &&
        this.resourceState.isUnlocked(index) &&
        !this.resourceState.isVisible(index)
      ) {
        this.resourceState.grantVisibility(index);
      }
    }
  }

  applyUnlockedResources(resourceIds: ReadonlySet<string>): void {
    for (const resourceId of resourceIds) {
      const index = this.resourceState.getIndex(resourceId);
      if (index === undefined) {
        continue;
      }
      if (!this.resourceState.isUnlocked(index)) {
        this.resourceState.unlock(index);
      }
      if (!this.resourceState.isVisible(index)) {
        this.resourceState.grantVisibility(index);
      }
    }
  }

  applyCapacityOverrides(overrides: ReadonlyMap<string, number>): void {
    for (const resourceId of this.capacityOverrideIds) {
      if (overrides.has(resourceId)) {
        continue;
      }
      const index = this.resourceState.getIndex(resourceId);
      if (index === undefined) {
        continue;
      }
      const baseCapacity =
        this.baseCapacityByIndex[index] ?? Number.POSITIVE_INFINITY;
      this.resourceState.setCapacity(index, baseCapacity);
    }
    this.capacityOverrideIds.clear();

    for (const [resourceId, capacity] of overrides) {
      const index = this.resourceState.getIndex(resourceId);
      if (index === undefined) {
        continue;
      }
      this.resourceState.setCapacity(index, capacity);
      this.capacityOverrideIds.add(resourceId);
    }
  }

  applyDirtyToleranceOverrides(overrides: ReadonlyMap<string, number>): void {
    for (const resourceId of this.dirtyToleranceOverrideIds) {
      const index = this.resourceState.getIndex(resourceId);
      if (index === undefined) {
        continue;
      }
      this.resourceState.setDirtyTolerance(
        index,
        this.baseDirtyToleranceByIndex[index] ?? 0,
      );
    }
    this.dirtyToleranceOverrideIds.clear();

    for (const [resourceId, tolerance] of overrides) {
      const index = this.resourceState.getIndex(resourceId);
      if (index === undefined) {
        continue;
      }
      this.resourceState.setDirtyTolerance(index, tolerance);
      this.dirtyToleranceOverrideIds.add(resourceId);
    }
  }

  getBaseCapacity(resourceId: string): number {
    const index = this.resourceState.getIndex(resourceId);
    if (index === undefined) {
      return Number.POSITIVE_INFINITY;
    }
    return this.baseCapacityByIndex[index] ?? Number.POSITIVE_INFINITY;
  }

  getBaseDirtyTolerance(resourceId: string): number {
    const index = this.resourceState.getIndex(resourceId);
    if (index === undefined) {
      return 0;
    }
    return this.baseDirtyToleranceByIndex[index] ?? 0;
  }

  getResourceDefinition(resourceId: string): ResourceDefinition | undefined {
    return this.resourceDefinitionsById.get(resourceId);
  }
}
