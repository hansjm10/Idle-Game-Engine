import { describe, expect, it } from 'vitest';

import { createProgressionCoordinator } from '../../internals.js';
import {
  createAchievementDefinition,
  createContentPack,
  createResourceDefinition,
} from '../../content-test-helpers.js';

describe('Achievement hydration with derived rewards', () => {
  it('rebuilds grantFlag rewards from completed achievements on hydration', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 0,
    });

    const flagAchievement = createAchievementDefinition('achievement.flag-reward', {
      reward: {
        kind: 'grantFlag' as const,
        flagId: 'flag.from-achievement',
        value: true,
      },
    });

    const pack = createContentPack({
      resources: [energy],
      achievements: [flagAchievement],
    });

    // Create coordinator with pre-completed achievement state
    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
      initialState: {
        stepDurationMs: 100,
        achievements: [
          {
            id: flagAchievement.id,
            category: flagAchievement.category,
            tier: flagAchievement.tier,
            mode: flagAchievement.progress.mode,
            isVisible: true,
            completions: 1,
            lastCompletedStep: 5,
            nextRepeatableAtStep: undefined,
            progress: 1,
            target: 1,
          },
        ],
      },
    });

    coordinator.updateForStep(10);

    // Flag should be set from hydrated achievement
    expect(coordinator.getConditionContext().isFlagSet?.('flag.from-achievement')).toBe(true);
  });

  it('rebuilds unlockAutomation rewards from completed achievements on hydration', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 0,
    });

    const automationAchievement = createAchievementDefinition('achievement.automation-reward', {
      reward: {
        kind: 'unlockAutomation' as const,
        automationId: 'automation.hydrated',
      },
    });

    const pack = createContentPack({
      resources: [energy],
      achievements: [automationAchievement],
    });

    // Create coordinator with pre-completed achievement state
    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
      initialState: {
        stepDurationMs: 100,
        achievements: [
          {
            id: automationAchievement.id,
            category: automationAchievement.category,
            tier: automationAchievement.tier,
            mode: automationAchievement.progress.mode,
            isVisible: true,
            completions: 1,
            lastCompletedStep: 3,
            nextRepeatableAtStep: undefined,
            progress: 1,
            target: 1,
          },
        ],
      },
    });

    coordinator.updateForStep(10);

    expect(coordinator.getGrantedAutomationIds().has('automation.hydrated')).toBe(true);
  });

  it('sorts hydrated achievements by completedAtStep then index for deterministic replay', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 0,
    });

    // Create achievements that grant flags with specific ordering
    const achievement1 = createAchievementDefinition('achievement.first', {
      reward: {
        kind: 'grantFlag' as const,
        flagId: 'flag.first',
        value: true,
      },
    });

    const achievement2 = createAchievementDefinition('achievement.second', {
      reward: {
        kind: 'grantFlag' as const,
        flagId: 'flag.second',
        value: true,
      },
    });

    const pack = createContentPack({
      resources: [energy],
      achievements: [achievement1, achievement2],
    });

    // Create with achievement2 completed before achievement1 (by step)
    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
      initialState: {
        stepDurationMs: 100,
        achievements: [
          {
            id: achievement1.id,
            category: achievement1.category,
            tier: achievement1.tier,
            mode: achievement1.progress.mode,
            isVisible: true,
            completions: 1,
            lastCompletedStep: 10,
            nextRepeatableAtStep: undefined,
            progress: 1,
            target: 1,
          },
          {
            id: achievement2.id,
            category: achievement2.category,
            tier: achievement2.tier,
            mode: achievement2.progress.mode,
            isVisible: true,
            completions: 1,
            lastCompletedStep: 5,
            nextRepeatableAtStep: undefined,
            progress: 1,
            target: 1,
          },
        ],
      },
    });

    coordinator.updateForStep(15);

    // Both flags should be set
    expect(coordinator.getConditionContext().isFlagSet?.('flag.first')).toBe(true);
    expect(coordinator.getConditionContext().isFlagSet?.('flag.second')).toBe(true);
  });
});
