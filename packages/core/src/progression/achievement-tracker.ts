import type {
  FormulaEvaluationContext,
  NormalizedAchievement,
} from '@idle-engine/content-schema';

/**
 * AchievementTracker owns achievement state and reward application.
 *
 * Responsibilities:
 * - Evaluate achievement progress each step and mark completions deterministically
 * - Apply rewards (flags, resources, upgrades, automations, runtime events)
 * - Rebuild derived rewards on hydration (e.g. completed achievements re-grant flags)
 *
 * This module exposes a flag-value lookup for the coordinator's condition context,
 * so other unlock conditions can be gated on achievement-derived flags.
 */
import {
  compareWithComparator,
  evaluateCondition,
  type ConditionContext,
} from '../condition-evaluator.js';
import type { EventPublisher } from '../events/event-bus.js';
import type { RuntimeEventType } from '../events/runtime-event.js';
import type { ProgressionAchievementState } from '../progression.js';

import type { FormulaEvaluationContextFactory } from './formula-context.js';
import {
  evaluateFiniteNumericFormula,
  normalizeFiniteNonNegativeNumber,
  normalizeNonNegativeInt,
  normalizeOptionalNonNegativeInt,
  type Mutable,
} from './progression-utils.js';

type AchievementRecord = {
  readonly definition: NormalizedAchievement;
  readonly state: Mutable<ProgressionAchievementState>;
};

type DerivedRewardEntry = {
  readonly record: AchievementRecord;
  readonly index: number;
  readonly completedAtStep: number;
};

type AchievementRewardOptions = Readonly<{
  readonly events?: EventPublisher;
  readonly grantResource: (resourceId: string, amount: number) => void;
  readonly grantUpgrade: (upgradeId: string) => void;
  readonly onAutomationIdsChanged: () => void;
}>;

function createAchievementRecord(
  achievement: NormalizedAchievement,
  initial?: ProgressionAchievementState,
): AchievementRecord {
  const resolveLocalizedText = (
    value: unknown,
    fallback: string,
  ): string => {
    if (typeof value === 'string') {
      return value;
    }
    if (value && typeof value === 'object') {
      const record = value as { readonly default?: unknown };
      if (typeof record.default === 'string') {
        return record.default;
      }
    }
    return fallback;
  };

  const state: Mutable<ProgressionAchievementState> = initial
    ? (initial as Mutable<ProgressionAchievementState>)
    : ({
        id: achievement.id,
        displayName: resolveLocalizedText(achievement.name, achievement.id),
        description: resolveLocalizedText(achievement.description, ''),
        category: achievement.category,
        tier: achievement.tier,
        mode: achievement.progress.mode,
        isVisible: false,
        completions: 0,
        progress: 0,
        target: 0,
        nextRepeatableAtStep: undefined,
        lastCompletedStep: undefined,
      } as Mutable<ProgressionAchievementState>);

  state.id = achievement.id;
  state.displayName = resolveLocalizedText(achievement.name, achievement.id);
  state.description = resolveLocalizedText(achievement.description, '');
  state.category = achievement.category;
  state.tier = achievement.tier;
  state.mode = achievement.progress.mode;
  state.isVisible = Boolean(state.isVisible);
  state.completions = normalizeNonNegativeInt(state.completions);
  state.progress = normalizeFiniteNonNegativeNumber(state.progress);
  state.target = normalizeFiniteNonNegativeNumber(state.target);
  state.nextRepeatableAtStep = normalizeOptionalNonNegativeInt(
    state.nextRepeatableAtStep,
  );
  state.lastCompletedStep = normalizeOptionalNonNegativeInt(
    state.lastCompletedStep,
  );

  return {
    definition: achievement,
    state,
  };
}

export class AchievementTracker {
  private readonly achievementList: AchievementRecord[];
  private readonly achievementFlagState = new Map<string, boolean>();
  private readonly grantedAutomationIds = new Set<string>();
  private readonly onError?: (error: Error) => void;
  private readonly createFormulaEvaluationContext: FormulaEvaluationContextFactory;
  private readonly getCustomMetricValue?: (metricId: string) => number;

