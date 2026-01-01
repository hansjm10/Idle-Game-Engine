import type { GeneratorPurchaseEvaluator, UpgradePurchaseEvaluator, UpgradeResourceCost, UpgradeStatus } from './resource-command-handlers.js';
import type { AutomationDefinition, TransformDefinition } from '@idle-engine/content-schema';
import type { AutomationState } from './automation-system.js';
import type { ConditionContext } from './condition-evaluator.js';
import type { ResourceState, SerializedResourceState } from './resource-state.js';
import type { TransformResourceState, TransformState, TransformView } from './transform-system.js';
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
export type AchievementCategory = 'progression' | 'prestige' | 'automation' | 'collection';
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
export declare function buildProgressionSnapshot(step: number, publishedAt: number, state?: ProgressionAuthoritativeState, options?: ProgressionSnapshotOptions): ProgressionSnapshot;
//# sourceMappingURL=progression.d.ts.map