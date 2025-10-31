import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';
import type { ReactNode } from 'react';

import type {
  DiagnosticsSubscriber,
  ShellBridgeApi,
  ShellDiagnosticsApi,
  ShellState,
  ShellStateProviderConfig,
} from './shell-state.types.js';
import {
  createInitialShellState,
  createShellStateReducer,
  DEFAULT_MAX_EVENT_HISTORY,
  DEFAULT_MAX_ERROR_HISTORY,
} from './shell-state-store.js';
import {
  type RuntimeStateSnapshot,
  type SocialCommandPayloads,
  type SocialCommandResults,
  type SocialCommandType,
  type WorkerBridgeErrorDetails,
  type WorkerRestoreSessionPayload,
  useWorkerBridge,
} from './worker-bridge.js';

type TelemetryFacadeLike = {
  recordError?: (
    event: string,
    data?: Record<string, unknown>,
  ) => void;
};

type IdleEngineGlobal = {
  __IDLE_ENGINE_TELEMETRY__?: TelemetryFacadeLike;
};

interface ShellStateProviderProps extends ShellStateProviderConfig {
  readonly children: ReactNode;
  readonly restorePayload?: WorkerRestoreSessionPayload;
}

const ShellStateContext = createContext<ShellState | null>(null);
const ShellBridgeContext = createContext<ShellBridgeApi | null>(null);
const ShellDiagnosticsContext =
  createContext<ShellDiagnosticsApi | null>(null);

