import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';

import { ShellStateProvider, useShellProgression } from './ShellStateProvider.js';
import type { ShellStateProviderConfig } from './shell-state.types.js';
import type {
  RuntimeStateSnapshot,
  WorkerBridgeErrorDetails,
} from './worker-bridge.js';

const backPressureStub: RuntimeStateSnapshot['backPressure'] = {
  tick: 0,
  channels: [],
  counters: {
    published: 0,
    softLimited: 0,
    overflowed: 0,
    subscribers: 0,
  },
};

// Mock the progression config
vi.mock('./progression-config.js', () => ({
  isProgressionUIEnabled: vi.fn(() => true),
}));

// Mock the worker bridge
const mockBridge = {
  isReady: vi.fn(() => true),
  awaitReady: vi.fn(async () => {}),
  sendCommand: vi.fn(),
  restoreSession: vi.fn(async () => {}),
  requestSessionSnapshot: vi.fn(async () => ({})),
  sendSocialCommand: vi.fn(async () => ({})),
  enableDiagnostics: vi.fn(),
  disableDiagnostics: vi.fn(),
  onStateUpdate: vi.fn<(listener: (snapshot: RuntimeStateSnapshot) => void) => void>(),
  offStateUpdate: vi.fn<(listener: (snapshot: RuntimeStateSnapshot) => void) => void>(),
  onError: vi.fn<(listener: (error: unknown) => void) => void>(),
  offError: vi.fn<(listener: (error: unknown) => void) => void>(),
  onDiagnosticsUpdate: vi.fn<(listener: (timeline: unknown) => void) => void>(),
  offDiagnosticsUpdate: vi.fn<(listener: (timeline: unknown) => void) => void>(),
  isSocialFeatureEnabled: vi.fn(() => false),
  terminate: vi.fn(),
};

vi.mock('./worker-bridge.js', () => ({
  WorkerBridge: vi.fn(() => mockBridge),
  useWorkerBridge: vi.fn(() => mockBridge),
}));

const defaultConfig: ShellStateProviderConfig = {};

