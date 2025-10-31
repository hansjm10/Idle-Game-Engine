import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from 'vitest';
import type { DiagnosticTimelineResult } from '@idle-engine/core';
import type {
  RuntimeStateSnapshot,
  WorkerBridge,
  WorkerBridgeErrorDetails,
  WorkerRestoreSessionPayload,
  SocialCommandPayloads,
  SocialCommandResults,
  SocialCommandType,
} from './worker-bridge.js';
import type * as WorkerBridgeModule from './worker-bridge.js';
import type { ShellBridgeApi, ShellDiagnosticsApi } from './shell-state.types.js';

type TelemetryFacade = {
  recordError: (event: string, data?: Record<string, unknown>) => void;
};

type IdleTelemetryGlobal = typeof globalThis & {
  __IDLE_ENGINE_TELEMETRY__?: TelemetryFacade;
};

type AwaitReadyMock = Mock<Promise<void>, []>;
type RestoreSessionMock = Mock<
  Promise<void>,
  [WorkerRestoreSessionPayload | undefined]
>;
type CommandMock = Mock<void, [string, unknown]>;
type SocialCommandMock = Mock<
  Promise<SocialCommandResults[SocialCommandType]>,
  [SocialCommandType, SocialCommandPayloads[SocialCommandType]]
>;
type NoArgsVoidMock = Mock<void, []>;

type BridgeStub = WorkerBridge<RuntimeStateSnapshot> & {
  emitDiagnostics(timeline: DiagnosticTimelineResult): void;
  emitError(error: WorkerBridgeErrorDetails): void;
};

type BridgeMock = BridgeStub & {
  awaitReady: AwaitReadyMock;
  restoreSession: RestoreSessionMock;
  sendCommand: CommandMock;
  sendSocialCommand: SocialCommandMock;
  enableDiagnostics: NoArgsVoidMock;
  disableDiagnostics: NoArgsVoidMock;
};

function createBridgeMock(): BridgeMock {
  const diagnosticsListeners = new Set<
    (timeline: DiagnosticTimelineResult) => void
  >();
  const errorListeners = new Set<(error: WorkerBridgeErrorDetails) => void>();
  const stateListeners = new Set<
    (snapshot: RuntimeStateSnapshot) => void
  >();

  const awaitReady: AwaitReadyMock = vi.fn(async () => {});
  const restoreSession: RestoreSessionMock = vi.fn(async () => {});
  const sendCommand: CommandMock = vi.fn();
  const sendSocialCommand: SocialCommandMock = vi.fn(
    (
      _kind: SocialCommandType,
      _payload: SocialCommandPayloads[SocialCommandType],
    ) =>
      Promise.resolve(
        undefined as unknown as SocialCommandResults[SocialCommandType],
      ),
  );
  const onStateUpdate: Mock<
    void,
    [(snapshot: RuntimeStateSnapshot) => void]
  > = vi.fn((listener: (snapshot: RuntimeStateSnapshot) => void) => {
    stateListeners.add(listener);
  });
  const offStateUpdate: Mock<
    void,
    [(snapshot: RuntimeStateSnapshot) => void]
  > = vi.fn((listener: (snapshot: RuntimeStateSnapshot) => void) => {
    stateListeners.delete(listener);
  });
  const enableDiagnostics: NoArgsVoidMock = vi.fn();
  const disableDiagnostics: NoArgsVoidMock = vi.fn();
  const onDiagnosticsUpdate = vi.fn(
    (listener: (timeline: DiagnosticTimelineResult) => void) => {
      diagnosticsListeners.add(listener);
    },
  );
  const offDiagnosticsUpdate = vi.fn(
    (listener: (timeline: DiagnosticTimelineResult) => void) => {
      diagnosticsListeners.delete(listener);
    },
  );
  const onError = vi.fn(
    (listener: (error: WorkerBridgeErrorDetails) => void) => {
      errorListeners.add(listener);
    },
  );
  const offError = vi.fn(
    (listener: (error: WorkerBridgeErrorDetails) => void) => {
      errorListeners.delete(listener);
    },
  );
  const isSocialFeatureEnabled = vi.fn(() => true);

  return {
    awaitReady,
    restoreSession,
    sendCommand,
    sendSocialCommand,
    onStateUpdate,
    offStateUpdate,
    enableDiagnostics,
    disableDiagnostics,
    onDiagnosticsUpdate,
    offDiagnosticsUpdate,
    onError,
    offError,
    isSocialFeatureEnabled,
    emitDiagnostics(timeline) {
      diagnosticsListeners.forEach((listener) => listener(timeline));
    },
    emitError(error) {
      errorListeners.forEach((listener) => listener(error));
    },
  } as BridgeMock;
}

