import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { createResourceState, type ResourceDefinition } from './resource-state.js';
import { applyPrestigeReset, type PrestigeResetContext } from './prestige-reset.js';
import {
  resetTelemetry,
  setTelemetry,
  type TelemetryFacade,
} from './telemetry.js';

describe('applyPrestigeReset', () => {
  let telemetryStub: TelemetryFacade;

  beforeEach(() => {
    telemetryStub = {
      recordError: vi.fn(),
      recordWarning: vi.fn(),
      recordProgress: vi.fn(),
      recordCounters: vi.fn(),
      recordTick: vi.fn(),
    };
    setTelemetry(telemetryStub);
  });

  afterEach(() => {
    resetTelemetry();
    vi.restoreAllMocks();
  });

  function createTestResources(): {
    definitions: ResourceDefinition[];
    state: ReturnType<typeof createResourceState>;
  } {
    const definitions: ResourceDefinition[] = [
      { id: 'energy', startAmount: 0 },
      { id: 'crystal', startAmount: 0 },
      { id: 'prestige-flux', startAmount: 0 },
    ];
    const state = createResourceState(definitions);
    return { definitions, state };
  }

  it('grants reward to the specified resource', () => {
    const { state } = createTestResources();
    const prestigeFluxIndex = state.requireIndex('prestige-flux');

    const context: PrestigeResetContext = {
      layerId: 'test-layer',
      resourceState: state,
      reward: { resourceId: 'prestige-flux', amount: 100 },
      resetTargets: [],
      retentionTargets: [],
    };

    applyPrestigeReset(context);

    expect(state.getAmount(prestigeFluxIndex)).toBe(100);
  });

  it('does not grant reward when amount is zero', () => {
    const { state } = createTestResources();
    const prestigeFluxIndex = state.requireIndex('prestige-flux');

    const context: PrestigeResetContext = {
      layerId: 'test-layer',
      resourceState: state,
      reward: { resourceId: 'prestige-flux', amount: 0 },
      resetTargets: [],
      retentionTargets: [],
    };

    applyPrestigeReset(context);

    expect(state.getAmount(prestigeFluxIndex)).toBe(0);
  });

  it('resets target resources to specified amounts', () => {
    const { state } = createTestResources();
    const energyIndex = state.requireIndex('energy');
    const crystalIndex = state.requireIndex('crystal');

    // Set initial values
    state.addAmount(energyIndex, 1000);
    state.addAmount(crystalIndex, 500);

    const context: PrestigeResetContext = {
      layerId: 'test-layer',
      resourceState: state,
      reward: { resourceId: 'prestige-flux', amount: 10 },
      resetTargets: [
        { resourceId: 'energy', resetToAmount: 50 },
        { resourceId: 'crystal', resetToAmount: 25 },
      ],
      retentionTargets: [],
    };

    applyPrestigeReset(context);

    expect(state.getAmount(energyIndex)).toBe(50);
    expect(state.getAmount(crystalIndex)).toBe(25);
  });

  it('applies retention amounts to specified resources', () => {
    const { state } = createTestResources();
    const energyIndex = state.requireIndex('energy');

    // Set initial value
    state.addAmount(energyIndex, 1000);

    const context: PrestigeResetContext = {
      layerId: 'test-layer',
      resourceState: state,
      reward: { resourceId: 'prestige-flux', amount: 10 },
      resetTargets: [],
      retentionTargets: [
        { resourceId: 'energy', retainedAmount: 100 }, // 10% of 1000
      ],
    };

    applyPrestigeReset(context);

    expect(state.getAmount(energyIndex)).toBe(100);
  });

  it('handles missing resource indices gracefully for rewards', () => {
    const { state } = createTestResources();

    const context: PrestigeResetContext = {
      layerId: 'test-layer',
      resourceState: state,
      reward: { resourceId: 'nonexistent-resource', amount: 100 },
      resetTargets: [],
      retentionTargets: [],
    };

    // Should not throw
    expect(() => applyPrestigeReset(context)).not.toThrow();
  });

  it('emits warning telemetry when reward resource not found', () => {
    const { state } = createTestResources();

    const context: PrestigeResetContext = {
      layerId: 'test-layer',
      resourceState: state,
      reward: { resourceId: 'nonexistent-reward', amount: 100 },
      resetTargets: [],
      retentionTargets: [],
    };

    applyPrestigeReset(context);

    expect(telemetryStub.recordWarning).toHaveBeenCalledWith(
      'PrestigeResetRewardSkipped',
      expect.objectContaining({
        layerId: 'test-layer',
        resourceId: 'nonexistent-reward',
      }),
    );
  });

  it('handles missing resource indices gracefully for reset targets', () => {
    const { state } = createTestResources();

    const context: PrestigeResetContext = {
      layerId: 'test-layer',
      resourceState: state,
      reward: { resourceId: 'prestige-flux', amount: 10 },
      resetTargets: [
        { resourceId: 'nonexistent-resource', resetToAmount: 0 },
      ],
      retentionTargets: [],
    };

    // Should not throw
    expect(() => applyPrestigeReset(context)).not.toThrow();
  });

  it('emits warning telemetry when reset target resource not found', () => {
    const { state } = createTestResources();

    const context: PrestigeResetContext = {
      layerId: 'test-layer',
      resourceState: state,
      reward: { resourceId: 'prestige-flux', amount: 10 },
      resetTargets: [
        { resourceId: 'nonexistent-reset-target', resetToAmount: 0 },
      ],
      retentionTargets: [],
    };

    applyPrestigeReset(context);

    expect(telemetryStub.recordWarning).toHaveBeenCalledWith(
      'PrestigeResetTargetSkipped',
      expect.objectContaining({
        layerId: 'test-layer',
        resourceId: 'nonexistent-reset-target',
        targetType: 'reset',
      }),
    );
  });

  it('handles missing resource indices gracefully for retention targets', () => {
    const { state } = createTestResources();

    const context: PrestigeResetContext = {
      layerId: 'test-layer',
      resourceState: state,
      reward: { resourceId: 'prestige-flux', amount: 10 },
      resetTargets: [],
      retentionTargets: [
        { resourceId: 'nonexistent-resource', retainedAmount: 50 },
      ],
    };

    // Should not throw
    expect(() => applyPrestigeReset(context)).not.toThrow();
  });

  it('emits warning telemetry when retention target resource not found', () => {
    const { state } = createTestResources();

    const context: PrestigeResetContext = {
      layerId: 'test-layer',
      resourceState: state,
      reward: { resourceId: 'prestige-flux', amount: 10 },
      resetTargets: [],
      retentionTargets: [
        { resourceId: 'nonexistent-retention-target', retainedAmount: 50 },
      ],
    };

    applyPrestigeReset(context);

    expect(telemetryStub.recordWarning).toHaveBeenCalledWith(
      'PrestigeResetTargetSkipped',
      expect.objectContaining({
        layerId: 'test-layer',
        resourceId: 'nonexistent-retention-target',
        targetType: 'retention',
      }),
    );
  });

  it('normalizes negative amounts to zero', () => {
    const { state } = createTestResources();
    const energyIndex = state.requireIndex('energy');

    state.addAmount(energyIndex, 100);

    const context: PrestigeResetContext = {
      layerId: 'test-layer',
      resourceState: state,
      reward: { resourceId: 'prestige-flux', amount: 10 },
      resetTargets: [{ resourceId: 'energy', resetToAmount: -50 }],
      retentionTargets: [],
    };

    applyPrestigeReset(context);

    expect(state.getAmount(energyIndex)).toBe(0);
  });

  it('normalizes non-finite amounts to zero', () => {
    const { state } = createTestResources();
    const energyIndex = state.requireIndex('energy');

    state.addAmount(energyIndex, 100);

    const context: PrestigeResetContext = {
      layerId: 'test-layer',
      resourceState: state,
      reward: { resourceId: 'prestige-flux', amount: 10 },
      resetTargets: [],
      retentionTargets: [{ resourceId: 'energy', retainedAmount: Number.NaN }],
    };

    applyPrestigeReset(context);

    expect(state.getAmount(energyIndex)).toBe(0);
  });

  it('emits telemetry on successful prestige reset', () => {
    const { state } = createTestResources();

    const context: PrestigeResetContext = {
      layerId: 'test-layer',
      resourceState: state,
      reward: { resourceId: 'prestige-flux', amount: 100 },
      resetTargets: [{ resourceId: 'energy', resetToAmount: 0 }],
      retentionTargets: [{ resourceId: 'crystal', retainedAmount: 50 }],
    };

    applyPrestigeReset(context);

    expect(telemetryStub.recordProgress).toHaveBeenCalledWith(
      'prestige.reset_applied',
      expect.objectContaining({
        layerId: 'test-layer',
        rewardResourceId: 'prestige-flux',
        rewardAmount: 100,
        resetCount: 1,
        retentionCount: 1,
      }),
    );
  });

  it('applies operations in correct order: reward, reset, retention', () => {
    const { state } = createTestResources();
    const energyIndex = state.requireIndex('energy');
    const prestigeFluxIndex = state.requireIndex('prestige-flux');

    // Set initial energy
    state.addAmount(energyIndex, 1000);

    const context: PrestigeResetContext = {
      layerId: 'test-layer',
      resourceState: state,
      reward: { resourceId: 'prestige-flux', amount: 50 },
      resetTargets: [{ resourceId: 'energy', resetToAmount: 10 }],
      retentionTargets: [{ resourceId: 'energy', retainedAmount: 100 }],
    };

    applyPrestigeReset(context);

    // Reward should be applied
    expect(state.getAmount(prestigeFluxIndex)).toBe(50);

    // Retention should override reset (retention comes after reset)
    expect(state.getAmount(energyIndex)).toBe(100);
  });

  it('floors retention amounts to integers', () => {
    const { state } = createTestResources();
    const energyIndex = state.requireIndex('energy');

    state.addAmount(energyIndex, 1000);

    const context: PrestigeResetContext = {
      layerId: 'test-layer',
      resourceState: state,
      reward: { resourceId: 'prestige-flux', amount: 10 },
      resetTargets: [],
      retentionTargets: [{ resourceId: 'energy', retainedAmount: 99.9 }],
    };

    applyPrestigeReset(context);

    expect(state.getAmount(energyIndex)).toBe(99);
  });
});
