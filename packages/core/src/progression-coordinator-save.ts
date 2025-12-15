import type { SerializedProductionAccumulators } from './production-system.js';
import type { ProgressionCoordinator } from './progression-coordinator.js';
import type {
  ProgressionAchievementState,
  ProgressionGeneratorState,
  ProgressionUpgradeState,
} from './progression.js';
import type { SerializedResourceState } from './resource-state.js';

type Mutable<T> = {
  -readonly [K in keyof T]: T[K];
};

export const PROGRESSION_COORDINATOR_SAVE_SCHEMA_VERSION = 2;

export type SerializedProgressionGeneratorStateV1 = Readonly<{
  readonly id: string;
  readonly owned: number;
  readonly enabled: boolean;
  readonly isUnlocked: boolean;
  readonly nextPurchaseReadyAtStep?: number;
}>;

export type SerializedProgressionUpgradeStateV1 = Readonly<{
  readonly id: string;
  readonly purchases: number;
}>;

export type SerializedProgressionCoordinatorStateV1 = Readonly<{
  readonly schemaVersion: 1;
  readonly step: number;
  readonly resources: SerializedResourceState;
  readonly generators: readonly SerializedProgressionGeneratorStateV1[];
  readonly upgrades: readonly SerializedProgressionUpgradeStateV1[];
  readonly productionAccumulators?: SerializedProductionAccumulators;
}>;

export type SerializedProgressionAchievementStateV2 = Readonly<{
  readonly id: string;
  readonly completions: number;
  readonly progress: number;
  readonly nextRepeatableAtStep?: number;
  readonly lastCompletedStep?: number;
}>;

export type SerializedProgressionCoordinatorStateV2 = Readonly<{
  readonly schemaVersion: 2;
  readonly step: number;
  readonly resources: SerializedResourceState;
  readonly generators: readonly SerializedProgressionGeneratorStateV1[];
  readonly upgrades: readonly SerializedProgressionUpgradeStateV1[];
  readonly achievements: readonly SerializedProgressionAchievementStateV2[];
  readonly productionAccumulators?: SerializedProductionAccumulators;
}>;

export type SerializedProgressionCoordinatorState =
  | SerializedProgressionCoordinatorStateV1
  | SerializedProgressionCoordinatorStateV2;

function normalizeNonNegativeInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeNonNegativeNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
}

function normalizeOptionalNonNegativeInt(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

function normalizeGeneratorStateV1(
  value: unknown,
): SerializedProgressionGeneratorStateV1 | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const id = record.id;
  if (typeof id !== 'string' || id.trim().length === 0) {
    return undefined;
  }

  return {
    id,
    owned: normalizeNonNegativeInt(record.owned),
    enabled: normalizeBoolean(record.enabled, true),
    isUnlocked: normalizeBoolean(record.isUnlocked, false),
    nextPurchaseReadyAtStep:
      record.nextPurchaseReadyAtStep === undefined
        ? undefined
        : normalizeNonNegativeInt(record.nextPurchaseReadyAtStep),
  };
}

function normalizeUpgradeStateV1(
  value: unknown,
): SerializedProgressionUpgradeStateV1 | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const id = record.id;
  if (typeof id !== 'string' || id.trim().length === 0) {
    return undefined;
  }

  return {
    id,
    purchases: normalizeNonNegativeInt(record.purchases),
  };
}

function normalizeAchievementStateV2(
  value: unknown,
): SerializedProgressionAchievementStateV2 | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const id = record.id;
  if (typeof id !== 'string' || id.trim().length === 0) {
    return undefined;
  }

  return {
    id,
    completions: normalizeNonNegativeInt(record.completions),
    progress: normalizeNonNegativeNumber(record.progress),
    nextRepeatableAtStep: normalizeOptionalNonNegativeInt(
      record.nextRepeatableAtStep,
    ),
    lastCompletedStep: normalizeOptionalNonNegativeInt(record.lastCompletedStep),
  };
}

