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
export type ProgressionSnapshot = Readonly<{
    step: number;
    publishedAt: number;
    resources: readonly ResourceView[];
    generators: readonly GeneratorView[];
    upgrades: readonly UpgradeView[];
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
export interface ProgressionAuthoritativeState {
    readonly stepDurationMs: number;
    readonly resources?: ProgressionResourceState;
    readonly generatorPurchases?: GeneratorPurchaseEvaluator;
    readonly generators?: readonly ProgressionGeneratorState[];
    readonly upgradePurchases?: UpgradePurchaseEvaluator;
    readonly upgrades?: readonly ProgressionUpgradeState[];
}
export declare function buildProgressionSnapshot(step: number, publishedAt: number, state?: ProgressionAuthoritativeState): ProgressionSnapshot;
//# sourceMappingURL=progression.d.ts.map