  constructor(options: {
    readonly achievements: readonly NormalizedAchievement[];
    readonly initialState?: readonly ProgressionAchievementState[];
    readonly createFormulaEvaluationContext: FormulaEvaluationContextFactory;
    readonly onError?: (error: Error) => void;
    readonly getCustomMetricValue?: (metricId: string) => number;
  }) {
    this.onError = options.onError;
    this.createFormulaEvaluationContext = options.createFormulaEvaluationContext;
    this.getCustomMetricValue = options.getCustomMetricValue;

    const initialAchievements = new Map(
      (options.initialState ?? []).map((achievement) => [achievement.id, achievement]),
    );
    this.achievementList = options.achievements.map((achievement) =>
      createAchievementRecord(achievement, initialAchievements.get(achievement.id)),
    );
  }

  getAchievementStates(): readonly ProgressionAchievementState[] | undefined {
    if (this.achievementList.length === 0) {
      return undefined;
    }
    return this.achievementList.map((record) => record.state);
  }

  getAchievementCount(): number {
    return this.achievementList.length;
  }

  getFlagValue(flagId: string): boolean | undefined {
    return this.achievementFlagState.get(flagId);
  }

  getGrantedAutomationIds(): ReadonlySet<string> {
    return this.grantedAutomationIds;
  }

  private collectDerivedRewardEntries(): DerivedRewardEntry[] {
    const completed: DerivedRewardEntry[] = [];

    for (let index = 0; index < this.achievementList.length; index += 1) {
      const record = this.achievementList[index];
      const state = record.state;
      const completions = normalizeNonNegativeInt(state.completions);
      state.completions = completions;
      if (completions <= 0) {
        continue;
      }

      const reward = record.definition.reward;
      if (!reward || (reward.kind !== 'grantFlag' && reward.kind !== 'unlockAutomation')) {
        continue;
      }

      const completedAtStep = Number(state.lastCompletedStep);
      completed.push({
        record,
        index,
        completedAtStep:
          Number.isFinite(completedAtStep) && completedAtStep >= 0
            ? Math.floor(completedAtStep)
            : -1,
      });
    }

    completed.sort((left, right) => {
      if (left.completedAtStep !== right.completedAtStep) {
        return left.completedAtStep - right.completedAtStep;
      }
      return left.index - right.index;
    });

    return completed;
  }

  private applyDerivedRewardEntries(entries: readonly DerivedRewardEntry[]): void {
    for (const entry of entries) {
      const reward = entry.record.definition.reward;
      if (!reward) {
        continue;
      }
      if (reward.kind === 'grantFlag') {
        this.achievementFlagState.set(reward.flagId, reward.value);
      } else if (reward.kind === 'unlockAutomation') {
        this.grantedAutomationIds.add(reward.automationId);
      }
    }
  }

  rebuildDerivedRewards(onAutomationIdsChanged: () => void): void {
    this.achievementFlagState.clear();
    this.grantedAutomationIds.clear();

    this.applyDerivedRewardEntries(this.collectDerivedRewardEntries());
    onAutomationIdsChanged();
  }

  private computeAchievementTarget(
    achievement: NormalizedAchievement,
    context: FormulaEvaluationContext,
  ): number {
    const targetValue =
      evaluateFiniteNumericFormula(
        achievement.progress.target,
        context,
        this.onError,
        `Achievement target evaluation for "${achievement.id}"`,
      ) ?? 0;
    return targetValue > 0 ? targetValue : 1;
  }

  private computeAchievementVisibility(
    achievement: NormalizedAchievement,
    completions: number,
    eligible: boolean,
    conditionContext: ConditionContext,
  ): boolean {
    return (
      completions > 0 ||
      (eligible &&
        evaluateCondition(achievement.visibilityCondition, conditionContext))
    );
  }

