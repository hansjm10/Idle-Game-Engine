import { describe, expect, it } from 'vitest';

import { IdleEngineRuntime } from '../index.js';
import { createResourceState } from '../resource-state.js';
import { createGeneratorState } from '../generator-state.js';
import { createUpgradeState } from '../upgrade-state.js';
import { PrestigeResetQueue } from './prestige-system.js';
import { TaskSchedulerState } from './task-system.js';
import { SocialIntentQueue } from './social-system.js';
import { RuntimeChangeJournal } from '../runtime-change-journal.js';
import {
  registerCoreSystems,
} from './core-systems.js';
import {
  additiveModifier,
  createModifierPipeline,
} from '../modifiers/modifier-pipeline.js';

describe('core-systems', () => {
  it('registers core systems in deterministic order and processes a tick', () => {
    const runtime = new IdleEngineRuntime({ stepSizeMs: 100 });
    const resources = createResourceState([{ id: 'energy', startAmount: 0 }]);
    const generators = createGeneratorState([
      { id: 'reactor', startLevel: 1 },
    ]);
    const upgrades = createUpgradeState([
      { id: 'turbo', purchaseCount: 1 },
    ]);
    const prestigeQueue = new PrestigeResetQueue();
    const tasks = new TaskSchedulerState();
    tasks.schedule({ id: 'task-1', durationMs: 100 });

    const socialQueue = new SocialIntentQueue(() => 0);
    const queuedIntent = socialQueue.queue(
      {
        type: 'guild:join',
        payload: { guildId: 'alpha' },
      },
      0,
    );

    const journal = new RuntimeChangeJournal();

    const events: Array<{ type: string; payload: unknown }> = [];
    runtime.getEventBus().on('task:completed', (event) => {
      events.push({ type: event.type, payload: event.payload });
    });
    runtime.getEventBus().on('social:intent-confirmed', (event) => {
      events.push({ type: event.type, payload: event.payload });
    });

    const provider = {
      pullConfirmations() {
        return [
          {
            intentId: queuedIntent.id,
            status: 'confirmed' as const,
            confirmedAt: 25,
            payload: { membershipId: 'member-1' },
          },
        ];
      },
    };

    const result = registerCoreSystems(runtime, {
      upgrades: {
        upgrades,
        resources,
        definitions: [
          {
            upgradeId: 'turbo',
            effects: [
              {
                targetGeneratorId: 'reactor',
                mode: 'multiplicative',
                baseValue: 1,
                pipeline: createModifierPipeline([
                  additiveModifier((ctx) => ctx.purchaseCount),
                ]),
              },
            ],
          },
        ],
      },
      production: {
        resources,
        generators,
        definitions: [
          {
            generatorId: 'reactor',
            produces: [
              {
                resourceId: 'energy',
                ratePerSecond: 1,
              },
            ],
          },
        ],
      },
      prestige: {
        resources,
        generators,
        upgrades,
        queue: prestigeQueue,
      },
      tasks: {
        state: tasks,
      },
      social: {
        queue: socialQueue,
        provider,
      },
      events: {
        resources,
        generators,
        upgrades,
        journal,
      },
    });

    expect(result.order).toEqual([
      'upgrades',
      'production',
      'prestige',
      'tasks',
      'social',
      'events',
    ]);

    runtime.tick(100);

    const energyIndex = resources.requireIndex('energy');
    expect(resources.getAmount(energyIndex)).toBeCloseTo(0.2, 6);

    expect(events.find((event) => event.type === 'task:completed')).toBeDefined();
    const socialConfirmed = events.find((event) => event.type === 'social:intent-confirmed');
    expect(socialConfirmed).toBeDefined();
    expect((socialConfirmed?.payload as { intentId: string }).intentId).toBe(queuedIntent.id);
  });
});

