import type {
  GeneratorPurchaseEvaluator,
  GeneratorPurchaseQuote,
  GeneratorResourceCost,
  UpgradePurchaseEvaluator,
  UpgradePurchaseQuote,
  UpgradeResourceCost,
  UpgradeStatus,
} from './resource-command-handlers.js';
import type {
  ResourceState,
  SerializedResourceState,
} from './resource-state.js';

const EMPTY_ARRAY: readonly never[] = Object.freeze([]);
const FLAG_VISIBLE = 1 << 0;
const FLAG_UNLOCKED = 1 << 1;

export type GeneratorRateView = Readonly<{
  resourceId: string;
  rate: number;
}>;

export type GeneratorCostView = Readonly<{
  resourceId: string;
  amount: number;
}>;

export type ResourceView = Readonly<{
  id: string;
  displayName: string;
  amount: number;
  isUnlocked: boolean;
  isVisible: boolean;
  capacity?: number;
  perTick: number;
}>;

export type GeneratorView = Readonly<{
  id: string;
  displayName: string;
  owned: number;
  enabled: boolean;
  isUnlocked: boolean;
  isVisible: boolean;
  costs: readonly GeneratorCostView[];
  produces: readonly GeneratorRateView[];
  consumes: readonly GeneratorRateView[];
  nextPurchaseReadyAtStep: number;
}>;

export type UpgradeCostView = Readonly<{
  resourceId: string;
  amount: number;
}>;

export type UpgradeView = Readonly<{
  id: string;
  displayName: string;
  status: UpgradeStatus;
  costs?: readonly UpgradeCostView[];
  unlockHint?: string;
  isVisible: boolean;
}>;

export type PrestigeRewardContribution = Readonly<{
  sourceResourceId: string;
  sourceAmount: number;
  contribution: number;
}>;

export type PrestigeRewardPreview = Readonly<{
  resourceId: string;
  amount: number;
  breakdown?: readonly PrestigeRewardContribution[];
}>;

export type PrestigeLayerView = Readonly<{
  id: string;
  displayName: string;
  summary?: string;
  status: 'locked' | 'available' | 'completed';
  unlockHint?: string;
  isVisible: boolean;
  rewardPreview?: PrestigeRewardPreview;
  resetTargets: readonly string[];
  resetGenerators?: readonly string[];
  resetUpgrades?: readonly string[];
  retainedTargets: readonly string[];
}>;

/**
 * Quote returned by PrestigeSystemEvaluator for a specific prestige layer.
 * Contains the current status, calculated reward, and reset/retention targets.
 */
export interface PrestigeQuote {
  readonly layerId: string;
  readonly status: 'locked' | 'available' | 'completed';
  readonly reward: PrestigeRewardPreview;
  readonly resetTargets: readonly string[];
  readonly resetGenerators?: readonly string[];
  readonly resetUpgrades?: readonly string[];
  readonly retainedTargets: readonly string[];
}

/**
 * Evaluator interface for the prestige system. Provides quote calculation
 * and prestige application. The concrete implementation lives in
 * `packages/core/src/prestige-system.ts` (follow-up issue).
 */
export interface PrestigeSystemEvaluator {
  /**
   * Calculate a prestige quote for the given layer.
   * Returns undefined if the layer does not exist.
   */
  getPrestigeQuote(layerId: string): PrestigeQuote | undefined;

  /**
   * Execute prestige for the given layer. Applies reward, resets targets,
   * and updates prestige count. The confirmationToken is advisory and passed
   * through for the evaluator to use if needed (e.g., UI-generated nonce).
   *
   * @throws Error if layer is locked or does not exist
   */
  applyPrestige(layerId: string, confirmationToken?: string): void;
}

export type ProgressionSnapshot = Readonly<{
  step: number;
  publishedAt: number;
  resources: readonly ResourceView[];
  generators: readonly GeneratorView[];
  upgrades: readonly UpgradeView[];
  prestigeLayers: readonly PrestigeLayerView[];
}>;

