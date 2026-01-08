import type { NormalizedAchievement } from '@idle-engine/content-schema';
import type { FormulaEvaluationContext } from '@idle-engine/content-schema';

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

  rebuildDerivedRewards(onAutomationIdsChanged: () => void): void {
    this.achievementFlagState.clear();
    this.grantedAutomationIds.clear();

    if (this.achievementList.length === 0) {
      onAutomationIdsChanged();
      return;
    }

    const completed: Array<{
      readonly record: AchievementRecord;
      readonly index: number;
      readonly completedAtStep: number;
    }> = [];

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

    for (const entry of completed) {
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

    onAutomationIdsChanged();
  }

  updateForStep(
    step: number,
    conditionContext: ConditionContext,
    options: {
      readonly events?: EventPublisher;
      readonly grantResource: (resourceId: string, amount: number) => void;
      readonly grantUpgrade: (upgradeId: string) => void;
      readonly onAutomationIdsChanged: () => void;
    },
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

      const targetValue =
        evaluateFiniteNumericFormula(
          definition.progress.target,
          formulaContext,
          this.onError,
          `Achievement target evaluation for "${definition.id}"`,
        ) ?? 0;
      const target = targetValue > 0 ? targetValue : 1;
      state.target = target;

      const eligible = evaluateCondition(
        definition.unlockCondition,
        conditionContext,
      );

      const visible =
        completions > 0 ||
        (eligible &&
          evaluateCondition(definition.visibilityCondition, conditionContext));
      state.isVisible = visible;

      if (state.mode === 'repeatable') {
        const repeatable = definition.progress.repeatable;
        const maxRepeats = normalizeOptionalNonNegativeInt(repeatable?.maxRepeats);
        if (maxRepeats !== undefined && completions >= maxRepeats) {
          state.progress = Math.max(
            normalizeFiniteNonNegativeNumber(state.progress),
            target,
          );
          state.nextRepeatableAtStep = undefined;
          continue;
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
          continue;
        }

        const measurement = this.getAchievementTrackValue(definition, conditionContext);
        state.progress = normalizeFiniteNonNegativeNumber(measurement);

        if (!eligible) {
          continue;
        }

        const complete = this.isAchievementTrackComplete(
          definition,
          measurement,
          target,
          conditionContext,
        );
        if (!complete) {
          continue;
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
        const resetWindow =
          normalizeOptionalNonNegativeInt(resetWindowTicks) ?? 1;

        const nextEligibleAt = step + Math.max(1, resetWindow);
        state.nextRepeatableAtStep =
          maxRepeats !== undefined && state.completions >= maxRepeats
            ? undefined
            : nextEligibleAt;

        this.applyAchievementReward(definition, formulaContext, options);
        completedAny = true;
        continue;
      }

      if (!eligible && completions === 0) {
        state.progress = 0;
        continue;
      }

      if (completions > 0) {
        state.progress = Math.max(
          normalizeFiniteNonNegativeNumber(state.progress),
          target,
        );
        continue;
      }

      const measurement = this.getAchievementTrackValue(definition, conditionContext);
      state.progress = Math.max(
        normalizeFiniteNonNegativeNumber(state.progress),
        normalizeFiniteNonNegativeNumber(measurement),
      );

      const complete =
        eligible &&
        this.isAchievementTrackComplete(
          definition,
          measurement,
          target,
          conditionContext,
        );
      if (!complete) {
        continue;
      }

      state.completions = 1;
      state.lastCompletedStep = step;
      state.progress = target;
      state.nextRepeatableAtStep = undefined;

      this.applyAchievementReward(definition, formulaContext, options);
      completedAny = true;
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
    options: {
      readonly events?: EventPublisher;
      readonly grantResource: (resourceId: string, amount: number) => void;
      readonly grantUpgrade: (upgradeId: string) => void;
      readonly onAutomationIdsChanged: () => void;
    },
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