let currentBridgeMock: BridgeMock = createBridgeMock();

function setBridgeMock(next: BridgeMock) {
  currentBridgeMock = next;
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function useWorkerBridgeMock<TState>() {
  return currentBridgeMock as unknown as WorkerBridge<TState>;
}

vi.mock('./worker-bridge.js', async () => {
  const actual = await vi.importActual<typeof WorkerBridgeModule>(
    './worker-bridge.js',
  );
  return {
    ...actual,
    useWorkerBridge: useWorkerBridgeMock,
  };
});

import { Fragment } from 'react';
import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import {
  ShellStateProvider,
  useShellBridge,
  useShellDiagnostics,
} from './ShellStateProvider.js';
import { SOCIAL_COMMAND_TYPES } from './runtime-worker-protocol.js';

let bridgeMock: BridgeMock;
let telemetrySpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  telemetrySpy = vi.fn();
  (globalThis as IdleTelemetryGlobal).__IDLE_ENGINE_TELEMETRY__ = {
    recordError: telemetrySpy,
  } satisfies TelemetryFacade;
  bridgeMock = createBridgeMock();
  setBridgeMock(bridgeMock);
});

afterEach(() => {
  delete (globalThis as IdleTelemetryGlobal).__IDLE_ENGINE_TELEMETRY__;
});