  private updateRepeatableAchievementForStep(
    record: AchievementRecord,
    step: number,
    conditionContext: ConditionContext,
    formulaContext: FormulaEvaluationContext,
    target: number,
    eligible: boolean,
    completions: number,
    options: AchievementRewardOptions,
  ): boolean {
    const definition = record.definition;
    const state = record.state;
    const repeatable = definition.progress.repeatable;
    const maxRepeats = normalizeOptionalNonNegativeInt(repeatable?.maxRepeats);

    if (maxRepeats !== undefined && completions >= maxRepeats) {
      state.progress = Math.max(
        normalizeFiniteNonNegativeNumber(state.progress),
        target,
      );
      state.nextRepeatableAtStep = undefined;
      return false;
    }

    const nextRepeatableAtStep = normalizeOptionalNonNegativeInt(
      state.nextRepeatableAtStep,
    );

    if (nextRepeatableAtStep !== undefined && step < nextRepeatableAtStep) {
      state.nextRepeatableAtStep = nextRepeatableAtStep;
      state.progress = Math.max(
        normalizeFiniteNonNegativeNumber(state.progress),
        target,
      );
      return false;
    }

    const measurement = this.getAchievementTrackValue(definition, conditionContext);
    state.progress = normalizeFiniteNonNegativeNumber(measurement);

    if (!eligible) {
      return false;
    }

    const complete = this.isAchievementTrackComplete(
      definition,
      measurement,
      target,
      conditionContext,
    );
    if (!complete) {
      return false;
    }

    state.completions = completions + 1;
    state.lastCompletedStep = step;
    state.progress = target;

    const resetWindowTicks =
      repeatable?.resetWindow &&
      evaluateFiniteNumericFormula(
        repeatable.resetWindow,
        formulaContext,
        this.onError,
        `Achievement resetWindow evaluation for "${definition.id}"`,
      );
    const resetWindow = normalizeOptionalNonNegativeInt(resetWindowTicks) ?? 1;

    const nextEligibleAt = step + Math.max(1, resetWindow);
    state.nextRepeatableAtStep =
      maxRepeats !== undefined && state.completions >= maxRepeats
        ? undefined
        : nextEligibleAt;

    this.applyAchievementReward(definition, formulaContext, options);
    return true;
  }

  private updateSingleAchievementForStep(
    record: AchievementRecord,
    step: number,
    conditionContext: ConditionContext,
    formulaContext: FormulaEvaluationContext,
    target: number,
    eligible: boolean,
    completions: number,
    options: AchievementRewardOptions,
  ): boolean {
    const definition = record.definition;
    const state = record.state;

    if (completions > 0) {
      state.progress = Math.max(
        normalizeFiniteNonNegativeNumber(state.progress),
        target,
      );
      return false;
    }

    if (!eligible) {
      state.progress = 0;
      return false;
    }

    const measurement = this.getAchievementTrackValue(definition, conditionContext);
    state.progress = Math.max(
      normalizeFiniteNonNegativeNumber(state.progress),
      normalizeFiniteNonNegativeNumber(measurement),
    );

    const complete = this.isAchievementTrackComplete(
      definition,
      measurement,
      target,
      conditionContext,
    );
    if (!complete) {
      return false;
    }

    state.completions = 1;
    state.lastCompletedStep = step;
    state.progress = target;
    state.nextRepeatableAtStep = undefined;

    this.applyAchievementReward(definition, formulaContext, options);
    return true;
  }

  updateForStep(
    step: number,
    conditionContext: ConditionContext,
    options: AchievementRewardOptions,
  ): boolean {
    if (this.achievementList.length === 0) {
      return false;
    }

    let completedAny = false;

    for (const record of this.achievementList) {
      const definition = record.definition;
      const state = record.state;

      const completions = normalizeNonNegativeInt(state.completions);
      state.completions = completions;

      const nextCompletionIndex =
        state.mode === 'repeatable' ? completions + 1 : 1;
      const formulaContext = this.createFormulaEvaluationContext(
        nextCompletionIndex,
        step,
      );

      const target = this.computeAchievementTarget(definition, formulaContext);
      state.target = target;

      const eligible = evaluateCondition(
        definition.unlockCondition,
        conditionContext,
      );

      state.isVisible = this.computeAchievementVisibility(
        definition,
        completions,
        eligible,
        conditionContext,
      );

      const completed =
        state.mode === 'repeatable'
          ? this.updateRepeatableAchievementForStep(
              record,
              step,
              conditionContext,
              formulaContext,
              target,
              eligible,
              completions,
              options,
            )
          : this.updateSingleAchievementForStep(
              record,
              step,
              conditionContext,
              formulaContext,
              target,
              eligible,
              completions,
              options,
            );

      if (completed) {
        completedAny = true;
      }
    }

    return completedAny;
  }

