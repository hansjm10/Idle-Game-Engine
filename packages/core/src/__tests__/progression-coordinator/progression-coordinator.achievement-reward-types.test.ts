import { describe, expect, it } from 'vitest';

import { IdleEngineRuntime, createProgressionCoordinator } from '../../internals.js';
import {
  createAchievementDefinition,
  createContentPack,
  createResourceDefinition,
  createUpgradeDefinition,
  literalOne,
} from '../../content-test-helpers.js';
import { buildProgressionSnapshot } from '../../progression.js';

describe('Achievement reward types', () => {
  it('grants an upgrade when achievement with grantUpgrade reward completes', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 0,
    });

    const grantedUpgrade = createUpgradeDefinition('upgrade.granted', {
      name: 'Granted Upgrade',
      cost: {
        currencyId: energy.id,
        costMultiplier: 1000,
        costCurve: literalOne,
      },
      effects: [
        {
          kind: 'grantFlag',
          flagId: 'flag.upgrade-granted',
          value: true,
        },
      ],
    });

    const grantUpgradeAchievement = createAchievementDefinition('achievement.grant-upgrade', {
      reward: {
        kind: 'grantUpgrade' as const,
        upgradeId: grantedUpgrade.id,
      },
    });

    const pack = createContentPack({
      resources: [energy],
      upgrades: [grantedUpgrade],
      achievements: [grantUpgradeAchievement],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    const energyIndex = coordinator.resourceState.requireIndex(energy.id);
    coordinator.resourceState.addAmount(energyIndex, 1);
    coordinator.updateForStep(0);

    const snapshot = buildProgressionSnapshot(0, 0, coordinator.state);
    expect(snapshot.achievements?.[0]?.completions).toBe(1);
    // Verify the upgrade was granted as a reward
    expect(
      coordinator.getConditionContext().getUpgradePurchases(grantedUpgrade.id),
    ).toBe(1);
  });

  it('unlocks automation when achievement with unlockAutomation reward completes', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 0,
    });

    const unlockAutomationAchievement = createAchievementDefinition('achievement.unlock-automation', {
      reward: {
        kind: 'unlockAutomation' as const,
        automationId: 'automation.auto-collect',
      },
    });

    const pack = createContentPack({
      resources: [energy],
      achievements: [unlockAutomationAchievement],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    const energyIndex = coordinator.resourceState.requireIndex(energy.id);
    coordinator.resourceState.addAmount(energyIndex, 1);
    coordinator.updateForStep(0);

    const snapshot = buildProgressionSnapshot(0, 0, coordinator.state);
    expect(snapshot.achievements?.[0]?.completions).toBe(1);
    expect(coordinator.getGrantedAutomationIds().has('automation.auto-collect')).toBe(true);
  });

  it('sets flag when achievement with grantFlag reward completes', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 0,
    });

    const grantFlagAchievement = createAchievementDefinition('achievement.grant-flag', {
      reward: {
        kind: 'grantFlag' as const,
        flagId: 'flag.achievement-unlocked',
        value: true,
      },
    });

    const pack = createContentPack({
      resources: [energy],
      achievements: [grantFlagAchievement],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    const energyIndex = coordinator.resourceState.requireIndex(energy.id);
    coordinator.resourceState.addAmount(energyIndex, 1);
    coordinator.updateForStep(0);

    const snapshot = buildProgressionSnapshot(0, 0, coordinator.state);
    expect(snapshot.achievements?.[0]?.completions).toBe(1);
    // The flag should be set in the internal conditionContext
    expect(coordinator.getConditionContext().isFlagSet?.('flag.achievement-unlocked')).toBe(true);
  });

  it('emits onUnlockEvents when achievement completes', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 0,
    });

    const achievementWithEvents = createAchievementDefinition('achievement.with-events', {
      onUnlockEvents: ['sample:reactor-primed'],
    });

    const pack = createContentPack({
      resources: [energy],
      achievements: [achievementWithEvents],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    const runtime = new IdleEngineRuntime({ stepSizeMs: 100, initialStep: 0 });
    const energyIndex = coordinator.resourceState.requireIndex(energy.id);

    runtime.addSystem({
      id: 'progression-coordinator',
      tick: ({ step, events }) => {
        if (step === 0) {
          coordinator.resourceState.addAmount(energyIndex, 1);
        }
        coordinator.updateForStep(step, { events });
      },
    });

    const manifest = runtime.getEventBus().getManifest();
    const entry = manifest.entries.find((e) => e.type === 'sample:reactor-primed');
    expect(entry).toBeDefined();

    runtime.tick(100);

    const buffer = runtime.getEventBus().getOutboundBuffer(entry!.channel);
    expect(buffer.length).toBe(1);
    expect(buffer.at(0).type).toBe('sample:reactor-primed');
  });

  it('calls onError when grantResource references unknown resource', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 0,
    });

    const badRewardAchievement = createAchievementDefinition('achievement.bad-reward', {
      reward: {
        kind: 'grantResource' as const,
        resourceId: 'resource.nonexistent',
        amount: { kind: 'constant' as const, value: 100 },
      },
    });

    const pack = createContentPack({
      resources: [energy],
      achievements: [badRewardAchievement],
    });

    const errors: Error[] = [];
    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
      onError: (error) => errors.push(error),
    });

    const energyIndex = coordinator.resourceState.requireIndex(energy.id);
    coordinator.resourceState.addAmount(energyIndex, 1);
    coordinator.updateForStep(0);

    expect(errors.length).toBe(1);
    expect(errors[0]?.message).toContain('resource.nonexistent');
    expect(errors[0]?.message).toContain('grantResource references unknown resource');
  });
});