describe('ShellStateProvider telemetry integration', () => {
  it('reports telemetry when restoring the session fails', async () => {
    const { bridgeRef, unmount } = await setupProvider({
      includeBridge: true,
    });

    if (!bridgeRef.current) {
      throw new Error('Bridge reference missing');
    }

    const error = new Error('restore failed');
    bridgeMock.restoreSession.mockRejectedValueOnce(error);

    let thrown: unknown;
    await act(async () => {
      try {
        await bridgeRef.current!.restoreSession();
      } catch (caught) {
        thrown = caught;
      }
    });
    expect(thrown).toBe(error);

    expect(telemetrySpy).toHaveBeenCalledWith(
      'ShellStateProviderRestoreFailed',
      expect.objectContaining({ message: 'restore failed' }),
    );

    await unmount();
  });

  it('reports telemetry when the restore effect fails on mount', async () => {
    const error = new Error('effect restore failed');
    bridgeMock.restoreSession.mockRejectedValueOnce(error);

    const { unmount } = await setupProvider();

    await flushMicrotasks();

    expect(telemetrySpy).toHaveBeenCalledWith(
      'ShellStateProviderRestoreEffectFailed',
      expect.objectContaining({ message: 'effect restore failed' }),
    );

    await unmount();
  });

  it('reports telemetry when awaiting readiness fails', async () => {
    const error = new Error('ready timeout');
    bridgeMock.awaitReady.mockRejectedValueOnce(error);

    const { unmount } = await setupProvider();

    await flushMicrotasks();

    expect(telemetrySpy).toHaveBeenCalledWith(
      'ShellStateProviderAwaitReadyFailed',
      expect.objectContaining({ message: 'ready timeout' }),
    );

    await unmount();
  });

  it('reports telemetry when a social command rejects', async () => {
    const { bridgeRef, unmount } = await setupProvider({
      includeBridge: true,
    });

    if (!bridgeRef.current) {
      throw new Error('Bridge reference missing');
    }

    const workerError = Object.assign(new Error('guild failure'), {
      code: 'SOCIAL_COMMAND_FAILED',
      requestId: 'social:42',
      details: { status: 500 },
    });

    bridgeMock.sendSocialCommand.mockRejectedValueOnce(
      workerError,
    );

    let thrown: unknown;
    await act(async () => {
      try {
        await bridgeRef.current!.sendSocialCommand(
          SOCIAL_COMMAND_TYPES.CREATE_GUILD,
          {
            name: 'Example Guild',
            description: 'Test guild',
            accessToken: 'token-1',
          },
        );
      } catch (caught) {
        thrown = caught;
      }
    });
    expect(thrown).toBe(workerError);

    expect(telemetrySpy).toHaveBeenCalledWith(
      'ShellStateProviderSocialCommandFailed',
      expect.objectContaining({
        kind: SOCIAL_COMMAND_TYPES.CREATE_GUILD,
        message: 'guild failure',
        code: 'SOCIAL_COMMAND_FAILED',
        requestId: 'social:42',
        details: { status: 500 },
      }),
    );

    await unmount();
  });

  it('reports telemetry when the worker surface emits errors', async () => {
    const { unmount } = await setupProvider();

    const errorDetails: WorkerBridgeErrorDetails = {
      code: 'RESTORE_FAILED',
      message: 'worker crashed',
      requestId: 'command:7',
    };

    await act(async () => {
      bridgeMock.emitError(errorDetails);
    });

    expect(telemetrySpy).toHaveBeenCalledWith(
      'ShellStateProviderWorkerError',
      expect.objectContaining({
        code: 'RESTORE_FAILED',
        message: 'worker crashed',
        requestId: 'command:7',
      }),
    );

    await unmount();
  });

  it('reports telemetry when enabling diagnostics fails', async () => {
    const { diagnosticsRef, unmount } = await setupProvider({
      includeDiagnostics: true,
    });

    if (!diagnosticsRef.current) {
      throw new Error('Diagnostics reference missing');
    }

    const error = new Error('enable failed');
    bridgeMock.enableDiagnostics.mockImplementationOnce(() => {
      throw error;
    });

    let unsubscribe: (() => void) | undefined;
    await act(async () => {
      unsubscribe = diagnosticsRef.current?.subscribe(() => {});
    });

    expect(telemetrySpy).toHaveBeenCalledWith(
      'ShellStateProviderEnableDiagnosticsFailed',
      expect.objectContaining({ message: 'enable failed' }),
    );

    telemetrySpy.mockClear();

    if (unsubscribe) {
      await act(async () => {
        unsubscribe?.();
      });
    }

    await unmount();
  });

  it('reports telemetry when disabling diagnostics fails', async () => {
    const { diagnosticsRef, unmount } = await setupProvider({
      includeDiagnostics: true,
    });

    if (!diagnosticsRef.current) {
      throw new Error('Diagnostics reference missing');
    }

    let unsubscribe: (() => void) | undefined;
    await act(async () => {
      unsubscribe = diagnosticsRef.current?.subscribe(() => {});
    });

    telemetrySpy.mockClear();
    bridgeMock.disableDiagnostics.mockImplementationOnce(() => {
      throw new Error('disable failed');
    });

    await act(async () => {
      unsubscribe?.();
    });

    expect(telemetrySpy).toHaveBeenCalledWith(
      'ShellStateProviderDisableDiagnosticsFailed',
      expect.objectContaining({ message: 'disable failed' }),
    );

    await unmount();
  });

  it('reports telemetry when a diagnostics subscriber throws immediately', async () => {
    const { diagnosticsRef, unmount } = await setupProvider({
      includeDiagnostics: true,
    });

    if (!diagnosticsRef.current) {
      throw new Error('Diagnostics reference missing');
    }

    await act(async () => {
      bridgeMock.emitDiagnostics(createDiagnosticTimeline());
    });

    telemetrySpy.mockClear();

    await act(async () => {
      diagnosticsRef.current?.subscribe(() => {
        throw new Error('subscriber immediate failure');
      });
    });

    expect(telemetrySpy).toHaveBeenCalledWith(
      'ShellStateProviderDiagnosticsSubscriberError',
      expect.objectContaining({
        phase: 'immediate',
        message: 'subscriber immediate failure',
      }),
    );

    await unmount();
  });

  it('reports telemetry when a diagnostics subscriber throws during updates', async () => {
    const { diagnosticsRef, unmount } = await setupProvider({
      includeDiagnostics: true,
    });

    if (!diagnosticsRef.current) {
      throw new Error('Diagnostics reference missing');
    }

    const subscriber = vi.fn(() => {
      throw new Error('subscriber update failure');
    });

    let unsubscribe: (() => void) | undefined;
    await act(async () => {
      unsubscribe = diagnosticsRef.current?.subscribe(subscriber);
    });

    telemetrySpy.mockClear();

    await act(async () => {
      bridgeMock.emitDiagnostics(createDiagnosticTimeline());
    });

    expect(telemetrySpy).toHaveBeenCalledWith(
      'ShellStateProviderDiagnosticsSubscriberError',
      expect.objectContaining({
        phase: 'update',
        message: 'subscriber update failure',
      }),
    );

    telemetrySpy.mockClear();

    if (unsubscribe) {
      await act(async () => {
        unsubscribe?.();
      });
    }

    await unmount();
  });
});

