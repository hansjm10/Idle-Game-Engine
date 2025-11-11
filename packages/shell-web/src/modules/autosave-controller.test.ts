import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { createDefinitionDigest } from '@idle-engine/core';

import type { WorkerBridge, SessionSnapshotPayload } from './worker-bridge.js';
import type {
  SessionPersistenceAdapter,
  StoredSessionSnapshot,
} from './session-persistence-adapter.js';
import { AutosaveController, DEFAULT_SLOT_ID } from './autosave-controller.js';

describe('AutosaveController', () => {
  let mockBridge: WorkerBridge;
  let mockAdapter: SessionPersistenceAdapter;
  let controller: AutosaveController;

  const createMockSnapshot = (): SessionSnapshotPayload => ({
    persistenceSchemaVersion: 1,
    slotId: DEFAULT_SLOT_ID,
    capturedAt: new Date().toISOString(),
    workerStep: 1000,
    monotonicMs: 5000,
    state: {
      ids: ['resource1'],
      amounts: [100],
      capacities: [1000],
      unlocked: [true],
      visible: [true],
      flags: [1],
      definitionDigest: createDefinitionDigest(['resource1']),
    },
    runtimeVersion: '0.1.0',
    contentDigest: createDefinitionDigest(['resource1']),
  });

  beforeEach(() => {
    vi.useFakeTimers();

    // Mock WorkerBridge
    mockBridge = {
      requestSessionSnapshot: vi.fn().mockResolvedValue(createMockSnapshot()),
    } as unknown as WorkerBridge;

    // Mock SessionPersistenceAdapter
    mockAdapter = {
      save: vi.fn().mockResolvedValue(undefined),
    } as unknown as SessionPersistenceAdapter;

    controller = new AutosaveController(mockBridge, mockAdapter, {
      intervalMs: 60000, // 60 seconds
    });
  });

  afterEach(() => {
    controller.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('start/stop', () => {
    it('should start the autosave loop', () => {
      expect(controller.isRunning()).toBe(false);

      controller.start();

      expect(controller.isRunning()).toBe(true);
    });

    it('should stop the autosave loop', () => {
      controller.start();
      expect(controller.isRunning()).toBe(true);

      controller.stop();

      expect(controller.isRunning()).toBe(false);
    });

    it('should be idempotent when starting', () => {
      controller.start();
      controller.start(); // Should not throw or create duplicate intervals

      expect(controller.isRunning()).toBe(true);
    });

    it('should be idempotent when stopping', () => {
      controller.start();
      controller.stop();
      controller.stop(); // Should not throw

      expect(controller.isRunning()).toBe(false);
    });
  });

  describe('telemetry', () => {
    let events: Array<{ event: string; data: Record<string, unknown> }>;
    let errors: Array<{ event: string; data: Record<string, unknown> }>;

    beforeEach(() => {
      events = [];
      errors = [];
      (globalThis as any).__IDLE_ENGINE_TELEMETRY__ = {
        recordEvent: (event: string, data?: Record<string, unknown>) => {
          events.push({ event, data: data ?? {} });
        },
        recordError: (event: string, data?: Record<string, unknown>) => {
          errors.push({ event, data: data ?? {} });
        },
      };
    });

    afterEach(() => {
      delete (globalThis as any).__IDLE_ENGINE_TELEMETRY__;
    });

    it('emits PersistenceSaveSucceeded on successful save', async () => {
      await controller.save('manual');
      expect(events.some((e) => e.event === 'PersistenceSaveSucceeded')).toBe(
        true,
      );
    });

    it('emits PersistenceSaveFailed on failure', async () => {
      (mockAdapter.save as unknown as Mock).mockRejectedValueOnce(
        new Error('boom'),
      );
      await controller.save('manual');
      expect(
        errors.some((e) => e.event === 'PersistenceSaveFailed'),
      ).toBe(true);
    });
  });

  describe('periodic autosave', () => {
    it('should trigger autosave at configured interval', async () => {
      controller.start();

      // Fast-forward time by interval
      await vi.advanceTimersByTimeAsync(60000);

      expect(mockBridge.requestSessionSnapshot).toHaveBeenCalledWith('periodic');
      expect(mockAdapter.save).toHaveBeenCalled();
    });

    it('should trigger multiple autosaves over time', async () => {
      controller.start();

      // Fast-forward time by 3 intervals
      await vi.advanceTimersByTimeAsync(60000);
      await vi.advanceTimersByTimeAsync(60000);
      await vi.advanceTimersByTimeAsync(60000);

      expect(mockBridge.requestSessionSnapshot).toHaveBeenCalledTimes(3);
      expect(mockAdapter.save).toHaveBeenCalledTimes(3);
    });

    it('should not trigger autosave when stopped', async () => {
      controller.start();
      controller.stop();

      // Fast-forward time
      await vi.advanceTimersByTimeAsync(60000);

      expect(mockBridge.requestSessionSnapshot).not.toHaveBeenCalled();
    });
  });

  describe('manual save', () => {
    it('should save immediately when called', async () => {
      await controller.save('manual');

      expect(mockBridge.requestSessionSnapshot).toHaveBeenCalledWith('manual');
      expect(mockAdapter.save).toHaveBeenCalled();
    });

    it('should respect force flag and bypass throttle', async () => {
      await controller.save('first');
      await controller.save('second'); // Should succeed even though throttled

      expect(mockBridge.requestSessionSnapshot).toHaveBeenCalledTimes(2);
    });
  });

  describe('error handling', () => {
    it('should not throw when snapshot request fails', async () => {
      mockBridge.requestSessionSnapshot = vi
        .fn()
        .mockRejectedValue(new Error('Worker error'));

      await expect(controller.save('test')).resolves.toBeUndefined();
    });

    it('should not throw when adapter save fails', async () => {
      mockAdapter.save = vi
        .fn()
        .mockRejectedValue(new Error('Storage error'));

      await expect(controller.save('test')).resolves.toBeUndefined();
    });

    it('should allow subsequent saves after failure', async () => {
      // First save fails
      mockAdapter.save = vi
        .fn()
        .mockRejectedValueOnce(new Error('Storage error'))
        .mockResolvedValueOnce(undefined);

      await controller.save('first');
      await controller.save('second');

      expect(mockBridge.requestSessionSnapshot).toHaveBeenCalledTimes(2);
    });
  });

  describe('throttling', () => {
    it('should skip saves that are too frequent (within MIN_AUTOSAVE_INTERVAL_MS)', async () => {
      controller.start();

      // Trigger first save
      await vi.advanceTimersByTimeAsync(60000);
      expect(mockBridge.requestSessionSnapshot).toHaveBeenCalledTimes(1);

      // Try to trigger saves rapidly (less than MIN_AUTOSAVE_INTERVAL_MS apart)
      await vi.advanceTimersByTimeAsync(1000); // 1 second
      await vi.advanceTimersByTimeAsync(1000); // 1 second

      // Should still be only 1 save
      expect(mockBridge.requestSessionSnapshot).toHaveBeenCalledTimes(1);

      // Wait for MIN_AUTOSAVE_INTERVAL_MS (5 seconds)
      await vi.advanceTimersByTimeAsync(5000);

      // Now next interval should succeed
      await vi.advanceTimersByTimeAsync(60000);
      expect(mockBridge.requestSessionSnapshot).toHaveBeenCalledTimes(2);
    });

    it('should not save while a save is in progress', async () => {
      let resolveSnapshot: (value: SessionSnapshotPayload) => void;
      mockBridge.requestSessionSnapshot = vi.fn().mockReturnValue(
        new Promise<SessionSnapshotPayload>((resolve) => {
          resolveSnapshot = resolve;
        }),
      );

      controller.start();

      // Start first save
      await vi.advanceTimersByTimeAsync(60000);
      expect(mockBridge.requestSessionSnapshot).toHaveBeenCalledTimes(1);

      // Try to trigger another save while first is in progress
      await vi.advanceTimersByTimeAsync(60000);

      // Should still be only 1 request
      expect(mockBridge.requestSessionSnapshot).toHaveBeenCalledTimes(1);

      // Complete the first save and flush pending microtasks
      resolveSnapshot!(createMockSnapshot());
      await Promise.resolve();

      // Next interval should succeed
      await vi.advanceTimersByTimeAsync(60000);
      expect(mockBridge.requestSessionSnapshot).toHaveBeenCalledTimes(2);
    });
  });

  describe('configuration', () => {
    it('should respect custom interval', async () => {
      const customController = new AutosaveController(
        mockBridge,
        mockAdapter,
        {
          intervalMs: 30000, // 30 seconds
        },
      );

      customController.start();

      // Fast-forward by custom interval
      await vi.advanceTimersByTimeAsync(30000);

      expect(mockBridge.requestSessionSnapshot).toHaveBeenCalledTimes(1);

      customController.stop();
    });

    it('should respect custom slot ID', async () => {
      const customSlotId = 'custom-slot';
      const customController = new AutosaveController(
        mockBridge,
        mockAdapter,
        {
          slotId: customSlotId,
        },
      );

      await customController.save('test');

      const savedSnapshot = (mockAdapter.save as any).mock
        .calls[0][0] as StoredSessionSnapshot;
      expect(savedSnapshot.slotId).toBe(customSlotId);

      customController.stop();
    });

    it('should enforce minimum interval', () => {
      const customController = new AutosaveController(
        mockBridge,
        mockAdapter,
        {
          intervalMs: 1000, // Too small, should be clamped to MIN (5000)
        },
      );

      expect(customController.getIntervalMs()).toBeGreaterThanOrEqual(5000);

      customController.stop();
    });
  });

  describe('beforeunload handling', () => {
    it('should register beforeunload handler when enabled', () => {
      const addEventListenerSpy = vi.spyOn(window, 'addEventListener');

      const controllerWithBeforeUnload = new AutosaveController(
        mockBridge,
        mockAdapter,
        {
          enableBeforeUnload: true,
        },
      );

      controllerWithBeforeUnload.start();

      expect(addEventListenerSpy).toHaveBeenCalledWith(
        'beforeunload',
        expect.any(Function),
      );

      controllerWithBeforeUnload.stop();
    });

    it('should not register beforeunload handler when disabled', () => {
      const addEventListenerSpy = vi.spyOn(window, 'addEventListener');

      const controllerWithoutBeforeUnload = new AutosaveController(
        mockBridge,
        mockAdapter,
        {
          enableBeforeUnload: false,
        },
      );

      controllerWithoutBeforeUnload.start();

      expect(addEventListenerSpy).not.toHaveBeenCalledWith(
        'beforeunload',
        expect.any(Function),
      );

      controllerWithoutBeforeUnload.stop();
    });

    it('should unregister beforeunload handler when stopped', () => {
      const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');

      const controllerWithBeforeUnload = new AutosaveController(
        mockBridge,
        mockAdapter,
        {
          enableBeforeUnload: true,
        },
      );

      controllerWithBeforeUnload.start();
      controllerWithBeforeUnload.stop();

      expect(removeEventListenerSpy).toHaveBeenCalledWith(
        'beforeunload',
        expect.any(Function),
      );
    });
  });
});
