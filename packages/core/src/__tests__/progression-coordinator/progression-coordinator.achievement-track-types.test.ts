import { describe, expect, it } from 'vitest';

import { createProgressionCoordinator } from '../../internals.js';
import {
  createAchievementDefinition,
  createContentPack,
  createResourceDefinition,
  createUpgradeDefinition,
  literalOne,
} from '../../content-test-helpers.js';
import { buildProgressionSnapshot } from '../../progression.js';

describe('Achievement track types', () => {
  it('tracks flag-based achievements when flag is set via upgrade effect', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 100,
    });

    const flagUpgrade = createUpgradeDefinition('upgrade.flag-granter', {
      name: 'Flag Granter',
      cost: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      effects: [
        {
          kind: 'grantFlag',
          flagId: 'flag.test-flag',
          value: true,
        },
      ],
    });

    const flagAchievement = createAchievementDefinition('achievement.flag-track', {
      track: {
        kind: 'flag' as const,
        flagId: 'flag.test-flag',
      },
      progress: {
        mode: 'oneShot' as const,
        target: literalOne,
      },
    });

    const pack = createContentPack({
      resources: [energy],
      upgrades: [flagUpgrade],
      achievements: [flagAchievement],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);
    const snapshot1 = buildProgressionSnapshot(0, 0, coordinator.state);
    expect(snapshot1.achievements?.[0]?.completions).toBe(0);

    // Purchase the upgrade to grant the flag
    coordinator.upgradeEvaluator!.applyPurchase(flagUpgrade.id);
    coordinator.updateForStep(1);
    const snapshot2 = buildProgressionSnapshot(1, 100, coordinator.state);
    expect(snapshot2.achievements?.[0]?.completions).toBe(1);
  });

  it('tracks script-based achievements when script condition evaluates to true', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 0,
    });

    const scriptAchievement = createAchievementDefinition('achievement.script-track', {
      track: {
        kind: 'script' as const,
        scriptId: 'script.test-condition',
      },
      progress: {
        mode: 'oneShot' as const,
        target: literalOne,
      },
    });

    const pack = createContentPack({
      resources: [energy],
      achievements: [scriptAchievement],
    });

    let scriptResult = false;
    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
      evaluateScriptCondition: (scriptId: string) =>
        scriptId === 'script.test-condition' && scriptResult,
    });

    coordinator.updateForStep(0);
    const snapshot1 = buildProgressionSnapshot(0, 0, coordinator.state);
    expect(snapshot1.achievements?.[0]?.completions).toBe(0);

    scriptResult = true;
    coordinator.updateForStep(1);
    const snapshot2 = buildProgressionSnapshot(1, 100, coordinator.state);
    expect(snapshot2.achievements?.[0]?.completions).toBe(1);
  });

  it('tracks custom-metric achievements using getCustomMetricValue callback', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 0,
    });

    const metricAchievement = createAchievementDefinition('achievement.metric-track', {
      track: {
        kind: 'custom-metric' as const,
        metricId: 'metric.playtime',
        threshold: { kind: 'constant' as const, value: 10 },
      },
      progress: {
        mode: 'oneShot' as const,
        target: { kind: 'constant' as const, value: 10 },
      },
    });

    const pack = createContentPack({
      resources: [energy],
      achievements: [metricAchievement],
    });

    let metricValue = 5;
    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
      getCustomMetricValue: (metricId: string) =>
        metricId === 'metric.playtime' ? metricValue : 0,
    });

    coordinator.updateForStep(0);
    const snapshot1 = buildProgressionSnapshot(0, 0, coordinator.state);
    expect(snapshot1.achievements?.[0]?.completions).toBe(0);

    metricValue = 15;
    coordinator.updateForStep(1);
    const snapshot2 = buildProgressionSnapshot(1, 100, coordinator.state);
    expect(snapshot2.achievements?.[0]?.completions).toBe(1);
  });

  it('returns 0 for custom-metric when callback returns non-finite value', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 0,
    });

    const metricAchievement = createAchievementDefinition('achievement.metric-track', {
      track: {
        kind: 'custom-metric' as const,
        metricId: 'metric.broken',
        threshold: { kind: 'constant' as const, value: 1 },
      },
      progress: {
        mode: 'oneShot' as const,
        target: { kind: 'constant' as const, value: 1 },
      },
    });

    const pack = createContentPack({
      resources: [energy],
      achievements: [metricAchievement],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
      getCustomMetricValue: () => NaN,
    });

    coordinator.updateForStep(0);
    const snapshot = buildProgressionSnapshot(0, 0, coordinator.state);
    expect(snapshot.achievements?.[0]?.completions).toBe(0);
    expect(snapshot.achievements?.[0]?.progress).toBe(0);
  });

  it('returns 0 for flag track when flag is not set', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 0,
    });

    const flagAchievement = createAchievementDefinition('achievement.flag-unset', {
      track: {
        kind: 'flag' as const,
        flagId: 'flag.unset-flag',
      },
      progress: {
        mode: 'oneShot' as const,
        target: literalOne,
      },
    });

    const pack = createContentPack({
      resources: [energy],
      achievements: [flagAchievement],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);
    const snapshot = buildProgressionSnapshot(0, 0, coordinator.state);
    expect(snapshot.achievements?.[0]?.completions).toBe(0);
    expect(snapshot.achievements?.[0]?.progress).toBe(0);
  });

  it('returns 0 for script track when evaluateScriptCondition callback is not provided', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 0,
    });

    const scriptAchievement = createAchievementDefinition('achievement.script-no-callback', {
      track: {
        kind: 'script' as const,
        scriptId: 'script.missing-callback',
      },
      progress: {
        mode: 'oneShot' as const,
        target: literalOne,
      },
    });

    const pack = createContentPack({
      resources: [energy],
      achievements: [scriptAchievement],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);
    const snapshot = buildProgressionSnapshot(0, 0, coordinator.state);
    expect(snapshot.achievements?.[0]?.completions).toBe(0);
    expect(snapshot.achievements?.[0]?.progress).toBe(0);
  });

  it('tracks upgrade-owned achievements', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 100,
    });

    const upgrade = createUpgradeDefinition('upgrade.tracker', {
      name: 'Tracked Upgrade',
      cost: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
    });

    const upgradeAchievement = createAchievementDefinition('achievement.upgrade-owned', {
      track: {
        kind: 'upgrade-owned' as const,
        upgradeId: upgrade.id,
        purchases: literalOne,
      },
      progress: {
        mode: 'oneShot' as const,
        target: literalOne,
      },
    });

    const pack = createContentPack({
      resources: [energy],
      upgrades: [upgrade],
      achievements: [upgradeAchievement],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);
    const snapshot1 = buildProgressionSnapshot(0, 0, coordinator.state);
    expect(snapshot1.achievements?.[0]?.completions).toBe(0);

    coordinator.upgradeEvaluator!.applyPurchase(upgrade.id);
    coordinator.updateForStep(1);
    const snapshot2 = buildProgressionSnapshot(1, 100, coordinator.state);
    expect(snapshot2.achievements?.[0]?.completions).toBe(1);
  });
});