describe('ShellStateProvider diagnostics subscriptions', () => {
  it('reference counts diagnostics subscribers', async () => {
    const { diagnosticsRef, unmount } = await setupProvider({
      includeDiagnostics: true,
    });

    if (!diagnosticsRef.current) {
      throw new Error('Diagnostics reference missing');
    }

    let first: (() => void) | undefined;
    let second: (() => void) | undefined;

    await act(async () => {
      first = diagnosticsRef.current!.subscribe(() => {});
    });

    await act(async () => {
      second = diagnosticsRef.current!.subscribe(() => {});
    });

    expect(bridgeMock.enableDiagnostics).toHaveBeenCalledTimes(1);
    expect(diagnosticsRef.current!.isEnabled).toBe(true);

    await act(async () => {
      second?.();
    });

    expect(bridgeMock.disableDiagnostics).not.toHaveBeenCalled();
    expect(diagnosticsRef.current!.isEnabled).toBe(true);

    await act(async () => {
      first?.();
    });

    expect(bridgeMock.disableDiagnostics).toHaveBeenCalledTimes(1);
    expect(diagnosticsRef.current!.isEnabled).toBe(false);

    await unmount();
  });
});

interface ProviderSetupOptions {
  readonly includeBridge?: boolean;
  readonly includeDiagnostics?: boolean;
  readonly restorePayload?: unknown;
}

interface ProviderSetupResult {
  readonly bridgeRef: { current: ShellBridgeApi | null };
  readonly diagnosticsRef: { current: ShellDiagnosticsApi | null };
  unmount(): Promise<void>;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function setupProvider(
  options: ProviderSetupOptions = {},
): Promise<ProviderSetupResult> {
  const {
    includeBridge = false,
    includeDiagnostics = false,
    restorePayload,
  } = options;

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  const bridgeRef: { current: ShellBridgeApi | null } = { current: null };
  const diagnosticsRef: { current: ShellDiagnosticsApi | null } = {
    current: null,
  };

  await act(async () => {
    root.render(
      <ShellStateProvider restorePayload={restorePayload}>
        <Fragment>
          {includeBridge ? (
            <BridgeProbe target={bridgeRef} />
          ) : null}
          {includeDiagnostics ? (
            <DiagnosticsProbe target={diagnosticsRef} />
          ) : null}
        </Fragment>
      </ShellStateProvider>,
    );
  });

  return {
    bridgeRef,
    diagnosticsRef,
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function BridgeProbe({
  target,
}: {
  readonly target: { current: ShellBridgeApi | null };
}) {
  target.current = useShellBridge();
  return null;
}

function DiagnosticsProbe({
  target,
}: {
  readonly target: { current: ShellDiagnosticsApi | null };
}) {
  target.current = useShellDiagnostics();
  return null;
}

function createDiagnosticTimeline(
  overrides: Partial<DiagnosticTimelineResult> = {},
): DiagnosticTimelineResult {
  return {
    entries: overrides.entries ?? [],
    head: overrides.head ?? 1,
    dropped: overrides.dropped ?? 0,
    configuration: {
      capacity: 128,
      ...(overrides.configuration ?? {}),
    },
  } satisfies DiagnosticTimelineResult;
}
