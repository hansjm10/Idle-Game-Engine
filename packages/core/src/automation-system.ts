/**
 * @fileoverview Automation System
 *
 * The AutomationSystem evaluates automation triggers and enqueues commands
 * when triggers fire. It supports 4 trigger types:
 * - interval: Fires periodically based on elapsed time
 * - resourceThreshold: Fires when resource amount crosses threshold
 * - commandQueueEmpty: Fires when command queue is empty
 * - event: Fires when a specific event is published
 *
 * The system manages automation state (enabled/disabled, cooldowns, last-fired)
 * and integrates with the IdleEngineRuntime tick loop.
 *
 * Resource thresholds resolve resource IDs to indices via ResourceStateReader.
 * Cooldown timing follows exact step-based calculation without off-by-one errors.
 *
 * @example
 * ```typescript
 * const system = createAutomationSystem({
 *   automations: contentPack.automations,
 *   stepDurationMs: 100,
 *   commandQueue: runtime.getCommandQueue(),
 *   resourceState: progressionCoordinator.resourceState,
 * });
 *
 * runtime.addSystem(system);
 * ```
 */

import type { AutomationDefinition } from '@idle-engine/content-schema';
import { evaluateNumericFormula } from '@idle-engine/content-schema';
import type { System } from './index.js';
import type { CommandQueue } from './command-queue.js';
import { CommandPriority, RUNTIME_COMMAND_TYPES } from './command.js';
import type { RuntimeEventType } from './events/runtime-event.js';
import type { AutomationToggledEventPayload } from './events/runtime-event-catalog.js';

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
  readonly commandQueue: CommandQueue;
  readonly resourceState: ResourceStateReader;
  readonly initialState?: Map<string, AutomationState>;
}

/**
 * Creates an AutomationSystem that evaluates triggers and enqueues commands.
 *
 * The system initializes automation states from the provided definitions,
 * subscribes to relevant events during setup(), and evaluates triggers
 * during each tick() call to enqueue commands at AUTOMATION priority.
 *
 * Unlock state is persistent: once an automation is unlocked (either via
 * initialState or unlock condition evaluation), it remains unlocked. The
 * system only evaluates unlock conditions for automations that are not yet
 * unlocked. Currently, only 'always' unlock conditions are evaluated; full
 * condition evaluation requires integration with progression systems.
 *
 * @param options - Configuration options including automations, step duration,
 *                  command queue, resource state, and optional initial state.
 * @returns A System object with an additional getState() method for state extraction.
 *
 * @example
 * ```typescript
 * const system = createAutomationSystem({
 *   automations: contentPack.automations,
 *   stepDurationMs: 100,
 *   commandQueue: runtime.getCommandQueue(),
 *   resourceState: progressionCoordinator.resourceState,
 * });
 * ```
 */
