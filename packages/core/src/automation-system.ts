/**
 * Automation System
 *
 * Evaluates automation triggers and enqueues commands when triggers fire.
 * Supports 4 trigger types: interval, resourceThreshold, commandQueueEmpty, event.
 */

import type { AutomationDefinition } from '@idle-engine/content-schema';
import type { System } from './index.js';

/**
 * Internal state for a single automation.
 */
export interface AutomationState {
  readonly id: string;
  enabled: boolean;
  lastFiredStep: number;
  cooldownExpiresStep: number;
  unlocked: boolean;
}

/**
 * Options for creating an AutomationSystem.
 */
export interface AutomationSystemOptions {
  readonly automations: readonly AutomationDefinition[];
  readonly stepDurationMs: number;
  readonly initialState?: Map<string, AutomationState>;
}

/**
 * Creates an AutomationSystem that evaluates triggers and enqueues commands.
 */
export function createAutomationSystem(
  options: AutomationSystemOptions,
): System & { getState: () => ReadonlyMap<string, AutomationState> } {
  // Internal state
  const automationStates = new Map<string, AutomationState>();

  // Initialize automation states
  for (const automation of options.automations) {
    const existingState = options.initialState?.get(automation.id);
    automationStates.set(automation.id, existingState ?? {
      id: automation.id,
      enabled: automation.enabledByDefault,
      lastFiredStep: -Infinity,
      cooldownExpiresStep: 0,
      unlocked: false, // Will be evaluated on first tick
    });
  }

  return {
    id: 'automation-system',

    getState() {
      return new Map(automationStates);
    },

    setup(_context) {
      // TODO: Subscribe to events
    },

    tick(_context) {
      // TODO: Evaluate triggers and enqueue commands
    },
  };
}

/**
 * Gets the current state of all automations.
 * Used for serialization to save files.
 */
export function getAutomationState(
  system: ReturnType<typeof createAutomationSystem>,
): ReadonlyMap<string, AutomationState> {
  return system.getState();
}
