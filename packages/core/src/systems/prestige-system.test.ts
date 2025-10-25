import { describe, expect, it } from 'vitest';

import { createResourceState } from '../resource-state.js';
import { createGeneratorState } from '../generator-state.js';
import { createUpgradeState } from '../upgrade-state.js';
import type { TickContext } from './system-types.js';
import {
  PrestigeResetQueue,
  createPrestigeSystem,
} from './prestige-system.js';

describe('prestige-system', () => {
  it('applies queued resets and emits prestige events', () => {
    const resources = createResourceState([{ id: 'energy', startAmount: 100 }]);
    const generators = createGeneratorState([
      { id: 'reactor', startLevel: 3 },
    ]);
    const upgrades = createUpgradeState([
      { id: 'turbo', purchaseCount: 2 },
    ]);

    const queue = new PrestigeResetQueue();
    queue.enqueue({
      layer: 1,
      resourceRetention: {
        energy: 0.5,
      },
      grantUpgrades: [{ upgradeId: 'turbo', count: 1 }],
    });

    const events: Array<{ type: string; payload: unknown }> = [];
    const system = createPrestigeSystem({
      resources,
      generators,
      upgrades,
      queue,
    });

    system.tick(createContext(events));

    const energyIndex = resources.requireIndex('energy');
    expect(resources.getAmount(energyIndex)).toBeCloseTo(50, 6);

    const reactorIndex = generators.requireIndex('reactor');
    expect(generators.getLevel(reactorIndex)).toBe(0);

    const turboIndex = upgrades.requireIndex('turbo');
    expect(upgrades.getPurchaseCount(turboIndex)).toBe(1);

    expect(events).toEqual([
      { type: 'prestige:reset', payload: { layer: 1 } },
    ]);
  });
  it('retries reset notifications when the publish is rejected', () => {
    const resources = createResourceState([{ id: 'energy', startAmount: 120 }]);
    const generators = createGeneratorState([]);
    const upgrades = createUpgradeState([]);

    const queue = new PrestigeResetQueue();
    queue.enqueue({
      layer: 2,
      resourceRetention: {
        energy: 0.5,
      },
    });

    const acceptanceSequence = [false, true];
    const attempts: boolean[] = [];
    const onPublish: PublishEvaluator = (type) => {
      if (type !== 'prestige:reset') {
        return true;
      }
      const accepted = acceptanceSequence.shift() ?? true;
      attempts.push(accepted);
      return accepted;
    };

    const events: Array<{ type: string; payload: unknown }> = [];
    const system = createPrestigeSystem({
      resources,
      generators,
      upgrades,
      queue,
    });

    system.tick(createContext(events, { onPublish }));

    const energyIndex = resources.requireIndex('energy');
    expect(resources.getAmount(energyIndex)).toBeCloseTo(60, 6);
    expect(events).toHaveLength(0);
    expect(attempts).toEqual([false]);

    system.tick(createContext(events, { onPublish }));

    expect(events).toEqual([{ type: 'prestige:reset', payload: { layer: 2 } }]);
    expect(attempts).toEqual([false, true]);
    expect(resources.getAmount(energyIndex)).toBeCloseTo(60, 6);
  });
});

type PublishEvaluator = (type: string, payload: unknown) => boolean;

interface CreateContextOptions {
  readonly onPublish?: PublishEvaluator;
}

function createContext(
  log: Array<{ type: string; payload: unknown }>,
  options: CreateContextOptions = {},
): TickContext {
  let dispatchOrder = 0;
  return {
    deltaMs: 100,
    step: 10,
    events: {
      publish(type, payload) {
        dispatchOrder += 1;
        const accepted = options.onPublish?.(type, payload) ?? true;
        if (accepted) {
          log.push({ type, payload });
        }
        return {
          accepted,
          state: accepted ? 'accepted' : 'soft-limit',
          type,
          channel: 0,
          bufferSize: 0,
          remainingCapacity: 0,
          dispatchOrder,
          softLimitActive: false,
        };
      },
    },
  };
}
