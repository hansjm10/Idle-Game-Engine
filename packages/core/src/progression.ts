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
  AutomationDefinition,
  TransformDefinition,
} from '@idle-engine/content-schema';
import type { AutomationState } from './automation-system.js';
import { evaluateCondition } from './condition-evaluator.js';
import type { ConditionContext } from './condition-evaluator.js';
import type {
  ResourceState,
  SerializedResourceState,
} from './resource-state.js';
import { buildTransformSnapshot } from './transform-system.js';
import type {
  TransformResourceState,
  TransformState,
  TransformView,
} from './transform-system.js';

const EMPTY_ARRAY: readonly never[] = Object.freeze([]);
const FLAG_VISIBLE = 1 << 0;
const FLAG_UNLOCKED = 1 << 1;
const compareStableStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export type GeneratorRateView = Readonly<{
  resourceId: string;
  rate: number;
}>;

export type GeneratorCostView = Readonly<{
  resourceId: string;
  amount: number;
  canAfford: boolean;
  currentAmount?: number;
}>;

export type ResourceView = Readonly<{
  id: string;
  displayName: string;
  amount: number;
  unlocked: boolean;
  visible: boolean;
  capacity?: number;
  perSecond: number;
  perTick: number;
}>;

export type GeneratorView = Readonly<{
  id: string;
  displayName: string;
  owned: number;
  enabled: boolean;
  unlocked: boolean;
  visible: boolean;
  unlockHint?: string;
  costs: readonly GeneratorCostView[];
  canAfford: boolean;
  produces: readonly GeneratorRateView[];
  consumes: readonly GeneratorRateView[];
  nextPurchaseReadyAtStep: number;
}>;

export type UpgradeCostView = Readonly<{
  resourceId: string;
  amount: number;
  canAfford: boolean;
  currentAmount?: number;
}>;

export type UpgradeView = Readonly<{
  id: string;
  displayName: string;
  status: UpgradeStatus;
  canAfford: boolean;
  costs?: readonly UpgradeCostView[];
  unlockHint?: string;
  visible: boolean;
}>;

export type AchievementCategory =
  | 'progression'
  | 'prestige'
  | 'automation'
  | 'collection';

export type AchievementTier = 'bronze' | 'silver' | 'gold' | 'platinum';

export type AchievementProgressMode = 'oneShot' | 'incremental' | 'repeatable';

export type AchievementView = Readonly<{
  id: string;
  displayName: string;
  description: string;
  category: AchievementCategory;
  tier: AchievementTier;
  mode: AchievementProgressMode;
  visible: boolean;
  unlocked: boolean;
  completions: number;
  progress: number;
  target: number;
  nextRepeatableAtStep?: number;
  lastCompletedStep?: number;
}>;

export type AutomationView = Readonly<{
  id: string;
  displayName: string;
  description: string;
  unlocked: boolean;
  visible: boolean;
  isEnabled: boolean;
  lastTriggeredAt: number | null;
  cooldownRemainingMs: number;
  isOnCooldown: boolean;
}>;

export interface ProgressionAchievementState {
  readonly id: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly category: AchievementCategory;
  readonly tier: AchievementTier;
  readonly mode: AchievementProgressMode;
  readonly isVisible: boolean;
  readonly completions: number;
  readonly progress: number;
  readonly target: number;
  readonly nextRepeatableAtStep?: number;
  readonly lastCompletedStep?: number;
}

export interface ProgressionAutomationState {
  readonly definitions: readonly AutomationDefinition[];
  readonly state: ReadonlyMap<string, AutomationState>;
  readonly conditionContext?: ConditionContext;
}

export interface ProgressionTransformState {
  readonly definitions: readonly TransformDefinition[];
  readonly state: ReadonlyMap<string, TransformState>;
  readonly resourceState: TransformResourceState;
  readonly conditionContext?: ConditionContext;
}

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
  visible: boolean;
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
  automations: readonly AutomationView[];
  transforms: readonly TransformView[];
  achievements?: readonly AchievementView[];
  prestigeLayers: readonly PrestigeLayerView[];
}>;

/**
 * Options for building a progression snapshot.
 */