export function createAutomationSystem(
  options: AutomationSystemOptions,
): System & { getState: () => ReadonlyMap<string, AutomationState> } {
  const { automations, stepDurationMs, commandQueue, resourceState } = options;
  const automationStates = new Map<string, AutomationState>();
  const pendingEventTriggers = new Set<string>();

  // Initialize automation states
  for (const automation of automations) {
    const existingState = options.initialState?.get(automation.id);
    automationStates.set(automation.id, existingState ?? {
      id: automation.id,
      enabled: automation.enabledByDefault,
      lastFiredStep: -Infinity,
      cooldownExpiresStep: 0,
      unlocked: false, // Evaluated on first tick for 'always' condition; persists once unlocked
    });
  }

  return {
    id: 'automation-system',

    getState() {
      return new Map(automationStates);
    },

    setup({ events }) {
      // Subscribe to event triggers
      for (const automation of automations) {
        if (automation.trigger.kind === 'event') {
          events.on(automation.trigger.eventId as RuntimeEventType, () => {
            pendingEventTriggers.add(automation.id);
          });
        }
      }

      // Subscribe to automation toggle events
      events.on('automation:toggled', (event) => {
        const { automationId, enabled } = event.payload as AutomationToggledEventPayload;
        const state = automationStates.get(automationId);
        if (state) {
          state.enabled = enabled;
        }
      });
    },

    tick({ step }) {
      // Evaluate each automation
      for (const automation of automations) {
        const state = automationStates.get(automation.id);
        if (!state) continue;

        // Update unlock status (only if not already unlocked)
        // Once unlocked, automations stay unlocked (unlock state is persistent)
        // For MVP, only 'always' condition is evaluated; full unlock evaluation
        // requires condition context (deferred to integration)
        if (!state.unlocked && automation.unlockCondition.kind === 'always') {
          state.unlocked = true;
        }

        // Skip if not unlocked or not enabled
        if (!state.unlocked || !state.enabled) {
          continue;
        }

        // Skip if cooldown is active
        if (isCooldownActive(state, step)) {
          continue;
        }

        // Evaluate trigger
        let triggered = false;
        switch (automation.trigger.kind) {
          case 'interval':
            triggered = evaluateIntervalTrigger(automation, state, step, stepDurationMs);
            break;
          case 'resourceThreshold':
            triggered = evaluateResourceThresholdTrigger(automation, resourceState);
            break;
          case 'commandQueueEmpty':
            triggered = evaluateCommandQueueEmptyTrigger(commandQueue);
            break;
          case 'event':
            triggered = evaluateEventTrigger(automation.id, pendingEventTriggers);
            break;
        }

        if (!triggered) {
          continue;
        }

        // TODO: Check resource cost (deferred - requires resource deduction API)

        // Enqueue command
        enqueueAutomationCommand(automation, commandQueue, step, stepDurationMs);

        // Update state
        state.lastFiredStep = step;
        updateCooldown(automation, state, step, stepDurationMs);
      }

      // Clear pending event triggers
      pendingEventTriggers.clear();
    },
  };
}

/**
 * Gets the current state of all automations.
 *
 * This function extracts the internal state from an AutomationSystem,
 * which is useful for serialization to save files. The returned map
 * contains automation IDs as keys and their current state as values.
 *
 * @param system - The AutomationSystem instance from which to extract state.
 * @returns A readonly map of automation IDs to their current state.
 *
 * @example
 * ```typescript
 * const state = getAutomationState(system);
 * const autoState = state.get('auto:collector');
 * console.log(`Enabled: ${autoState?.enabled}`);
 * ```
 */
export function getAutomationState(
  system: ReturnType<typeof createAutomationSystem>,
): ReadonlyMap<string, AutomationState> {
  return system.getState();
}

/**
 * Checks if an automation is currently in cooldown.
 *
 * An automation is considered in cooldown if the current step is less than
 * the cooldownExpiresStep value in the automation's state.
 *
 * @param state - The automation state to check.
 * @param currentStep - The current step number in the runtime.
 * @returns True if the automation is in cooldown, false otherwise.
 *
 * @example
 * ```typescript
 * const state = { id: 'auto:test', enabled: true, lastFiredStep: 10,
 *                 cooldownExpiresStep: 20, unlocked: true };
 * const isActive = isCooldownActive(state, 15); // true
 * const isExpired = isCooldownActive(state, 20); // false
 * ```
 */
export function isCooldownActive(
  state: AutomationState,
  currentStep: number,
): boolean {
  return currentStep < state.cooldownExpiresStep;
}

