import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import {
  createGeneratorState,
  type GeneratorDefinition,
} from './generator-state.js';
import {
  resetTelemetry,
  setTelemetry,
  type TelemetryFacade,
} from './telemetry.js';

describe('GeneratorState', () => {
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

  it('initializes generators with normalized struct-of-arrays layout', () => {
    const definitions: GeneratorDefinition[] = [
      {
        id: 'reactor',
        startLevel: 3,
        maxLevel: 5,
        unlocked: true,
        visible: true,
        enabled: true,
      },
      {
        id: 'solar',
        startLevel: 0,
      },
    ];

    const state = createGeneratorState(definitions);
    const reactor = state.requireIndex('reactor');
    const solar = state.requireIndex('solar');

    expect(reactor).toBe(0);
    expect(solar).toBe(1);
    expect(state.getLevel(reactor)).toBe(3);
    expect(state.getMaxLevel(reactor)).toBe(5);
    expect(state.isUnlocked(reactor)).toBe(true);
    expect(state.isVisible(reactor)).toBe(true);
    expect(state.isEnabled(reactor)).toBe(true);

    const view = state.view();
    expect(view.ids).toEqual(['reactor', 'solar']);
    expect(() => {
      (view.levels as unknown as Uint32Array)[0] = 0;
    }).toThrowError(/immutable/i);
  });

  it('tracks dirty generators and emits compact delta snapshots', () => {
    const state = createGeneratorState([
      { id: 'reactor', startLevel: 1, maxLevel: 4 },
      { id: 'solar' },
    ]);

    const reactor = state.requireIndex('reactor');
    const solar = state.requireIndex('solar');

    // Level adjustments clamp to max and aggregate per tick deltas.
    expect(state.adjustLevel(reactor, 3)).toBe(4);
    expect(state.adjustLevel(reactor, 1)).toBe(4);

    // Toggling boolean flags marks the generator dirty once.
    state.setEnabled(reactor, true);

    const delta = state.snapshot();
    expect(delta.dirtyCount).toBe(1);
    expect(Array.from(delta.indices)).toEqual([reactor]);
    expect(Array.from(delta.levels)).toEqual([4]);
    expect(Array.from(delta.levelDelta)).toEqual([3]);
    expect(Array.from(delta.enabled)).toEqual([1]);

    // Subsequent snapshots after clearing dirties are empty.
    const clean = state.snapshot();
    expect(clean.dirtyCount).toBe(0);

    state.setEnabled(solar, true);
    state.setLevel(solar, 2);

    const solarDelta = state.snapshot();
    expect(solarDelta.dirtyCount).toBe(1);
    expect(Array.from(solarDelta.indices)).toEqual([solar]);
    expect(Array.from(solarDelta.levels)).toEqual([2]);
    expect(Array.from(solarDelta.levelDelta)).toEqual([2]);
  });

  it('records telemetry when definitions are invalid', () => {
    expect(() => {
      createGeneratorState([
        { id: 'duplicate' },
        { id: 'duplicate' },
      ]);
    }).toThrowError(/duplicated/i);
    expect(telemetryStub.recordError).toHaveBeenCalledWith(
      'GeneratorDefinitionDuplicateId',
      expect.objectContaining({ id: 'duplicate' }),
    );
  });
});

