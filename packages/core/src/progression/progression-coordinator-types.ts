import type { NormalizedContentPack } from '@idle-engine/content-schema';

import type {
  ResourceDefinition,
  ResourceState,
  SerializedResourceState,
} from '../resource-state.js';
import type {
  GeneratorPurchaseEvaluator,
  UpgradePurchaseEvaluator,
} from '../resource-command-handlers.js';
import type {
  PrestigeSystemEvaluator,
  ProgressionAuthoritativeState,
} from '../progression.js';
import type { ConditionContext } from '../condition-evaluator.js';
import type { EventPublisher } from '../events/event-bus.js';

/**
 * Coordinates progression state for an idle game, managing resources, generators, and upgrades.
 *
 * The coordinator maintains authoritative state and provides evaluators for calculating
 * purchase costs and availability. It handles state updates per game step and supports
 * hydration from serialized saves.
 */
export interface ProgressionCoordinator {
  readonly state: ProgressionAuthoritativeState;
  readonly resourceState: ResourceState;
  readonly generatorEvaluator: GeneratorPurchaseEvaluator;
  readonly upgradeEvaluator?: UpgradePurchaseEvaluator;
  readonly prestigeEvaluator?: PrestigeSystemEvaluator;

  hydrateResources(serialized: SerializedResourceState | undefined): void;
  updateForStep(step: number, options?: { readonly events?: EventPublisher }): void;
  getLastUpdatedStep(): number;

  incrementGeneratorOwned(generatorId: string, count: number): void;
  setGeneratorEnabled(generatorId: string, enabled: boolean): boolean;
  incrementUpgradePurchases(upgradeId: string): void;
  setUpgradePurchases(upgradeId: string, purchases: number): void;

  getGrantedAutomationIds(): ReadonlySet<string>;
  getConditionContext(): ConditionContext;
  getResourceDefinition(resourceId: string): ResourceDefinition | undefined;
}

export interface ProgressionCoordinatorOptions {
  readonly content: NormalizedContentPack;
  readonly stepDurationMs: number;
  readonly initialState?: ProgressionAuthoritativeState;
  readonly onError?: (error: Error) => void;
  readonly evaluateScriptCondition?: (scriptId: string) => boolean;
  readonly getCustomMetricValue?: (metricId: string) => number;
}

