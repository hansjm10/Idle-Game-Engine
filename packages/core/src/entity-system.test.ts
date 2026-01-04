import { describe, expect, it } from 'vitest';

import type { NormalizedEntity, NumericFormula } from '@idle-engine/content-schema';

import {
  createEntityDefinition,
  literalOne,
} from './content-test-helpers.js';
import type {
  EventPublisher,
  PublishMetadata,
  PublishResult,
} from './events/event-bus.js';
import type {
  RuntimeEventPayload,
  RuntimeEventType,
} from './events/runtime-event.js';
import { EntitySystem, type EntityAssignment } from './entity-system.js';

const literal = (value: number): NumericFormula => ({
  kind: 'constant',
  value,
});

const createEventPublisher = (): EventPublisher => ({
  publish<TType extends RuntimeEventType>(
    eventType: TType,
    _payload: RuntimeEventPayload<TType>,
    _metadata?: PublishMetadata,
  ): PublishResult<TType> {
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
});

describe('EntitySystem', () => {
  it('generates deterministic instance ids using step + rng suffix', () => {
    const definition = createEntityDefinition('entity.scout', {
      trackInstances: true,
    });
    const rng = {
      nextInt: () => 0xabc,
    };
    const system = new EntitySystem([definition], rng);

    const instance = system.createInstance('entity.scout', 5);

    expect(instance.instanceId).toBe('entity.scout_5_000abc');
  });

  it('updates stats when leveling up via experience', () => {
    const definition = createEntityDefinition('entity.guard', {
      trackInstances: true,
      stats: ([
        {
          id: 'stat.power',
          name: { default: 'Power', variants: {} },
          baseValue: literal(10),
        },
      ] as unknown as NormalizedEntity['stats']),
      progression: {
        experienceResource: 'resource.exp',
        levelFormula: literal(1),
        maxLevel: 3,
        statGrowth: {
          'stat.power': literal(2),
        },
      },
    });
    const rng = { nextInt: () => 1 };
    const system = new EntitySystem([definition], rng, { stepDurationMs: 100 });

    const instance = system.createInstance('entity.guard', 0);
    system.addExperience(instance.instanceId, 5, 1);

    const updated = system.getInstanceState(instance.instanceId)!;
    expect(updated.level).toBe(3);
    expect(updated.stats['stat.power']).toBe(14);
  });

  it('adds and removes entity counts for non-instance entities', () => {
    const definition = createEntityDefinition('entity.worker', {
      trackInstances: false,
    });
    const rng = { nextInt: () => 1 };
    const system = new EntitySystem([definition], rng);

    system.addEntity('entity.worker', 5, 0);
    expect(system.getEntityState('entity.worker')?.count).toBe(5);
    expect(system.getEntityState('entity.worker')?.availableCount).toBe(5);

    system.removeEntity('entity.worker', 3);
    expect(system.getEntityState('entity.worker')?.count).toBe(2);
    expect(system.getEntityState('entity.worker')?.availableCount).toBe(2);
  });

  it('tracks assignments and available counts for instances', () => {
    const definition = createEntityDefinition('entity.runner', {
      trackInstances: true,
      stats: ([
        {
          id: 'stat.speed',
          name: { default: 'Speed', variants: {} },
          baseValue: literalOne,
        },
      ] as unknown as NormalizedEntity['stats']),
    });
    const rng = { nextInt: () => 1 };
    const system = new EntitySystem([definition], rng);

    const instance = system.createInstance('entity.runner', 1);
    const assignment: EntityAssignment = {
      missionId: 'mission.alpha',
      batchId: 'batch.1',
      deployedAtStep: 1,
      returnStep: 3,
    };

    system.assignToMission(instance.instanceId, assignment);
    expect(system.getEntityState('entity.runner')?.availableCount).toBe(0);

    system.returnFromMission(instance.instanceId);
    expect(system.getEntityState('entity.runner')?.availableCount).toBe(1);
  });

  it('restores serialized state with step rebasing for assignments', () => {
    const definition = createEntityDefinition('entity.miner', {
      trackInstances: true,
      stats: ([
        {
          id: 'stat.stamina',
          name: { default: 'Stamina', variants: {} },
          baseValue: literalOne,
        },
      ] as unknown as NormalizedEntity['stats']),
    });
    const rng = { nextInt: () => 2 };
    const system = new EntitySystem([definition], rng);

    const instance = system.createInstance('entity.miner', 2);
    system.assignToMission(instance.instanceId, {
      missionId: 'mission.alpha',
      batchId: 'batch.1',
      deployedAtStep: 2,
      returnStep: 4,
    });

    const serialized = system.exportForSave();

    const restored = new EntitySystem([definition], rng);
    restored.restoreState(serialized, { savedWorkerStep: 2, currentStep: 5 });

    const restoredInstance = restored.getInstanceState(instance.instanceId)!;
    expect(restoredInstance.assignment?.deployedAtStep).toBe(5);
    expect(restoredInstance.assignment?.returnStep).toBe(7);
  });

  it('updates visibility, unlocks entities, and returns assignments on tick', () => {
    const definition = createEntityDefinition('entity.scout', {
      trackInstances: true,
      visible: false,
      unlocked: false,
      unlockCondition: {
        kind: 'resourceThreshold',
        resourceId: 'resource.energy' as any,
        comparator: 'gte',
        amount: literal(1),
      },
      visibilityCondition: {
        kind: 'resourceThreshold',
        resourceId: 'resource.energy' as any,
        comparator: 'gte',
        amount: literal(2),
      },
      stats: ([
        {
          id: 'stat.range',
          name: { default: 'Range', variants: {} },
          baseValue: literalOne,
        },
      ] as unknown as NormalizedEntity['stats']),
    });
    const conditionContext = {
      getResourceAmount: () => 5,
      getGeneratorLevel: () => 0,
      getUpgradePurchases: () => 0,
    };
    const system = new EntitySystem(
      [definition],
      { nextInt: () => 1 },
      { conditionContext },
    );

    const instance = system.createInstance('entity.scout', 0);
    system.assignToMission(instance.instanceId, {
      missionId: 'mission.alpha',
      batchId: 'batch.1',
      deployedAtStep: 0,
      returnStep: 1,
    });

    expect(system.getEntityState('entity.scout')?.availableCount).toBe(0);

    system.tick({ step: 1, deltaMs: 100, events: createEventPublisher() });

    const state = system.getEntityState('entity.scout');
    expect(state?.visible).toBe(true);
    expect(state?.unlocked).toBe(true);
    expect(state?.availableCount).toBe(1);
    expect(system.getInstanceState(instance.instanceId)?.assignment).toBeNull();
  });

  it('rebuilds entity instance lists when restoring legacy state', () => {
    const definition = createEntityDefinition('entity.medic', {
      trackInstances: true,
      stats: ([
        {
          id: 'stat.heal',
          name: { default: 'Heal', variants: {} },
          baseValue: literalOne,
        },
      ] as unknown as NormalizedEntity['stats']),
    });
    const system = new EntitySystem([definition], { nextInt: () => 7 });
    const instance = system.createInstance('entity.medic', 0);
    system.assignToMission(instance.instanceId, {
      missionId: 'mission.delta',
      batchId: 'batch.9',
      deployedAtStep: 2,
      returnStep: 5,
    });

    const serialized = system.exportForSave();
    const legacySerialized = {
      ...serialized,
      entityInstances: [],
    };

    const restored = new EntitySystem([definition], { nextInt: () => 7 });
    restored.restoreState(legacySerialized);

    const restoredState = restored.getEntityState('entity.medic');
    expect(restoredState?.count).toBe(1);
    expect(restoredState?.availableCount).toBe(0);
    expect(restored.getInstancesForEntity('entity.medic')).toHaveLength(1);
  });

  it('applies max count when initializing instance-tracked entities', () => {
    const definition = createEntityDefinition('entity.builder', {
      trackInstances: true,
      startCount: 3,
      maxCount: literal(1),
      stats: ([
        {
          id: 'stat.build',
          name: { default: 'Build', variants: {} },
          baseValue: literalOne,
        },
      ] as unknown as NormalizedEntity['stats']),
    });

    const system = new EntitySystem([definition], { nextInt: () => 4 });
    const state = system.getEntityState('entity.builder');

    expect(state?.count).toBe(1);
    expect(system.getInstancesForEntity('entity.builder')).toHaveLength(1);
  });

  it('falls back to deterministic ids when rng collisions persist', () => {
    const definition = createEntityDefinition('entity.builder', {
      trackInstances: true,
    });
    const rng = { nextInt: () => 0 };
    const system = new EntitySystem([definition], rng);

    const first = system.createInstance('entity.builder', 0);
    const second = system.createInstance('entity.builder', 0);

    expect(first.instanceId).toBe('entity.builder_0_000000');
    expect(second.instanceId).toBe('entity.builder_0_000001');
  });

  it('throws when removing more instances than available', () => {
    const definition = createEntityDefinition('entity.scout', {
      trackInstances: true,
    });
    const rng = { nextInt: () => 1 };
    const system = new EntitySystem([definition], rng);

    const first = system.createInstance('entity.scout', 0);
    system.createInstance('entity.scout', 0);
    system.assignToMission(first.instanceId, {
      missionId: 'mission.alpha',
      batchId: 'batch.1',
      deployedAtStep: 0,
      returnStep: 2,
    });

    expect(() => system.removeEntity('entity.scout', 2)).toThrow(
      'Entity "entity.scout" lacks 2 available instances.',
    );
  });

  it('rejects assignments with return steps before deployment', () => {
    const definition = createEntityDefinition('entity.ranger', {
      trackInstances: true,
    });
    const system = new EntitySystem([definition], { nextInt: () => 1 });
    const instance = system.createInstance('entity.ranger', 3);

    expect(() =>
      system.assignToMission(instance.instanceId, {
        missionId: 'mission.alpha',
        batchId: 'batch.1',
        deployedAtStep: 3,
        returnStep: 2,
      }),
    ).toThrow('Assignment returnStep must be >= deployedAtStep.');
  });

  it('retains experience when level formula is non-positive', () => {
    const definition = createEntityDefinition('entity.mage', {
      trackInstances: true,
      progression: {
        experienceResource: 'resource.exp',
        levelFormula: literal(0),
        statGrowth: {},
      },
    });
    const system = new EntitySystem([definition], { nextInt: () => 1 });

    const instance = system.createInstance('entity.mage', 0);
    system.addExperience(instance.instanceId, 12, 0);

    const updated = system.getInstanceState(instance.instanceId)!;
    expect(updated.level).toBe(1);
    expect(updated.experience).toBe(12);
  });
});
