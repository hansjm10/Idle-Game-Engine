import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { WorkerBridge, SessionSnapshotPayload } from './worker-bridge.js';
import { PersistencePanel } from './PersistencePanel.js';

describe('PersistencePanel', () => {
  let mockBridge: WorkerBridge;
  let mockOnSave: ReturnType<typeof vi.fn>;
  let mockOnLoad: ReturnType<typeof vi.fn>;
  let mockOnClear: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockOnSave = vi.fn();
    mockOnLoad = vi.fn();
    mockOnClear = vi.fn();

    mockBridge = {
      awaitReady: vi.fn().mockResolvedValue(undefined),
      requestSessionSnapshot: vi.fn().mockResolvedValue({
        persistenceSchemaVersion: 1,
        slotId: 'default',
        capturedAt: new Date().toISOString(),
        workerStep: 100,
        monotonicMs: 1000,
        state: { resources: {} },
        runtimeVersion: '0.1.0',
        contentDigest: { hash: 'abc123', timestamp: Date.now() },
      } as SessionSnapshotPayload),
      onError: vi.fn(),
      offError: vi.fn(),
    } as unknown as WorkerBridge;
  });

  it('renders save/load controls', () => {
    render(
      <PersistencePanel
        bridge={mockBridge}
        onSave={mockOnSave}
        onLoad={mockOnLoad}
        onClear={mockOnClear}
      />,
    );

    expect(screen.getByRole('button', { name: /save game manually/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /load saved game/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /clear all saved data/i })).toBeInTheDocument();
  });

  it('calls onSave when save button is clicked', async () => {
    const user = userEvent.setup();
    mockOnSave.mockResolvedValue(undefined);

    render(
      <PersistencePanel
        bridge={mockBridge}
        onSave={mockOnSave}
        onLoad={mockOnLoad}
        onClear={mockOnClear}
      />,
    );

    const saveButton = screen.getByRole('button', { name: /save game manually/i });
    await user.click(saveButton);

    await waitFor(() => {
      expect(mockBridge.requestSessionSnapshot).toHaveBeenCalledWith('manual_save');
      expect(mockOnSave).toHaveBeenCalled();
    });
  });

  it('displays last saved timestamp after successful save', async () => {
    const user = userEvent.setup();
    mockOnSave.mockResolvedValue(undefined);

    render(
      <PersistencePanel
        bridge={mockBridge}
        onSave={mockOnSave}
        onLoad={mockOnLoad}
        onClear={mockOnClear}
      />,
    );

    const saveButton = screen.getByRole('button', { name: /save game manually/i });
    await user.click(saveButton);

    await waitFor(() => {
      expect(screen.getByText(/last manual save:/i)).toBeInTheDocument();
    });
  });

  it('shows success toast after successful save', async () => {
    const user = userEvent.setup();
    mockOnSave.mockResolvedValue(undefined);

    render(
      <PersistencePanel
        bridge={mockBridge}
        onSave={mockOnSave}
        onLoad={mockOnLoad}
        onClear={mockOnClear}
      />,
    );

    const saveButton = screen.getByRole('button', { name: /save game manually/i });
    await user.click(saveButton);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText(/game saved successfully/i)).toBeInTheDocument();
    });
  });

  it('shows error toast when save fails', async () => {
    const user = userEvent.setup();
    mockOnSave.mockRejectedValue(new Error('Save failed'));

    render(
      <PersistencePanel
        bridge={mockBridge}
        onSave={mockOnSave}
        onLoad={mockOnClear}
        onClear={mockOnClear}
      />,
    );

    const saveButton = screen.getByRole('button', { name: /save game manually/i });
    await user.click(saveButton);

    await waitFor(() => {
      expect(screen.getByText(/failed to save game/i)).toBeInTheDocument();
    });
  });

  it('calls onLoad when load button is clicked', async () => {
    const user = userEvent.setup();
    mockOnLoad.mockResolvedValue(undefined);

    render(
      <PersistencePanel
        bridge={mockBridge}
        onSave={mockOnSave}
        onLoad={mockOnLoad}
        onClear={mockOnClear}
      />,
    );

    const loadButton = screen.getByRole('button', { name: /load saved game/i });
    await user.click(loadButton);

    await waitFor(() => {
      expect(mockOnLoad).toHaveBeenCalled();
    });
  });

  it('shows error alert when restore fails via bridge error', async () => {
    render(
      <PersistencePanel
        bridge={mockBridge}
        onSave={mockOnSave}
        onLoad={mockOnLoad}
        onClear={mockOnClear}
      />,
    );

    // Simulate bridge error
    expect(mockBridge.onError).toHaveBeenCalled();
    const onErrorCalls = (mockBridge.onError as ReturnType<typeof vi.fn>).mock.calls;
    expect(onErrorCalls.length).toBeGreaterThan(0);
    const errorHandler = onErrorCalls[0]?.[0];
    expect(errorHandler).toBeDefined();

    act(() => {
      errorHandler({ code: 'RESTORE_FAILED', message: 'Restore failed due to validation error' });
    });

    await waitFor(() => {
      expect(screen.getByText(/restore error:/i)).toBeInTheDocument();
      expect(screen.getAllByText(/restore failed due to validation error/i).length).toBeGreaterThan(0);
    });
  });

  it('provides retry and clear options when restore fails', async () => {
    render(
      <PersistencePanel
        bridge={mockBridge}
        onSave={mockOnSave}
        onLoad={mockOnLoad}
        onClear={mockOnClear}
      />,
    );

    // Simulate bridge error
    expect(mockBridge.onError).toHaveBeenCalled();
    const onErrorCalls = (mockBridge.onError as ReturnType<typeof vi.fn>).mock.calls;
    expect(onErrorCalls.length).toBeGreaterThan(0);
    const errorHandler = onErrorCalls[0]?.[0];
    expect(errorHandler).toBeDefined();

    act(() => {
      errorHandler({ code: 'RESTORE_FAILED', message: 'Restore failed' });
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /clear data/i })).toBeInTheDocument();
    });
  });

  it('calls onClear with confirmation when clear button is clicked', async () => {
    const user = userEvent.setup();
    mockOnClear.mockResolvedValue(undefined);

    // Mock window.confirm
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(
      <PersistencePanel
        bridge={mockBridge}
        onSave={mockOnSave}
        onLoad={mockOnLoad}
        onClear={mockOnClear}
      />,
    );

    const clearButton = screen.getByRole('button', { name: /clear all saved data/i });
    await user.click(clearButton);

    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalled();
      expect(mockOnClear).toHaveBeenCalled();
    });

    confirmSpy.mockRestore();
  });

  it('does not call onClear if user cancels confirmation', async () => {
    const user = userEvent.setup();
    mockOnClear.mockResolvedValue(undefined);

    // Mock window.confirm to return false
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(
      <PersistencePanel
        bridge={mockBridge}
        onSave={mockOnSave}
        onLoad={mockOnLoad}
        onClear={mockOnClear}
      />,
    );

    const clearButton = screen.getByRole('button', { name: /clear all saved data/i });
    await user.click(clearButton);

    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalled();
      expect(mockOnClear).not.toHaveBeenCalled();
    });

    confirmSpy.mockRestore();
  });

  it('shows saving indicator while save is in progress', async () => {
    const user = userEvent.setup();
    let resolveSave: () => void;
    const savePromise = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    mockOnSave.mockReturnValue(savePromise);

    render(
      <PersistencePanel
        bridge={mockBridge}
        onSave={mockOnSave}
        onLoad={mockOnLoad}
        onClear={mockOnClear}
      />,
    );

    const saveButton = screen.getByRole('button', { name: /save game manually/i });
    await user.click(saveButton);

    // Should show saving state
    await waitFor(() => {
      expect(screen.getByText(/^Saving\.\.\.$/i)).toBeInTheDocument();
      expect(screen.getByText(/manual save in progress.../i)).toBeInTheDocument();
    });

    // Resolve the save
    resolveSave!();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save game manually/i })).toBeInTheDocument();
    });
  });

  it('allows toast dismissal', async () => {
    const user = userEvent.setup();
    mockOnSave.mockResolvedValue(undefined);

    render(
      <PersistencePanel
        bridge={mockBridge}
        onSave={mockOnSave}
        onLoad={mockOnLoad}
        onClear={mockOnClear}
      />,
    );

    const saveButton = screen.getByRole('button', { name: /save game manually/i });
    await user.click(saveButton);

    const toast = await screen.findByRole('alert');
    expect(toast).toBeInTheDocument();
    expect(screen.getByText(/game saved successfully/i)).toBeInTheDocument();

    const dismissButton = screen.getByRole('button', { name: /dismiss notification/i });
    await user.click(dismissButton);

    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  it('unregisters error listener on unmount', () => {
    const { unmount } = render(
      <PersistencePanel
        bridge={mockBridge}
        onSave={mockOnSave}
        onLoad={mockOnLoad}
        onClear={mockOnClear}
      />,
    );

    expect(mockBridge.onError).toHaveBeenCalled();

    unmount();

    expect(mockBridge.offError).toHaveBeenCalled();
  });
});
