import type { GeneratorPurchaseEvaluator, UpgradePurchaseEvaluator, UpgradeResourceCost, UpgradeStatus } from './resource-command-handlers.js';
import type { ResourceState, SerializedResourceState } from './resource-state.js';
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
export declare function buildProgressionSnapshot(step: number, publishedAt: number, state?: ProgressionAuthoritativeState): ProgressionSnapshot;
//# sourceMappingURL=progression.d.ts.map