import { describe, expect, it } from 'vitest';

import type { NormalizedEntity, NumericFormula } from '@idle-engine/content-schema';

import {
  createEntityDefinition,
  literalOne,
} from './content-test-helpers.js';
import { EntitySystem, type EntityAssignment } from './entity-system.js';

const literal = (value: number): NumericFormula => ({
  kind: 'constant',
  value,
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
});
