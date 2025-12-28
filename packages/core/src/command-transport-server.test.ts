import { describe, expect, it } from 'vitest';

import { CommandPriority } from './command.js';
import { CommandDispatcher } from './command-dispatcher.js';
import { CommandQueue } from './command-queue.js';
import { createCommandTransportServer } from './command-transport-server.js';
import { IdleEngineRuntime } from './index.js';
import type { CommandEnvelope } from './command-transport.js';

const createRuntime = () => {
  const commandQueue = new CommandQueue();
  const commandDispatcher = new CommandDispatcher();
  const runtime = new IdleEngineRuntime({
    commandQueue,
    commandDispatcher,
    stepSizeMs: 10,
    maxStepsPerFrame: 1,
  });

  return { runtime, commandQueue, commandDispatcher };
};

const createEnvelope = (
  overrides: Partial<CommandEnvelope> = {},
): CommandEnvelope => ({
  requestId: 'req-1',
  clientId: 'client-1',
  sentAt: 100,
  command: {
    type: 'TEST',
    priority: CommandPriority.PLAYER,
    timestamp: 100,
    step: 0,
    payload: {},
    requestId: 'req-1',
  },
  ...overrides,
});

describe('createCommandTransportServer', () => {
  it('accepts envelopes and returns duplicates without enqueueing again', () => {
    const { runtime, commandQueue, commandDispatcher } = createRuntime();
    commandDispatcher.register('TEST', () => undefined);

    const server = createCommandTransportServer({
      commandQueue,
      getNextExecutableStep: () => runtime.getNextExecutableStep(),
    });

    const envelope = createEnvelope();

    const accepted = server.handleEnvelope(envelope);
    expect(accepted).toEqual({
      requestId: 'req-1',
      status: 'accepted',
      serverStep: 0,
    });
    expect(commandQueue.size).toBe(1);

    const duplicate = server.handleEnvelope(envelope);
    expect(duplicate).toEqual({
      requestId: 'req-1',
      status: 'duplicate',
      serverStep: 0,
    });
    expect(commandQueue.size).toBe(1);
  });

  it('records rejected responses and returns duplicate status for repeats', () => {
    const { commandQueue } = createRuntime();

    const server = createCommandTransportServer({
      commandQueue,
    });

    const envelope = createEnvelope({
      command: {
        type: ' ',
        priority: CommandPriority.PLAYER,
        timestamp: 10,
        step: 0,
        payload: {},
        requestId: 'req-1',
      },
    });

    const rejected = server.handleEnvelope(envelope);
    expect(rejected.status).toBe('rejected');
    expect(rejected.error?.code).toBe('INVALID_COMMAND_TYPE');

    const duplicate = server.handleEnvelope(envelope);
    expect(duplicate.status).toBe('duplicate');
    expect(duplicate.error?.code).toBe('INVALID_COMMAND_TYPE');
  });

  it('rejects requestId collisions across clients', () => {
    const { runtime, commandQueue, commandDispatcher } = createRuntime();
    commandDispatcher.register('TEST', () => undefined);

    const server = createCommandTransportServer({
      commandQueue,
      getNextExecutableStep: () => runtime.getNextExecutableStep(),
    });

    const envelope = createEnvelope();
    const accepted = server.handleEnvelope(envelope);
    expect(accepted.status).toBe('accepted');
    expect(commandQueue.size).toBe(1);

    const collision = server.handleEnvelope(
      createEnvelope({ clientId: 'client-2' }),
    );
    expect(collision.status).toBe('rejected');
    expect(collision.error?.code).toBe('REQUEST_ID_IN_USE');
    expect(commandQueue.size).toBe(1);

    const duplicate = server.handleEnvelope(envelope);
    expect(duplicate.status).toBe('duplicate');
    expect(commandQueue.size).toBe(1);
  });

  it('accepts distinct client/request pairs when identifiers include colons', () => {
    const { runtime, commandQueue, commandDispatcher } = createRuntime();
    commandDispatcher.register('TEST', () => undefined);

    const server = createCommandTransportServer({
      commandQueue,
      getNextExecutableStep: () => runtime.getNextExecutableStep(),
    });

    const first = createEnvelope({
      requestId: 'c',
      clientId: 'a:b',
      command: {
        type: 'TEST',
        priority: CommandPriority.PLAYER,
        timestamp: 100,
        step: 0,
        payload: {},
        requestId: 'c',
      },
    });

    const second = createEnvelope({
      requestId: 'b:c',
      clientId: 'a',
      command: {
        type: 'TEST',
        priority: CommandPriority.PLAYER,
        timestamp: 100,
        step: 0,
        payload: {},
        requestId: 'b:c',
      },
    });

    expect(server.handleEnvelope(first).status).toBe('accepted');
    expect(server.handleEnvelope(second).status).toBe('accepted');
    expect(commandQueue.size).toBe(2);
  });

  it('rejects envelopes with non-finite sentAt values', () => {
    const { commandQueue } = createRuntime();

    const server = createCommandTransportServer({
      commandQueue,
    });

    const envelope = createEnvelope({
      sentAt: Number.NaN,
    });

    const rejected = server.handleEnvelope(envelope);
    expect(rejected.status).toBe('rejected');
    expect(rejected.error?.code).toBe('INVALID_SENT_AT');
    expect(commandQueue.size).toBe(0);

    const duplicate = server.handleEnvelope(envelope);
    expect(duplicate.status).toBe('duplicate');
    expect(duplicate.error?.code).toBe('INVALID_SENT_AT');
  });

  it('updates stored responses when command outcomes are drained', () => {
    const { runtime, commandQueue, commandDispatcher } = createRuntime();
    commandDispatcher.register('TEST_FAIL', () => ({
      success: false,
      error: {
        code: 'TEST_FAILURE',
        message: 'Nope',
      },
    }));

    const server = createCommandTransportServer({
      commandQueue,
      getNextExecutableStep: () => runtime.getNextExecutableStep(),
      drainCommandOutcomes: () => runtime.drainCommandOutcomes(),
    });

    const envelope = createEnvelope({
      requestId: 'req-fail',
      command: {
        type: 'TEST_FAIL',
        priority: CommandPriority.PLAYER,
        timestamp: 50,
        step: 0,
        payload: {},
        requestId: 'req-fail',
      },
    });

    const accepted = server.handleEnvelope(envelope);
    expect(accepted.status).toBe('accepted');

    runtime.tick(10);

    const outcomes = server.drainOutcomeResponses();
    expect(outcomes).toEqual([
      {
        requestId: 'req-fail',
        status: 'rejected',
        serverStep: 0,
        error: {
          code: 'TEST_FAILURE',
          message: 'Nope',
        },
      },
    ]);

    const duplicate = server.handleEnvelope(envelope);
    expect(duplicate.status).toBe('duplicate');
    expect(duplicate.error?.code).toBe('TEST_FAILURE');
  });

  it('returns accepted outcome responses when commands succeed', () => {
    const { runtime, commandQueue, commandDispatcher } = createRuntime();
    commandDispatcher.register('TEST_SUCCESS', () => undefined);

    const server = createCommandTransportServer({
      commandQueue,
      getNextExecutableStep: () => runtime.getNextExecutableStep(),
      drainCommandOutcomes: () => runtime.drainCommandOutcomes(),
    });

    const envelope = createEnvelope({
      requestId: 'req-success',
      command: {
        type: 'TEST_SUCCESS',
        priority: CommandPriority.PLAYER,
        timestamp: 50,
        step: 0,
        payload: {},
        requestId: 'req-success',
      },
    });

    const accepted = server.handleEnvelope(envelope);
    expect(accepted.status).toBe('accepted');

    runtime.tick(10);

    const outcomes = server.drainOutcomeResponses();
    expect(outcomes).toEqual([
      {
        requestId: 'req-success',
        status: 'accepted',
        serverStep: 0,
      },
    ]);

    const duplicate = server.handleEnvelope(envelope);
    expect(duplicate).toEqual({
      requestId: 'req-success',
      status: 'duplicate',
      serverStep: 0,
    });
  });
});
