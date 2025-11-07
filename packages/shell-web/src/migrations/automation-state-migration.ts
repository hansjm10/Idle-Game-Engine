import type { SerializedResourceState } from '@idle-engine/core';

/**
 * Migrates saves without automation state to include an empty array.
 * This ensures old saves can load with the new automation system.
 *
 * @param state - The serialized resource state from a save file
 * @returns The migrated state with automation state initialized
 */
export function migrateAutomationState(
  state: SerializedResourceState
): SerializedResourceState {
  // If automation state already exists, return as-is
  if (state.automationState !== undefined) {
    return state;
  }

  // Add empty automation state for old saves
  return {
    ...state,
    automationState: [],
  };
}
