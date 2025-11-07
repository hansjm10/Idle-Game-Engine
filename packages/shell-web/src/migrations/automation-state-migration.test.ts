import { describe, test, expect } from 'vitest';
import { migrateAutomationState } from './automation-state-migration.js';
import type { SerializedResourceState } from '@idle-engine/core';

describe('automation state migration', () => {
  test('adds default automation state to saves without it', () => {
    const oldState: SerializedResourceState = {
      ids: ['gold', 'wood'],
      amounts: [100, 50],
      capacities: [1000, null],
      flags: [0, 0],
      unlocked: [true, true],
      visible: [true, true],
    };

    const migrated = migrateAutomationState(oldState);

    expect(migrated.automationState).toEqual([]);
  });

  test('preserves existing automation state', () => {
    const existingState: SerializedResourceState = {
      ids: ['gold', 'wood'],
      amounts: [100, 50],
      capacities: [1000, null],
      flags: [0, 0],
      automationState: [{
        id: 'auto:collector',
        enabled: true,
        lastFiredStep: 10,
        cooldownExpiresStep: 15,
        unlocked: true,
        lastThresholdSatisfied: false,
      }],
    };

    const migrated = migrateAutomationState(existingState);

    expect(migrated.automationState).toEqual(existingState.automationState);
  });
});