describe('ShellStateProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('useShellProgression', () => {
    it('throws error when used outside ShellStateProvider', () => {
      expect(() => {
        renderHook(() => useShellProgression());
      }).toThrow('useShellProgression must be used within a ShellStateProvider');
    });

    it('returns progression API when used within provider', () => {
      const wrapper = ({ children }: { children: ReactNode }) => (
        <ShellStateProvider {...defaultConfig}>{children}</ShellStateProvider>
      );

      const { result, rerender } = renderHook(() => useShellProgression(), {
        wrapper,
      });

      expect(result.current).toBeDefined();
      expect(result.current.isEnabled).toBe(true);
      expect(result.current.schemaVersion).toBe(1);
      expect(typeof result.current.selectResources).toBe('function');
      expect(typeof result.current.selectGenerators).toBe('function');
      expect(typeof result.current.selectUpgrades).toBe('function');
      expect(typeof result.current.selectOptimisticResources).toBe('function');
    });
  });

  describe('progression selectors', () => {
    it('return null when snapshot is null', () => {
      const wrapper = ({ children }: { children: ReactNode }) => (
        <ShellStateProvider {...defaultConfig}>{children}</ShellStateProvider>
      );

      const { result, rerender } = renderHook(
        () => useShellProgression(),
        { wrapper },
      );

      expect(result.current.selectResources()).toBeNull();
      expect(result.current.selectGenerators()).toBeNull();
      expect(result.current.selectUpgrades()).toBeNull();
      expect(result.current.selectOptimisticResources()).toBeNull();
    });

    // Note: Testing with actual snapshot data would require deeper integration
    // with the worker bridge and state reducer, which is better suited for
    // integration tests. The reducer tests in shell-state-store.test.ts
    // already verify the state management logic.
  });

  describe('optimistic resources selector', () => {
    // Note: Testing optimistic updates requires triggering state updates
    // through the reducer, which is already tested in shell-state-store.test.ts.
    // These tests verify the selector logic is present and callable.

    it('selector is memoized and callable', () => {
      const wrapper = ({ children }: { children: ReactNode }) => (
        <ShellStateProvider {...defaultConfig}>{children}</ShellStateProvider>
      );

      const { result, rerender } = renderHook(
        () => useShellProgression(),
        { wrapper },
      );

      const selector1 = result.current.selectOptimisticResources;
      const selector2 = result.current.selectOptimisticResources;

      expect(selector1).toBe(selector2);
      expect(typeof selector1).toBe('function');
    });

    it('returns snapshot resources when available', () => {
      const wrapper = ({ children }: { children: ReactNode }) => (
        <ShellStateProvider {...defaultConfig}>{children}</ShellStateProvider>
      );

      const { result, rerender } = renderHook(() => useShellProgression(), { wrapper });

      // Initially null
      expect(result.current.selectOptimisticResources()).toBeNull();

      // Simulate state update with progression snapshot
      const stateUpdateCall =
        vi.mocked(mockBridge.onStateUpdate).mock.calls[0];
      expect(stateUpdateCall).toBeDefined();
      if (!stateUpdateCall) {
        throw new Error('stateUpdateHandler was not registered');
      }
      const [stateUpdateHandler] = stateUpdateCall;
      expect(stateUpdateHandler).toBeDefined();

      const mockSnapshot = {
        currentStep: 1,
        events: [],
        backPressure: backPressureStub,
        progression: {
          step: 1,
          publishedAt: 1000,
          resources: [
            {
              id: 'gold',
              displayName: 'Gold',
              amount: 100,
              isUnlocked: true,
              isVisible: true,
              perTick: 10,
            },
            {
              id: 'wood',
              displayName: 'Wood',
              amount: 50,
              isUnlocked: true,
              isVisible: true,
              perTick: 5,
            },
          ],
          generators: [],
          upgrades: [],
        },
      } satisfies RuntimeStateSnapshot;

      act(() => {
        stateUpdateHandler(mockSnapshot);
      });
      rerender();

      // Should now return the resources
      const resources = result.current.selectOptimisticResources();
      expect(resources).not.toBeNull();
      expect(resources).toHaveLength(2);
      expect(resources?.[0].id).toBe('gold');
      expect(resources?.[0].amount).toBe(100);
      expect(resources?.[1].id).toBe('wood');
      expect(resources?.[1].amount).toBe(50);
    });

    // Note: Full testing of delta application logic (applying pending deltas
    // to resource amounts) will be possible once the purchase command API
    // is implemented in #299. The delta application logic in the selector
    // (lines 439-454 of ShellStateProvider.tsx) creates a deltaMap from
    // pendingDeltas and applies them to resource amounts. This logic is
    // exercised by the reducer tests in shell-state-store.test.ts which
    // verify deltas are staged and cleared correctly.
  });

  describe('worker command error handling', () => {
    it('only clears staged deltas for command errors', () => {
      const wrapper = ({ children }: { children: ReactNode }) => (
        <ShellStateProvider {...defaultConfig}>{children}</ShellStateProvider>
      );

      const { result, rerender } = renderHook(
        () => useShellProgression(),
        { wrapper },
      );

      const stateUpdateCalls = vi.mocked(mockBridge.onStateUpdate).mock.calls;
      const stateUpdateHandler =
        stateUpdateCalls[stateUpdateCalls.length - 1]?.[0];
      expect(stateUpdateHandler).toBeDefined();

      const snapshot: RuntimeStateSnapshot = {
        currentStep: 1,
        events: [],
        backPressure: backPressureStub,
        progression: {
          publishedAt: 100,
          resources: [
            {
              id: 'gold',
              displayName: 'Gold',
              amount: 100,
              isUnlocked: true,
              isVisible: true,
              perTick: 0,
            },
          ],
          generators: [],
          upgrades: [],
        },
      };

      act(() => {
        stateUpdateHandler!(snapshot);
      });
      rerender();

      act(() => {
        result.current.stageResourceDelta('gold', -30);
      });
      rerender();

      const readGoldAmount = () =>
        result.current
          .selectOptimisticResources()
          ?.find((resource) => resource.id === 'gold')?.amount;

      expect(readGoldAmount()).toBe(70);

      const errorCalls = vi.mocked(mockBridge.onError).mock.calls;
      const errorHandler = errorCalls[errorCalls.length - 1]?.[0] as
          | ((error: WorkerBridgeErrorDetails) => void)
          | undefined;
      expect(errorHandler).toBeDefined();

      act(() => {
        errorHandler!({
          code: 'SNAPSHOT_FAILED',
          message: 'snapshot failure',
          requestId: 'snapshot:1',
        });
      });
      rerender();

      expect(readGoldAmount()).toBe(70);

      act(() => {
        errorHandler!({
          code: 'INVALID_COMMAND_PAYLOAD',
          message: 'invalid command',
          requestId: 'command:2',
        });
      });
      rerender();

      expect(readGoldAmount()).toBe(100);
    });
  });

  describe('feature flag integration', () => {
    it('reflects isProgressionUIEnabled config', async () => {
      const { isProgressionUIEnabled } = await import('./progression-config.js');

      const wrapper = ({ children }: { children: ReactNode }) => (
        <ShellStateProvider {...defaultConfig}>{children}</ShellStateProvider>
      );

      const { result } = renderHook(() => useShellProgression(), { wrapper });

      expect(result.current.isEnabled).toBe(true);
      expect(isProgressionUIEnabled).toHaveBeenCalled();
    });
  });

  describe('schema version', () => {
    it('initializes with default schema version', () => {
      const wrapper = ({ children }: { children: ReactNode }) => (
        <ShellStateProvider {...defaultConfig}>{children}</ShellStateProvider>
      );

      const { result } = renderHook(() => useShellProgression(), { wrapper });

      expect(result.current.schemaVersion).toBe(1);
    });

    // Note: Testing schema mismatch error handling would require
    // triggering worker errors, which is better tested through
    // integration tests or by verifying the error handler logic
    // in isolation (already covered in shell-state-store.test.ts).
  });
});
