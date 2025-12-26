import { describe, expect, it, vi, afterEach } from 'vitest';

import type { DiagnosticTimelineResult } from '@idle-engine/core';

import {
  CommandSource,
  WorkerBridgeImpl,
  type WorkerBridge,
  type RuntimeStateSnapshot,
  type WorkerBridgeErrorDetails,
  SOCIAL_COMMAND_TYPES,
  type WorkerBridgeWorker,
  registerWorkerBridgeDebugHandleForTesting,
} from './worker-bridge.js';
import { createInlineRuntimeWorker } from './inline-runtime-worker.js';
import {
  WORKER_MESSAGE_SCHEMA_VERSION,
  type RuntimeWorkerReady,
} from '@idle-engine/runtime-bridge-contracts';
import { setSocialConfigOverrideForTesting } from './social-config.js';

const progressionSnapshot: RuntimeStateSnapshot['progression'] = {
  step: 0,
  publishedAt: 0,
  resources: [],
  generators: [],
  upgrades: [],
  automations: [],
  transforms: [],
  prestigeLayers: [],
};

class MockWorker implements WorkerBridgeWorker {
  public readonly postMessage = vi.fn<(data: unknown) => void>();
  public readonly terminate = vi.fn();

  private readonly listeners = new Map<
    string,
    Set<(event: MessageEvent<unknown>) => void>
  >();

