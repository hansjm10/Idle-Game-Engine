/**
 * Automation execution system that evaluates triggers and enqueues commands.
 *
 * Implements the AutomationSystem as specified in
 * docs/automation-execution-system-design.md §6.
 */

import type { AutomationDefinition } from '@idle-engine/content-schema';
import {
  evaluateNumericFormula,
  type FormulaEvaluationContext,
} from '@idle-engine/content-schema';
import type { Condition } from '@idle-engine/content-schema';
import type { CommandQueue } from './command-queue.js';
import { CommandPriority, RUNTIME_COMMAND_TYPES } from './command.js';
import type { ResourceState } from './resource-state.js';
import type { System, SystemRegistrationContext, TickContext } from './index.js';

/**
 * State tracked for each automation instance
 */
export interface AutomationState {
  readonly id: string;
  enabled: boolean;
  lastFiredStep: number;
  cooldownExpiresStep: number;
  unlocked: boolean;
}

/**
 * Container for all automation states in progression
 */
export interface ProgressionAutomationState {
  readonly automations: Record<string, AutomationState>;
}

/**
 * Options for creating an automation system
 */
export interface AutomationSystemOptions {
  readonly automations: readonly AutomationDefinition[];
  readonly commandQueue: CommandQueue;
  readonly resourceState: ResourceState;
  readonly stepDurationMs: number;
  readonly initialState?: ProgressionAutomationState;
  readonly evaluateCondition: (
    condition: Condition | undefined,
    context: ConditionContext,
  ) => boolean;
  readonly getGeneratorLevel: (generatorId: string) => number;
  readonly getUpgradePurchases: (upgradeId: string) => number;
}

/**
 * Context for evaluating unlock conditions
 */
export interface ConditionContext {
  readonly getResourceAmount: (resourceId: string) => number;
  readonly getGeneratorLevel: (generatorId: string) => number;
  readonly getUpgradePurchases: (upgradeId: string) => number;
}

/**
 * Creates an automation system that evaluates triggers and enqueues commands
 */
export function createAutomationSystem(
  options: AutomationSystemOptions,
): System {
  const automationStates = new Map<string, AutomationState>();
  const pendingEventTriggers = new Set<string>();

  // Initialize automation states
  for (const automation of options.automations) {
    const existingState = options.initialState?.automations[automation.id];
    automationStates.set(automation.id, existingState ?? {
      id: automation.id,
      enabled: automation.enabledByDefault,
      lastFiredStep: -Infinity,
      cooldownExpiresStep: 0,
      unlocked: false, // Evaluated during first tick
    });
  }

  return {
    id: 'automation',

    setup(context: SystemRegistrationContext): void {
      // Subscribe to event triggers
      for (const automation of options.automations) {
        if (automation.trigger.kind === 'event') {
          // Event IDs from content are ContentIds (branded strings) but events.on expects
          // RuntimeEventType. We cast through unknown to bridge this type gap safely.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          context.events.on(automation.trigger.eventId as any, () => {
            pendingEventTriggers.add(automation.id);
          });
        }
      }

      // Subscribe to automation toggle commands
      context.events.on('automation:toggled', (event) => {
        const state = automationStates.get(event.payload.automationId);
        if (state) {
          state.enabled = event.payload.enabled;
        }
      });
    },

    tick(context: TickContext): void {
      const conditionContext: ConditionContext = {
        getResourceAmount: (resourceId: string) => {
          const index = options.resourceState.requireIndex(resourceId);
          return options.resourceState.getAmount(index);
        },
        getGeneratorLevel: options.getGeneratorLevel,
        getUpgradePurchases: options.getUpgradePurchases,
      };

      const formulaContext: FormulaEvaluationContext = {
        variables: { level: 0 },
        entities: {
          resource: (id: string) => {
            const index = options.resourceState.getIndex(id);
            if (index === undefined) {
              return undefined;
            }
            return options.resourceState.getAmount(index);
          },
        },
      };

      for (const automation of options.automations) {
        const state = automationStates.get(automation.id);
        if (!state) continue;

        // Update unlock status
        state.unlocked = options.evaluateCondition(
          automation.unlockCondition,
          conditionContext,
        );

        if (!state.unlocked || !state.enabled) {
          continue;
        }

        if (isCooldownActive(state, context.step)) {
          continue;
        }

        // Evaluate trigger
        let triggered = false;
        switch (automation.trigger.kind) {
          case 'interval':
            triggered = evaluateIntervalTrigger(
              automation,
              state,
              context.step,
              options.stepDurationMs,
              formulaContext,
            );
            break;
          case 'resourceThreshold':
            triggered = evaluateResourceThresholdTrigger(
              automation,
              options.resourceState,
              formulaContext,
            );
            break;
          case 'commandQueueEmpty':
            triggered = evaluateCommandQueueEmptyTrigger(
              options.commandQueue,
            );
            break;
          case 'event':
            triggered = evaluateEventTrigger(
              automation,
              pendingEventTriggers,
            );
            break;
        }

        if (!triggered) {
          continue;
        }

        // Check resource cost
        if (!canAffordAutomation(automation, options.resourceState, formulaContext)) {
          continue;
        }

        // Deduct cost and enqueue command
        deductAutomationCost(automation, options.resourceState, formulaContext);
        enqueueAutomationCommand(
          automation,
          options.commandQueue,
          context.step,
          context.events,
        );

        // Update state
        state.lastFiredStep = context.step;
        updateCooldown(automation, state, context.step, options.stepDurationMs);
      }

      // Clear event triggers for next tick
      pendingEventTriggers.clear();
    },
  };
}

