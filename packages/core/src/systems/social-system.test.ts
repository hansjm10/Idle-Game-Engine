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

  it('retries queued intents when the publish is rejected', () => {
    const queue = new SocialIntentQueue(() => 0);
    const intent = queue.queue(
      {
        type: 'guild:join',
        payload: { guildId: 'gamma' },
      },
      0,
    );

    const attempts: boolean[] = [];
    const acceptanceSequence = [false, true];
    const onPublish: PublishEvaluator = (type) => {
      if (type !== 'social:intent-queued') {
        return true;
      }
      const accepted = acceptanceSequence.shift() ?? true;
      attempts.push(accepted);
      return accepted;
    };

    const events: Array<{ type: string; payload: unknown }> = [];
    const system = createSocialSystem({
      queue,
      removeResolved: false,
    });

    system.tick(createContext(events, 16, 0, { onPublish }));

    expect(events).toHaveLength(0);
    expect(attempts).toEqual([false]);
    const pending = queue.list().find((item) => item.id === intent.id);
    expect(pending?.status).toBe('queued');

    system.tick(createContext(events, 16, 1, { onPublish }));

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('social:intent-queued');
    expect(attempts).toEqual([false, true]);
    const queued = queue.list().find((item) => item.id === intent.id);
    expect(queued?.dirtyReason).toBeUndefined();
  });

  it('retries resolved intents when the publish is rejected', () => {
    const queue = new SocialIntentQueue(() => 0);
    const intent = queue.queue(
      {
        type: 'guild:join',
        payload: { guildId: 'delta' },
      },
      0,
    );

    const attempts: boolean[] = [];
    const confirmationAcceptance = [false, true];
    const onPublish: PublishEvaluator = (type) => {
      if (type === 'social:intent-confirmed') {
        const accepted = confirmationAcceptance.shift() ?? true;
        attempts.push(accepted);
        return accepted;
      }
      return true;
    };

    const confirmations: SocialConfirmation[] = [
      {
        intentId: intent.id,
        status: 'confirmed',
        confirmedAt: 25,
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

    system.tick(createContext(events, 16, 0, { onPublish }));

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('social:intent-queued');
    expect(attempts).toEqual([false]);
    const confirmed = queue.list().find((item) => item.id === intent.id);
    expect(confirmed?.status).toBe('confirmed');
    expect(confirmed?.resolutionNotified).toBe(false);

    system.tick(createContext(events, 16, 1, { onPublish }));

    expect(events).toHaveLength(2);
    expect(events[1]?.type).toBe('social:intent-confirmed');
    expect(attempts).toEqual([false, true]);
    expect(queue.list()).toHaveLength(0);
  });
});

type PublishEvaluator = (type: string, payload: unknown) => boolean;

interface CreateContextOptions {
  readonly onPublish?: PublishEvaluator;
}

function createContext(
  events: Array<{ type: string; payload: unknown }>,
  deltaMs: number,
  step = 0,
  options: CreateContextOptions = {},
): TickContext {
  return {
    deltaMs,
    step,
    events: {
      publish(type, payload) {
        const accepted = options.onPublish?.(type, payload) ?? true;
        if (accepted) {
          events.push({ type, payload });
        }
        return {
          accepted,
          state: accepted ? 'accepted' : 'soft-limit',
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