  addEventListener(
    type: string,
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(
    type: string,
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    const registry = this.listeners.get(type);
    registry?.delete(listener);
  }

  emitMessage<TData>(type: string, data: TData): void {
    const registry = this.listeners.get(type);
    if (!registry) {
      return;
    }
    const event = { data } as MessageEvent<TData>;
    for (const listener of registry) {
      listener(event);
    }
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

type WorkerBridgeDebugGlobal = typeof globalThis & {
  __ENABLE_IDLE_DEBUG__?: unknown;
  __IDLE_WORKER_BRIDGE__?: WorkerBridge<unknown>;
};

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
    const bridge = new WorkerBridgeImpl(worker as WorkerBridgeWorker);
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
      new WorkerBridgeImpl<RuntimeStateSnapshot>(worker as WorkerBridgeWorker);
    const handler = vi.fn<(snapshot: RuntimeStateSnapshot) => void>();
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
      progression: progressionSnapshot,
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
    const bridge = new WorkerBridgeImpl(worker as WorkerBridgeWorker);

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
    const bridge = new WorkerBridgeImpl(worker as WorkerBridgeWorker);

    const handler = vi.fn<(timeline: DiagnosticTimelineResult) => void>();
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
    const bridge = new WorkerBridgeImpl(worker as WorkerBridgeWorker);

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

  it('includes maxElapsedMs and maxSteps in restore envelopes', async () => {
    const worker = new MockWorker();
    const bridge = new WorkerBridgeImpl(worker as WorkerBridgeWorker);

    const restorePromise = bridge.restoreSession({
      elapsedMs: 42,
      maxElapsedMs: 24000,
      maxSteps: 3,
    });

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
      maxElapsedMs?: number;
      maxSteps?: number;
    };
    expect(restoreEnvelope).toMatchObject({
      type: 'RESTORE_SESSION',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      elapsedMs: 42,
      maxElapsedMs: 24000,
      maxSteps: 3,
    });

    worker.emitMessage('message', {
      type: 'SESSION_RESTORED',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
    });

    await restorePromise;
  });

  it('rejects restore payloads with invalid maxElapsedMs values', async () => {
    const worker = new MockWorker();
    const bridge = new WorkerBridgeImpl(worker as WorkerBridgeWorker);

    await expect(
      bridge.restoreSession({ maxElapsedMs: -1 }),
    ).rejects.toThrow('maxElapsedMs must be a non-negative finite number');
    await expect(
      bridge.restoreSession({ maxElapsedMs: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow('maxElapsedMs must be a non-negative finite number');

    expect(worker.postMessage).not.toHaveBeenCalled();
  });

  it('rejects restore payloads with invalid maxSteps values', async () => {
    const worker = new MockWorker();
    const bridge = new WorkerBridgeImpl(worker as WorkerBridgeWorker);

    await expect(
      bridge.restoreSession({ maxSteps: -1 }),
    ).rejects.toThrow('maxSteps must be a non-negative finite number');
    await expect(
      bridge.restoreSession({ maxSteps: Number.NaN }),
    ).rejects.toThrow('maxSteps must be a non-negative finite number');

    expect(worker.postMessage).not.toHaveBeenCalled();
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
    const bridge = new WorkerBridgeImpl(worker as WorkerBridgeWorker);
    const errorHandler = vi.fn<
      (error: WorkerBridgeErrorDetails) => void
    >();
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
    const bridge = new WorkerBridgeImpl(worker as WorkerBridgeWorker);

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
    const bridge = new WorkerBridgeImpl(worker as WorkerBridgeWorker);
    const errorHandler = vi.fn<
      (error: WorkerBridgeErrorDetails) => void
    >();
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
    const bridge = new WorkerBridgeImpl(worker as WorkerBridgeWorker);

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
    const bridge = new WorkerBridgeImpl(worker as WorkerBridgeWorker);

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
    const bridge = new WorkerBridgeImpl(worker as WorkerBridgeWorker);

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

const INLINE_WORKER_READY_TIMEOUT_MS = 15_000;

describe('createInlineRuntimeWorker', () => {
  it('boots the runtime harness when the worker bridge flag is disabled', async () => {
    const worker = createInlineRuntimeWorker();

    const readyEnvelope = await new Promise<RuntimeWorkerReady>((resolve, reject) => {
      const timeout = setTimeout(() => {
        worker.terminate();
        reject(new Error('Inline runtime worker did not emit READY'));
      }, INLINE_WORKER_READY_TIMEOUT_MS);

      const listener = (event: MessageEvent<unknown>) => {
        const payload = event.data as { type?: string } | null;
        if (payload?.type === 'READY') {
          clearTimeout(timeout);
          worker.removeEventListener('message', listener);
          resolve(payload as RuntimeWorkerReady);
        }
      };

      worker.addEventListener('message', listener);
    });

    expect(readyEnvelope.type).toBe('READY');
    expect(readyEnvelope.schemaVersion).toBe(WORKER_MESSAGE_SCHEMA_VERSION);

    worker.terminate();
  }, INLINE_WORKER_READY_TIMEOUT_MS);
});

describe('Inline runtime worker integration', () => {
  it('resolves READY and emits state updates when using the inline legacy path', async () => {
    vi.useFakeTimers();
    const worker = createInlineRuntimeWorker();
    const bridge =
      new WorkerBridgeImpl<RuntimeStateSnapshot>(worker);

    try {
      await bridge.awaitReady();

      const updates: RuntimeStateSnapshot[] = [];
      bridge.onStateUpdate((state) => {
        updates.push(state);
      });

      // IdleEngineRuntime emits STATE_UPDATE only after completing a 100ms step.
      await vi.advanceTimersByTimeAsync(160);
      await Promise.resolve();

      expect(updates.length).toBeGreaterThan(0);
      expect(updates.at(-1)?.currentStep ?? 0).toBeGreaterThan(0);
    } finally {
      bridge.dispose();
      vi.useRealTimers();
    }
  });

  it('keeps inline worker instances isolated when one is terminated', async () => {
    vi.useFakeTimers();
    const workerA = createInlineRuntimeWorker();
    const workerB = createInlineRuntimeWorker();
    const bridgeA =
      new WorkerBridgeImpl<RuntimeStateSnapshot>(workerA);
    const bridgeB =
      new WorkerBridgeImpl<RuntimeStateSnapshot>(workerB);

    try {
      await Promise.all([
        bridgeA.awaitReady(),
        bridgeB.awaitReady(),
      ]);

      const updatesA: RuntimeStateSnapshot[] = [];
      const updatesB: RuntimeStateSnapshot[] = [];

      bridgeA.onStateUpdate((state) => {
        updatesA.push(state);
      });
      bridgeB.onStateUpdate((state) => {
        updatesB.push(state);
      });

      await vi.advanceTimersByTimeAsync(160);
      await Promise.resolve();

      expect(updatesA.length).toBeGreaterThan(0);
      expect(updatesB.length).toBeGreaterThan(0);

      const lastStepB =
        updatesB.at(-1)?.currentStep ?? 0;

      bridgeA.dispose();

      await vi.advanceTimersByTimeAsync(160);
      await Promise.resolve();

      const nextStepB =
        updatesB.at(-1)?.currentStep ?? 0;

      expect(nextStepB).toBeGreaterThan(lastStepB);
    } finally {
      bridgeB.dispose();
      vi.useRealTimers();
    }
  });
});

describe('worker bridge debug handle guard', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const debugGlobal = globalThis as WorkerBridgeDebugGlobal;

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    delete debugGlobal.__ENABLE_IDLE_DEBUG__;
    delete debugGlobal.__IDLE_WORKER_BRIDGE__;
  });

  it('skips exposing the debug handle in production without opt-in', () => {
    process.env.NODE_ENV = 'production';
    const bridge = {} as WorkerBridge<unknown>;

    registerWorkerBridgeDebugHandleForTesting(debugGlobal, bridge);

    expect(debugGlobal.__IDLE_WORKER_BRIDGE__).toBeUndefined();
  });

  it('exposes the debug handle in production when __ENABLE_IDLE_DEBUG__ is truthy', () => {
    process.env.NODE_ENV = 'production';
    debugGlobal.__ENABLE_IDLE_DEBUG__ = 'true';
    const bridge = {} as WorkerBridge<unknown>;

    registerWorkerBridgeDebugHandleForTesting(debugGlobal, bridge);

    expect(debugGlobal.__IDLE_WORKER_BRIDGE__).toBe(bridge);
  });

  it('exposes the debug handle outside of production environments', () => {
    process.env.NODE_ENV = 'test';
    const bridge = {} as WorkerBridge<unknown>;

    registerWorkerBridgeDebugHandleForTesting(debugGlobal, bridge);

    expect(debugGlobal.__IDLE_WORKER_BRIDGE__).toBe(bridge);
  });
});