export function serializeProgressionCoordinatorState(
  coordinator: ProgressionCoordinator,
  productionSystem?: { exportAccumulators: () => SerializedProductionAccumulators },
): SerializedProgressionCoordinatorStateV2 {
  const resources = coordinator.resourceState.exportForSave();

  const step = normalizeNonNegativeInt(coordinator.getLastUpdatedStep());

  const generators = (coordinator.state.generators ?? []).map((generator) => ({
    id: generator.id,
    owned: normalizeNonNegativeInt(generator.owned),
    enabled: Boolean(generator.enabled),
    isUnlocked: Boolean(generator.isUnlocked),
    nextPurchaseReadyAtStep: normalizeNonNegativeInt(
      generator.nextPurchaseReadyAtStep,
    ),
  }));

  const upgrades = (coordinator.state.upgrades ?? []).map((upgrade) => {
    const purchases = normalizeNonNegativeInt(
      (upgrade as unknown as { purchases?: unknown }).purchases,
    );
    return {
      id: upgrade.id,
      purchases,
    };
  });

  const achievements = (coordinator.state.achievements ?? []).map((achievement) => ({
    id: achievement.id,
    completions: normalizeNonNegativeInt(
      (achievement as unknown as { completions?: unknown }).completions,
    ),
    progress: normalizeNonNegativeNumber(
      (achievement as unknown as { progress?: unknown }).progress,
    ),
    nextRepeatableAtStep: normalizeOptionalNonNegativeInt(
      (achievement as unknown as { nextRepeatableAtStep?: unknown })
        .nextRepeatableAtStep,
    ),
    lastCompletedStep: normalizeOptionalNonNegativeInt(
      (achievement as unknown as { lastCompletedStep?: unknown })
        .lastCompletedStep,
    ),
  }));

  return {
    schemaVersion: PROGRESSION_COORDINATOR_SAVE_SCHEMA_VERSION,
    step,
    resources,
    generators,
    upgrades,
    achievements,
    productionAccumulators: productionSystem?.exportAccumulators(),
  };
}

export function hydrateProgressionCoordinatorState(
  serialized: SerializedProgressionCoordinatorState | undefined,
  coordinator: ProgressionCoordinator,
  productionSystem?: { restoreAccumulators: (state: SerializedProductionAccumulators) => void },
): void {
  if (!serialized) {
    return;
  }

  const schemaVersion = serialized.schemaVersion;
  if (schemaVersion !== 1 && schemaVersion !== PROGRESSION_COORDINATOR_SAVE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported progression coordinator save schema version: ${schemaVersion}`,
    );
  }

  coordinator.hydrateResources(serialized.resources);

  const generatorById = new Map<string, Mutable<ProgressionGeneratorState>>();
  for (const generator of coordinator.state.generators ?? []) {
    generatorById.set(
      generator.id,
      generator as Mutable<ProgressionGeneratorState>,
    );
  }

  for (const generator of generatorById.values()) {
    generator.owned = 0;
    generator.enabled = true;
    generator.isUnlocked = false;
    generator.nextPurchaseReadyAtStep = 1;
  }

  for (const entry of serialized.generators) {
    const normalized = normalizeGeneratorStateV1(entry);
    if (!normalized) {
      continue;
    }

    const generator = generatorById.get(normalized.id);
    if (!generator) {
      continue;
    }

    generator.owned = normalized.owned;
    generator.enabled = normalized.enabled;
    generator.isUnlocked = normalized.isUnlocked;
    if (normalized.nextPurchaseReadyAtStep !== undefined) {
      generator.nextPurchaseReadyAtStep = normalized.nextPurchaseReadyAtStep;
    }
  }

  const upgradeById = new Map<string, ProgressionUpgradeState>();
  for (const upgrade of coordinator.state.upgrades ?? []) {
    upgradeById.set(upgrade.id, upgrade);
  }

  for (const upgrade of upgradeById.values()) {
    coordinator.setUpgradePurchases(upgrade.id, 0);
  }

  for (const entry of serialized.upgrades) {
    const normalized = normalizeUpgradeStateV1(entry);
    if (!normalized) {
      continue;
    }

    if (!upgradeById.has(normalized.id)) {
      continue;
    }

    coordinator.setUpgradePurchases(normalized.id, normalized.purchases);
  }

  const achievementById = new Map<string, Mutable<ProgressionAchievementState>>();
  for (const achievement of coordinator.state.achievements ?? []) {
    achievementById.set(
      achievement.id,
      achievement as Mutable<ProgressionAchievementState>,
    );
  }

  for (const achievement of achievementById.values()) {
    achievement.isVisible = false;
    achievement.completions = 0;
    achievement.progress = 0;
    achievement.target = 0;
    achievement.nextRepeatableAtStep = undefined;
    achievement.lastCompletedStep = undefined;
  }

  if (schemaVersion === 2) {
    const achievements = (serialized as SerializedProgressionCoordinatorStateV2).achievements;
    for (const entry of achievements) {
      const normalized = normalizeAchievementStateV2(entry);
      if (!normalized) {
        continue;
      }

      const achievement = achievementById.get(normalized.id);
      if (!achievement) {
        continue;
      }

      achievement.completions = normalized.completions;
      achievement.progress = normalized.progress;
      achievement.nextRepeatableAtStep = normalized.nextRepeatableAtStep;
      achievement.lastCompletedStep = normalized.lastCompletedStep;
    }
  }

  if (serialized.productionAccumulators && productionSystem) {
    productionSystem.restoreAccumulators(serialized.productionAccumulators);
  }

  coordinator.updateForStep(normalizeNonNegativeInt(serialized.step));
}
