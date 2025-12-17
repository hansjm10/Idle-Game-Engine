import type {
  GeneratorCostView,
  GeneratorView,
  ProgressionSnapshot,
  ResourceView,
  UpgradeCostView,
  UpgradeView,
} from './progression.js';

const EMPTY_ARRAY: readonly never[] = Object.freeze([]);

export type ProgressionActionableItem =
  | Readonly<{ kind: 'generator'; generator: GeneratorView }>
  | Readonly<{ kind: 'upgrade'; upgrade: UpgradeView }>;

export interface ProgressionSelectorOptions {
  readonly commandStep?: number;
}

export function selectVisibleGenerators(
  snapshot: ProgressionSnapshot,
): readonly GeneratorView[] {
  return filterValues(snapshot.generators, (generator) => generator.isVisible);
}

export function selectUnlockedGenerators(
  snapshot: ProgressionSnapshot,
): readonly GeneratorView[] {
  return filterValues(snapshot.generators, (generator) => generator.isUnlocked);
}

export function selectPurchasableGenerators(
  snapshot: ProgressionSnapshot,
  options?: ProgressionSelectorOptions,
): readonly GeneratorView[] {
  const commandStep = resolveCommandStep(snapshot, options?.commandStep);
  const resourceAmounts = createResourceAmountLookup(snapshot.resources);

  return filterValues(snapshot.generators, (generator) => {
    if (!generator.isVisible || !generator.isUnlocked) {
      return false;
    }

    if (!isReadyForCommandStep(generator, commandStep)) {
      return false;
    }

    return areCostsAffordable(resourceAmounts, generator.costs);
  });
}

export function selectVisibleUpgrades(
  snapshot: ProgressionSnapshot,
): readonly UpgradeView[] {
  return filterValues(snapshot.upgrades, (upgrade) => upgrade.isVisible);
}

export function selectAvailableUpgrades(
  snapshot: ProgressionSnapshot,
): readonly UpgradeView[] {
  return filterValues(
    snapshot.upgrades,
    (upgrade) => upgrade.isVisible && upgrade.status === 'available',
  );
}

export function selectLockedUpgradesWithHints(
  snapshot: ProgressionSnapshot,
): readonly UpgradeView[] {
  return filterValues(snapshot.upgrades, (upgrade) => {
    if (!upgrade.isVisible || upgrade.status !== 'locked') {
      return false;
    }

    return typeof upgrade.unlockHint === 'string' && upgrade.unlockHint.trim().length > 0;
  });
}

export function selectPurchasableUpgrades(
  snapshot: ProgressionSnapshot,
): readonly UpgradeView[] {
  const resourceAmounts = createResourceAmountLookup(snapshot.resources);

  return filterValues(snapshot.upgrades, (upgrade) => {
    if (!upgrade.isVisible || upgrade.status !== 'available') {
      return false;
    }

    return areCostsAffordable(resourceAmounts, upgrade.costs);
  });
}

export function selectTopNActionables(
  snapshot: ProgressionSnapshot,
  count: number,
  options?: ProgressionSelectorOptions,
): readonly ProgressionActionableItem[] {
  const limit = normalizeLimit(count);
  if (limit === 0) {
    return EMPTY_ARRAY as readonly ProgressionActionableItem[];
  }

  const commandStep = resolveCommandStep(snapshot, options?.commandStep);
  const resourceAmounts = createResourceAmountLookup(snapshot.resources);
  const actionables: ProgressionActionableItem[] = [];

  for (const generator of snapshot.generators) {
    if (actionables.length >= limit) {
      break;
    }

    if (!generator.isVisible || !generator.isUnlocked) {
      continue;
    }

    if (!isReadyForCommandStep(generator, commandStep)) {
      continue;
    }

    if (!areCostsAffordable(resourceAmounts, generator.costs)) {
      continue;
    }

    actionables.push(
      Object.freeze({ kind: 'generator', generator }),
    );
  }

  for (const upgrade of snapshot.upgrades) {
    if (actionables.length >= limit) {
      break;
    }

    if (!upgrade.isVisible || upgrade.status !== 'available') {
      continue;
    }

    if (!areCostsAffordable(resourceAmounts, upgrade.costs)) {
      continue;
    }

    actionables.push(
      Object.freeze({ kind: 'upgrade', upgrade }),
    );
  }

  return actionables.length > 0
    ? Object.freeze(actionables)
    : (EMPTY_ARRAY as readonly ProgressionActionableItem[]);
}

function createResourceAmountLookup(
  resources: readonly ResourceView[],
): ReadonlyMap<string, number> {
  if (!resources || resources.length === 0) {
    return new Map();
  }

  const lookup = new Map<string, number>();

  for (const resource of resources) {
    lookup.set(
      resource.id,
      Number.isFinite(resource.amount) ? resource.amount : 0,
    );
  }

  return lookup;
}

function areCostsAffordable(
  amountsByResourceId: ReadonlyMap<string, number>,
  costs: readonly GeneratorCostView[] | readonly UpgradeCostView[] | undefined,
): boolean {
  if (!costs || costs.length === 0) {
    return true;
  }

  for (const cost of costs) {
    const available = amountsByResourceId.get(cost.resourceId);
    if (available === undefined) {
      return false;
    }
    if (!Number.isFinite(available)) {
      return false;
    }

    const required = Number(cost.amount);
    if (!Number.isFinite(required) || required < 0) {
      return false;
    }

    if (available < required) {
      return false;
    }
  }

  return true;
}

function isReadyForCommandStep(
  generator: GeneratorView,
  commandStep: number,
): boolean {
  const readyAt = Number(generator.nextPurchaseReadyAtStep);
  return Number.isFinite(readyAt) && readyAt <= commandStep;
}

function resolveCommandStep(
  snapshot: ProgressionSnapshot,
  commandStep: number | undefined,
): number {
  const defaultStep = snapshot.step + 1;
  if (commandStep === undefined) {
    return defaultStep;
  }

  const normalized = Math.floor(Number(commandStep));
  return Number.isFinite(normalized) ? normalized : defaultStep;
}

function normalizeLimit(count: number): number {
  const normalized = Math.floor(Number(count));
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return 0;
  }

  return normalized;
}

function filterValues<T>(
  values: readonly T[],
  predicate: (value: T) => boolean,
): readonly T[] {
  if (!values || values.length === 0) {
    return EMPTY_ARRAY as readonly T[];
  }

  let result: T[] | undefined;

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (predicate(value)) {
      if (result) {
        result.push(value);
      }
      continue;
    }

    if (!result) {
      result = values.slice(0, index);
    }
  }

  if (!result) {
    return values;
  }

  return result.length > 0
    ? Object.freeze(result)
    : (EMPTY_ARRAY as readonly T[]);
}
