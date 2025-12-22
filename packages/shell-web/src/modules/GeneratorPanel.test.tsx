import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { GeneratorView, ResourceView } from '@idle-engine/core';

import { GeneratorPanel } from './GeneratorPanel.js';
import type { ShellProgressionApi, ShellState } from './shell-state.types.js';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const mockProgressionApi: Mutable<ShellProgressionApi> = {
  isEnabled: true,
  schemaVersion: 1,
  selectResources: vi.fn(() => null),
  selectGenerators: vi.fn(() => null),
  selectUpgrades: vi.fn(() => null),
  selectOptimisticResources: vi.fn(() => null),
  stageResourceDelta: vi.fn(),
  clearPendingDeltas: vi.fn(),
};

const mockShellState: { bridge: Mutable<ShellState['bridge']>; runtime: Mutable<ShellState['runtime']> } = {
  bridge: {
    isReady: true,
    isRestoring: false,
    lastUpdateAt: Date.now(),
    errors: [],
  },
  runtime: {
    currentStep: 0,
    backPressure: null,
    events: [],
    lastSnapshot: undefined,
    progression: {
      snapshot: null,
      pendingDeltas: [],
      schemaVersion: 1,
    },
  },
};

const mockBridge = {
  onError: vi.fn<(err: unknown) => void>(() => undefined),
  offError: vi.fn<(err: unknown) => void>(() => undefined),
  sendCommand: vi.fn(),
};

vi.mock('./ShellStateProvider.js', () => ({
  useShellProgression: vi.fn(() => mockProgressionApi),
  useShellState: vi.fn(() => mockShellState),
  useShellBridge: vi.fn(() => mockBridge),
}));

describe('GeneratorPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProgressionApi.isEnabled = true;
    mockProgressionApi.selectGenerators = vi.fn(() => null);
    mockProgressionApi.selectOptimisticResources = vi.fn(() => null);
    mockShellState.bridge.isReady = true;
    mockShellState.bridge.lastUpdateAt = Date.now();
    mockShellState.runtime.currentStep = 0;
  });

  it('renders nothing when feature flag is disabled', () => {
    mockProgressionApi.isEnabled = false;
    const { container } = render(<GeneratorPanel />);
    expect(container.firstChild).toBeNull();
  });

  it('shows loading state when no snapshot yet', () => {
    mockProgressionApi.selectGenerators = vi.fn(() => null);
    mockProgressionApi.selectOptimisticResources = vi.fn(() => null);
    // Simulate bridge not ready / no update yet
    mockShellState.bridge.isReady = false;
    mockShellState.bridge.lastUpdateAt = null;
    render(<GeneratorPanel />);
    expect(screen.getByText('Generators')).toBeInTheDocument();
    expect(screen.getByText(/Loading generator data/i)).toBeInTheDocument();
  });

  it('disables purchase when insufficient funds', () => {
    const generators: GeneratorView[] = [
      {
        id: 'gen-1',
        displayName: 'Reactor',
        owned: 0,
        enabled: true,
        unlocked: true,
        visible: true,
        costs: [{ resourceId: 'res.energy', amount: 10, canAfford: false }],
        canAfford: false,
        produces: [],
        consumes: [],
        nextPurchaseReadyAtStep: 0,
      },
    ];
    const resources: ResourceView[] = [
      { id: 'res.energy', displayName: 'Energy', amount: 5, unlocked: true, visible: true, perTick: 0 },
    ];
    mockProgressionApi.selectGenerators = vi.fn(() => generators);
    mockProgressionApi.selectOptimisticResources = vi.fn(() => resources);

    render(<GeneratorPanel />);
    const buyBtn = screen.getByRole('button', { name: /Buy 1/i });
    expect(buyBtn).toBeDisabled();
  });

  it('stages deltas and sends command on purchase', () => {
    const generators: GeneratorView[] = [
      {
        id: 'gen-1',
        displayName: 'Reactor',
        owned: 0,
        enabled: true,
        unlocked: true,
        visible: true,
        costs: [{ resourceId: 'res.energy', amount: 10, canAfford: true }],
        canAfford: true,
        produces: [],
        consumes: [],
        nextPurchaseReadyAtStep: 0,
      },
    ];
    const resources: ResourceView[] = [
      { id: 'res.energy', displayName: 'Energy', amount: 15, unlocked: true, visible: true, perTick: 0 },
    ];
    mockProgressionApi.selectGenerators = vi.fn(() => generators);
    mockProgressionApi.selectOptimisticResources = vi.fn(() => resources);

    render(<GeneratorPanel />);
    const buyBtn = screen.getByRole('button', { name: /Buy 1/i });
    expect(buyBtn).not.toBeDisabled();

    fireEvent.click(buyBtn);
    expect(mockProgressionApi.stageResourceDelta).toHaveBeenCalledWith('res.energy', -10);
    expect(mockBridge.sendCommand).toHaveBeenCalledWith('PURCHASE_GENERATOR', {
      generatorId: 'gen-1',
      count: 1,
    });
  });
});
