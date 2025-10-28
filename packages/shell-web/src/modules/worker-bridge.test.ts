import { describe, expect, it, vi } from 'vitest';

import type { DiagnosticTimelineResult } from '@idle-engine/core';

import {
  CommandSource,
  WorkerBridgeImpl,
  type RuntimeStateSnapshot,
  type WorkerBridgeErrorDetails,
  SOCIAL_COMMAND_TYPES,
} from './worker-bridge.js';
import { WORKER_MESSAGE_SCHEMA_VERSION } from './runtime-worker-protocol.js';
import { setSocialConfigOverrideForTesting } from './social-config.js';

type MessageListener<TData = unknown> = (event: { data: TData }) => void;

class MockWorker {
  public readonly postMessage = vi.fn<(data: unknown) => void>();
  public readonly terminate = vi.fn<void, []>();

  private readonly listeners = new Map<string, Set<MessageListener>>();

  addEventListener<TData>(
    type: string,
    listener: MessageListener<TData>,
  ): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener as MessageListener);
  }

  removeEventListener<TData>(
    type: string,
    listener: MessageListener<TData>,
  ): void {
    const registry = this.listeners.get(type);
    registry?.delete(listener as MessageListener);
  }

  emitMessage<TData>(type: string, data: TData): void {
    const registry = this.listeners.get(type);
    if (!registry) {
      return;
    }
    for (const listener of registry) {
      listener({ data });
    }
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

describe('WorkerBridgeImpl', () => {
  afterEach(() => {
    delete (globalThis as {
      __IDLE_ENGINE_TELEMETRY__?: {
        recordError: (event: string, data?: Record<string, unknown>) => void;
      };
    }).__IDLE_ENGINE_TELEMETRY__;
    setSocialConfigOverrideForTesting(null);
    vi.restoreAllMocks();
  });

  it('queues commands until the worker sends READY', async () => {
    const worker = new MockWorker();
    const bridge = new WorkerBridgeImpl(worker as unknown as Worker);
    const readyPromise = bridge.awaitReady();

    bridge.sendCommand('PING', { iteration: 1 });

    expect(worker.postMessage).not.toHaveBeenCalled();

    worker.emitMessage('message', {
      type: 'READY',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
    });

    await readyPromise;

    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    const envelope = worker.postMessage.mock.calls[0]![0] as {
      type: string;
      schemaVersion: number;
      requestId?: string;
      source: CommandSource;
      command: { type: string; payload: unknown; issuedAt: number };
    };

    expect(envelope).toMatchObject({
      type: 'COMMAND',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      source: CommandSource.PLAYER,
      command: {
        type: 'PING',
        payload: { iteration: 1 },
      },
    });
    expect(typeof envelope.command.issuedAt).toBe('number');
    expect(typeof envelope.requestId).toBe('string');
  });

  it('notifies subscribers when state updates arrive from the worker', () => {
    const worker = new MockWorker();
    const bridge =
      new WorkerBridgeImpl<RuntimeStateSnapshot>(worker as unknown as Worker);
    const handler = vi.fn<void, [RuntimeStateSnapshot]>();
    bridge.onStateUpdate(handler);

    worker.emitMessage('message', {
      type: 'READY',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
    });

    const snapshot: RuntimeStateSnapshot = {
      currentStep: 7,
      events: [],
      backPressure: {
        tick: 7,
        counters: {
          published: 0,
          softLimited: 0,
          overflowed: 0,
          subscribers: 0,
        },
        channels: [],
      },
    };

    worker.emitMessage('message', {
      type: 'STATE_UPDATE',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      state: snapshot,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(snapshot);

    bridge.offStateUpdate(handler);
    worker.emitMessage('message', {
      type: 'STATE_UPDATE',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      state: snapshot,
    });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('disposes the worker and prevents additional commands', () => {
    const worker = new MockWorker();
    const bridge = new WorkerBridgeImpl(worker as unknown as Worker);

    worker.emitMessage('message', {
      type: 'READY',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
    });

    expect(worker.listenerCount('message')).toBe(1);

    bridge.dispose();

    expect(worker.listenerCount('message')).toBe(0);
    expect(worker.postMessage).toHaveBeenCalledWith({
      type: 'TERMINATE',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
    });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(() => bridge.sendCommand('PING', {})).toThrow(
      'WorkerBridge has been disposed',
    );
    expect(() => bridge.enableDiagnostics()).toThrow(
      'WorkerBridge has been disposed',
    );
    expect(() => bridge.disableDiagnostics()).toThrow(
      'WorkerBridge has been disposed',
    );
  });

  it('subscribes to diagnostics updates and forwards payloads', async () => {
    const worker = new MockWorker();
    const bridge = new WorkerBridgeImpl(worker as unknown as Worker);

    const handler = vi.fn<void, [DiagnosticTimelineResult]>();
    const readyPromise = bridge.awaitReady();
    bridge.onDiagnosticsUpdate(handler);
    bridge.enableDiagnostics();

    expect(worker.postMessage).not.toHaveBeenCalled();

    worker.emitMessage('message', {
      type: 'READY',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
    });

    await readyPromise;

    expect(worker.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({
      type: 'DIAGNOSTICS_SUBSCRIBE',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
    });

    const diagnosticsPayload = Object.freeze({
      entries: Object.freeze([]),
      head: 1,
      dropped: 0,
      configuration: Object.freeze({
        capacity: 120,
        slowTickBudgetMs: 50,
        enabled: true,
        slowSystemBudgetMs: 16,
        systemHistorySize: 60,
        tickBudgetMs: 100,
      }),
    }) as DiagnosticTimelineResult;

    worker.emitMessage('message', {
      type: 'DIAGNOSTICS_UPDATE',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      diagnostics: diagnosticsPayload,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(diagnosticsPayload);

    bridge.offDiagnosticsUpdate(handler);
    worker.emitMessage('message', {
      type: 'DIAGNOSTICS_UPDATE',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      diagnostics: diagnosticsPayload,
    });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('restores session and flushes queued commands after acknowledgement', async () => {
    const worker = new MockWorker();
    const bridge = new WorkerBridgeImpl(worker as unknown as Worker);

    const restorePromise = bridge.restoreSession({ elapsedMs: 42 });

    worker.emitMessage('message', {
      type: 'READY',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
    });
    await bridge.awaitReady();

    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    const restoreEnvelope = worker.postMessage.mock.calls[0]![0] as {
      type: string;
      schemaVersion: number;
      elapsedMs?: number;
    };
    expect(restoreEnvelope).toMatchObject({
      type: 'RESTORE_SESSION',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      elapsedMs: 42,
    });

    bridge.sendCommand('PING', { data: true });
    expect(worker.postMessage).toHaveBeenCalledTimes(1);

    worker.emitMessage('message', {
      type: 'SESSION_RESTORED',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
    });

    await restorePromise;

    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    const commandEnvelope = worker.postMessage.mock.calls[1]![0] as {
      type: string;
    };
    expect(commandEnvelope.type).toBe('COMMAND');
  });

  it('rejects session restore when the worker reports a failure', async () => {
    const telemetrySpy = vi.fn();
    (globalThis as {
      __IDLE_ENGINE_TELEMETRY__?: {
        recordError: (event: string, data?: Record<string, unknown>) => void;
      };
    }).__IDLE_ENGINE_TELEMETRY__ = {
      recordError: telemetrySpy,
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const worker = new MockWorker();
    const bridge = new WorkerBridgeImpl(worker as unknown as Worker);
    const errorHandler = vi.fn<void, [WorkerBridgeErrorDetails]>();
    bridge.onError(errorHandler);

    const restorePromise = bridge.restoreSession();

    worker.emitMessage('message', {
      type: 'READY',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
    });

    worker.emitMessage('message', {
      type: 'ERROR',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      error: {
        code: 'RESTORE_FAILED',
        message: 'restore failed',
        requestId: 'restore:1',
      },
    });

    await expect(restorePromise).rejects.toThrow('restore failed');
    expect(errorHandler).toHaveBeenCalledWith({
      code: 'RESTORE_FAILED',
      message: 'restore failed',
      requestId: 'restore:1',
    });
    expect(telemetrySpy).toHaveBeenCalledWith('WorkerBridgeError', {
      code: 'RESTORE_FAILED',
      message: 'restore failed',
      requestId: 'restore:1',
    });
  });

  it('sends diagnostics unsubscribe messages', async () => {
    const worker = new MockWorker();
    const bridge = new WorkerBridgeImpl(worker as unknown as Worker);

    worker.emitMessage('message', {
      type: 'READY',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
    });
    await bridge.awaitReady();

    bridge.disableDiagnostics();

    expect(worker.postMessage).toHaveBeenCalledWith({
      type: 'DIAGNOSTICS_UNSUBSCRIBE',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
    });
  });

  it('emits error events when the worker reports failures', () => {
    const worker = new MockWorker();
    const bridge = new WorkerBridgeImpl(worker as unknown as Worker);
    const errorHandler = vi.fn<void, [WorkerBridgeErrorDetails]>();
    const errorLogSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    bridge.onError(errorHandler);

    const errorPayload = {
      type: 'ERROR',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      error: {
        code: 'INVALID_COMMAND_PAYLOAD',
        message: 'Invalid payload',
        requestId: 'test-0',
      },
    } satisfies {
      type: string;
      schemaVersion: number;
      error: WorkerBridgeErrorDetails;
    };

    worker.emitMessage('message', errorPayload);

    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(errorHandler).toHaveBeenCalledWith(errorPayload.error);
    expect(errorLogSpy).toHaveBeenCalledWith(
      '[WorkerBridge] Worker error received',
      errorPayload.error,
    );

    bridge.offError(errorHandler);
    worker.emitMessage('message', errorPayload);
    expect(errorHandler).toHaveBeenCalledTimes(1);
  });

  it('rejects social commands when the feature flag is disabled', async () => {
    const worker = new MockWorker();
    const bridge = new WorkerBridgeImpl(worker as unknown as Worker);

    await expect(
      bridge.sendSocialCommand(SOCIAL_COMMAND_TYPES.FETCH_LEADERBOARD, {
        leaderboardId: 'daily',
        accessToken: 'token',
      }),
    ).rejects.toThrow('Social commands are disabled');

    expect(worker.postMessage).not.toHaveBeenCalled();
  });

  it('sends social commands through the worker when enabled', async () => {
    setSocialConfigOverrideForTesting({
      enabled: true,
      baseUrl: 'https://social.example',
    });

    const worker = new MockWorker();
    const bridge = new WorkerBridgeImpl(worker as unknown as Worker);

    const responsePromise = bridge.sendSocialCommand(
      SOCIAL_COMMAND_TYPES.FETCH_LEADERBOARD,
      {
        leaderboardId: 'daily',
        accessToken: 'token',
      },
    );

    expect(worker.postMessage).not.toHaveBeenCalled();

    worker.emitMessage('message', {
      type: 'READY',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
    });

    const socialEnvelope = worker.postMessage.mock.calls[0]![0] as {
      type: string;
      requestId: string;
      command: { kind: string; payload: unknown };
    };

    expect(socialEnvelope.type).toBe('SOCIAL_COMMAND');
    expect(socialEnvelope.command.kind).toBe(
      SOCIAL_COMMAND_TYPES.FETCH_LEADERBOARD,
    );

    const successPayload = {
      type: 'SOCIAL_COMMAND_RESULT',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      requestId: socialEnvelope.requestId,
      status: 'success',
      kind: SOCIAL_COMMAND_TYPES.FETCH_LEADERBOARD,
      data: {
        leaderboardId: 'daily',
        entries: [],
      },
    } as const;

    worker.emitMessage('message', successPayload);

    await expect(responsePromise).resolves.toEqual(successPayload.data);
  });

  it('rejects social command promises when the worker reports an error', async () => {
    setSocialConfigOverrideForTesting({
      enabled: true,
      baseUrl: 'https://social.example',
    });

    const telemetrySpy = vi.fn();
    (globalThis as {
      __IDLE_ENGINE_TELEMETRY__?: {
        recordError: (event: string, data?: Record<string, unknown>) => void;
      };
    }).__IDLE_ENGINE_TELEMETRY__ = {
      recordError: telemetrySpy,
    };

    const worker = new MockWorker();
    const bridge = new WorkerBridgeImpl(worker as unknown as Worker);

    const responsePromise = bridge.sendSocialCommand(
      SOCIAL_COMMAND_TYPES.CREATE_GUILD,
      {
        name: 'Guild',
        description: 'Test guild',
        accessToken: 'token',
      },
    );

    worker.emitMessage('message', {
      type: 'READY',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
    });

    const socialEnvelope = worker.postMessage.mock.calls[0]![0] as {
      requestId: string;
    };

    worker.emitMessage('message', {
      type: 'SOCIAL_COMMAND_RESULT',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      requestId: socialEnvelope.requestId,
      status: 'error',
      kind: SOCIAL_COMMAND_TYPES.CREATE_GUILD,
      error: {
        code: 'SOCIAL_COMMAND_FAILED',
        message: 'Social command failed: request rejected',
        details: { status: 401 },
      },
    });

    await expect(responsePromise).rejects.toThrow(
      'Social command failed: request rejected',
    );

    expect(telemetrySpy).toHaveBeenCalledWith('SocialCommandFailed', {
      code: 'SOCIAL_COMMAND_FAILED',
      kind: SOCIAL_COMMAND_TYPES.CREATE_GUILD,
      requestId: socialEnvelope.requestId,
    });
  });
});
