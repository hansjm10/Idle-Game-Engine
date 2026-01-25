import { assertAllowlisted } from './allowlists.js';
import { ensureFormulaReferencesAtPath } from './formulas.js';
import { validateConditionNode } from './conditions.js';
import type { CrossReferenceState } from './state.js';
import type { ParsedContentPack } from '../schema.js';

type AchievementTrack = ParsedContentPack['achievements'][number]['track'];
type AchievementTrackByKind<K extends AchievementTrack['kind']> = Extract<
  AchievementTrack,
  { kind: K }
>;
type AchievementReward = NonNullable<ParsedContentPack['achievements'][number]['reward']>;
type AchievementRewardByKind<K extends AchievementReward['kind']> = Extract<
  AchievementReward,
  { kind: K }
>;

export const validateAchievements = (state: CrossReferenceState) => {
  const {
    pack,
    ctx,
    context,
    indexes,
    formulaMaps,
    ensureContentReference,
    ensureRuntimeEventKnown,
    runtimeEventSeverity,
  } = state;
  const {
    resources: resourceIndex,
    generators: generatorIndex,
    upgrades: upgradeIndex,
    metrics: metricIndex,
    automations: automationIndex,
  } = indexes;
  const warn = context.warningSink;

  const achievementTrackHandlers = {
    resource: (
      track: AchievementTrackByKind<'resource'>,
      trackPath: readonly (string | number)[],
      achievementId: string,
    ) => {
      ensureContentReference(
        resourceIndex,
        track.resourceId,
        [...trackPath, 'resourceId'],
        `Achievement "${achievementId}" references unknown resource "${track.resourceId}".`,
      );
      ensureFormulaReferencesAtPath(
        track.threshold,
        [...trackPath, 'threshold'],
        ctx,
        formulaMaps,
      );
    },
    'generator-level': (
      track: AchievementTrackByKind<'generator-level'>,
      trackPath: readonly (string | number)[],
      achievementId: string,
    ) => {
      ensureContentReference(
        generatorIndex,
        track.generatorId,
        [...trackPath, 'generatorId'],
        `Achievement "${achievementId}" references unknown generator "${track.generatorId}".`,
      );
      ensureFormulaReferencesAtPath(track.level, [...trackPath, 'level'], ctx, formulaMaps);
    },
    'generator-count': (
      track: AchievementTrackByKind<'generator-count'>,
      trackPath: readonly (string | number)[],
      achievementId: string,
    ) => {
      track.generatorIds?.forEach((generatorId, generatorIdIndex) => {
        ensureContentReference(
          generatorIndex,
          generatorId,
          [...trackPath, 'generatorIds', generatorIdIndex],
          `Achievement "${achievementId}" references unknown generator "${generatorId}".`,
        );
      });
      ensureFormulaReferencesAtPath(
        track.threshold,
        [...trackPath, 'threshold'],
        ctx,
        formulaMaps,
      );
    },
    'upgrade-owned': (
      track: AchievementTrackByKind<'upgrade-owned'>,
      trackPath: readonly (string | number)[],
      achievementId: string,
    ) => {
      ensureContentReference(
        upgradeIndex,
        track.upgradeId,
        [...trackPath, 'upgradeId'],
        `Achievement "${achievementId}" references unknown upgrade "${track.upgradeId}".`,
      );
      if (track.purchases) {
        ensureFormulaReferencesAtPath(
          track.purchases,
          [...trackPath, 'purchases'],
          ctx,
          formulaMaps,
        );
      }
    },
    flag: (
      track: AchievementTrackByKind<'flag'>,
      trackPath: readonly (string | number)[],
      achievementId: string,
    ) => {
      assertAllowlisted(
        context.allowlists.flags,
        track.flagId,
        [...trackPath, 'flagId'],
        ctx,
        warn,
        'allowlist.flag.missing',
        `Achievement "${achievementId}" references flag "${track.flagId}" that is not in the flags allowlist.`,
      );
    },
    script: (
      track: AchievementTrackByKind<'script'>,
      trackPath: readonly (string | number)[],
      achievementId: string,
    ) => {
      assertAllowlisted(
        context.allowlists.scripts,
        track.scriptId,
        [...trackPath, 'scriptId'],
        ctx,
        warn,
        'allowlist.script.missing',
        `Achievement "${achievementId}" references script "${track.scriptId}" that is not in the scripts allowlist.`,
      );
    },
    'custom-metric': (
      track: AchievementTrackByKind<'custom-metric'>,
      trackPath: readonly (string | number)[],
      achievementId: string,
    ) => {
      ensureContentReference(
        metricIndex,
        track.metricId,
        [...trackPath, 'metricId'],
        `Achievement "${achievementId}" references unknown metric "${track.metricId}".`,
      );
      ensureFormulaReferencesAtPath(
        track.threshold,
        [...trackPath, 'threshold'],
        ctx,
        formulaMaps,
      );
    },
  } satisfies {
    [K in AchievementTrack['kind']]: (
      track: AchievementTrackByKind<K>,
      trackPath: readonly (string | number)[],
      achievementId: string,
    ) => void;
  };

  const handleAchievementTrack = (
    track: AchievementTrack,
    trackPath: readonly (string | number)[],
    achievementId: string,
  ) => {
    const handler = achievementTrackHandlers[track.kind] as (
      entry: AchievementTrack,
      currentPath: readonly (string | number)[],
      currentAchievementId: string,
    ) => void;
    handler(track, trackPath, achievementId);
  };

  const achievementRewardHandlers = {
    grantResource: (
      reward: AchievementRewardByKind<'grantResource'>,
      rewardPath: readonly (string | number)[],
      achievementId: string,
    ) => {
      ensureContentReference(
        resourceIndex,
        reward.resourceId,
        [...rewardPath, 'resourceId'],
        `Achievement "${achievementId}" grants unknown resource "${reward.resourceId}".`,
      );
      ensureFormulaReferencesAtPath(reward.amount, [...rewardPath, 'amount'], ctx, formulaMaps);
    },
    grantUpgrade: (
      reward: AchievementRewardByKind<'grantUpgrade'>,
      rewardPath: readonly (string | number)[],
      achievementId: string,
    ) => {
      ensureContentReference(
        upgradeIndex,
        reward.upgradeId,
        [...rewardPath, 'upgradeId'],
        `Achievement "${achievementId}" grants unknown upgrade "${reward.upgradeId}".`,
      );
    },
    emitEvent: (reward: AchievementRewardByKind<'emitEvent'>, rewardPath: readonly (string | number)[]) => {
      ensureRuntimeEventKnown(
        reward.eventId,
        [...rewardPath, 'eventId'],
        runtimeEventSeverity,
      );
    },
    unlockAutomation: (
      reward: AchievementRewardByKind<'unlockAutomation'>,
      rewardPath: readonly (string | number)[],
      achievementId: string,
    ) => {
      ensureContentReference(
        automationIndex,
        reward.automationId,
        [...rewardPath, 'automationId'],
        `Achievement "${achievementId}" unlocks unknown automation "${reward.automationId}".`,
      );
    },
    grantFlag: (
      reward: AchievementRewardByKind<'grantFlag'>,
      rewardPath: readonly (string | number)[],
      achievementId: string,
    ) => {
      assertAllowlisted(
        context.allowlists.flags,
        reward.flagId,
        [...rewardPath, 'flagId'],
        ctx,
        warn,
        'allowlist.flag.missing',
        `Achievement "${achievementId}" grants flag "${reward.flagId}" that is not in the flags allowlist.`,
      );
    },
  } satisfies {
    [K in AchievementReward['kind']]: (
      reward: AchievementRewardByKind<K>,
      rewardPath: readonly (string | number)[],
      achievementId: string,
    ) => void;
  };

  const handleAchievementReward = (
    reward: AchievementReward,
    rewardPath: readonly (string | number)[],
    achievementId: string,
  ) => {
    const handler = achievementRewardHandlers[reward.kind] as (
      entry: AchievementReward,
      currentPath: readonly (string | number)[],
      currentAchievementId: string,
    ) => void;
    handler(reward, rewardPath, achievementId);
  };

  pack.achievements.forEach((achievement, index) => {
    handleAchievementTrack(achievement.track, ['achievements', index, 'track'], achievement.id);
    if (achievement.reward) {
      handleAchievementReward(
        achievement.reward,
        ['achievements', index, 'reward'],
        achievement.id,
      );
    }
    if (achievement.unlockCondition) {
      validateConditionNode(state, achievement.unlockCondition, [
        'achievements',
        index,
        'unlockCondition',
      ]);
    }
    if (achievement.visibilityCondition) {
      validateConditionNode(state, achievement.visibilityCondition, [
        'achievements',
        index,
        'visibilityCondition',
      ]);
    }
    achievement.onUnlockEvents.forEach((eventId, eventIndex) => {
      ensureRuntimeEventKnown(
        eventId,
        ['achievements', index, 'onUnlockEvents', eventIndex],
        runtimeEventSeverity,
      );
    });
  });
};