/**
 * Evaluates an interval trigger
 */
function evaluateIntervalTrigger(
  automation: AutomationDefinition,
  state: AutomationState,
  currentStep: number,
  stepDurationMs: number,
  context: FormulaEvaluationContext,
): boolean {
  if (automation.trigger.kind !== 'interval') {
    return false;
  }

  if (state.lastFiredStep === -Infinity) {
    return true; // Fire immediately on first tick
  }

  const intervalMs = evaluateNumericFormula(
    automation.trigger.interval,
    context,
  );
  const intervalSteps = Math.ceil(intervalMs / stepDurationMs);
  const stepsSinceLastFired = currentStep - state.lastFiredStep;

  return stepsSinceLastFired >= intervalSteps;
}

/**
 * Evaluates a resource threshold trigger
 */
function evaluateResourceThresholdTrigger(
  automation: AutomationDefinition,
  resourceState: ResourceState,
  context: FormulaEvaluationContext,
): boolean {
  if (automation.trigger.kind !== 'resourceThreshold') {
    return false;
  }

  const { resourceId, comparator, threshold } = automation.trigger;
  const resourceIndex = resourceState.getIndex(resourceId);
  if (resourceIndex === undefined) {
    return false;
  }

  const resourceAmount = resourceState.getAmount(resourceIndex);
  const thresholdValue = evaluateNumericFormula(threshold, context);

  switch (comparator) {
    case 'gte':
      return resourceAmount >= thresholdValue;
    case 'gt':
      return resourceAmount > thresholdValue;
    case 'lte':
      return resourceAmount <= thresholdValue;
    case 'lt':
      return resourceAmount < thresholdValue;
  }
}

/**
 * Evaluates a command queue empty trigger
 */
function evaluateCommandQueueEmptyTrigger(
  commandQueue: CommandQueue,
): boolean {
  return commandQueue.size === 0;
}

/**
 * Evaluates an event trigger
 */
function evaluateEventTrigger(
  automation: AutomationDefinition,
  pendingEventTriggers: Set<string>,
): boolean {
  return pendingEventTriggers.has(automation.id);
}

/**
 * Checks if automation can afford its resource cost
 */
function canAffordAutomation(
  automation: AutomationDefinition,
  resourceState: ResourceState,
  context: FormulaEvaluationContext,
): boolean {
  if (!automation.resourceCost) {
    return true;
  }

  const { resourceId, rate } = automation.resourceCost;
  const cost = evaluateNumericFormula(rate, context);
  const resourceIndex = resourceState.getIndex(resourceId);
  if (resourceIndex === undefined) {
    return false;
  }

  const resourceAmount = resourceState.getAmount(resourceIndex);
  return resourceAmount >= cost;
}

/**
 * Deducts automation resource cost
 */
function deductAutomationCost(
  automation: AutomationDefinition,
  resourceState: ResourceState,
  context: FormulaEvaluationContext,
): void {
  if (!automation.resourceCost) {
    return;
  }

  const { resourceId, rate } = automation.resourceCost;
  const cost = evaluateNumericFormula(rate, context);
  const resourceIndex = resourceState.getIndex(resourceId);
  if (resourceIndex === undefined) {
    return;
  }

  resourceState.spendAmount(resourceIndex, cost, {
    systemId: 'automation',
  });
}

/**
 * Enqueues a command for an automation
 */
function enqueueAutomationCommand(
  automation: AutomationDefinition,
  commandQueue: CommandQueue,
  currentStep: number,
  _events: TickContext['events'],
): void {
  const { targetType, targetId, systemTargetId } = automation;

  let commandType: string;
  let payload: unknown;

  if (targetType === 'generator') {
    commandType = RUNTIME_COMMAND_TYPES.TOGGLE_GENERATOR;
    payload = { generatorId: targetId };
  } else if (targetType === 'upgrade') {
    commandType = RUNTIME_COMMAND_TYPES.PURCHASE_UPGRADE;
    payload = { upgradeId: targetId };
  } else if (targetType === 'system') {
    // System automations require custom handling
    commandType = systemTargetId ?? 'system:unknown';
    payload = {};
  } else {
    return;
  }

  commandQueue.enqueue({
    type: commandType,
    payload,
    priority: CommandPriority.AUTOMATION,
    timestamp: Date.now(),
    step: currentStep + 1, // Execute next step
  });
}

/**
 * Updates cooldown after automation fires
 */
function updateCooldown(
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
 * Checks if cooldown is active
 */
function isCooldownActive(
  state: AutomationState,
  currentStep: number,
): boolean {
  return currentStep < state.cooldownExpiresStep;
}

/**
 * Gets the current automation states (for persistence)
 */
export function getAutomationStates(
  _system: System,
): ProgressionAutomationState | undefined {
  // This is a helper that could be called from the runtime worker
  // to extract state for saving. For now, we'll add this to the
  // system instance itself
  return undefined;
}
