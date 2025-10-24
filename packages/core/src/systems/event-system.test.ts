import { describe, expect, it } from 'vitest';

import type {
  EventPublisher,
  PublishResult,
} from '../events/event-bus.js';
import type { RuntimeEventPayload, RuntimeEventType } from '../events/runtime-event.js';
import { createResourceState } from '../resource-state.js';
import { RuntimeChangeJournal } from '../runtime-change-journal.js';
import type { TickContext } from './system-types.js';
import { createEventSystem } from './event-system.js';

describe('event-system', () => {
  it('finalizes resource state and records change journal deltas', () => {
    const resources = createResourceState([{ id: 'energy', startAmount: 0 }]);
    const journal = new RuntimeChangeJournal();

    const energy = resources.requireIndex('energy');
    resources.applyIncome(energy, 5);

    const system = createEventSystem({
      resources,
      journal,
    });

    system.tick(createContext(1000, 1));

    expect(resources.getAmount(energy)).toBeCloseTo(5, 6);

    const snapshot = resources.snapshot({ mode: 'recorder' });
    expect(snapshot.incomePerSecond[energy]).toBe(0);

    const delta = journal.capture({
      tick: 2,
      resources,
    });
    expect(delta).toBeUndefined();
  });
});

function createContext(deltaMs: number, step: number): TickContext {
  const events: EventPublisher = {
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

  return {
    deltaMs,
    step,
    events,
  };
}
