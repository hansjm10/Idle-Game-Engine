import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import type { ResourceDefinition } from '@idle-engine/core';

import { PersistenceIntegration } from './PersistenceIntegration.js';
import type { WorkerBridge } from './worker-bridge.js';
import { SessionPersistenceAdapter } from './session-persistence-adapter.js';
import { AutosaveController } from './autosave-controller.js';
import * as sessionRestore from './session-restore.js';
import * as persistenceConfig from './persistence-config.js';

// Mock modules
vi.mock('./session-persistence-adapter.js');
vi.mock('./autosave-controller.js');
vi.mock('./session-restore.js');
vi.mock('./persistence-config.js');
vi.mock('./PersistencePanel.js', () => ({
  PersistencePanel: () => null,
}));

describe('PersistenceIntegration', () => {
  let mockBridge: WorkerBridge;
  let mockDefinitions: ResourceDefinition[];
  let mockAdapter: SessionPersistenceAdapter;
  let mockAutosave: AutosaveController;
  let telemetryEvents: Array<{ event: string; data: Record<string, unknown> }>;

  beforeEach(() => {
    // Setup telemetry spy
    telemetryEvents = [];
    (globalThis as any).__IDLE_ENGINE_TELEMETRY__ = {
      recordEvent: (event: string, data: Record<string, unknown>) => {
        telemetryEvents.push({ event, data });
      },
    };

    mockBridge = {
      awaitReady: vi.fn().mockResolvedValue(undefined),
      requestSessionSnapshot: vi.fn(),
      onError: vi.fn(),
      offError: vi.fn(),
    } as unknown as WorkerBridge;

    mockDefinitions = [
      { id: 'gold', name: 'Gold', initial: 0 },
    ] as ResourceDefinition[];

    // Mock adapter
    mockAdapter = {
      open: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
      deleteSlot: vi.fn().mockResolvedValue(undefined),
    } as unknown as SessionPersistenceAdapter;

    // Mock autosave controller
    mockAutosave = {
      start: vi.fn(),
      stop: vi.fn(),
      isRunning: vi.fn().mockReturnValue(false),
    } as unknown as AutosaveController;

    // Mock constructors
    vi.mocked(SessionPersistenceAdapter).mockImplementation(() => mockAdapter);
    vi.mocked(AutosaveController).mockImplementation(() => mockAutosave);

    // Default: persistence UI enabled
    vi.mocked(persistenceConfig.isPersistenceUIEnabled).mockReturnValue(true);
  });

  afterEach(() => {
    delete (globalThis as any).__IDLE_ENGINE_TELEMETRY__;
  });

  it('returns null when persistence UI is disabled', () => {
    vi.mocked(persistenceConfig.isPersistenceUIEnabled).mockReturnValue(false);

    const { container } = render(
      <PersistenceIntegration
        bridge={mockBridge}
        definitions={mockDefinitions}
      />,
    );

    expect(container.firstChild).toBeNull();
    expect(SessionPersistenceAdapter).not.toHaveBeenCalled();
    expect(AutosaveController).not.toHaveBeenCalled();
  });

  it('initializes adapter and autosave controller on mount', () => {
    render(
      <PersistenceIntegration
        bridge={mockBridge}
        definitions={mockDefinitions}
        slotId="test-slot"
        autosaveIntervalMs={30000}
      />,
    );

    expect(SessionPersistenceAdapter).toHaveBeenCalled();
    expect(AutosaveController).toHaveBeenCalledWith(
      mockBridge,
      mockAdapter,
      { slotId: 'test-slot', intervalMs: 30000 },
    );
  });

  it('records telemetry on initialization', async () => {
    render(
      <PersistenceIntegration
        bridge={mockBridge}
        definitions={mockDefinitions}
        slotId="test-slot"
      />,
    );

    await waitFor(() => {
      expect(telemetryEvents).toContainEqual({
        event: 'PersistenceUIInitialized',
        data: { slotId: 'test-slot', autosaveIntervalMs: 'default' },
      });
    });
  });

  it('attempts restore on mount and starts autosave on success', async () => {
    vi.mocked(sessionRestore.restoreSession).mockResolvedValue({
      success: true,
    });

    render(
      <PersistenceIntegration
        bridge={mockBridge}
        definitions={mockDefinitions}
        slotId="test-slot"
      />,
    );

    await waitFor(() => {
      expect(mockAdapter.open).toHaveBeenCalled();
      expect(sessionRestore.restoreSession).toHaveBeenCalledWith(
        mockBridge,
        mockAdapter,
        { slotId: 'test-slot', definitions: mockDefinitions },
      );
    });

    await waitFor(() => {
      expect(mockAutosave.start).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(telemetryEvents).toContainEqual({
        event: 'PersistenceUIRestoreAttempted',
        data: { slotId: 'test-slot' },
      });
      expect(telemetryEvents).toContainEqual({
        event: 'PersistenceUIRestoreSucceeded',
        data: { slotId: 'test-slot' },
      });
      expect(telemetryEvents).toContainEqual({
        event: 'PersistenceUIAutosaveStarted',
        data: { slotId: 'test-slot', afterSuccessfulRestore: true, adapterInitialized: true },
      });
    });
  });

  it('starts autosave even when restore fails', async () => {
    const restoreError = new Error('Restore failed');
    vi.mocked(sessionRestore.restoreSession).mockResolvedValue({
      success: false,
      error: restoreError,
    });

    render(
      <PersistenceIntegration
        bridge={mockBridge}
        definitions={mockDefinitions}
        slotId="test-slot"
      />,
    );

    await waitFor(() => {
      expect(sessionRestore.restoreSession).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(mockAutosave.start).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(telemetryEvents).toContainEqual({
        event: 'PersistenceUIRestoreFailed',
        data: {
          slotId: 'test-slot',
          error: 'Restore failed',
          errorCode: 'Error',
        },
      });
      expect(telemetryEvents).toContainEqual({
        event: 'PersistenceUIAutosaveStarted',
        data: { slotId: 'test-slot', afterSuccessfulRestore: false, adapterInitialized: true },
      });
    });
  });

  it('does NOT start autosave when adapter initialization fails', async () => {
    const initError = new Error('Adapter open failed');
    vi.mocked(mockAdapter.open).mockRejectedValue(initError);

    render(
      <PersistenceIntegration
        bridge={mockBridge}
        definitions={mockDefinitions}
        slotId="test-slot"
      />,
    );

    // Wait for initialization to complete (evidenced by telemetry events)
    await waitFor(() => {
      expect(telemetryEvents).toContainEqual({
        event: 'PersistenceUIInitializationFailed',
        data: { slotId: 'test-slot', error: 'Adapter open failed', adapterInitialized: false },
      });
      expect(telemetryEvents).toContainEqual({
        event: 'PersistenceUIAutosaveSkipped',
        data: { slotId: 'test-slot', reason: 'adapter_initialization_failed' },
      });
    });

    // Verify autosave was never started (checked after initialization completes)
    expect(mockAutosave.start).not.toHaveBeenCalled();
  });

  it('calls autosave.start() only once despite multiple code paths', async () => {
    vi.mocked(sessionRestore.restoreSession).mockResolvedValue({
      success: true,
    });

    render(
      <PersistenceIntegration
        bridge={mockBridge}
        definitions={mockDefinitions}
      />,
    );

    // Wait for autosave to start and initialization to complete (evidenced by telemetry)
    await waitFor(() => {
      expect(telemetryEvents).toContainEqual({
        event: 'PersistenceUIAutosaveStarted',
        data: expect.objectContaining({ afterSuccessfulRestore: true }),
      });
    });

    // Verify autosave.start() was called exactly once (checked after initialization completes)
    expect(mockAutosave.start).toHaveBeenCalledTimes(1);
  });

  it('cleans up resources on unmount', async () => {
    vi.mocked(sessionRestore.restoreSession).mockResolvedValue({
      success: true,
    });

    const { unmount } = render(
      <PersistenceIntegration
        bridge={mockBridge}
        definitions={mockDefinitions}
        slotId="test-slot"
      />,
    );

    await waitFor(() => {
      expect(mockAutosave.start).toHaveBeenCalled();
    });

    unmount();

    expect(mockAutosave.stop).toHaveBeenCalled();
    expect(mockAdapter.close).toHaveBeenCalled();

    await waitFor(() => {
      expect(telemetryEvents).toContainEqual({
        event: 'PersistenceUIUnmounted',
        data: { slotId: 'test-slot' },
      });
    });
  });

  it('uses default slot ID when not provided', () => {
    render(
      <PersistenceIntegration
        bridge={mockBridge}
        definitions={mockDefinitions}
      />,
    );

    expect(AutosaveController).toHaveBeenCalledWith(
      mockBridge,
      mockAdapter,
      expect.objectContaining({ slotId: 'default' }),
    );
  });

  it('passes custom autosave interval to controller', () => {
    render(
      <PersistenceIntegration
        bridge={mockBridge}
        definitions={mockDefinitions}
        autosaveIntervalMs={120000}
      />,
    );

    expect(AutosaveController).toHaveBeenCalledWith(
      mockBridge,
      mockAdapter,
      expect.objectContaining({ intervalMs: 120000 }),
    );
  });
});
