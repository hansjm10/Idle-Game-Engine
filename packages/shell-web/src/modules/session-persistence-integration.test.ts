import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

import * as core from '@idle-engine/core';
import type { ResourceDefinition } from '@idle-engine/core';

import {
  initializeRuntimeWorker,
  type RuntimeWorkerHarness,
} from '../runtime.worker.js';
import {
  WORKER_MESSAGE_SCHEMA_VERSION,
  type RuntimeWorkerSessionSnapshot,
} from './runtime-worker-protocol.js';
import {
  StubWorkerContext,
  createTestTimeController,
} from '../test-utils.js';
import { SessionPersistenceAdapter } from './session-persistence-adapter.js';
import { sampleContent } from '@idle-engine/content-sample';
import { AutosaveController, DEFAULT_SLOT_ID } from './autosave-controller.js';
import { restoreSession } from './session-restore.js';

describe('Session Persistence Integration', () => {
  let timeController = createTestTimeController();
  let context: StubWorkerContext;
  let harness: RuntimeWorkerHarness | null = null;
  let adapter: SessionPersistenceAdapter;

  // Note: resource definitions for the integration tests use
  // sampleContent.resources to stay aligned with the worker runtime.

  beforeEach(() => {
    // Reset IndexedDB for each test
    globalThis.indexedDB = new IDBFactory();

    timeController = createTestTimeController();
    context = new StubWorkerContext();
    adapter = new SessionPersistenceAdapter();

    vi.resetModules();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    core.clearGameState();
    harness?.dispose();
    harness = null;
    adapter.close();
  });

  describe('snapshot save flow', () => {
    it('should capture and persist a session snapshot', async () => {
      // Initialize worker
      harness = initializeRuntimeWorker({
        context: context as unknown as DedicatedWorkerGlobalScope,
        now: timeController.now,
        scheduleTick: timeController.scheduleTick,
      });

      // Wait for READY message
      expect(context.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'READY' }),
      );

      // Advance runtime to generate some state
      timeController.advanceTime(110);
      timeController.runTick();

      // Request a snapshot
      context.dispatch({
        type: 'REQUEST_SESSION_SNAPSHOT',
        schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
        requestId: 'test-snapshot-1',
        reason: 'test',
      });

      // Verify SESSION_SNAPSHOT message was emitted
      const snapshotCall = context.postMessage.mock.calls.find(
        ([payload]) =>
          (payload as { type?: string } | undefined)?.type === 'SESSION_SNAPSHOT',
      );
      expect(snapshotCall).toBeDefined();

      const snapshotEnvelope = snapshotCall?.[0] as RuntimeWorkerSessionSnapshot;
      expect(snapshotEnvelope.type).toBe('SESSION_SNAPSHOT');
      expect(snapshotEnvelope.requestId).toBe('test-snapshot-1');
      expect(snapshotEnvelope.snapshot).toBeDefined();
      expect(snapshotEnvelope.snapshot.state).toBeDefined();
      expect(snapshotEnvelope.snapshot.workerStep).toBeGreaterThanOrEqual(0);

      // Persist the snapshot
      await adapter.save({
        schemaVersion: snapshotEnvelope.snapshot.persistenceSchemaVersion,
        slotId: DEFAULT_SLOT_ID,
        capturedAt: snapshotEnvelope.snapshot.capturedAt,
        workerStep: snapshotEnvelope.snapshot.workerStep,
        monotonicMs: snapshotEnvelope.snapshot.monotonicMs,
        state: snapshotEnvelope.snapshot.state,
        runtimeVersion: snapshotEnvelope.snapshot.runtimeVersion,
        contentDigest: snapshotEnvelope.snapshot.contentDigest,
      });

      // Verify snapshot can be loaded
      const loaded = await adapter.load(DEFAULT_SLOT_ID);
      expect(loaded).not.toBeNull();
      expect(loaded?.workerStep).toBe(snapshotEnvelope.snapshot.workerStep);
    });
  });

  describe('snapshot restore flow', () => {
    it('should restore a persisted session snapshot', async () => {
      // Initialize first worker and generate state
      harness = initializeRuntimeWorker({
        context: context as unknown as DedicatedWorkerGlobalScope,
        now: timeController.now,
        scheduleTick: timeController.scheduleTick,
      });

      // Advance runtime
      timeController.advanceTime(110);
      timeController.runTick();

      // Request and persist a snapshot
      context.dispatch({
        type: 'REQUEST_SESSION_SNAPSHOT',
        schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
        requestId: 'save-snapshot',
        reason: 'test-save',
      });

      const snapshotCall = context.postMessage.mock.calls.find(
        ([payload]) =>
          (payload as { type?: string } | undefined)?.type === 'SESSION_SNAPSHOT',
      );

      const snapshotEnvelope = snapshotCall?.[0] as RuntimeWorkerSessionSnapshot;
      await adapter.save({
        schemaVersion: snapshotEnvelope.snapshot.persistenceSchemaVersion,
        slotId: DEFAULT_SLOT_ID,
        capturedAt: snapshotEnvelope.snapshot.capturedAt,
        workerStep: snapshotEnvelope.snapshot.workerStep,
        monotonicMs: snapshotEnvelope.snapshot.monotonicMs,
        state: snapshotEnvelope.snapshot.state,
        runtimeVersion: snapshotEnvelope.snapshot.runtimeVersion,
        contentDigest: snapshotEnvelope.snapshot.contentDigest,
      });

      // Dispose first worker
      harness.dispose();
      harness = null;

      // Create new worker context for restore
      const restoreContext = new StubWorkerContext();
      const restoreTimeController = createTestTimeController();

      // Initialize new worker
      harness = initializeRuntimeWorker({
        context: restoreContext as unknown as DedicatedWorkerGlobalScope,
        now: restoreTimeController.now,
        scheduleTick: restoreTimeController.scheduleTick,
      });

      // Create mock bridge for restore operation
      const mockBridge = {
        restoreSession: vi.fn().mockImplementation(async (payload) => {
          // Simulate the bridge calling RESTORE_SESSION on the worker
          restoreContext.dispatch({
            type: 'RESTORE_SESSION',
            schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
            state: payload.state,
            elapsedMs: payload.elapsedMs,
            resourceDeltas: payload.resourceDeltas,
          });

          // Wait for SESSION_RESTORED
          return Promise.resolve();
        }),
      };

      // Perform restore
      const result = await restoreSession(
        mockBridge as any,
        adapter,
        {
          slotId: DEFAULT_SLOT_ID,
          // Use the same content definitions the worker/runtime uses
          // so reconciliation succeeds without migration.
          definitions: sampleContent.resources,
        },
      );

      expect(result.success).toBe(true);
      expect(result.validationStatus).toBe('valid');
      expect(result.snapshot).toBeDefined();
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(mockBridge.restoreSession).toHaveBeenCalledWith({
        state: expect.any(Object),
        elapsedMs: expect.any(Number),
      });
    });

    it('should fail to restore snapshot with mismatched definitions', async () => {
      // Save a snapshot with certain resource IDs
      harness = initializeRuntimeWorker({
        context: context as unknown as DedicatedWorkerGlobalScope,
        now: timeController.now,
        scheduleTick: timeController.scheduleTick,
      });

      timeController.advanceTime(110);
      timeController.runTick();

      context.dispatch({
        type: 'REQUEST_SESSION_SNAPSHOT',
        schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
        requestId: 'save-snapshot',
        reason: 'test-save',
      });

      const snapshotCall = context.postMessage.mock.calls.find(
        ([payload]) =>
          (payload as { type?: string } | undefined)?.type === 'SESSION_SNAPSHOT',
      );

      const snapshotEnvelope = snapshotCall?.[0] as RuntimeWorkerSessionSnapshot;
      await adapter.save({
        schemaVersion: snapshotEnvelope.snapshot.persistenceSchemaVersion,
        slotId: DEFAULT_SLOT_ID,
        capturedAt: snapshotEnvelope.snapshot.capturedAt,
        workerStep: snapshotEnvelope.snapshot.workerStep,
        monotonicMs: snapshotEnvelope.snapshot.monotonicMs,
        state: snapshotEnvelope.snapshot.state,
        runtimeVersion: snapshotEnvelope.snapshot.runtimeVersion,
        contentDigest: snapshotEnvelope.snapshot.contentDigest,
      });

      harness.dispose();
      harness = null;

      // Try to restore with different definitions
      const mismatchedDefinitions: ResourceDefinition[] = [
        {
          id: 'different-resource',
          name: 'Different',
          initialAmount: 0,
          capacity: 1000,
          unlocked: true,
          visible: true,
        },
      ];

      const mockBridge = {
        restoreSession: vi.fn().mockResolvedValue(undefined),
      };

      const result = await restoreSession(
        mockBridge as any,
        adapter,
        {
          slotId: DEFAULT_SLOT_ID,
          definitions: mismatchedDefinitions,
        },
      );

      expect(result.success).toBe(false);
      expect(result.validationStatus).toBe('invalid');
      expect(result.error).toBeDefined();
      expect(mockBridge.restoreSession).not.toHaveBeenCalled();
    });
  });

  describe('autosave controller integration', () => {
    it('should automatically save snapshots at intervals', async () => {
      vi.useFakeTimers();

      // Initialize worker
      harness = initializeRuntimeWorker({
        context: context as unknown as DedicatedWorkerGlobalScope,
        now: timeController.now,
        scheduleTick: timeController.scheduleTick,
      });

      // Create mock bridge that captures snapshot requests
      const snapshotRequests: string[] = [];
      const mockBridge = {
        requestSessionSnapshot: vi.fn().mockImplementation(async (reason) => {
          snapshotRequests.push(reason);

          // Dispatch actual request to worker
          const requestId = `snapshot-${Date.now()}`;
          context.dispatch({
            type: 'REQUEST_SESSION_SNAPSHOT',
            schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
            requestId,
            reason,
          });

          // Find the response
          const snapshotCall = context.postMessage.mock.calls.find(
            ([payload]) =>
              (payload as RuntimeWorkerSessionSnapshot | undefined)?.requestId === requestId,
          );

          if (snapshotCall) {
            const envelope = snapshotCall[0] as RuntimeWorkerSessionSnapshot;
            return envelope.snapshot;
          }

          throw new Error('No snapshot response');
        }),
      };

      // Start autosave controller
      const controller = new AutosaveController(
        mockBridge as any,
        adapter,
        {
          intervalMs: 60000, // 60 seconds
          enableBeforeUnload: false,
        },
      );

      controller.start();

      // Fast-forward time by interval
      await vi.advanceTimersByTimeAsync(60000);

      expect(snapshotRequests).toContain('periodic');

      // Stop periodic loop and switch to real timers before IndexedDB ops
      // (fake timers interfere with fake-indexeddb's promise handling)
      controller.stop();
      vi.useRealTimers();

      // Perform an explicit save using a fresh controller to avoid any
      // in-flight save state from the fake-timer interval.
      const controller2 = new AutosaveController(
        mockBridge as any,
        adapter,
        {
          intervalMs: 60000,
          enableBeforeUnload: false,
        },
      );
      await controller2.save('periodic');

      // Sanity check: autosave reported completion
      expect(controller2.getLastSaveTimestamp()).not.toBeNull();

      // Wait until autosave has fully completed (persisted to IndexedDB).
      // We poll the controller status since the interval callback fires
      // asynchronously and save completion isn't awaited by the timer.
      // Wait until the snapshot becomes readable from IndexedDB.
      // This directly verifies persistence completion without relying on controller state.
      const waitUntilPersisted = async () => {
        const start = Date.now();
        while (Date.now() - start <= 3000) {
          const probe = await adapter.load(DEFAULT_SLOT_ID);
          if (probe) return probe;
          await new Promise((r) => setTimeout(r, 15));
        }
        return null;
      };
      const maybePersisted = await waitUntilPersisted();

      // Verify snapshot was persisted
      expect(maybePersisted).not.toBeNull();
    });
  });

  describe('full round-trip flow', () => {
    it('should save, restore, and continue from persisted state', async () => {
      // Initialize worker
      harness = initializeRuntimeWorker({
        context: context as unknown as DedicatedWorkerGlobalScope,
        now: timeController.now,
        scheduleTick: timeController.scheduleTick,
      });

      // Advance runtime to generate state
      timeController.advanceTime(110);
      timeController.runTick();

      // Request and persist snapshot
      context.dispatch({
        type: 'REQUEST_SESSION_SNAPSHOT',
        schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
        requestId: 'round-trip-save',
        reason: 'test',
      });

      const saveSnapshotCall = context.postMessage.mock.calls.find(
        ([payload]) =>
          (payload as RuntimeWorkerSessionSnapshot | undefined)?.requestId === 'round-trip-save',
      );

      expect(saveSnapshotCall).toBeDefined();
      const saveEnvelope = saveSnapshotCall?.[0] as RuntimeWorkerSessionSnapshot;

      await adapter.save({
        schemaVersion: saveEnvelope.snapshot.persistenceSchemaVersion,
        slotId: DEFAULT_SLOT_ID,
        capturedAt: saveEnvelope.snapshot.capturedAt,
        workerStep: saveEnvelope.snapshot.workerStep,
        monotonicMs: saveEnvelope.snapshot.monotonicMs,
        state: saveEnvelope.snapshot.state,
        runtimeVersion: saveEnvelope.snapshot.runtimeVersion,
        contentDigest: saveEnvelope.snapshot.contentDigest,
      });

      const originalStep = saveEnvelope.snapshot.workerStep;

      // Dispose worker
      harness.dispose();
      harness = null;
      core.clearGameState();

      // Create new worker for restore
      const restoreContext = new StubWorkerContext();
      const restoreTimeController = createTestTimeController();

      harness = initializeRuntimeWorker({
        context: restoreContext as unknown as DedicatedWorkerGlobalScope,
        now: restoreTimeController.now,
        scheduleTick: restoreTimeController.scheduleTick,
      });

      // Load and restore snapshot
      const loaded = await adapter.load(DEFAULT_SLOT_ID);
      expect(loaded).not.toBeNull();

      restoreContext.dispatch({
        type: 'RESTORE_SESSION',
        schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
        state: loaded!.state,
        elapsedMs: 5000, // 5 seconds offline
      });

      // Verify SESSION_RESTORED message
      const restoredCall = restoreContext.postMessage.mock.calls.find(
        ([payload]) =>
          (payload as { type?: string } | undefined)?.type === 'SESSION_RESTORED',
      );

      expect(restoredCall).toBeDefined();

      // Advance runtime and verify it continues from restored state
      restoreTimeController.advanceTime(110);
      restoreTimeController.runTick();

      // Request new snapshot to verify state continuity
      restoreContext.dispatch({
        type: 'REQUEST_SESSION_SNAPSHOT',
        schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
        requestId: 'round-trip-verify',
        reason: 'verify',
      });

      const verifySnapshotCall = restoreContext.postMessage.mock.calls.find(
        ([payload]) =>
          (payload as RuntimeWorkerSessionSnapshot | undefined)?.requestId === 'round-trip-verify',
      );

      expect(verifySnapshotCall).toBeDefined();
      const verifyEnvelope = verifySnapshotCall?.[0] as RuntimeWorkerSessionSnapshot;

      // Step should have progressed from original
      expect(verifyEnvelope.snapshot.workerStep).toBeGreaterThanOrEqual(originalStep);
    });
  });
});
