import { describe, expect, it } from 'vitest';

import type { NumericFormula } from '@idle-engine/content-schema';

import type { EventPublisher } from './events/event-bus.js';
import {
  hydrateProgressionCoordinatorState,
  serializeProgressionCoordinatorState,
} from './progression-coordinator-save.js';
import { createProgressionCoordinator } from './progression-coordinator.js';
import {
  createAchievementDefinition,
  createContentPack,
  createGeneratorDefinition,
  createResourceDefinition,
} from './content-test-helpers.js';

const literal = (value: number): NumericFormula => ({
  kind: 'constant',
  value,
});

function getAchievementState(
  coordinator: ReturnType<typeof createProgressionCoordinator>,
  id: string,
) {
  const state = coordinator.state.achievements?.find((entry) => entry.id === id);
  if (!state) {
    throw new Error(`Missing achievement state for "${id}".`);
  }
  return state;
}

describe('achievement runtime', () => {
  it('unlocks resource threshold achievements and applies grantResource once', () => {
    const content = createContentPack({
      resources: [
        createResourceDefinition('resource.energy', { startAmount: 0 }),
        createResourceDefinition('resource.gold', { startAmount: 0 }),
      ],
      achievements: [
        createAchievementDefinition('achievement.energy-10', {
          track: {
            kind: 'resource' as const,
            resourceId: 'resource.energy',
            threshold: literal(10),
            comparator: 'gte' as const,
          },
          progress: {
            mode: 'oneShot' as const,
            target: literal(10),
          },
          reward: {
            kind: 'grantResource' as const,
            resourceId: 'resource.gold',
            amount: literal(5),
          },
        }),
      ],
    });

    const coordinator = createProgressionCoordinator({
      content,
      stepDurationMs: 100,
    });

    const energyIndex = coordinator.resourceState.requireIndex('resource.energy');
    coordinator.resourceState.addAmount(energyIndex, 10);
    coordinator.updateForStep(1);

    const goldIndex = coordinator.resourceState.requireIndex('resource.gold');
    expect(coordinator.resourceState.getAmount(goldIndex)).toBe(5);

    const achievement = getAchievementState(coordinator, 'achievement.energy-10');
    expect(achievement.completions).toBe(1);

    coordinator.updateForStep(2);
    expect(coordinator.resourceState.getAmount(goldIndex)).toBe(5);
    expect(getAchievementState(coordinator, 'achievement.energy-10').completions).toBe(1);
  });

  it('unlocks generator-level achievements deterministically', () => {
    const content = createContentPack({
      resources: [createResourceDefinition('resource.energy', { startAmount: 0 })],
      generators: [createGeneratorDefinition('generator.mine')],
      achievements: [
        createAchievementDefinition('achievement.mine-level-2', {
          track: {
            kind: 'generator-level' as const,
            generatorId: 'generator.mine',
            level: literal(2),
          },
          progress: {
            mode: 'oneShot' as const,
            target: literal(2),
          },
        }),
      ],
    });

    const coordinator = createProgressionCoordinator({
      content,
      stepDurationMs: 100,
    });

    coordinator.incrementGeneratorOwned('generator.mine', 2);
    coordinator.updateForStep(1);

    const achievement = getAchievementState(coordinator, 'achievement.mine-level-2');
    expect(achievement.completions).toBe(1);
  });

  it('publishes emitEvent rewards via EventPublisher', () => {
    const published: string[] = [];
    const events: EventPublisher = {
      publish: (eventType, _payload) => {
        published.push(eventType);
        return {
          accepted: true,
          state: 'accepted',
          type: eventType,
          channel: 0,
          bufferSize: 0,
          remainingCapacity: 0,
          dispatchOrder: 0,
          softLimitActive: false,
        };
      },
    };

    const content = createContentPack({
      resources: [createResourceDefinition('resource.energy', { startAmount: 0 })],
      achievements: [
        createAchievementDefinition('achievement.emit-reactor-primed', {
          track: {
            kind: 'resource' as const,
            resourceId: 'resource.energy',
            threshold: literal(1),
            comparator: 'gte' as const,
          },
          progress: {
            mode: 'oneShot' as const,
            target: literal(1),
          },
          reward: {
            kind: 'emitEvent' as const,
            eventId: 'sample:reactor-primed',
          },
        }),
      ],
    });

    const coordinator = createProgressionCoordinator({
      content,
      stepDurationMs: 100,
    });

    const energyIndex = coordinator.resourceState.requireIndex('resource.energy');
    coordinator.resourceState.addAmount(energyIndex, 1);
    coordinator.updateForStep(1, { events });

    expect(published).toEqual(['sample:reactor-primed']);

    coordinator.updateForStep(2, { events });
    expect(published).toEqual(['sample:reactor-primed']);
  });

  it('roundtrips repeatable achievement progress and cooldown', () => {
    const content = createContentPack({
      resources: [
        createResourceDefinition('resource.energy', { startAmount: 0 }),
        createResourceDefinition('resource.gold', { startAmount: 0 }),
      ],
      achievements: [
        createAchievementDefinition('achievement.repeatable-energy', {
          track: {
            kind: 'resource' as const,
            resourceId: 'resource.energy',
            threshold: literal(1),
            comparator: 'gte' as const,
          },
          progress: {
            mode: 'repeatable' as const,
            target: literal(1),
            repeatable: {
              resetWindow: literal(2),
              maxRepeats: 2,
              rewardScaling: literal(1),
            },
          },
          reward: {
            kind: 'grantResource' as const,
            resourceId: 'resource.gold',
            amount: literal(1),
          },
        }),
      ],
    });

    const coordinator = createProgressionCoordinator({
      content,
      stepDurationMs: 100,
    });

    const energyIndex = coordinator.resourceState.requireIndex('resource.energy');
    const goldIndex = coordinator.resourceState.requireIndex('resource.gold');

    coordinator.resourceState.addAmount(energyIndex, 1);
    coordinator.updateForStep(0);
    expect(coordinator.resourceState.getAmount(goldIndex)).toBe(1);

    const saved = serializeProgressionCoordinatorState(coordinator);

    const restored = createProgressionCoordinator({
      content,
      stepDurationMs: 100,
    });
    hydrateProgressionCoordinatorState(saved, restored);

    expect(restored.resourceState.getAmount(goldIndex)).toBe(1);
    expect(
      getAchievementState(restored, 'achievement.repeatable-energy').completions,
    ).toBe(1);

    restored.updateForStep(1);
    expect(restored.resourceState.getAmount(goldIndex)).toBe(1);

    restored.updateForStep(2);
    expect(restored.resourceState.getAmount(goldIndex)).toBe(2);
    expect(
      getAchievementState(restored, 'achievement.repeatable-energy').completions,
    ).toBe(2);

    restored.updateForStep(4);
    expect(restored.resourceState.getAmount(goldIndex)).toBe(2);
  });
});