export interface ProgressionSnapshotOptions {
  /**
   * Whether to reset per-tick accumulators (income, expense, netPerSecond, tickDelta)
   * after building the snapshot. When true (the default), the snapshot "consumes"
   * the accumulator data, resetting it for the next tick.
   *
   * Set to false when you need to build a snapshot without consuming the accumulator
   * data - for example, when deriving long-lived metrics or when multiple consumers
   * need access to the same tick's data.
   *
   * **Warning:** When set to false, you MUST manually call
   * `resourceState.resetPerTickAccumulators()` before the next tick's rate
   * application (e.g., before `finalizeTick`). Failing to do so will cause
   * rates to accumulate incorrectly, resulting in double-counting bugs.
   *
   * @default true
   */
  readonly resetAccumulators?: boolean;
}

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
  readonly unlockHint?: string;
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
  readonly automations?: ProgressionAutomationState;
  readonly transforms?: ProgressionTransformState;
  readonly achievements?: readonly ProgressionAchievementState[];
  readonly prestigeSystem?: PrestigeSystemEvaluator;
  readonly prestigeLayers?: readonly ProgressionPrestigeLayerState[];
}

/**
 * Builds a UI-ready progression snapshot from authoritative game state.
 *
 * By default, this function resets per-tick accumulators after building the snapshot,
 * "consuming" the accumulator data. Pass `{ resetAccumulators: false }` to build a
 * snapshot without resetting accumulators - useful when deriving long-lived metrics
 * or when multiple consumers need access to the same tick's data.
 *
 * **Note:** When using `resetAccumulators: false`, you are responsible for manually
 * calling `resetPerTickAccumulators()` before the next tick to prevent double-counting.
 *
 * @param step - The current simulation step number
 * @param publishedAt - Timestamp when the snapshot is published (ms since epoch)
 * @param state - The authoritative game state to snapshot
 * @param options - Snapshot options (optional)
 * @returns A frozen ProgressionSnapshot object
 */
export function buildProgressionSnapshot(
  step: number,
  publishedAt: number,
  state?: ProgressionAuthoritativeState,
  options?: ProgressionSnapshotOptions,
): ProgressionSnapshot {
  const resetAccumulators = options?.resetAccumulators ?? true;
  const stepDurationMs = state?.stepDurationMs ?? 100;
  const resources = createResourceViews(stepDurationMs, state?.resources, resetAccumulators);
  const resourceAmounts = createResourceAmountLookup(resources);
  const generators = createGeneratorViews(
    step,
    state?.generators,
    state?.generatorPurchases,
    resourceAmounts,
  );
  const upgrades = createUpgradeViews(
    state?.upgrades,
    state?.upgradePurchases,
    resourceAmounts,
  );
  const automations = createAutomationViews(
    step,
    publishedAt,
    stepDurationMs,
    state?.automations,
  );
  const transforms = createTransformViews(
    step,
    publishedAt,
    stepDurationMs,
    state?.transforms,
  );
  const achievements = createAchievementViews(state?.achievements);
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
    automations,
    transforms,
    ...(achievements ? { achievements } : {}),
    prestigeLayers,
  });
}