export interface ResourceProgressionMetadata {
  readonly displayName?: string;
}

export interface ProgressionResourceState {
  readonly state?: ResourceState;
  readonly serialized?: SerializedResourceState;
  readonly metadata?: ReadonlyMap<string, ResourceProgressionMetadata>;
}

export interface ProgressionGeneratorState {
  readonly id: string;
  readonly displayName?: string;
  readonly owned: number;
  readonly enabled: boolean;
  readonly isUnlocked: boolean;
  readonly isVisible: boolean;
  readonly produces?: readonly GeneratorRateView[];
  readonly consumes?: readonly GeneratorRateView[];
  readonly nextPurchaseReadyAtStep?: number;
}

export interface ProgressionUpgradeState {
  readonly id: string;
  readonly displayName?: string;
  readonly status?: UpgradeStatus;
  readonly isVisible: boolean;
  readonly unlockHint?: string;
  readonly costs?: readonly UpgradeResourceCost[];
}

export interface ProgressionPrestigeLayerState {
  readonly id: string;
  readonly displayName?: string;
  readonly summary?: string;
  readonly isUnlocked: boolean;
  readonly isVisible: boolean;
  readonly unlockHint?: string;
}

export interface ProgressionAuthoritativeState {
  readonly stepDurationMs: number;
  readonly resources?: ProgressionResourceState;
  readonly generatorPurchases?: GeneratorPurchaseEvaluator;
  readonly generators?: readonly ProgressionGeneratorState[];
  readonly upgradePurchases?: UpgradePurchaseEvaluator;
  readonly upgrades?: readonly ProgressionUpgradeState[];
  readonly prestigeSystem?: PrestigeSystemEvaluator;
  readonly prestigeLayers?: readonly ProgressionPrestigeLayerState[];
}

export function buildProgressionSnapshot(
  step: number,
  publishedAt: number,
  state?: ProgressionAuthoritativeState,
): ProgressionSnapshot {
  const stepDurationMs = state?.stepDurationMs ?? 100;
  const resources = createResourceViews(stepDurationMs, state?.resources);
  const generators = createGeneratorViews(
    step,
    state?.generators,
    state?.generatorPurchases,
  );
  const upgrades = createUpgradeViews(
    state?.upgrades,
    state?.upgradePurchases,
  );
  const prestigeLayers = createPrestigeLayerViews(
    state?.prestigeLayers,
    state?.prestigeSystem,
  );

  return Object.freeze({
    step,
    publishedAt,
    resources,
    generators,
    upgrades,
    prestigeLayers,
  });
}

function createResourceViews(
  stepDurationMs: number,
  source?: ProgressionResourceState,
): readonly ResourceView[] {
  if (!source) {
    return EMPTY_ARRAY as readonly ResourceView[];
  }

  if (source.state) {
    const snapshot = source.state.snapshot({ mode: 'publish' });
    const views: ResourceView[] = [];

    for (let index = 0; index < snapshot.ids.length; index += 1) {
      const id = snapshot.ids[index];
      const displayName =
        source.metadata?.get(id)?.displayName ?? id;
      const capacityValue = source.state.getCapacity(index);
      const capacity =
        Number.isFinite(capacityValue) && capacityValue >= 0
          ? capacityValue
          : undefined;
      const perSecond = source.state.getNetPerSecond(index);
      const perTick = perSecond * (stepDurationMs / 1000);

      const view: ResourceView = Object.freeze({
        id,
        displayName,
        amount: snapshot.amounts[index] ?? 0,
        isUnlocked: source.state.isUnlocked(index),
        isVisible: source.state.isVisible(index),
        ...(capacity !== undefined ? { capacity } : {}),
        perTick,
      });

      views.push(view);
    }

    const frozen = Object.freeze(views);
    source.state.resetPerTickAccumulators();
    return frozen;
  }

  if (source.serialized) {
    const { serialized } = source;
    const views: ResourceView[] = [];

    for (let index = 0; index < serialized.ids.length; index += 1) {
      const id = serialized.ids[index];
      const displayName =
        source.metadata?.get(id)?.displayName ?? id;
      const capacityValue = serialized.capacities[index] ?? undefined;
      const capacity =
        capacityValue == null ? undefined : capacityValue;

      const unlocked =
        serialized.unlocked?.[index] ??
        ((serialized.flags[index] ?? 0) & FLAG_UNLOCKED) !== 0;
      const visible =
        serialized.visible?.[index] ??
        ((serialized.flags[index] ?? 0) & FLAG_VISIBLE) !== 0;

      const view: ResourceView = Object.freeze({
        id,
        displayName,
        amount: serialized.amounts[index] ?? 0,
        isUnlocked: Boolean(unlocked),
        isVisible: Boolean(visible),
        ...(capacity !== undefined ? { capacity } : {}),
        perTick: 0,
      });

      views.push(view);
    }

    return Object.freeze(views);
  }

  return EMPTY_ARRAY as readonly ResourceView[];
}