/**
 * Updates the cooldown expiration step after an automation fires.
 *
 * Converts the cooldown duration (in milliseconds) from the automation
 * definition into steps and sets the cooldownExpiresStep in the state.
 * If no cooldown is defined, sets cooldownExpiresStep to 0 (no cooldown).
 *
 * @param automation - The automation definition containing the cooldown duration.
 * @param state - The automation state to update.
 * @param currentStep - The current step when the automation fired.
 * @param stepDurationMs - The duration of each step in milliseconds.
 *
 * @example
 * ```typescript
 * const automation = { ..., cooldown: 500 }; // 500ms cooldown
 * const state = { ..., cooldownExpiresStep: 0 };
 * updateCooldown(automation, state, 10, 100); // stepDurationMs = 100ms
 * // state.cooldownExpiresStep will be 16 (10 + ceil(500/100) + 1)
 * ```
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
 *
 * Interval triggers fire periodically based on elapsed time. The trigger
 * fires immediately on the first tick (when lastFiredStep is -Infinity),
 * and subsequently when the number of elapsed steps since the last fire
 * meets or exceeds the interval duration.
 *
 * @param automation - The automation definition with an interval trigger.
 * @param state - The automation state containing lastFiredStep information.
 * @param currentStep - The current step number in the runtime.
 * @param stepDurationMs - The duration of each step in milliseconds.
 * @returns True if the trigger should fire, false otherwise.
 * @throws {Error} If the automation trigger is not of kind 'interval'.
 *
 * @example
 * ```typescript
 * const automation = { ..., trigger: { kind: 'interval',
 *                      interval: { kind: 'constant', value: 1000 } } };
 * const state = { ..., lastFiredStep: 0 };
 * // With stepDurationMs=100, interval is 10 steps (1000ms / 100ms)
 * const shouldFire = evaluateIntervalTrigger(automation, state, 10, 100); // true
 * ```
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
 *
 * This trigger fires when the command queue is empty (size is 0),
 * allowing automations to be triggered when no other commands are
 * pending execution.
 *
 * @param commandQueue - The command queue to check.
 * @returns True if the command queue is empty, false otherwise.
 *
 * @example
 * ```typescript
 * const commandQueue = new CommandQueue();
 * const shouldFire = evaluateCommandQueueEmptyTrigger(commandQueue); // true
 *
 * commandQueue.enqueue({ ... });
 * const shouldNotFire = evaluateCommandQueueEmptyTrigger(commandQueue); // false
 * ```
 */
export function evaluateCommandQueueEmptyTrigger(
  commandQueue: CommandQueue,
): boolean {
  return commandQueue.size === 0;
}

/**
 * Evaluates whether an event trigger should fire.
 *
 * Event triggers fire when the automation ID is in the pendingEventTriggers set.
 * The set is populated by event handlers during setup() and cleared after each tick.
 *
 * @param automationId - The ID of the automation to check.
 * @param pendingEventTriggers - A set containing automation IDs that have pending event triggers.
 * @returns True if the automation ID is in the pending triggers set, false otherwise.
 *
 * @example
 * ```typescript
 * const pendingEventTriggers = new Set(['auto:collector', 'auto:upgrader']);
 * const shouldFire = evaluateEventTrigger('auto:collector', pendingEventTriggers); // true
 * const shouldNotFire = evaluateEventTrigger('auto:other', pendingEventTriggers); // false
 * ```
 */
export function evaluateEventTrigger(
  automationId: string,
  pendingEventTriggers: ReadonlySet<string>,
): boolean {
  return pendingEventTriggers.has(automationId);
}

/**
 * Minimal ResourceState interface for automation evaluation.
 * The full ResourceState is defined in shell-web package.
 */
export interface ResourceStateReader {
  getAmount(resourceIndex: number): number;
  getResourceIndex?(resourceId: string): number;
}

/**
 * Evaluates whether a resourceThreshold trigger should fire.
 *
 * This trigger fires when a resource amount crosses a defined threshold
 * using one of four comparison operators: gte (>=), gt (>), lte (<=), or lt (<).
 * The threshold value is evaluated from a numeric formula.
 *
 * Resource IDs are resolved to indices via ResourceStateReader.getResourceIndex.
 * If getResourceIndex is not provided, falls back to index 0 for legacy compatibility.
 *
 * @param automation - The automation definition with a resourceThreshold trigger.
 * @param resourceState - The resource state reader for accessing resource amounts.
 * @returns True if the resource amount meets the threshold condition, false otherwise.
 * @throws {Error} If the automation trigger is not of kind 'resourceThreshold'.
 *
 * @example
 * ```typescript
 * const automation = { ..., trigger: { kind: 'resourceThreshold',
 *                      resourceId: 'res:gold', comparator: 'gte',
 *                      threshold: { kind: 'constant', value: 100 } } };
 * const resourceState = {
 *   getAmount: (idx) => 150,
 *   getResourceIndex: (id) => id === 'res:gold' ? 0 : -1
 * };
 * const shouldFire = evaluateResourceThresholdTrigger(automation, resourceState); // true
 * ```
 */