  private getAchievementTrackValue(
    achievement: NormalizedAchievement,
    conditionContext: ConditionContext,
  ): number {
    switch (achievement.track.kind) {
      case 'resource':
        return conditionContext.getResourceAmount(achievement.track.resourceId);
      case 'generator-level':
        return conditionContext.getGeneratorLevel(achievement.track.generatorId);
      case 'upgrade-owned':
        return conditionContext.getUpgradePurchases(achievement.track.upgradeId);
      case 'flag':
        return conditionContext.isFlagSet?.(achievement.track.flagId) ? 1 : 0;
      case 'script':
        return conditionContext.evaluateScriptCondition?.(achievement.track.scriptId)
          ? 1
          : 0;
      case 'custom-metric': {
        const value = this.getCustomMetricValue?.(achievement.track.metricId);
        return typeof value === 'number' && Number.isFinite(value) ? value : 0;
      }
      default:
        return 0;
    }
  }

  private isAchievementTrackComplete(
    achievement: NormalizedAchievement,
    measurement: number,
    target: number,
    conditionContext: ConditionContext,
  ): boolean {
    const left = Number.isFinite(measurement) ? measurement : 0;
    const right = Number.isFinite(target) ? target : 0;

    if (achievement.track.kind === 'resource') {
      return compareWithComparator(left, right, achievement.track.comparator, conditionContext);
    }

    return compareWithComparator(left, right, 'gte', conditionContext);
  }

  private applyAchievementReward(
    achievement: NormalizedAchievement,
    context: FormulaEvaluationContext,
    options: AchievementRewardOptions,
  ): void {
    const reward = achievement.reward;
    let rewardScaling = 1;
    if (achievement.progress.mode === 'repeatable') {
      const scalingFormula = achievement.progress.repeatable?.rewardScaling;
      if (scalingFormula) {
        const scaling =
          evaluateFiniteNumericFormula(
            scalingFormula,
            context,
            this.onError,
            `Achievement rewardScaling evaluation for "${achievement.id}"`,
          ) ?? 1;
        rewardScaling = Number.isFinite(scaling) ? scaling : 1;
      }
    }

    if (reward?.kind === 'grantResource') {
      const amount =
        evaluateFiniteNumericFormula(
          reward.amount,
          context,
          this.onError,
          `Achievement reward evaluation for "${achievement.id}" (${reward.kind})`,
        ) ?? 0;
      options.grantResource(reward.resourceId, amount * rewardScaling);
    } else if (reward?.kind === 'grantUpgrade') {
      options.grantUpgrade(reward.upgradeId);
    } else if (reward?.kind === 'unlockAutomation') {
      this.grantedAutomationIds.add(reward.automationId);
      options.onAutomationIdsChanged();
    } else if (reward?.kind === 'grantFlag') {
      this.achievementFlagState.set(reward.flagId, reward.value);
    } else if (reward?.kind === 'emitEvent') {
      this.publishAchievementEvent(reward.eventId, options.events);
    }

    for (const eventId of achievement.onUnlockEvents) {
      this.publishAchievementEvent(eventId, options.events);
    }
  }

  private publishAchievementEvent(
    eventId: string,
    publisher: EventPublisher | undefined,
  ): void {
    if (!publisher) {
      return;
    }

    try {
      publisher.publish(eventId as RuntimeEventType, {});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.onError?.(
        new Error(
          `Achievement event publish failed for "${eventId}": ${message}`,
        ),
      );
    }
  }
}