function createGeneratorViews(
  step: number,
  generators: readonly ProgressionGeneratorState[] | undefined,
  evaluator: GeneratorPurchaseEvaluator | undefined,
): readonly GeneratorView[] {
  if (!generators || generators.length === 0) {
    return EMPTY_ARRAY as readonly GeneratorView[];
  }

  const views: GeneratorView[] = [];

  for (const generator of generators) {
    const quote = evaluateGeneratorCosts(evaluator, generator.id);

    const produces = normalizeRates(generator.produces);
    const consumes = normalizeRates(generator.consumes);
    const nextPurchaseReadyAtStep =
      generator.nextPurchaseReadyAtStep ?? step + 1;

    const view: GeneratorView = Object.freeze({
      id: generator.id,
      displayName: generator.displayName ?? generator.id,
      owned: Number.isFinite(generator.owned) ? generator.owned : 0,
      enabled: generator.enabled ?? true,
      isUnlocked: Boolean(generator.isUnlocked),
      isVisible: Boolean(generator.isVisible),
      costs: quote,
      produces,
      consumes,
      nextPurchaseReadyAtStep,
    });

    views.push(view);
  }

  return Object.freeze(views);
}

function createUpgradeViews(
  upgrades: readonly ProgressionUpgradeState[] | undefined,
  evaluator: UpgradePurchaseEvaluator | undefined,
): readonly UpgradeView[] {
  if (!upgrades || upgrades.length === 0) {
    return EMPTY_ARRAY as readonly UpgradeView[];
  }

  const views: UpgradeView[] = [];

  for (const upgrade of upgrades) {
    const quote = evaluateUpgradeQuote(evaluator, upgrade.id);
    const costs =
      quote?.costs ??
      upgrade.costs ??
      (EMPTY_ARRAY as readonly UpgradeResourceCost[]);
    const normalizedCosts = normalizeUpgradeCosts(costs);
    const status = quote?.status ?? upgrade.status ?? 'locked';

    const view: UpgradeView = Object.freeze({
      id: upgrade.id,
      displayName: upgrade.displayName ?? upgrade.id,
      status,
      costs: normalizedCosts.length > 0 ? normalizedCosts : undefined,
      unlockHint: upgrade.unlockHint,
      isVisible: Boolean(upgrade.isVisible),
    });

    views.push(view);
  }

  return Object.freeze(views);
}

function normalizeRates(
  rates: readonly GeneratorRateView[] | undefined,
): readonly GeneratorRateView[] {
  if (!rates || rates.length === 0) {
    return EMPTY_ARRAY as readonly GeneratorRateView[];
  }

  return Object.freeze(
    rates.map((rate) =>
      Object.freeze({
        resourceId: rate.resourceId,
        rate: Number.isFinite(rate.rate) ? rate.rate : 0,
      }),
    ),
  );
}

