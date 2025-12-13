import type { SerializedProductionAccumulators } from './production-system.js';
import type { ProgressionCoordinator } from './progression-coordinator.js';
import type {
  ProgressionGeneratorState,
  ProgressionUpgradeState,
} from './progression.js';
import type { SerializedResourceState } from './resource-state.js';

type Mutable<T> = {
  -readonly [K in keyof T]: T[K];
};

export const PROGRESSION_COORDINATOR_SAVE_SCHEMA_VERSION = 1;

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

export type SerializedProgressionCoordinatorState =
  SerializedProgressionCoordinatorStateV1;

function normalizeNonNegativeInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
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

export function serializeProgressionCoordinatorState(
  coordinator: ProgressionCoordinator,
  productionSystem?: { exportAccumulators: () => SerializedProductionAccumulators },
): SerializedProgressionCoordinatorStateV1 {
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

  return {
    schemaVersion: PROGRESSION_COORDINATOR_SAVE_SCHEMA_VERSION,
    step,
    resources,
    generators,
    upgrades,
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

  if (serialized.schemaVersion !== PROGRESSION_COORDINATOR_SAVE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported progression coordinator save schema version: ${serialized.schemaVersion}`,
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

  if (serialized.productionAccumulators && productionSystem) {
    productionSystem.restoreAccumulators(serialized.productionAccumulators);
  }

  coordinator.updateForStep(normalizeNonNegativeInt(serialized.step));
}