function createResourceViews(
  stepDurationMs: number,
  source?: ProgressionResourceState,
  resetAccumulators = true,
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
        unlocked: source.state.isUnlocked(index),
        visible: source.state.isVisible(index),
        ...(capacity !== undefined ? { capacity } : {}),
        perSecond,
        perTick,
      });

      views.push(view);
    }

    const frozen = Object.freeze(views);
    if (resetAccumulators) {
      source.state.resetPerTickAccumulators();
    }
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
        unlocked: Boolean(unlocked),
        visible: Boolean(visible),
        ...(capacity !== undefined ? { capacity } : {}),
        perSecond: 0,
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
  resourceAmounts: ReadonlyMap<string, number>,
): readonly GeneratorView[] {
  if (!generators || generators.length === 0) {
    return EMPTY_ARRAY as readonly GeneratorView[];
  }

  const views: GeneratorView[] = [];

  for (const generator of generators) {
    const quote = evaluateGeneratorCosts(
      evaluator,
      generator.id,
      resourceAmounts,
    );

    const produces = normalizeRates(generator.produces);
    const consumes = normalizeRates(generator.consumes);
    const nextPurchaseReadyAtStep =
      generator.nextPurchaseReadyAtStep ?? step + 1;
    const unlockHint =
      typeof generator.unlockHint === 'string' && generator.unlockHint.trim().length > 0
        ? generator.unlockHint
        : undefined;
    const canAfford = areCostsAffordable(resourceAmounts, quote);

    const view: GeneratorView = Object.freeze({
      id: generator.id,
      displayName: generator.displayName ?? generator.id,
      owned: Number.isFinite(generator.owned) ? generator.owned : 0,
      enabled: generator.enabled ?? true,
      unlocked: Boolean(generator.isUnlocked),
      visible: Boolean(generator.isVisible),
      ...(unlockHint ? { unlockHint } : {}),
      costs: quote,
      canAfford,
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
  resourceAmounts: ReadonlyMap<string, number>,
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
    const normalizedCosts = normalizeUpgradeCosts(
      costs,
      resourceAmounts,
    );
    const status = quote?.status ?? upgrade.status ?? 'locked';
    const unlockHint =
      typeof upgrade.unlockHint === 'string' && upgrade.unlockHint.trim().length > 0
        ? upgrade.unlockHint
        : undefined;
    const canAfford = areCostsAffordable(resourceAmounts, normalizedCosts);

    const view: UpgradeView = Object.freeze({
      id: upgrade.id,
      displayName: upgrade.displayName ?? upgrade.id,
      status,
      canAfford,
      costs: normalizedCosts.length > 0 ? normalizedCosts : undefined,
      ...(unlockHint ? { unlockHint } : {}),
      visible: Boolean(upgrade.isVisible),
    });

    views.push(view);
  }

  return Object.freeze(views);
}

function createAchievementViews(
  achievements: readonly ProgressionAchievementState[] | undefined,
): readonly AchievementView[] | undefined {
  if (!achievements || achievements.length === 0) {
    return undefined;
  }

  const views: AchievementView[] = [];

  for (const achievement of achievements) {
    const progress = Number(achievement.progress);
    const target = Number(achievement.target);
    const completions = Number(achievement.completions);
    const nextRepeatableAtStep = Number(achievement.nextRepeatableAtStep);
    const lastCompletedStep = Number(achievement.lastCompletedStep);

    const view: AchievementView = Object.freeze({
      id: achievement.id,
      displayName: achievement.displayName ?? achievement.id,
      description: achievement.description ?? '',
      category: achievement.category,
      tier: achievement.tier,
      mode: achievement.mode,
      visible: Boolean(achievement.isVisible),
      unlocked:
        Number.isFinite(completions) && completions > 0,
      completions:
        Number.isFinite(completions) && completions > 0
          ? Math.floor(completions)
          : 0,
      progress:
        Number.isFinite(progress) ? progress : 0,
      target:
        Number.isFinite(target) ? target : 0,
      ...(Number.isFinite(nextRepeatableAtStep) && nextRepeatableAtStep >= 0
        ? { nextRepeatableAtStep: Math.floor(nextRepeatableAtStep) }
        : {}),
      ...(Number.isFinite(lastCompletedStep) && lastCompletedStep >= 0
        ? { lastCompletedStep: Math.floor(lastCompletedStep) }
        : {}),
    });

    views.push(view);
  }

  return views.length > 0 ? Object.freeze(views) : undefined;
}

function createAutomationViews(
  step: number,
  publishedAt: number,
  stepDurationMs: number,
  source: ProgressionAutomationState | undefined,
): readonly AutomationView[] {
  if (!source || source.definitions.length === 0) {
    return EMPTY_ARRAY as readonly AutomationView[];
  }

  const safeStepDurationMs =
    Number.isFinite(stepDurationMs) && stepDurationMs >= 0 ? stepDurationMs : 0;
  const sorted = [...source.definitions].sort((left, right) => {
    const orderA = left.order ?? 0;
    const orderB = right.order ?? 0;
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return compareStableStrings(left.id, right.id);
  });

  const views: AutomationView[] = [];
  const conditionContext = source.conditionContext;

  for (const automation of sorted) {
    const state = source.state.get(automation.id);
    const unlocked = state?.unlocked ?? false;
    const visible =
      automation.visibilityCondition && conditionContext
        ? evaluateCondition(automation.visibilityCondition, conditionContext)
        : unlocked;
    const rawCooldownExpiresStep = state?.cooldownExpiresStep;
    const cooldownExpiresStep = Number.isFinite(rawCooldownExpiresStep)
      ? Number(rawCooldownExpiresStep)
      : 0;
    const cooldownRemainingMs = Math.max(
      0,
      (cooldownExpiresStep - step) * safeStepDurationMs,
    );
    const rawLastFiredStep = state?.lastFiredStep;
    const lastFiredStep = Number.isFinite(rawLastFiredStep)
      ? Number(rawLastFiredStep)
      : null;
    const lastTriggeredAt =
      lastFiredStep !== null && lastFiredStep >= 0
        ? publishedAt - (step - lastFiredStep) * safeStepDurationMs
        : null;

    views.push(
      Object.freeze({
        id: automation.id,
        displayName: automation.name.default,
        description: automation.description.default,
        unlocked,
        visible,
        isEnabled: state?.enabled ?? automation.enabledByDefault ?? false,
        lastTriggeredAt,
        cooldownRemainingMs,
        isOnCooldown: cooldownRemainingMs > 0,
      }),
    );
  }

  return Object.freeze(views);
}

function createTransformViews(
  step: number,
  publishedAt: number,
  stepDurationMs: number,
  source: ProgressionTransformState | undefined,
): readonly TransformView[] {
  if (!source || source.definitions.length === 0) {
    return EMPTY_ARRAY as readonly TransformView[];
  }

  const snapshot = buildTransformSnapshot(step, publishedAt, {
    transforms: source.definitions,
    state: source.state,
    stepDurationMs,
    resourceState: source.resourceState,
    conditionContext: source.conditionContext,
  });

  return snapshot.transforms;
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
  resourceAmounts: ReadonlyMap<string, number>,
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

  return normalizeGeneratorCosts(quote.costs, resourceAmounts);
}

function normalizeGeneratorCosts(
  costs: readonly GeneratorResourceCost[],
  resourceAmounts: ReadonlyMap<string, number>,
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
    const currentAmount = resolveCurrentAmount(
      resourceAmounts,
      cost.resourceId,
    );
    const canAfford = isCostAffordable(
      resourceAmounts,
      cost.resourceId,
      amount,
    );
    views.push(
      Object.freeze({
        resourceId: cost.resourceId,
        amount,
        canAfford,
        ...(currentAmount !== undefined ? { currentAmount } : {}),
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
  resourceAmounts: ReadonlyMap<string, number>,
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
    const currentAmount = resolveCurrentAmount(
      resourceAmounts,
      cost.resourceId,
    );
    const canAfford = isCostAffordable(
      resourceAmounts,
      cost.resourceId,
      amount,
    );
    views.push(
      Object.freeze({
        resourceId: cost.resourceId,
        amount,
        canAfford,
        ...(currentAmount !== undefined ? { currentAmount } : {}),
      }),
    );
  }

  return views.length > 0
    ? Object.freeze(views)
    : (EMPTY_ARRAY as readonly UpgradeCostView[]);
}

function isCostAffordable(
  amountsByResourceId: ReadonlyMap<string, number>,
  resourceId: string,
  amount: number,
): boolean {
  const available = amountsByResourceId.get(resourceId);
  if (available === undefined || !Number.isFinite(available)) {
    return false;
  }

  if (!Number.isFinite(amount) || amount < 0) {
    return false;
  }

  return available >= amount;
}

function resolveCurrentAmount(
  amountsByResourceId: ReadonlyMap<string, number>,
  resourceId: string,
): number | undefined {
  const currentAmount = amountsByResourceId.get(resourceId);
  return Number.isFinite(currentAmount) ? currentAmount : undefined;
}

function areCostsAffordable(
  amountsByResourceId: ReadonlyMap<string, number>,
  costs: readonly GeneratorCostView[] | readonly UpgradeCostView[] | undefined,
): boolean {
  if (!costs || costs.length === 0) {
    return true;
  }

  for (const cost of costs) {
    if (!isCostAffordable(amountsByResourceId, cost.resourceId, cost.amount)) {
      return false;
    }
  }

  return true;
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
    const unlockHint =
      typeof layer.unlockHint === 'string' && layer.unlockHint.trim().length > 0
        ? layer.unlockHint
        : undefined;

    const view: PrestigeLayerView = Object.freeze({
      id: layer.id,
      displayName: layer.displayName ?? layer.id,
      summary: layer.summary,
      status: quote?.status ?? 'locked',
      ...(unlockHint ? { unlockHint } : {}),
      visible: Boolean(layer.isVisible),
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
