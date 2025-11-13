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
  ShellProgressionApi,
  ProgressionResourcesSelector,
  ProgressionGeneratorsSelector,
  ProgressionUpgradesSelector,
  ProgressionOptimisticResourcesSelector,
} from './shell-state.types.js';
import { isProgressionUIEnabled } from './progression-config.js';
import {
  createInitialShellState,
  createShellStateReducer,
  DEFAULT_MAX_EVENT_HISTORY,
  DEFAULT_MAX_ERROR_HISTORY,
  WORKER_PROGRESSION_SCHEMA_VERSION,
} from './shell-state-store.js';
import {
  type RuntimeStateSnapshot,
  type SocialCommandPayloads,
  type SocialCommandResults,
  type SocialCommandType,
  type WorkerBridgeErrorDetails,
  type WorkerBridge,
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
const ShellProgressionContext = createContext<ShellProgressionApi | null>(null);

const COMMAND_REQUEST_ID_PREFIX = 'command:';
const COMMAND_ERROR_CODES: ReadonlySet<WorkerBridgeErrorDetails['code']> =
  new Set(['INVALID_COMMAND_PAYLOAD', 'STALE_COMMAND']);
const RESTORE_PAYLOAD_NOT_SET = Symbol('ShellStateProvider.restorePayload.initial');

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

  const lastRestorePayloadRef = useRef<
    WorkerRestoreSessionPayload | typeof RESTORE_PAYLOAD_NOT_SET | undefined
  >(RESTORE_PAYLOAD_NOT_SET);
  const lastRestoreBridgeRef = useRef<WorkerBridge | null>(null);

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

  // Track provider mounted state to avoid scheduling updates after unmount
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Epoch used to trigger reconciliation of diagnostics subscriber changes
  const [_diagnosticsEpoch, bumpDiagnosticsEpoch] = useReducer((n: number) => n + 1, 0);
  const lastDiagnosticsCountRef = useRef(0);

  // Track which bridge instance we've awaited to ensure each new
  // WorkerBridge is awaited and announced, while avoiding duplicate
  // dispatches for the same instance.
  const lastAwaitedBridgeRef = useRef<WorkerBridge | null>(null);

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

        // bridge.onError listener records the failure with worker-supplied details.
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

      // Compute transition and apply enable + state update synchronously (inside act)
      const prev = lastDiagnosticsCountRef.current;
      const count = diagnosticsSubscribersRef.current.size;
      if (count !== prev) {
        lastDiagnosticsCountRef.current = count;
        if (prev === 0 && count > 0) {
          try {
            bridge.enableDiagnostics();
          } catch (error) {
            recordTelemetryError('ShellStateProviderEnableDiagnosticsFailed', {
              message: toErrorMessage(error),
            });
          }
        }
        dispatch({
          type: 'diagnostics-subscribers',
          count,
          timestamp: Date.now(),
        });
      }

      const latestTimeline = diagnosticsTimelineRef.current;
      if (latestTimeline) {
        try {
          subscriber(latestTimeline);
        } catch (error) {
          recordTelemetryError('ShellStateProviderDiagnosticsSubscriberError', {
            phase: 'immediate',
            message: toErrorMessage(error),
          });
        }
      }

      return () => {
        if (!diagnosticsSubscribersRef.current.has(subscriber)) {
          return;
        }

        diagnosticsSubscribersRef.current.delete(subscriber);

        // Avoid dispatching or toggling during cleanup; defer to next macrotask.
        setTimeout(() => {
          if (!isMountedRef.current) {
            return;
          }
          const prev = lastDiagnosticsCountRef.current;
          const count = diagnosticsSubscribersRef.current.size;
          if (count !== prev) {
            lastDiagnosticsCountRef.current = count;
            if (prev > 0 && count === 0) {
              try {
                bridge.disableDiagnostics();
              } catch (error) {
                recordTelemetryError(
                  'ShellStateProviderDisableDiagnosticsFailed',
                  { message: toErrorMessage(error) },
                );
              }
            }
            dispatch({
              type: 'diagnostics-subscribers',
              count,
              timestamp: Date.now(),
            });
          }
          // Bump epoch for any observers relying on it
          bumpDiagnosticsEpoch();
        }, 0);
      };
    },
    [bridge, dispatch],
  );

  useEffect(() => {
    // Only await readiness once per WorkerBridge instance.
    if (lastAwaitedBridgeRef.current === bridge) {
      return;
    }
    lastAwaitedBridgeRef.current = bridge;

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

      // Track progression schema mismatches separately for bridge logging
      if (error.code === 'SCHEMA_VERSION_MISMATCH') {
        const details = error.details as Record<string, unknown> | undefined;
        const expectedVersion = typeof details?.expected === 'number'
          ? details.expected
          : WORKER_PROGRESSION_SCHEMA_VERSION;
        const actualVersion = typeof details?.received === 'number'
          ? details.received
          : 0;
        dispatch({
          type: 'progression-schema-mismatch',
          expectedVersion,
          actualVersion,
          timestamp: Date.now(),
        });
        recordTelemetryError('ProgressionUiSchemaMismatch', {
          code: error.code,
          message: error.message,
          expectedVersion,
          actualVersion,
        });
      } else {
        // For command-related errors, proactively clear optimistic deltas to rollback UI.
        if (isCommandBridgeError(error)) {
          dispatch({
            type: 'progression-clear-deltas',
            timestamp: Date.now(),
          });
          // Emit command error telemetry for shell observability.
          recordTelemetryError('ProgressionUiCommandError', {
            code: error.code,
            message: error.message,
            requestId: error.requestId ?? null,
          });
        }
        recordTelemetryError('ShellStateProviderWorkerError', {
          code: error.code,
          message: error.message,
          requestId: error.requestId ?? null,
        });
      }
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
    // Ensure we re-run restore when either the payload reference or bridge changes.
    const previousPayload = lastRestorePayloadRef.current;
    const previousBridge = lastRestoreBridgeRef.current;
    const payloadChanged = previousPayload !== restorePayload;
    const bridgeChanged = previousBridge !== bridge;

    if (!payloadChanged && !bridgeChanged) {
      return;
    }

    lastRestorePayloadRef.current = restorePayload;
    lastRestoreBridgeRef.current = bridge;

    let cancelled = false;

    (async () => {
      try {
        await bridge.awaitReady();
        if (cancelled) {
          return;
        }
        await restoreSession(restorePayload);
      } catch (error) {
        if (cancelled) {
          return;
        }
        recordTelemetryError('ShellStateProviderRestoreEffectFailed', {
          message: toErrorMessage(error),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [bridge, restoreSession, restorePayload]);

  const bridgeValue = useMemo<ShellBridgeApi>(
    () => ({
      awaitReady: () => bridge.awaitReady(),
      sendCommand(type, payload) {
        bridge.sendCommand(type, payload);
      },
      sendSocialCommand: sendSocialCommand,
      restoreSession,
      requestSessionSnapshot: (reason) =>
        bridge.requestSessionSnapshot(reason),
      onStateUpdate(callback) {
        bridge.onStateUpdate(callback);
      },
      offStateUpdate(callback) {
        bridge.offStateUpdate(callback);
      },
      enableDiagnostics: () => bridge.enableDiagnostics(),
      disableDiagnostics: () => bridge.disableDiagnostics(),
      onDiagnosticsUpdate(callback) {
        bridge.onDiagnosticsUpdate(callback);
      },
      offDiagnosticsUpdate(callback) {
        bridge.offDiagnosticsUpdate(callback);
      },
      onError(callback) {
        bridge.onError(callback);
      },
      offError(callback) {
        bridge.offError(callback);
      },
      isSocialFeatureEnabled: () => bridge.isSocialFeatureEnabled(),
    }),
    [bridge, restoreSession, sendSocialCommand],
  );

  const diagnosticsValue = useMemo<ShellDiagnosticsApi>(
    () => ({
      latest: state.diagnostics.timeline,
      get isEnabled() {
        return lastDiagnosticsCountRef.current > 0;
      },
      subscribe: diagnosticsSubscribe,
    }) as ShellDiagnosticsApi,
    [
      state.diagnostics.timeline,
      diagnosticsSubscribe,
    ],
  );

  // Create memoized progression selectors
  const selectResources = useMemo<ProgressionResourcesSelector>(() => {
    return () => {
      const snapshot = state.runtime.progression.snapshot;
      return snapshot?.resources ?? null;
    };
  }, [state.runtime.progression.snapshot]);

  const selectGenerators = useMemo<ProgressionGeneratorsSelector>(() => {
    return () => {
      const snapshot = state.runtime.progression.snapshot;
      return snapshot?.generators ?? null;
    };
  }, [state.runtime.progression.snapshot]);

  const selectUpgrades = useMemo<ProgressionUpgradesSelector>(() => {
    return () => {
      const snapshot = state.runtime.progression.snapshot;
      return snapshot?.upgrades ?? null;
    };
  }, [state.runtime.progression.snapshot]);

  const selectOptimisticResources = useMemo<ProgressionOptimisticResourcesSelector>(() => {
    return () => {
      const snapshot = state.runtime.progression.snapshot;
      if (!snapshot?.resources) {
        return null;
      }

      // Apply pending deltas to create optimistic view
      if (state.runtime.progression.pendingDeltas.length === 0) {
        return snapshot.resources;
      }

      const deltaMap = new Map<string, number>();
      state.runtime.progression.pendingDeltas.forEach((delta) => {
        const current = deltaMap.get(delta.resourceId) ?? 0;
        deltaMap.set(delta.resourceId, current + delta.delta);
      });

      return Object.freeze(
        snapshot.resources.map((resource) => {
          const delta = deltaMap.get(resource.id);
          if (delta === undefined) {
            return resource;
          }
          return Object.freeze({
            ...resource,
            amount: resource.amount + delta,
          });
        }),
      );
    };
  }, [
    state.runtime.progression.snapshot,
    state.runtime.progression.pendingDeltas,
  ]);

  const progressionValue = useMemo<ShellProgressionApi>(
    () => ({
      isEnabled: isProgressionUIEnabled(),
      schemaVersion: state.runtime.progression.schemaVersion,
      expectedSchemaVersion: state.runtime.progression.expectedSchemaVersion,
      receivedSchemaVersion: state.runtime.progression.receivedSchemaVersion,
      selectResources,
      selectGenerators,
      selectUpgrades,
      selectOptimisticResources,
      stageResourceDelta(resourceId: string, delta: number) {
        dispatch({
          type: 'progression-stage-delta',
          resourceId,
          delta,
          timestamp: Date.now(),
        });
      },
      clearPendingDeltas() {
        dispatch({
          type: 'progression-clear-deltas',
          timestamp: Date.now(),
        });
      },
    }),
    [
      state.runtime.progression.schemaVersion,
      state.runtime.progression.expectedSchemaVersion,
      state.runtime.progression.receivedSchemaVersion,
      selectResources,
      selectGenerators,
      selectUpgrades,
      selectOptimisticResources,
    ],
  );

  return (
    <ShellStateContext.Provider value={state}>
      <ShellBridgeContext.Provider value={bridgeValue}>
        <ShellDiagnosticsContext.Provider value={diagnosticsValue}>
          <ShellProgressionContext.Provider value={progressionValue}>
            {children}
          </ShellProgressionContext.Provider>
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

export function useShellProgression(): ShellProgressionApi {
  const context = useContext(ShellProgressionContext);
  if (!context) {
    throw new Error(
      'useShellProgression must be used within a ShellStateProvider',
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

function isCommandBridgeError(
  error: WorkerBridgeErrorDetails,
): boolean {
  return (
    isCommandRequestId(error.requestId) ||
    COMMAND_ERROR_CODES.has(error.code)
  );
}

function isCommandRequestId(requestId?: string): boolean {
  return (
    typeof requestId === 'string' &&
    requestId.startsWith(COMMAND_REQUEST_ID_PREFIX)
  );
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
