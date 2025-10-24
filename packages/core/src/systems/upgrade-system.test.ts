import { describe, expect, it } from 'vitest';

import { createResourceState } from '../resource-state.js';
import { createUpgradeState } from '../upgrade-state.js';
import {
  additiveModifier,
  createModifierPipeline,
} from '../modifiers/modifier-pipeline.js';
import type {
  EventPublisher,
  PublishResult,
} from '../events/event-bus.js';
import type { RuntimeEventPayload, RuntimeEventType } from '../events/runtime-event.js';
import type { TickContext } from './system-types.js';
import { createUpgradeSystem } from './upgrade-system.js';
import { GeneratorModifierLedger } from './modifier-ledger.js';

describe('upgrade-system', () => {
  it('unlocks upgrades based on requirements and applies modifier pipelines', () => {
    const resources = createResourceState([{ id: 'energy', startAmount: 20 }]);
    const upgrades = createUpgradeState([
      { id: 'turbo', unlocked: false, purchaseCount: 0 },
    ]);
    const ledger = new GeneratorModifierLedger();

    const turboIndex = upgrades.requireIndex('turbo');
    upgrades.setPurchaseCount(turboIndex, 2);

    const system = createUpgradeSystem({
      resources,
      upgrades,
      ledger,
      definitions: [
        {
          upgradeId: 'turbo',
          requirement: {
            type: 'resourceThreshold',
            resourceId: 'energy',
            amount: 10,
          },
          effects: [
            {
              targetGeneratorId: 'reactor',
              mode: 'multiplicative',
              baseValue: 1,
              pipeline: createModifierPipeline([
                additiveModifier((ctx) => ctx.purchaseCount * 0.5),
              ]),
            },
          ],
        },
      ],
    });

    system.tick(createContext());

    expect(upgrades.isUnlocked(turboIndex)).toBe(true);

    const modifiers = ledger.get('reactor');
    expect(modifiers.multiplicative).toBeCloseTo(2, 6);
    expect(modifiers.additive).toBe(0);
    expect(modifiers.exponential).toBe(1);
  });
});

function createContext(): TickContext {
  return {
    deltaMs: 100,
    step: 1,
    events: createEventPublisherStub(),
  };
}

function createEventPublisherStub(): EventPublisher {
  return {
    publish<TType extends RuntimeEventType>(
      eventType: TType,
      _payload: RuntimeEventPayload<TType>,
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
  };
}
