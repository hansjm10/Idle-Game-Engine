import type { NormalizedContentPack } from '@idle-engine/content-schema';

import type { EngineConfigOverrides } from '../config.js';
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
 * Coordinates progression state for an idle game.
 *
 * The coordinator maintains authoritative state and exposes evaluators for quoting/applying
 * progression actions (generator purchases, upgrade purchases, prestige resets). It is also
 * responsible for evaluating unlock/visibility conditions, tracking achievements, and
 * assembling metric state for snapshots.
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
  readonly config?: EngineConfigOverrides;
  readonly initialState?: ProgressionAuthoritativeState;
  readonly onError?: (error: Error) => void;
  readonly evaluateScriptCondition?: (scriptId: string) => boolean;
  readonly getCustomMetricValue?: (metricId: string) => number;
}
