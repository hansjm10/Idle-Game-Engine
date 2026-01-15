import { describe, expect, it } from 'vitest';

import { CommandPriority } from './command.js';
import { CommandDispatcher } from './command-dispatcher.js';
import { CommandQueue } from './command-queue.js';
import type { JsonValue } from './command-queue.js';
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

const createIdentifier = (length: number) => 'x'.repeat(length);

const createCircularPayload = (): Record<string, unknown> => {
  const payload: Record<string, unknown> = {};
  payload.self = payload;
  return payload;
};

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

  it('rejects envelopes when command requestId differs from envelope requestId', () => {
    const { commandQueue } = createRuntime();

    const server = createCommandTransportServer({
      commandQueue,
    });

    const envelope = createEnvelope({
      requestId: 'req-envelope',
      command: {
        type: 'TEST',
        priority: CommandPriority.PLAYER,
        timestamp: 10,
        step: 0,
        payload: {},
        requestId: 'req-command',
      },
    });

    const rejected = server.handleEnvelope(envelope);
    expect(rejected.status).toBe('rejected');
    expect(rejected.error?.code).toBe('REQUEST_ID_MISMATCH');
    expect(commandQueue.size).toBe(0);

    const duplicate = server.handleEnvelope(envelope);
    expect(duplicate.status).toBe('duplicate');
    expect(duplicate.error?.code).toBe('REQUEST_ID_MISMATCH');
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

  it.each([
    {
      label: 'empty requestId',
      requestId: '',
      errorCode: 'INVALID_IDENTIFIER',
    },
    {
      label: 'whitespace requestId',
      requestId: ' ',
      errorCode: 'INVALID_IDENTIFIER',
    },
    {
      label: 'leading whitespace requestId',
      requestId: ' req-1',
      errorCode: 'INVALID_IDENTIFIER_FORMAT',
    },
    {
      label: 'trailing whitespace requestId',
      requestId: 'req-1 ',
      errorCode: 'INVALID_IDENTIFIER_FORMAT',
    },
    {
      label: 'over-length requestId',
      requestId: createIdentifier(6),
      errorCode: 'IDENTIFIER_TOO_LONG',
      maxIdentifierLength: 5,
    },
  ])('rejects invalid requestId ($label)', ({ requestId, errorCode, maxIdentifierLength }) => {
    const { commandQueue } = createRuntime();

    const server = createCommandTransportServer({
      commandQueue,
      maxIdentifierLength,
    });

    const response = server.handleEnvelope(createEnvelope({ requestId }));
    expect(response.status).toBe('rejected');
    expect(response.error?.code).toBe(errorCode);
    expect(commandQueue.size).toBe(0);
  });

  it.each([
    {
      label: 'numeric requestId',
      requestId: 42 as unknown as string,
    },
    {
      label: 'null requestId',
      requestId: null as unknown as string,
    },
    {
      label: 'undefined requestId',
      requestId: undefined as unknown as string,
    },
  ])('rejects non-string requestId ($label)', ({ requestId }) => {
    const { commandQueue } = createRuntime();

    const server = createCommandTransportServer({
      commandQueue,
    });

    const response = server.handleEnvelope(createEnvelope({ requestId }));
    expect(response.status).toBe('rejected');
    expect(response.error?.code).toBe('INVALID_IDENTIFIER');
    expect(commandQueue.size).toBe(0);
  });

  it.each([
    {
      label: 'empty clientId',
      clientId: '',
      errorCode: 'INVALID_IDENTIFIER',
    },
    {
      label: 'whitespace clientId',
      clientId: ' ',
      errorCode: 'INVALID_IDENTIFIER',
    },
    {
      label: 'leading whitespace clientId',
      clientId: ' client-1',
      errorCode: 'INVALID_IDENTIFIER_FORMAT',
    },
    {
      label: 'trailing whitespace clientId',
      clientId: 'client-1 ',
      errorCode: 'INVALID_IDENTIFIER_FORMAT',
    },
    {
      label: 'over-length clientId',
      clientId: createIdentifier(6),
      errorCode: 'IDENTIFIER_TOO_LONG',
      maxIdentifierLength: 5,
    },
  ])('rejects invalid clientId ($label)', ({ clientId, errorCode, maxIdentifierLength }) => {
    const { commandQueue } = createRuntime();

    const server = createCommandTransportServer({
      commandQueue,
      maxIdentifierLength,
    });

    const response = server.handleEnvelope(createEnvelope({ clientId }));
    expect(response.status).toBe('rejected');
    expect(response.error?.code).toBe(errorCode);
    expect(commandQueue.size).toBe(0);
  });

  it.each([
    {
      label: 'numeric clientId',
      clientId: 42 as unknown as string,
    },
    {
      label: 'null clientId',
      clientId: null as unknown as string,
    },
    {
      label: 'undefined clientId',
      clientId: undefined as unknown as string,
    },
  ])('rejects non-string clientId ($label)', ({ clientId }) => {
    const { commandQueue } = createRuntime();

    const server = createCommandTransportServer({
      commandQueue,
    });

    const response = server.handleEnvelope(createEnvelope({ clientId }));
    expect(response.status).toBe('rejected');
    expect(response.error?.code).toBe('INVALID_IDENTIFIER');
    expect(commandQueue.size).toBe(0);
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

  it.each([
    {
      label: 'invalid priority',
      commandOverrides: { priority: 99 },
      errorCode: 'INVALID_COMMAND_PRIORITY',
      expectedDetails: { priority: 99 },
    },
    {
      label: 'non-finite priority',
      commandOverrides: { priority: Number.NaN },
      errorCode: 'INVALID_COMMAND_PRIORITY',
      expectedDetails: { priority: 'NaN' },
    },
    {
      label: 'invalid timestamp',
      commandOverrides: { timestamp: Number.NaN },
      errorCode: 'INVALID_COMMAND_TIMESTAMP',
    },
    {
      label: 'invalid step',
      commandOverrides: { step: -1 },
      errorCode: 'INVALID_COMMAND_STEP',
    },
  ])('rejects commands with $label', ({ commandOverrides, errorCode, expectedDetails }) => {
    const { commandQueue } = createRuntime();

    const baseCommand = createEnvelope().command;
    const server = createCommandTransportServer({
      commandQueue,
    });

    const envelope = createEnvelope({
      command: {
        ...baseCommand,
        ...commandOverrides,
      },
    });

    const rejected = server.handleEnvelope(envelope);
    expect(rejected.status).toBe('rejected');
    expect(rejected.error?.code).toBe(errorCode);
    if (expectedDetails) {
      expect(rejected.error?.details).toEqual(expectedDetails);
    }
    expect(commandQueue.size).toBe(0);
  });

  it('rejects commands with invalid command requestId values', () => {
    const { commandQueue } = createRuntime();

    const baseCommand = createEnvelope().command;
    const server = createCommandTransportServer({
      commandQueue,
    });

    const envelope = createEnvelope({
      command: {
        ...baseCommand,
        requestId: ' invalid',
      },
    });

    const rejected = server.handleEnvelope(envelope);
    expect(rejected.status).toBe('rejected');
    expect(rejected.error?.code).toBe('INVALID_COMMAND_REQUEST_ID');
    expect(commandQueue.size).toBe(0);

    const duplicate = server.handleEnvelope(envelope);
    expect(duplicate.status).toBe('duplicate');
    expect(duplicate.error?.code).toBe('INVALID_COMMAND_REQUEST_ID');
  });

  it.each([
    {
      label: 'string command',
      command: 'invalid' as unknown as CommandEnvelope['command'],
    },
    {
      label: 'null command',
      command: null as unknown as CommandEnvelope['command'],
    },
  ])('rejects non-object commands ($label)', ({ command }) => {
    const { commandQueue } = createRuntime();

    const server = createCommandTransportServer({
      commandQueue,
    });

    const envelope = createEnvelope({ command });
    const rejected = server.handleEnvelope(envelope);
    expect(rejected.status).toBe('rejected');
    expect(rejected.error?.code).toBe('INVALID_COMMAND');
    expect(commandQueue.size).toBe(0);

    const duplicate = server.handleEnvelope(envelope);
    expect(duplicate.status).toBe('duplicate');
    expect(duplicate.error?.code).toBe('INVALID_COMMAND');
  });

  it.each([
    {
      label: 'undefined values',
      createPayload: () => ({ value: undefined }),
    },
    {
      label: 'non-finite number',
      createPayload: () => ({ value: Number.POSITIVE_INFINITY }),
    },
    {
      label: 'circular reference',
      createPayload: () => createCircularPayload(),
    },
    {
      label: 'non-plain object',
      createPayload: () => new (class Payload {})(),
    },
    {
      label: 'symbol key',
      createPayload: () => ({ [Symbol('payload')]: 'value' }),
    },
  ])('rejects commands with invalid payloads ($label)', ({ createPayload }) => {
    const { commandQueue } = createRuntime();

    const server = createCommandTransportServer({
      commandQueue,
    });

    const payload = createPayload() as unknown as JsonValue;
    const envelope = createEnvelope({
      command: {
        type: 'TEST',
        priority: CommandPriority.PLAYER,
        timestamp: 100,
        step: 0,
        payload,
        requestId: 'req-1',
      },
    });

    const rejected = server.handleEnvelope(envelope);
    expect(rejected.status).toBe('rejected');
    expect(rejected.error?.code).toBe('INVALID_COMMAND_PAYLOAD');
    expect(commandQueue.size).toBe(0);
  });

  it('accepts envelopes when command requestId is omitted', () => {
    const { runtime, commandQueue, commandDispatcher } = createRuntime();
    commandDispatcher.register('TEST', () => undefined);

    const server = createCommandTransportServer({
      commandQueue,
      getNextExecutableStep: () => runtime.getNextExecutableStep(),
    });

    const baseCommand = createEnvelope().command;
    const command = { ...baseCommand, requestId: undefined };

    const accepted = server.handleEnvelope(
      createEnvelope({
        command,
      }),
    );

    expect(accepted.status).toBe('accepted');
    expect(commandQueue.dequeueAll()[0]?.requestId).toBe('req-1');
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
