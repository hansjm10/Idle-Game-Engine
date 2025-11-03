import type {
  DiagnosticTimelineResult,
} from '@idle-engine/core';

import type {
  ShellState,
  ShellBridgeErrorEntry,
  ShellStateProviderConfig,
  ShellSocialFailure,
  ShellProgressionState,
  ShellProgressionPendingDelta,
} from './shell-state.types.js';
import type {
  SocialCommandType,
  WorkerBridgeErrorDetails,
  RuntimeStateSnapshot,
} from './worker-bridge.js';

export const DEFAULT_MAX_EVENT_HISTORY = 200;
export const DEFAULT_MAX_ERROR_HISTORY = 10;
export const WORKER_PROGRESSION_SCHEMA_VERSION = 1;

export interface ShellStateReducerConfig
  extends Required<Pick<ShellStateProviderConfig, 'maxEventHistory'>> {
  readonly maxErrorHistory: number;
}

export type ShellStateAction =
  | {
      readonly type: 'bridge-ready';
      readonly timestamp: number;
    }
  | {
      readonly type: 'state-update';
      readonly snapshot: RuntimeStateSnapshot;
      readonly timestamp: number;
    }
  | {
      readonly type: 'bridge-error';
      readonly error: WorkerBridgeErrorDetails;
      readonly timestamp: number;
    }
  | {
      readonly type: 'restore-started';
      readonly timestamp: number;
    }
  | {
      readonly type: 'restore-complete';
      readonly timestamp: number;
    }
  | {
      readonly type: 'social-request-start';
      readonly requestId: string;
      readonly kind: SocialCommandType;
      readonly timestamp: number;
    }
  | {
      readonly type: 'social-request-complete';
      readonly requestId: string;
      readonly timestamp: number;
    }
  | {
      readonly type: 'social-request-failed';
      readonly requestId: string;
      readonly kind: SocialCommandType;
      readonly message: string;
      readonly timestamp: number;
    }
  | {
      readonly type: 'diagnostics-update';
      readonly timeline: DiagnosticTimelineResult;
      readonly timestamp: number;
    }
  | {
      readonly type: 'diagnostics-subscribers';
      readonly count: number;
      readonly timestamp: number;
    }
  // Optimistic update actions for progression state.
  // These actions stage resource deltas before authoritative worker snapshots arrive,
  // enabling optimistic UI updates during generator/upgrade purchases.
  // Wiring for these actions will be implemented in #299 (generator and upgrade interactions).
  | {
      readonly type: 'progression-stage-delta';
      readonly resourceId: string;
      readonly delta: number;
      readonly timestamp: number;
    }
  | {
      readonly type: 'progression-clear-deltas';
      readonly timestamp: number;
    }
  | {
      readonly type: 'progression-schema-mismatch';
      readonly expectedVersion: number;
      readonly actualVersion: number;
      readonly timestamp: number;
    };

export function createInitialShellState(): ShellState {
  return {
    runtime: {
      currentStep: 0,
      events: [],
      backPressure: null,
      lastSnapshot: undefined,
      progression: {
        snapshot: null,
        pendingDeltas: [],
        schemaVersion: WORKER_PROGRESSION_SCHEMA_VERSION,
      },
    },
    bridge: {
      isReady: false,
      isRestoring: false,
      lastUpdateAt: null,
      errors: [],
    },
    social: {
      pendingRequests: new Map(),
      lastFailure: null,
    },
    diagnostics: {
      timeline: null,
      lastUpdateAt: null,
      subscriberCount: 0,
    },
  };
}

