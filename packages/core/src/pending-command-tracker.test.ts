import { describe, expect, it } from 'vitest';

import { CommandPriority } from './command.js';
import type { CommandEnvelope, CommandResponse } from './command-transport.js';
import { DEFAULT_PENDING_COMMAND_TIMEOUT_MS } from './command-transport.js';
import { InMemoryPendingCommandTracker } from './pending-command-tracker.js';

const createEnvelope = (
  requestId: string,
  sentAt: number,
): CommandEnvelope => ({
  requestId,
  clientId: 'client-a',
  command: {
    type: 'TEST_COMMAND',
    priority: CommandPriority.PLAYER,
    timestamp: sentAt,
    step: 0,
    payload: null,
  },
  sentAt,
});

const createResponse = (
  requestId: string,
): CommandResponse => ({
  requestId,
  status: 'accepted',
  serverStep: 1,
});

describe('InMemoryPendingCommandTracker', () => {
  it('tracks and resolves pending envelopes', () => {
    const tracker = new InMemoryPendingCommandTracker({
      timeoutMs: 1000,
    });
    const envelope = createEnvelope('req-1', 100);

    tracker.track(envelope);

    expect(tracker.getPending()).toEqual([envelope]);

    tracker.resolve(createResponse('req-1'));

    expect(tracker.getPending()).toEqual([]);
  });

  it('ignores resolve calls for unknown requestIds', () => {
    const tracker = new InMemoryPendingCommandTracker({
      timeoutMs: 1000,
    });
    const envelope = createEnvelope('req-1', 100);

    tracker.track(envelope);

    tracker.resolve(createResponse('req-unknown'));

    expect(tracker.getPending()).toEqual([envelope]);
  });

  it('expires envelopes past their timeout', () => {
    const tracker = new InMemoryPendingCommandTracker({
      timeoutMs: 100,
    });
    const envelopeA = createEnvelope('req-a', 0);
    const envelopeB = createEnvelope('req-b', 80);

    tracker.track(envelopeA);
    tracker.track(envelopeB);

    const expired = tracker.expire(120);

    expect(expired).toEqual([envelopeA]);
    expect(tracker.getPending()).toEqual([envelopeB]);
  });

  it('expires envelopes when now equals the timeout boundary', () => {
    const tracker = new InMemoryPendingCommandTracker({
      timeoutMs: 100,
    });
    const envelope = createEnvelope('req-boundary', 0);

    tracker.track(envelope);

    const expired = tracker.expire(100);

    expect(expired).toEqual([envelope]);
    expect(tracker.getPending()).toEqual([]);
  });

  it('expires immediately when timeout is zero', () => {
    const tracker = new InMemoryPendingCommandTracker({
      timeoutMs: 0,
    });
    const envelope = createEnvelope('req-zero', 100);

    tracker.track(envelope);

    expect(tracker.expire(100)).toEqual([envelope]);
    expect(tracker.getPending()).toEqual([]);
  });

  it('expires multiple envelopes in one call', () => {
    const tracker = new InMemoryPendingCommandTracker({
      timeoutMs: 100,
    });
    const envelopeA = createEnvelope('req-a', 0);
    const envelopeB = createEnvelope('req-b', 10);
    const envelopeC = createEnvelope('req-c', 200);

    tracker.track(envelopeA);
    tracker.track(envelopeB);
    tracker.track(envelopeC);

    const expired = tracker.expire(150);

    expect(expired).toEqual(
      expect.arrayContaining([envelopeA, envelopeB]),
    );
    expect(expired).toHaveLength(2);
    expect(tracker.getPending()).toEqual([envelopeC]);
  });

  it('uses the default timeout when none is provided', () => {
    const tracker = new InMemoryPendingCommandTracker();
    const envelope = createEnvelope('req-default', 50);

    tracker.track(envelope);

    expect(
      tracker.expire(50 + DEFAULT_PENDING_COMMAND_TIMEOUT_MS - 1),
    ).toEqual([]);
    expect(tracker.getPending()).toEqual([envelope]);

    expect(
      tracker.expire(50 + DEFAULT_PENDING_COMMAND_TIMEOUT_MS),
    ).toEqual([envelope]);
    expect(tracker.getPending()).toEqual([]);
  });

  it('does not change state when resolving after expire', () => {
    const tracker = new InMemoryPendingCommandTracker({
      timeoutMs: 100,
    });
    const envelope = createEnvelope('req-expired', 0);

    tracker.track(envelope);

    tracker.expire(100);
    tracker.resolve(createResponse('req-expired'));

    expect(tracker.getPending()).toEqual([]);
  });

  it('replaces tracked envelopes with the same requestId', () => {
    const tracker = new InMemoryPendingCommandTracker({
      timeoutMs: 1000,
    });
    const envelopeA = createEnvelope('req-1', 100);
    const envelopeB = createEnvelope('req-1', 200);

    tracker.track(envelopeA);
    tracker.track(envelopeB);

    expect(tracker.getPending()).toEqual([envelopeB]);
  });
});
