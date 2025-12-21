import { describe, expect, it } from 'vitest';
import type { ProgressionSnapshot } from '@idle-engine/core';

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

const progressionSnapshotStub: ProgressionSnapshot = {
  step: 1,
  publishedAt: 1000,
  resources: [
    {
      id: 'gold',
      displayName: 'Gold',
      amount: 100,
      isUnlocked: true,
      isVisible: true,
      perTick: 0,
    },
    {
      id: 'wood',
      displayName: 'Wood',
      amount: 50,
      isUnlocked: true,
      isVisible: true,
      perTick: 0,
    },
  ],
  generators: [
    {
      id: 'mine',
      displayName: 'Mine',
      owned: 5,
      enabled: true,
      isUnlocked: true,
      isVisible: true,
      costs: [],
      produces: [{ resourceId: 'gold', rate: 1 }],
      consumes: [],
      nextPurchaseReadyAtStep: 0,
    },
  ],
  upgrades: [
    {
      id: 'mining-speed',
      displayName: 'Mining Speed',
      status: 'available',
      isVisible: true,
    },
  ],
  automations: [],
  transforms: [],
  prestigeLayers: [],
};

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
      progression: progressionSnapshotStub,
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
        progression: progressionSnapshotStub,
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

  it('initializes progression state with null snapshot and empty pending deltas', () => {
    const state = createInitialShellState();

    expect(state.runtime.progression.snapshot).toBeNull();
    expect(state.runtime.progression.pendingDeltas).toHaveLength(0);
    expect(state.runtime.progression.schemaVersion).toBe(1);
  });

  it('updates progression snapshot from state-update action and clears pending deltas', () => {
    const reducer = createShellStateReducer();
    let state = createInitialShellState();

    // Stage a pending delta first
    state = reducer(state, {
      type: 'progression-stage-delta',
      resourceId: 'gold',
      delta: 50,
      timestamp: 100,
    });

    expect(state.runtime.progression.pendingDeltas).toHaveLength(1);

    // Now receive authoritative snapshot
    const snapshot: RuntimeStateSnapshot = {
      currentStep: 1,
      events: [],
      backPressure: backPressureStub,
      progression: progressionSnapshotStub,
    };

    state = reducer(state, {
      type: 'state-update',
      snapshot,
      timestamp: 200,
    });

    expect(state.runtime.progression.snapshot).toBe(progressionSnapshotStub);
    expect(state.runtime.progression.pendingDeltas).toHaveLength(0);
  });

  it('stages and maintains progression pending deltas', () => {
    const reducer = createShellStateReducer();
    let state = createInitialShellState();

    state = reducer(state, {
      type: 'progression-stage-delta',
      resourceId: 'gold',
      delta: 50,
      timestamp: 100,
    });

    state = reducer(state, {
      type: 'progression-stage-delta',
      resourceId: 'wood',
      delta: 25,
      timestamp: 110,
    });

    expect(state.runtime.progression.pendingDeltas).toHaveLength(2);
    expect(state.runtime.progression.pendingDeltas[0]).toEqual({
      resourceId: 'gold',
      delta: 50,
      stagedAt: 100,
    });
    expect(state.runtime.progression.pendingDeltas[1]).toEqual({
      resourceId: 'wood',
      delta: 25,
      stagedAt: 110,
    });
  });

  it('clears progression pending deltas on explicit action', () => {
    const reducer = createShellStateReducer();
    let state = createInitialShellState();

    state = reducer(state, {
      type: 'progression-stage-delta',
      resourceId: 'gold',
      delta: 50,
      timestamp: 100,
    });

    expect(state.runtime.progression.pendingDeltas).toHaveLength(1);

    state = reducer(state, {
      type: 'progression-clear-deltas',
      timestamp: 150,
    });

    expect(state.runtime.progression.pendingDeltas).toHaveLength(0);
  });

  it('handles progression schema mismatch by marking schemaVersion as negative', () => {
    const reducer = createShellStateReducer();
    let state = createInitialShellState();

    expect(state.runtime.progression.schemaVersion).toBe(1);

    state = reducer(state, {
      type: 'progression-schema-mismatch',
      expectedVersion: 1,
      actualVersion: 0,
      timestamp: 100,
    });

    expect(state.runtime.progression.schemaVersion).toBe(-1);
  });

  it('clears progression state on schema mismatch to prevent stale optimistic updates', () => {
    const reducer = createShellStateReducer();
    let state = createInitialShellState();

    // Set up a state with snapshot and pending deltas
    const snapshot: RuntimeStateSnapshot = {
      currentStep: 1,
      events: [],
      backPressure: backPressureStub,
      progression: progressionSnapshotStub,
    };

    state = reducer(state, {
      type: 'state-update',
      snapshot,
      timestamp: 100,
    });

    // Stage some optimistic deltas
    state = reducer(state, {
      type: 'progression-stage-delta',
      resourceId: 'gold',
      delta: -100,
      timestamp: 150,
    });

    // Verify we have snapshot and deltas
    expect(state.runtime.progression.snapshot).toBe(progressionSnapshotStub);
    expect(state.runtime.progression.pendingDeltas).toHaveLength(1);

    // Now trigger schema mismatch
    state = reducer(state, {
      type: 'progression-schema-mismatch',
      expectedVersion: 2,
      actualVersion: 1,
      timestamp: 200,
    });

    // Verify state is cleared to prevent stale optimistic updates
    expect(state.runtime.progression.snapshot).toBeNull();
    expect(state.runtime.progression.pendingDeltas).toHaveLength(0);
    expect(state.runtime.progression.schemaVersion).toBe(-1);
    expect(state.runtime.progression.expectedSchemaVersion).toBe(2);
    expect(state.runtime.progression.receivedSchemaVersion).toBe(1);
  });
});