export function createShellStateReducer(
  options?: ShellStateProviderConfig,
) {
  const maxEventHistory =
    options?.maxEventHistory ?? DEFAULT_MAX_EVENT_HISTORY;
  const maxErrorHistory =
    options?.maxErrorHistory ?? DEFAULT_MAX_ERROR_HISTORY;

  const config: ShellStateReducerConfig = {
    maxEventHistory,
    maxErrorHistory,
  };

  return function shellStateReducer(
    state: ShellState,
    action: ShellStateAction,
  ): ShellState {
    switch (action.type) {
      case 'bridge-ready': {
        return {
          ...state,
          bridge: {
            ...state.bridge,
            isReady: true,
            lastUpdateAt: action.timestamp,
          },
        };
      }
      case 'state-update': {
        const { snapshot } = action;

        const nextEvents =
          snapshot.events.length > 0
            ? mergeEvents(
                state.runtime.events,
                snapshot.events,
                config.maxEventHistory,
              )
            : state.runtime.events;

        // Update progression snapshot and clear pending deltas upon authoritative update
        const nextProgression: ShellProgressionState = {
          snapshot: snapshot.progression ?? null,
          pendingDeltas: [], // Clear pending deltas once authoritative snapshot arrives
          schemaVersion: WORKER_PROGRESSION_SCHEMA_VERSION,
        };

        return {
          ...state,
          runtime: {
            currentStep: snapshot.currentStep,
            backPressure: snapshot.backPressure ?? null,
            events: nextEvents,
            lastSnapshot: snapshot,
            progression: nextProgression,
          },
          bridge: {
            ...state.bridge,
            lastUpdateAt: action.timestamp,
          },
        };
      }
      case 'bridge-error': {
        const errors = addErrorEntry(
          state.bridge.errors,
          {
            error: action.error,
            occurredAt: action.timestamp,
          },
          config.maxErrorHistory,
        );
        return {
          ...state,
          bridge: {
            ...state.bridge,
            errors,
            lastUpdateAt: action.timestamp,
          },
        };
      }
      case 'restore-started': {
        return {
          ...state,
          bridge: {
            ...state.bridge,
            isRestoring: true,
            lastUpdateAt: action.timestamp,
          },
        };
      }
      case 'restore-complete': {
        return {
          ...state,
          bridge: {
            ...state.bridge,
            isRestoring: false,
            lastUpdateAt: action.timestamp,
          },
        };
      }
      case 'social-request-start': {
        const pending = new Map(state.social.pendingRequests);
        pending.set(action.requestId, {
          kind: action.kind,
          issuedAt: action.timestamp,
        });
        return {
          ...state,
          social: {
            pendingRequests: pending,
            lastFailure: state.social.lastFailure,
          },
        };
      }
      case 'social-request-complete': {
        const pending = new Map(state.social.pendingRequests);
        pending.delete(action.requestId);
        return {
          ...state,
          social: {
            pendingRequests: pending,
            lastFailure: state.social.lastFailure,
          },
        };
      }
      case 'social-request-failed': {
        const pending = new Map(state.social.pendingRequests);
        pending.delete(action.requestId);
        const failure: ShellSocialFailure = {
          requestId: action.requestId,
          kind: action.kind,
          occurredAt: action.timestamp,
          message: action.message,
        };
        return {
          ...state,
          social: {
            pendingRequests: pending,
            lastFailure: failure,
          },
        };
      }
      case 'diagnostics-update': {
        return {
          ...state,
          diagnostics: {
            ...state.diagnostics,
            timeline: action.timeline,
            lastUpdateAt: action.timestamp,
          },
        };
      }
      case 'diagnostics-subscribers': {
        return {
          ...state,
          diagnostics: {
            ...state.diagnostics,
            subscriberCount: action.count,
            lastUpdateAt: action.timestamp,
          },
        };
      }
      // Optimistic update handlers for progression state.
      // Will be dispatched from generator/upgrade purchase commands in #299.
      case 'progression-stage-delta': {
        const delta: ShellProgressionPendingDelta = {
          resourceId: action.resourceId,
          delta: action.delta,
          stagedAt: action.timestamp,
        };
        const nextDeltas = [
          ...state.runtime.progression.pendingDeltas,
          delta,
        ];
        return {
          ...state,
          runtime: {
            ...state.runtime,
            progression: {
              ...state.runtime.progression,
              pendingDeltas: nextDeltas,
            },
          },
        };
      }
      case 'progression-clear-deltas': {
        return {
          ...state,
          runtime: {
            ...state.runtime,
            progression: {
              ...state.runtime.progression,
              pendingDeltas: [],
            },
          },
        };
      }
      case 'progression-schema-mismatch': {
        // Log schema mismatch but don't fail; allow UI to handle gracefully
        // Set schemaVersion to mismatch indicator for consumer awareness
        // Store both versions for actionable error messaging
        // Clear pending deltas and null snapshot to prevent stale optimistic updates
        return {
          ...state,
          runtime: {
            ...state.runtime,
            progression: {
              snapshot: null,
              pendingDeltas: [],
              schemaVersion: -1, // Negative indicates mismatch
              expectedSchemaVersion: action.expectedVersion,
              receivedSchemaVersion: action.actualVersion,
            },
          },
        };
      }
      default: {
        return state;
      }
    }
  };
}

function mergeEvents(
  existing: readonly RuntimeStateSnapshot['events'],
  incoming: readonly RuntimeStateSnapshot['events'],
  limit: number,
): readonly RuntimeStateSnapshot['events'] {
  const combined = [...incoming, ...existing];

  combined.sort((left, right) => {
    if (left.tick !== right.tick) {
      return right.tick - left.tick;
    }
    return right.dispatchOrder - left.dispatchOrder;
  });

  if (combined.length <= limit) {
    return combined;
  }

  return combined.slice(0, limit);
}

function addErrorEntry(
  existing: readonly ShellBridgeErrorEntry[],
  entry: ShellBridgeErrorEntry,
  maxErrorHistory: number,
): readonly ShellBridgeErrorEntry[] {
  const next = [entry, ...existing];

  if (next.length <= maxErrorHistory) {
    return next;
  }

  return next.slice(0, maxErrorHistory);
}