export function ShellStateProvider({
  children,
  maxEventHistory = DEFAULT_MAX_EVENT_HISTORY,
  maxErrorHistory = DEFAULT_MAX_ERROR_HISTORY,
  restorePayload,
}: ShellStateProviderProps) {
  const bridge = useWorkerBridge<RuntimeStateSnapshot>();

  const reducer = useMemo(
    () =>
      createShellStateReducer({
        maxEventHistory,
        maxErrorHistory,
      }),
    [maxEventHistory, maxErrorHistory],
  );

  const [state, dispatch] = useReducer(
    reducer,
    undefined,
    createInitialShellState,
  );

  const diagnosticsSubscribersRef = useRef<
    Set<DiagnosticsSubscriber>
  >(new Set());
  const diagnosticsTimelineRef = useRef<
    ShellDiagnosticsApi['latest']
  >(null);
  diagnosticsTimelineRef.current = state.diagnostics.timeline;

  const socialRequestCounterRef = useRef(0);

  const restoreSession = useCallback(
    async (payload?: WorkerRestoreSessionPayload) => {
      const start = Date.now();
      dispatch({
        type: 'restore-started',
        timestamp: start,
      });
      try {
        await bridge.restoreSession(payload);
        dispatch({
          type: 'restore-complete',
          timestamp: Date.now(),
        });
      } catch (error) {
        const message = toErrorMessage(error);

        recordTelemetryError('ShellStateProviderRestoreFailed', {
          message,
        });

        dispatch({
          type: 'bridge-error',
          error: {
            code: 'RESTORE_FAILED',
            message,
            details: {
              source: 'ShellStateProvider.restoreSession',
            },
          },
          timestamp: Date.now(),
        });

        dispatch({
          type: 'restore-complete',
          timestamp: Date.now(),
        });
        throw error;
      }
    },
    [bridge, dispatch],
  );

  const sendSocialCommand = useCallback(
    async <TCommand extends SocialCommandType>(
      kind: TCommand,
      payload: SocialCommandPayloads[TCommand],
    ): Promise<SocialCommandResults[TCommand]> => {
      const requestId = `shell-social-${Date.now()}-${socialRequestCounterRef.current++}`;
      dispatch({
        type: 'social-request-start',
        requestId,
        kind,
        timestamp: Date.now(),
      });

      try {
        const result = await bridge.sendSocialCommand(kind, payload);
        dispatch({
          type: 'social-request-complete',
          requestId,
          timestamp: Date.now(),
        });
        return result;
      } catch (error) {
        const message = toErrorMessage(error);
        const telemetryPayload: Record<string, unknown> = {
          kind,
          requestId,
          message,
        };

        if (isWorkerSocialCommandError(error)) {
          telemetryPayload.code = error.code;
          telemetryPayload.requestId = error.requestId ?? requestId;
          telemetryPayload.details = error.details ?? null;
        }

        recordTelemetryError(
          'ShellStateProviderSocialCommandFailed',
          telemetryPayload,
        );

        dispatch({
          type: 'social-request-failed',
          requestId,
          kind,
          message,
          timestamp: Date.now(),
        });

        throw error;
      }
    },
    [bridge, dispatch],
  );

  const diagnosticsSubscribe = useCallback(
    (subscriber: DiagnosticsSubscriber) => {
      diagnosticsSubscribersRef.current.add(subscriber);
      const count = diagnosticsSubscribersRef.current.size;
      dispatch({
        type: 'diagnostics-subscribers',
        count,
        timestamp: Date.now(),
      });

      if (count === 1) {
        try {
          bridge.enableDiagnostics();
        } catch (error) {
          recordTelemetryError(
            'ShellStateProviderEnableDiagnosticsFailed',
            { message: toErrorMessage(error) },
          );
        }
      }

      const latestTimeline = diagnosticsTimelineRef.current;
      if (latestTimeline) {
        try {
          subscriber(latestTimeline);
        } catch (error) {
          recordTelemetryError(
            'ShellStateProviderDiagnosticsSubscriberError',
            {
              phase: 'immediate',
              message: toErrorMessage(error),
            },
          );
        }
      }

      return () => {
        if (!diagnosticsSubscribersRef.current.has(subscriber)) {
          return;
        }

        diagnosticsSubscribersRef.current.delete(subscriber);
        const nextCount = diagnosticsSubscribersRef.current.size;
        dispatch({
          type: 'diagnostics-subscribers',
          count: nextCount,
          timestamp: Date.now(),
        });

        if (nextCount === 0) {
          try {
            bridge.disableDiagnostics();
          } catch (error) {
            recordTelemetryError(
              'ShellStateProviderDisableDiagnosticsFailed',
              { message: toErrorMessage(error) },
            );
          }
        }
      };
    },
    [bridge, dispatch],
  );

  useEffect(() => {
    let active = true;
    bridge
      .awaitReady()
      .then(() => {
        if (!active) {
          return;
        }
        dispatch({
          type: 'bridge-ready',
          timestamp: Date.now(),
        });
      })
      .catch((error) => {
        if (!active) {
          return;
        }
        recordTelemetryError(
          'ShellStateProviderAwaitReadyFailed',
          { message: toErrorMessage(error) },
        );
      });
    return () => {
      active = false;
    };
  }, [bridge, dispatch]);

  useEffect(() => {
    const handleStateUpdate = (snapshot: RuntimeStateSnapshot) => {
      dispatch({
        type: 'state-update',
        snapshot,
        timestamp: Date.now(),
      });
    };
    bridge.onStateUpdate(handleStateUpdate);
    return () => {
      bridge.offStateUpdate(handleStateUpdate);
    };
  }, [bridge, dispatch]);

  useEffect(() => {
    const handleError = (error: WorkerBridgeErrorDetails) => {
      dispatch({
        type: 'bridge-error',
        error,
        timestamp: Date.now(),
      });
      recordTelemetryError('ShellStateProviderWorkerError', {
        code: error.code,
        message: error.message,
        requestId: error.requestId ?? null,
      });
    };
    bridge.onError(handleError);
    return () => {
      bridge.offError(handleError);
    };
  }, [bridge, dispatch]);

  useEffect(() => {
    const handleDiagnostics = (
      diagnostics: NonNullable<ShellDiagnosticsApi['latest']>,
    ) => {
      diagnosticsTimelineRef.current = diagnostics;

      dispatch({
        type: 'diagnostics-update',
        timeline: diagnostics,
        timestamp: Date.now(),
      });

      diagnosticsSubscribersRef.current.forEach((subscriber) => {
        try {
          subscriber(diagnostics);
        } catch (error) {
          recordTelemetryError(
            'ShellStateProviderDiagnosticsSubscriberError',
            {
              phase: 'update',
              message: toErrorMessage(error),
            },
          );
        }
      });
    };

    bridge.onDiagnosticsUpdate(handleDiagnostics);

    return () => {
      bridge.offDiagnosticsUpdate(handleDiagnostics);
    };
  }, [bridge, dispatch]);

  useEffect(() => {
    let cancelled = false;
    restoreSession(restorePayload).catch((error) => {
      if (cancelled) {
        return;
      }
      recordTelemetryError('ShellStateProviderRestoreEffectFailed', {
        message: toErrorMessage(error),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [restoreSession, restorePayload]);

  const bridgeValue = useMemo<ShellBridgeApi>(
    () => ({
      awaitReady: () => bridge.awaitReady(),
      sendCommand(type, payload) {
        bridge.sendCommand(type, payload);
      },
      sendSocialCommand: sendSocialCommand,
      restoreSession,
      isSocialFeatureEnabled: () => bridge.isSocialFeatureEnabled(),
    }),
    [bridge, restoreSession, sendSocialCommand],
  );

  const diagnosticsValue = useMemo<ShellDiagnosticsApi>(
    () => ({
      latest: state.diagnostics.timeline,
      isEnabled: state.diagnostics.subscriberCount > 0,
      subscribe: diagnosticsSubscribe,
    }),
    [
      state.diagnostics.timeline,
      state.diagnostics.subscriberCount,
      diagnosticsSubscribe,
    ],
  );

  return (
    <ShellStateContext.Provider value={state}>
      <ShellBridgeContext.Provider value={bridgeValue}>
        <ShellDiagnosticsContext.Provider value={diagnosticsValue}>
          {children}
        </ShellDiagnosticsContext.Provider>
      </ShellBridgeContext.Provider>
    </ShellStateContext.Provider>
  );
}

export function useShellState(): ShellState {
  const context = useContext(ShellStateContext);
  if (!context) {
    throw new Error(
      'useShellState must be used within a ShellStateProvider',
    );
  }
  return context;
}

export function useShellBridge(): ShellBridgeApi {
  const context = useContext(ShellBridgeContext);
  if (!context) {
    throw new Error(
      'useShellBridge must be used within a ShellStateProvider',
    );
  }
  return context;
}

export function useShellDiagnostics(): ShellDiagnosticsApi {
  const context = useContext(ShellDiagnosticsContext);
  if (!context) {
    throw new Error(
      'useShellDiagnostics must be used within a ShellStateProvider',
    );
  }
  return context;
}

function recordTelemetryError(
  event: string,
  data: Record<string, unknown>,
): void {
  const telemetry = (globalThis as IdleEngineGlobal).__IDLE_ENGINE_TELEMETRY__;
  telemetry?.recordError?.(event, data);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isWorkerSocialCommandError(
  error: unknown,
): error is {
  code?: string;
  details?: Record<string, unknown>;
  requestId?: string;
} {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  );
}