function evaluateGeneratorCosts(
  evaluator: GeneratorPurchaseEvaluator | undefined,
  generatorId: string,
): readonly GeneratorCostView[] {
  if (!evaluator) {
    return EMPTY_ARRAY as readonly GeneratorCostView[];
  }

  let quote: GeneratorPurchaseQuote | undefined;
  try {
    quote = evaluator.getPurchaseQuote(generatorId, 1);
  } catch {
    return EMPTY_ARRAY as readonly GeneratorCostView[];
  }

  if (!quote || !Array.isArray(quote.costs)) {
    return EMPTY_ARRAY as readonly GeneratorCostView[];
  }

  return normalizeGeneratorCosts(quote.costs);
}

function normalizeGeneratorCosts(
  costs: readonly GeneratorResourceCost[],
): readonly GeneratorCostView[] {
  if (!costs || costs.length === 0) {
    return EMPTY_ARRAY as readonly GeneratorCostView[];
  }

  const views: GeneratorCostView[] = [];

  for (const cost of costs) {
    if (typeof cost.resourceId !== 'string') {
      continue;
    }
    const amount = Number(cost.amount);
    if (!Number.isFinite(amount) || amount < 0) {
      continue;
    }
    views.push(
      Object.freeze({
        resourceId: cost.resourceId,
        amount,
      }),
    );
  }

  return views.length > 0
    ? Object.freeze(views)
    : (EMPTY_ARRAY as readonly GeneratorCostView[]);
}

function evaluateUpgradeQuote(
  evaluator: UpgradePurchaseEvaluator | undefined,
  upgradeId: string,
): UpgradePurchaseQuote | undefined {
  if (!evaluator) {
    return undefined;
  }

  try {
    return evaluator.getPurchaseQuote(upgradeId);
  } catch {
    return undefined;
  }
}

function normalizeUpgradeCosts(
  costs: readonly UpgradeResourceCost[],
): readonly UpgradeCostView[] {
  if (!costs || costs.length === 0) {
    return EMPTY_ARRAY as readonly UpgradeCostView[];
  }

  const views: UpgradeCostView[] = [];

  for (const cost of costs) {
    if (typeof cost?.resourceId !== 'string') {
      continue;
    }
    const amount = Number(cost.amount);
    if (!Number.isFinite(amount) || amount < 0) {
      continue;
    }
    views.push(
      Object.freeze({
        resourceId: cost.resourceId,
        amount,
      }),
    );
  }

  return views.length > 0
    ? Object.freeze(views)
    : (EMPTY_ARRAY as readonly UpgradeCostView[]);
}

function createPrestigeLayerViews(
  prestigeLayers: readonly ProgressionPrestigeLayerState[] | undefined,
  evaluator: PrestigeSystemEvaluator | undefined,
): readonly PrestigeLayerView[] {
  if (!prestigeLayers || prestigeLayers.length === 0) {
    return EMPTY_ARRAY as readonly PrestigeLayerView[];
  }

  const views: PrestigeLayerView[] = [];

  for (const layer of prestigeLayers) {
    const quote = evaluatePrestigeQuote(evaluator, layer.id);

    const view: PrestigeLayerView = Object.freeze({
      id: layer.id,
      displayName: layer.displayName ?? layer.id,
      summary: layer.summary,
      status: quote?.status ?? 'locked',
      unlockHint: layer.unlockHint,
      isVisible: Boolean(layer.isVisible),
      rewardPreview: quote?.reward,
      resetTargets: quote?.resetTargets ?? (EMPTY_ARRAY as readonly string[]),
      resetGenerators: quote?.resetGenerators,
      resetUpgrades: quote?.resetUpgrades,
      retainedTargets:
        quote?.retainedTargets ?? (EMPTY_ARRAY as readonly string[]),
    });

    views.push(view);
  }

  return Object.freeze(views);
}

function evaluatePrestigeQuote(
  evaluator: PrestigeSystemEvaluator | undefined,
  layerId: string,
): PrestigeQuote | undefined {
  if (!evaluator) {
    return undefined;
  }

  try {
    return evaluator.getPrestigeQuote(layerId);
  } catch {
    return undefined;
  }
}