export function evaluateResourceThresholdTrigger(
  automation: AutomationDefinition,
  resourceState: ResourceStateReader,
): boolean {
  if (automation.trigger.kind !== 'resourceThreshold') {
    throw new Error('Expected resourceThreshold trigger');
  }

  const { resourceId, comparator, threshold } = automation.trigger;

  // Resolve resource ID to index
  let resourceIndex = 0;
  if (resourceState.getResourceIndex) {
    const resolvedIndex = resourceState.getResourceIndex(resourceId);
    if (resolvedIndex === -1) {
      // Resource doesn't exist - treat as 0 amount
      // This handles cases where automation references unavailable resource
      return false;
    }
    resourceIndex = resolvedIndex;
  }
  // If getResourceIndex not provided, fall back to index 0 (for legacy tests)

  // Get resource amount
  const amount = resourceState.getAmount(resourceIndex);

  // Evaluate threshold formula
  const thresholdValue = evaluateNumericFormula(threshold, {
    variables: { level: 0 }, // Static evaluation
  });

  // Compare resource amount to threshold
  switch (comparator) {
    case 'gte':
      return amount >= thresholdValue;
    case 'gt':
      return amount > thresholdValue;
    case 'lte':
      return amount <= thresholdValue;
    case 'lt':
      return amount < thresholdValue;
    default: {
      const exhaustiveCheck: never = comparator;
      throw new Error(`Unknown comparator: ${exhaustiveCheck}`);
    }
  }
}

/**
 * Enqueues a command for an automation trigger.
 *
 * Converts an automation's target into the appropriate command type and
 * enqueues it to the command queue at AUTOMATION priority. Supports three
 * target types:
 * - generator: Enqueues TOGGLE_GENERATOR command
 * - upgrade: Enqueues PURCHASE_UPGRADE command (quantity 1)
 * - system: Enqueues system command with the systemTargetId
 *
 * The command is scheduled to execute on the next step (currentStep + 1).
 * Timestamps are derived from the simulation clock (step * stepDurationMs)
 * to ensure deterministic replay behavior.
 *
 * @param automation - The automation definition containing the target information.
 * @param commandQueue - The command queue to enqueue the command to.
 * @param currentStep - The current step number in the runtime.
 * @param stepDurationMs - The duration of each step in milliseconds.
 * @throws {Error} If the target type is unknown.
 *
 * @example
 * ```typescript
 * const automation = { ..., targetType: 'generator', targetId: 'gen:clicks' };
 * const commandQueue = new CommandQueue();
 * enqueueAutomationCommand(automation, commandQueue, 10, 100);
 * // Command is enqueued to execute at step 11 with timestamp 1000ms
 * ```
 */
export function enqueueAutomationCommand(
  automation: AutomationDefinition,
  commandQueue: CommandQueue,
  currentStep: number,
  stepDurationMs: number,
): void {
  const { targetType, targetId, systemTargetId } = automation;

  let commandType: string;
  let payload: unknown;

  if (targetType === 'generator') {
    commandType = RUNTIME_COMMAND_TYPES.TOGGLE_GENERATOR;
    payload = { generatorId: targetId };
  } else if (targetType === 'upgrade') {
    commandType = RUNTIME_COMMAND_TYPES.PURCHASE_UPGRADE;
    payload = { upgradeId: targetId, quantity: 1 };
  } else if (targetType === 'system') {
    commandType = systemTargetId ?? 'system:unknown';
    payload = {};
  } else {
    throw new Error(`Unknown target type: ${targetType}`);
  }

  const timestamp = currentStep * stepDurationMs;

  commandQueue.enqueue({
    type: commandType,
    payload,
    priority: CommandPriority.AUTOMATION,
    timestamp,
    step: currentStep + 1, // Execute on next step
  });
}
