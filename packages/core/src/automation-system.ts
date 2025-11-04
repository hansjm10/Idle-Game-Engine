/**
 * Automation System
 *
 * Evaluates automation triggers and enqueues commands when triggers fire.
 * Supports 4 trigger types: interval, resourceThreshold, commandQueueEmpty, event.
 */

import type { AutomationDefinition } from '@idle-engine/content-schema';
import { evaluateNumericFormula } from '@idle-engine/content-schema';
import type { System } from './index.js';
import type { CommandQueue } from './command-queue.js';

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

/**
 * Checks if an automation is currently in cooldown.
 */
export function isCooldownActive(
  state: AutomationState,
  currentStep: number,
): boolean {
  return currentStep < state.cooldownExpiresStep;
}

/**
 * Updates the cooldown expiration step after an automation fires.
 */
export function updateCooldown(
  automation: AutomationDefinition,
  state: AutomationState,
  currentStep: number,
  stepDurationMs: number,
): void {
  if (!automation.cooldown) {
    state.cooldownExpiresStep = 0;
    return;
  }

  const cooldownSteps = Math.ceil(automation.cooldown / stepDurationMs);
  state.cooldownExpiresStep = currentStep + cooldownSteps;
}

/**
 * Evaluates whether an interval trigger should fire.
 */
export function evaluateIntervalTrigger(
  automation: AutomationDefinition,
  state: AutomationState,
  currentStep: number,
  stepDurationMs: number,
): boolean {
  if (automation.trigger.kind !== 'interval') {
    throw new Error('Expected interval trigger');
  }

  // Fire immediately on first tick
  if (state.lastFiredStep === -Infinity) {
    return true;
  }

  // Calculate interval in steps
  const intervalMs = evaluateNumericFormula(automation.trigger.interval, {
    variables: { level: 0 }, // Static evaluation
  });
  const intervalSteps = Math.ceil(intervalMs / stepDurationMs);

  // Check if enough steps have elapsed
  const stepsSinceLastFired = currentStep - state.lastFiredStep;
  return stepsSinceLastFired >= intervalSteps;
}

/**
 * Evaluates whether a commandQueueEmpty trigger should fire.
 */
export function evaluateCommandQueueEmptyTrigger(
  commandQueue: CommandQueue,
): boolean {
  return commandQueue.size === 0;
}
