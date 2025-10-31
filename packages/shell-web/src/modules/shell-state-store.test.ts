import { describe, expect, it } from 'vitest';

import {
  createInitialShellState,
  createShellStateReducer,
} from './shell-state-store.js';
import type { RuntimeStateSnapshot, WorkerBridgeErrorDetails } from './worker-bridge.js';

const backPressureStub = {
  tick: 0,
  channels: [],
  counters: {
    published: 0,
    softLimited: 0,
    overflowed: 0,
    subscribers: 0,
  },
} satisfies RuntimeStateSnapshot['backPressure'];

describe('shell-state-store', () => {
  it('updates runtime state and sorts events by tick and dispatch order', () => {
    const reducer = createShellStateReducer({
      maxEventHistory: 5,
    });
    let state = createInitialShellState();

    const snapshot: RuntimeStateSnapshot = {
      currentStep: 12,
      events: [
        {
          channel: 1,
          type: 'test-event',
          tick: 1,
          issuedAt: 10,
          dispatchOrder: 2,
          payload: { index: 1 },
        },
        {
          channel: 2,
          type: 'test-event',
          tick: 2,
          issuedAt: 20,
          dispatchOrder: 1,
          payload: { index: 2 },
        },
        {
          channel: 2,
          type: 'test-event',
          tick: 2,
          issuedAt: 25,
          dispatchOrder: 3,
          payload: { index: 3 },
        },
      ],
      backPressure: backPressureStub,
    };

    state = reducer(state, {
      type: 'state-update',
      snapshot,
      timestamp: 100,
    });

    expect(state.runtime.currentStep).toBe(12);
    expect(state.runtime.events).toHaveLength(3);
    expect(state.runtime.events[0]?.payload).toEqual({ index: 3 });
    expect(state.runtime.events[1]?.payload).toEqual({ index: 2 });
    expect(state.runtime.events[2]?.payload).toEqual({ index: 1 });
  });

  it('enforces the configured event history bound', () => {
    const reducer = createShellStateReducer({
      maxEventHistory: 3,
    });
    let state = createInitialShellState();

    for (let tick = 0; tick < 6; tick += 1) {
      const snapshot: RuntimeStateSnapshot = {
        currentStep: tick,
        events: [
          {
            channel: 1,
            type: 'bounded-event',
            tick,
            issuedAt: tick * 10,
            dispatchOrder: 1,
            payload: { tick },
          },
        ],
        backPressure: {
          ...backPressureStub,
          tick,
        },
      };

      state = reducer(state, {
        type: 'state-update',
        snapshot,
        timestamp: tick * 100,
      });
    }

    expect(state.runtime.events).toHaveLength(3);
    expect(state.runtime.events[0]?.payload).toEqual({ tick: 5 });
    expect(state.runtime.events[1]?.payload).toEqual({ tick: 4 });
    expect(state.runtime.events[2]?.payload).toEqual({ tick: 3 });
  });

  it('captures worker errors with bounded history', () => {
    const reducer = createShellStateReducer({
      maxEventHistory: 5,
      maxErrorHistory: 2,
    });
    let state = createInitialShellState();

    for (let index = 0; index < 3; index += 1) {
      const error: WorkerBridgeErrorDetails = {
        code: 'RESTORE_FAILED',
        message: `error-${index}`,
      };

      state = reducer(state, {
        type: 'bridge-error',
        error,
        timestamp: index * 50,
      });
    }

    expect(state.bridge.errors).toHaveLength(2);
    expect(state.bridge.errors[0]?.error.message).toBe('error-2');
    expect(state.bridge.errors[1]?.error.message).toBe('error-1');
  });
});
