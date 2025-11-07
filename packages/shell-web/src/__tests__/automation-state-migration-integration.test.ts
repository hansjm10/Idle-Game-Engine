import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initializeRuntimeWorker, type RuntimeWorkerHarness } from '../runtime.worker.js';
import {
  CommandSource,
  WORKER_MESSAGE_SCHEMA_VERSION,
  type RuntimeWorkerSessionSnapshot,
} from '../modules/runtime-worker-protocol.js';
import type { SerializedResourceState } from '@idle-engine/core';
import { clearGameState } from '@idle-engine/core';

describe('automation state migration integration', () => {
  let harness: RuntimeWorkerHarness | null = null;
  let messages: unknown[];
  let mockContext: DedicatedWorkerGlobalScope;
  let currentTime: number;

  beforeEach(() => {
    messages = [];
    currentTime = 0;

    // Mock DedicatedWorkerGlobalScope
    mockContext = {
      postMessage: vi.fn((msg: unknown) => {
        messages.push(msg);
      }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      close: vi.fn(),
    } as unknown as DedicatedWorkerGlobalScope;

    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearGameState();
    harness?.dispose();
    harness = null;
  });

  it('old save loads with default automation state and automations work', async () => {
    // Create worker
    harness = initializeRuntimeWorker({
      context: mockContext,
      now: () => currentTime,
      scheduleTick: (_callback) => {
        return () => {};
      },
      stepSizeMs: 100,
    });

    // Clear initial READY message
    messages.length = 0;

    // Create a snapshot with old save format (no automationState field)
    const oldSave: SerializedResourceState = {
      ids: ['sample-pack.energy', 'sample-pack.crystal'],
      amounts: [100, 50],
      capacities: [null, 1000],
      flags: [0, 0],
      unlocked: [true, true],
      visible: [true, true],
      // No automationState - simulating old save
    };

    // Restore from old save
    harness.handleMessage({
      type: 'RESTORE_SESSION',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      state: oldSave,
    });

    // Wait for restoration
    const sessionRestored = messages.find(
      (m: any) => m.type === 'SESSION_RESTORED'
    );
    expect(sessionRestored).toBeDefined();

    // Clear messages for clean slate
    messages.length = 0;

    // Enable an automation (should work even after migrating old save)
    harness.handleMessage({
      type: 'COMMAND',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      source: CommandSource.PLAYER,
      requestId: 'toggle-auto-1',
      command: {
        type: 'TOGGLE_AUTOMATION',
        payload: { automationId: 'sample-pack.auto-reactor', enabled: true },
        issuedAt: currentTime,
      },
    });

    // Tick to process the command
    currentTime += 100;
    harness.tick();

    // Verify state update was emitted (confirming runtime is processing)
    const stateUpdate = messages.find(
      (m: any) => m.type === 'STATE_UPDATE'
    );
    expect(stateUpdate).toBeDefined();

    // Clear messages again
    messages.length = 0;

    // Take snapshot to verify automation state
    const requestId = 'final-check';
    harness.handleMessage({
      type: 'REQUEST_SESSION_SNAPSHOT',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      requestId,
    });

    const snapshotMessage = messages.find(
      (m: any) => m.type === 'SESSION_SNAPSHOT' && m.requestId === requestId
    ) as RuntimeWorkerSessionSnapshot | undefined;

    expect(snapshotMessage).toBeDefined();

    // Verify automation state exists and automation is enabled
    expect(snapshotMessage!.snapshot.state.automationState).toBeDefined();
    expect(snapshotMessage!.snapshot.state.automationState).toContainEqual(
      expect.objectContaining({
        id: 'sample-pack.auto-reactor',
        enabled: true,
      })
    );
  });
});
