import { describe, expect, it } from 'vitest';

import type { TickContext } from './system-types.js';
import {
  SocialIntentQueue,
  createSocialSystem,
  type SocialConfirmation,
} from './social-system.js';

describe('social-system', () => {
  it('publishes queued intents and reconciles confirmations deterministically', () => {
    const queue = new SocialIntentQueue(() => 0);
    const intent = queue.queue(
      {
        type: 'guild:join',
        payload: { guildId: 'alpha' },
      },
      0,
    );

    const confirmations: SocialConfirmation[] = [
      {
        intentId: intent.id,
        status: 'confirmed',
        confirmedAt: 25,
        payload: { membershipId: 'member-1' },
      },
    ];

    const provider = {
      pullConfirmations() {
        return confirmations.splice(0, confirmations.length);
      },
    };

    const events: Array<{ type: string; payload: unknown }> = [];
    const system = createSocialSystem({
      queue,
      provider,
    });

    system.tick(createContext(events, 16));

    expect(events).toEqual([
      {
        type: 'social:intent-queued',
        payload: {
          intentId: intent.id,
          type: 'guild:join',
          payload: { guildId: 'alpha' },
          issuedAt: 0,
        },
      },
      {
        type: 'social:intent-confirmed',
        payload: {
          intentId: intent.id,
          type: 'guild:join',
          payload: { membershipId: 'member-1' },
          confirmedAt: 25,
        },
      },
    ]);

    expect(queue.list()).toHaveLength(0);
  });

  it('ignores stale confirmations while keeping latest resolution', () => {
    const queue = new SocialIntentQueue(() => 0);
    const intent = queue.queue(
      {
        type: 'guild:invite',
        payload: { guildId: 'beta' },
      },
      0,
    );

    queue.applyConfirmation({
      intentId: intent.id,
      status: 'confirmed',
      confirmedAt: 50,
    });

    const stale = queue.applyConfirmation({
      intentId: intent.id,
      status: 'rejected',
      confirmedAt: 40,
    });

    expect(stale).toBeUndefined();
  });
});

function createContext(
  events: Array<{ type: string; payload: unknown }>,
  deltaMs: number,
  step = 0,
): TickContext {
  return {
    deltaMs,
    step,
    events: {
      publish(type, payload) {
        events.push({ type, payload });
        return {
          accepted: true,
          state: 'accepted',
          type,
          channel: 0,
          bufferSize: 0,
          remainingCapacity: 0,
          dispatchOrder: events.length,
          softLimitActive: false,
        };
      },
    },
  };
}
