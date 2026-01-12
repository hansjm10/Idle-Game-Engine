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
  return filterValues(snapshot.generators, (generator) => generator.visible);
}

export function selectUnlockedGenerators(
  snapshot: ProgressionSnapshot,
): readonly GeneratorView[] {
  return filterValues(snapshot.generators, (generator) => generator.unlocked);
}

export function selectPurchasableGenerators(
  snapshot: ProgressionSnapshot,
  options?: ProgressionSelectorOptions,
): readonly GeneratorView[] {
  const commandStep = resolveCommandStep(snapshot, options?.commandStep);
  const resourceAmounts = createResourceAmountLookup(snapshot.resources);

  return filterValues(snapshot.generators, (generator) => {
    if (!generator.visible || !generator.unlocked) {
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
  return filterValues(snapshot.upgrades, (upgrade) => upgrade.visible);
}

export function selectAvailableUpgrades(
  snapshot: ProgressionSnapshot,
): readonly UpgradeView[] {
  return filterValues(
    snapshot.upgrades,
    (upgrade) => upgrade.visible && upgrade.status === 'available',
  );
}

export function selectLockedUpgradesWithHints(
  snapshot: ProgressionSnapshot,
): readonly UpgradeView[] {
  return filterValues(snapshot.upgrades, (upgrade) => {
    if (!upgrade.visible || upgrade.status !== 'locked') {
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
    if (!upgrade.visible || upgrade.status !== 'available') {
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
    tryAddGeneratorActionable(actionables, generator, commandStep, resourceAmounts);
  }

  for (const upgrade of snapshot.upgrades) {
    if (actionables.length >= limit) {
      break;
    }
    tryAddUpgradeActionable(actionables, upgrade, resourceAmounts);
  }

  return actionables.length > 0
    ? Object.freeze(actionables)
    : (EMPTY_ARRAY as readonly ProgressionActionableItem[]);
}

function tryAddGeneratorActionable(
  actionables: ProgressionActionableItem[],
  generator: GeneratorView,
  commandStep: number,
  resourceAmounts: ReadonlyMap<string, number>,
): void {
  if (!generator.visible || !generator.unlocked) {
    return;
  }

  if (!isReadyForCommandStep(generator, commandStep)) {
    return;
  }

  if (!areCostsAffordable(resourceAmounts, generator.costs)) {
    return;
  }

  actionables.push(Object.freeze({ kind: 'generator', generator }));
}

function tryAddUpgradeActionable(
  actionables: ProgressionActionableItem[],
  upgrade: UpgradeView,
  resourceAmounts: ReadonlyMap<string, number>,
): void {
  if (!upgrade.visible || upgrade.status !== 'available') {
    return;
  }

  if (!areCostsAffordable(resourceAmounts, upgrade.costs)) {
    return;
  }

  actionables.push(Object.freeze({ kind: 'upgrade', upgrade }));
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
