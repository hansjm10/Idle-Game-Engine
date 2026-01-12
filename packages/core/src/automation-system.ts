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
 * Resource thresholds resolve resource IDs to indices via ResourceStateAccessor.
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

import type {
  AutomationDefinition,
  FormulaEvaluationContext,
} from '@idle-engine/content-schema';
import { evaluateNumericFormula } from '@idle-engine/content-schema';
import type { System } from './index.js';
import type { CommandQueue } from './command-queue.js';
import { CommandPriority, RUNTIME_COMMAND_TYPES } from './command.js';
import { evaluateCondition } from './condition-evaluator.js';
import type { ConditionContext } from './condition-evaluator.js';
import type { EventPublisher } from './events/event-bus.js';
import type { RuntimeEventType } from './events/runtime-event.js';
import type { AutomationToggledEventPayload } from './events/runtime-event-catalog.js';
import { mapSystemTargetToCommandType } from './system-automation-target-mapping.js';

const STATIC_AUTOMATION_FORMULA_LEVEL = 0;

const createAutomationFormulaEvaluationContext = (options: {
  readonly currentStep?: number;
  readonly stepDurationMs?: number;
  readonly resourceState?: ResourceStateAccessor;
  readonly conditionContext?: ConditionContext;
}): FormulaEvaluationContext => {
  const currentStep =
    typeof options.currentStep === 'number' && Number.isFinite(options.currentStep)
      ? options.currentStep
      : 0;
  const stepDurationMs =
    typeof options.stepDurationMs === 'number' &&
    Number.isFinite(options.stepDurationMs)
      ? options.stepDurationMs
      : 0;
  const deltaTime = stepDurationMs / 1000;
  const time = currentStep * deltaTime;

  const conditionContext = options.conditionContext;
  const resourceState = options.resourceState;

  const resolveResourceAmount = (resourceId: string): number => {
    if (conditionContext) {
      return conditionContext.getResourceAmount(resourceId);
    }

    if (resourceState?.getResourceIndex) {
      const idx = resourceState.getResourceIndex(resourceId);
      return idx === -1 ? 0 : resourceState.getAmount(idx);
    }

    if (resourceState) {
      return resourceState.getAmount(0);
    }

    return 0;
  };

  return {
    variables: {
      level: STATIC_AUTOMATION_FORMULA_LEVEL,
      time,
      deltaTime,
    },
    entities: {
      resource: resolveResourceAmount,
      generator: (generatorId) =>
        conditionContext?.getGeneratorLevel(generatorId) ?? 0,
      upgrade: (upgradeId) => conditionContext?.getUpgradePurchases(upgradeId) ?? 0,
      automation: () => 0,
      prestigeLayer: () => 0,
    },
  };
};

/**
 * Internal state for a single automation.
 */
export interface AutomationState {
  readonly id: string;
  enabled: boolean;
  lastFiredStep: number;
  cooldownExpiresStep: number;
  unlocked: boolean;
  /**
   * Tracks the threshold state from the previous tick for crossing detection.
   * Updated every tick (even during cooldown) to ensure accurate crossing
   * detection when cooldown expires. Without continuous updates, threshold
   * crossings that occur during cooldown would be missed.
   *
   * - undefined: Never evaluated yet
   * - true: Threshold was satisfied on last tick
   * - false: Threshold was not satisfied on last tick
   */
  lastThresholdSatisfied?: boolean;
}

/**
 * Serialized representation of automation state for save files and persistence.
 *
 * This type differs from AutomationState in that lastFiredStep is `number | null`
 * instead of `number`. During serialization, `-Infinity` values are converted to
 * `null` for JSON compatibility. During restoration, `null` values are converted
 * back to `-Infinity`.
 *
 * @see AutomationState - Runtime automation state type
 * @see restoreState - Method that accepts this type for state restoration
 */
export interface SerializedAutomationState {
  readonly id: string;
  readonly enabled: boolean;
  readonly lastFiredStep: number | null; // null = never fired (-Infinity)
  readonly cooldownExpiresStep: number;
  readonly unlocked: boolean;
  readonly lastThresholdSatisfied?: boolean;
}

const compareStableStrings = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

export function serializeAutomationState(
  state: ReadonlyMap<string, AutomationState>,
): readonly SerializedAutomationState[] {
  if (!state || state.size === 0) {
    return [];
  }

  const values = Array.from(state.values());
  values.sort((left, right) => compareStableStrings(left.id, right.id));

  return values.map((entry) => ({
    id: entry.id,
    enabled: entry.enabled,
    lastFiredStep: Number.isFinite(entry.lastFiredStep)
      ? entry.lastFiredStep
      : null,
    cooldownExpiresStep: entry.cooldownExpiresStep,
    unlocked: entry.unlocked,
    lastThresholdSatisfied: entry.lastThresholdSatisfied,
  }));
}

/**
 * Options for creating an AutomationSystem.
 */
export interface AutomationSystemOptions {
  readonly automations: readonly AutomationDefinition[];
  readonly stepDurationMs: number;
  readonly commandQueue: CommandQueue;
  readonly resourceState: ResourceStateAccessor;
  readonly initialState?: Map<string, AutomationState>;
  /**
   * Optional context for evaluating automation unlock conditions.
   *
   * @remarks
   * When provided, {@link AutomationDefinition.unlockCondition} is evaluated
   * using {@link evaluateCondition} and applied monotonically: once unlocked,
   * an automation stays unlocked even if the condition later becomes false.
   *
   * When omitted, the system only auto-unlocks `{ kind: 'always' }` conditions
   * (or uses {@link isAutomationUnlocked}) for backwards compatibility.
   */
  readonly conditionContext?: ConditionContext;
  /**
   * Optional hook for externally unlocking automations (e.g. via upgrade effects).
   *
   * @remarks
   * Unlock state is persistent: once unlocked, automations stay unlocked even if
   * this callback later returns false.
   */
  readonly isAutomationUnlocked?: (automationId: string) => boolean;
}

type AutomationTriggerEvaluation = Readonly<{
  readonly triggered: boolean;
  readonly thresholdCrossing: boolean;
}>;

function ensureAutomationUnlocked(
  automation: AutomationDefinition,
  state: AutomationState,
  conditionContext: ConditionContext | undefined,
  isAutomationUnlocked: ((automationId: string) => boolean) | undefined,
): void {
  if (state.unlocked) {
    return;
  }

  if (isAutomationUnlocked?.(automation.id)) {
    state.unlocked = true;
    return;
  }

  if (conditionContext) {
    if (evaluateCondition(automation.unlockCondition, conditionContext)) {
      state.unlocked = true;
    }
    return;
  }

  if (automation.unlockCondition.kind === 'always') {
    state.unlocked = true;
  }
}

function updateThresholdStateDuringCooldown(
  automation: AutomationDefinition,
  state: AutomationState,
  resourceState: ResourceStateAccessor,
  formulaContext: FormulaEvaluationContext,
): void {
  if (automation.trigger.kind !== 'resourceThreshold') {
    return;
  }

  const currentlySatisfied = evaluateResourceThresholdTrigger(
    automation,
    resourceState,
    formulaContext,
  );
  if (!currentlySatisfied) {
    state.lastThresholdSatisfied = false;
  }
}

function evaluateAutomationTrigger(
  automation: AutomationDefinition,
  state: AutomationState,
  step: number,
  stepDurationMs: number,
  formulaContext: FormulaEvaluationContext,
  commandQueue: CommandQueue,
  resourceState: ResourceStateAccessor,
  pendingEventTriggers: ReadonlySet<string>,
): AutomationTriggerEvaluation {
  switch (automation.trigger.kind) {
    case 'interval':
      return {
        triggered: evaluateIntervalTrigger(
          automation,
          state,
          step,
          stepDurationMs,
          formulaContext,
        ),
        thresholdCrossing: false,
      };
    case 'resourceThreshold': {
      const currentThresholdSatisfied = evaluateResourceThresholdTrigger(
        automation,
        resourceState,
        formulaContext,
      );
      const previouslySatisfied = state.lastThresholdSatisfied ?? false;

      const thresholdCrossing = currentThresholdSatisfied && !previouslySatisfied;
      if (!thresholdCrossing) {
        state.lastThresholdSatisfied = currentThresholdSatisfied;
      }

      return {
        triggered: thresholdCrossing,
        thresholdCrossing,
      };
    }
    case 'commandQueueEmpty':
      return {
        triggered: evaluateCommandQueueEmptyTrigger(commandQueue),
        thresholdCrossing: false,
      };
    case 'event':
      return {
        triggered: evaluateEventTrigger(automation.id, pendingEventTriggers),
        thresholdCrossing: false,
      };
    default: {
      const exhaustive: never = automation.trigger;
      return exhaustive;
    }
  }
}

function handleAutomationSpendFailure(
  automation: AutomationDefinition,
  state: AutomationState,
  retainedEventTriggers: Set<string>,
  thresholdCrossing: boolean,
): void {
  if (automation.trigger.kind === 'event') {
    retainedEventTriggers.add(automation.id);
  }

  if (automation.trigger.kind === 'resourceThreshold' && thresholdCrossing) {
    state.lastThresholdSatisfied = false;
  }
}

function trySpendAutomationResourceCost(
  automation: AutomationDefinition,
  formulaContext: FormulaEvaluationContext,
  resourceState: ResourceStateAccessor,
): boolean {
  const cost = automation.resourceCost;
  if (!cost) {
    return true;
  }

  const amountRaw = evaluateNumericFormula(cost.rate, formulaContext);
  if (!Number.isFinite(amountRaw)) {
    return false;
  }

  const amount = Math.max(0, amountRaw);
  const idx = resourceState.getResourceIndex?.(cost.resourceId) ?? -1;
  const spender = resourceState.spendAmount;
  if (idx === -1 || typeof spender !== 'function') {
    return false;
  }

  return Boolean(
    spender(idx, amount, { systemId: 'automation', commandId: automation.id }),
  );
}

function processAutomationTick(input: Readonly<{
  automation: AutomationDefinition;
  state: AutomationState | undefined;
  step: number;
  stepDurationMs: number;
  formulaContext: FormulaEvaluationContext;
  retainedEventTriggers: Set<string>;
  pendingEventTriggers: ReadonlySet<string>;
  events: EventPublisher;
  commandQueue: CommandQueue;
  resourceState: ResourceStateAccessor;
  conditionContext: ConditionContext | undefined;
  isAutomationUnlocked: ((automationId: string) => boolean) | undefined;
}>): void {
  const state = input.state;
  if (!state) {
    return;
  }

  ensureAutomationUnlocked(
    input.automation,
    state,
    input.conditionContext,
    input.isAutomationUnlocked,
  );

  if (!state.unlocked || !state.enabled) {
    return;
  }

  if (isCooldownActive(state, input.step)) {
    updateThresholdStateDuringCooldown(
      input.automation,
      state,
      input.resourceState,
      input.formulaContext,
    );
    return;
  }

  const evaluation = evaluateAutomationTrigger(
    input.automation,
    state,
    input.step,
    input.stepDurationMs,
    input.formulaContext,
    input.commandQueue,
    input.resourceState,
    input.pendingEventTriggers,
  );
  if (!evaluation.triggered) {
    return;
  }

  if (
    !trySpendAutomationResourceCost(
      input.automation,
      input.formulaContext,
      input.resourceState,
    )
  ) {
    handleAutomationSpendFailure(
      input.automation,
      state,
      input.retainedEventTriggers,
      evaluation.thresholdCrossing,
    );
    return;
  }

  input.events.publish('automation:fired', {
    automationId: input.automation.id,
    triggerKind: input.automation.trigger.kind,
    step: input.step,
  });

  enqueueAutomationCommand(
    input.automation,
    input.commandQueue,
    input.step,
    input.stepDurationMs,
    input.formulaContext,
  );

  state.lastFiredStep = input.step;
  updateCooldown(
    input.automation,
    state,
    input.step,
    input.stepDurationMs,
    input.formulaContext,
  );

  if (evaluation.thresholdCrossing) {
    state.lastThresholdSatisfied = true;
  }
}

function replacePendingEventTriggers(
  pendingEventTriggers: Set<string>,
  retainedEventTriggers: ReadonlySet<string>,
): void {
  pendingEventTriggers.clear();
  for (const id of retainedEventTriggers) {
    pendingEventTriggers.add(id);
  }
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
 * unlocked. When `conditionContext` is provided, `unlockCondition` is evaluated
 * via {@link evaluateCondition}; otherwise only `{ kind: 'always' }` is
 * auto-unlocked (plus {@link isAutomationUnlocked}).
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
): System & {
  getState: () => ReadonlyMap<string, AutomationState>;
  restoreState: (
    state: readonly SerializedAutomationState[],
    options?: { savedWorkerStep?: number; currentStep?: number },
  ) => void;
} {
  const {
    automations,
    stepDurationMs,
    commandQueue,
    resourceState,
    isAutomationUnlocked,
    conditionContext,
  } = options;
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
      lastThresholdSatisfied: undefined, // NEW: undefined = never evaluated
    });
  }

  return {
    id: 'automation-system',

    getState() {
      return new Map(automationStates);
    },

    restoreState(
      stateArray: readonly SerializedAutomationState[],
      restoreOptions?: { savedWorkerStep?: number; currentStep?: number },
    ) {
      // If no state provided (e.g., legacy save migrated to []), retain defaults
      if (!stateArray || stateArray.length === 0) {
        return;
      }

      // Merge provided entries into existing definitions without clearing
      for (const restored of stateArray) {
        const existing = automationStates.get(restored.id);
        if (!existing) {
          // Ignore unknown automations not present in current definitions
          continue;
        }
        // Normalize fields that may not round-trip through JSON (e.g. -Infinity -> null)
        // SerializedAutomationState.lastFiredStep is number | null, convert null to -Infinity
        const normalizedLastFired =
          restored.lastFiredStep !== null &&
          typeof restored.lastFiredStep === 'number' &&
          Number.isFinite(restored.lastFiredStep)
            ? restored.lastFiredStep
            : -Infinity;

        // Compute optional step rebase if provided by caller.
        // When restoring from a snapshot captured at a non-zero worker step,
        // lastFiredStep and cooldownExpiresStep are absolute to that timeline.
        // Rebase them into the caller's current timeline so cooldown math
        // remains consistent.
        const savedWorkerStep = restoreOptions?.savedWorkerStep;
        const targetCurrentStep = restoreOptions?.currentStep ?? 0;
        const hasValidSavedStep =
          typeof savedWorkerStep === 'number' && Number.isFinite(savedWorkerStep);

        const rebaseDelta = hasValidSavedStep
          ? targetCurrentStep - (savedWorkerStep)
          : 0;

        const rebasedLastFired =
          normalizedLastFired === -Infinity
            ? -Infinity
            : normalizedLastFired + rebaseDelta;

        const originalCooldownExpires = restored.cooldownExpiresStep;
        const rebasedCooldownExpires = hasValidSavedStep
          ? originalCooldownExpires + rebaseDelta
          : originalCooldownExpires;

        // Shallow-merge to preserve any fields not present in older saves,
        // and override with normalized/rebased values where needed.
        automationStates.set(restored.id, {
          ...existing,
          ...restored,
          lastFiredStep: rebasedLastFired,
          cooldownExpiresStep: rebasedCooldownExpires,
        });
      }
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

    tick({ step, events }) {
      const formulaContext = createAutomationFormulaEvaluationContext({
        currentStep: step,
        stepDurationMs,
        resourceState,
        conditionContext,
      });

      // Collect event triggers to retain across ticks on failed spend
      const retainedEventTriggers = new Set<string>();

      // Evaluate each automation
      for (const automation of automations) {
        processAutomationTick({
          automation,
          state: automationStates.get(automation.id),
          step,
          stepDurationMs,
          formulaContext,
          retainedEventTriggers,
          pendingEventTriggers,
          events,
          commandQueue,
          resourceState,
          conditionContext,
          isAutomationUnlocked,
        });
      }

      replacePendingEventTriggers(pendingEventTriggers, retainedEventTriggers);
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
 * Cooldowns are evaluated from numeric formulas using the current formula context.
 * If no cooldown is defined, sets cooldownExpiresStep to 0 (no cooldown).
 *
 * @param automation - The automation definition containing the cooldown duration.
 * @param state - The automation state to update.
 * @param currentStep - The current step when the automation fired.
 * @param stepDurationMs - The duration of each step in milliseconds.
 * @param formulaContext - Optional formula evaluation context for cooldown formulas.
 *
 * @example
 * ```typescript
 * const automation = { ..., cooldown: { kind: 'constant', value: 500 } }; // 500ms cooldown
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
  formulaContext?: FormulaEvaluationContext,
): void {
  if (!automation.cooldown) {
    state.cooldownExpiresStep = 0;
    return;
  }

  const cooldownMs = evaluateNumericFormula(
    automation.cooldown,
    formulaContext ??
      createAutomationFormulaEvaluationContext({ currentStep, stepDurationMs }),
  );
  if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) {
    state.cooldownExpiresStep = 0;
    return;
  }

  const cooldownSteps = Math.ceil(cooldownMs / stepDurationMs);
  state.cooldownExpiresStep = currentStep + cooldownSteps + 1;
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
  formulaContext?: FormulaEvaluationContext,
): boolean {
  if (automation.trigger.kind !== 'interval') {
    throw new Error('Expected interval trigger');
  }

  // Fire immediately on first tick
  if (state.lastFiredStep === -Infinity) {
    return true;
  }

  // Calculate interval in steps
  const intervalMs = evaluateNumericFormula(
    automation.trigger.interval,
    formulaContext ??
      createAutomationFormulaEvaluationContext({
        currentStep,
        stepDurationMs,
      }),
  );
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
 * The full ResourceState is defined in `packages/core/src/resource-state.ts`.
 */
export interface ResourceStateAccessor {
  getAmount(resourceIndex: number): number;
  getResourceIndex?(resourceId: string): number;
  spendAmount?(
    resourceIndex: number,
    amount: number,
    context?: { systemId?: string; commandId?: string },
  ): boolean;
  addAmount?(resourceIndex: number, amount: number): number;
}

// Backwards-compat alias (deprecated): use ResourceStateAccessor instead.
export type ResourceStateReader = ResourceStateAccessor;

/**
 * Evaluates whether a resourceThreshold condition is currently satisfied.
 *
 * This function checks if a resource amount meets a defined threshold
 * using one of four comparison operators: gte (>=), gt (>), lte (<=), or lt (<).
 * The threshold value is evaluated from a numeric formula.
 *
 * IMPORTANT: This function returns the CURRENT state of the condition.
 * To detect threshold crossings (transitions), the caller must track the
 * previous state and compare. See AutomationState.lastThresholdSatisfied.
 *
 * COOLDOWN INTERACTION: This function is called during cooldown checks to
 * update AutomationState.lastThresholdSatisfied. This ensures crossing
 * detection remains accurate when the cooldown expires, even if the resource
 * crossed the threshold multiple times during the cooldown period.
 *
 * Resource IDs are resolved to indices via ResourceStateReader.getResourceIndex.
 * If the resource doesn't exist (getResourceIndex returns -1), the amount is
 * treated as 0 and the comparator is evaluated normally. This allows automations
 * to fire based on missing resources (e.g., "gems < 50" fires when gems is locked).
 *
 * If getResourceIndex is not provided, falls back to index 0 for legacy compatibility.
 *
 * @param automation - The automation definition with a resourceThreshold trigger.
 * @param resourceState - The resource state reader for accessing resource amounts.
 * @returns True if the resource amount currently meets the threshold condition, false otherwise.
 * @throws {Error} If the automation trigger is not of kind 'resourceThreshold'.
 *
 * @example
 * ```typescript
 * // Check if condition is currently met
 * const currentlySatisfied = evaluateResourceThresholdTrigger(automation, resourceState);
 * const previouslySatisfied = state.lastThresholdSatisfied ?? false;
 *
 * // Detect crossing (transition from false to true)
 * const crossed = currentlySatisfied && !previouslySatisfied;
 * ```
 */
export function evaluateResourceThresholdTrigger(
  automation: AutomationDefinition,
  resourceState: ResourceStateAccessor,
  formulaContext?: FormulaEvaluationContext,
): boolean {
  if (automation.trigger.kind !== 'resourceThreshold') {
    throw new Error('Expected resourceThreshold trigger');
  }

  const { resourceId, comparator, threshold } = automation.trigger;

  const amount = resourceState.getResourceIndex
    ? (() => {
        const idx = resourceState.getResourceIndex?.(resourceId) ?? -1;
        return idx === -1 ? 0 : resourceState.getAmount(idx);
      })()
    : resourceState.getAmount(0);

  // Evaluate threshold formula
  const thresholdValue = evaluateNumericFormula(
    threshold,
    formulaContext ??
      createAutomationFormulaEvaluationContext({
        resourceState,
      }),
  );

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
 * enqueues it to the command queue at AUTOMATION priority. Supports
 * target types:
 * - generator: Enqueues TOGGLE_GENERATOR command with enabled derived from targetEnabled (default: true)
 * - upgrade: Enqueues PURCHASE_UPGRADE command (one purchase)
 * - purchaseGenerator: Enqueues PURCHASE_GENERATOR command (default count: 1)
 * - collectResource: Enqueues COLLECT_RESOURCE command (default amount: 1)
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
  formulaContext?: FormulaEvaluationContext,
): void {
  const { targetType, targetId, systemTargetId } = automation;

  const evaluationContext =
    formulaContext ??
    createAutomationFormulaEvaluationContext({
      currentStep,
      stepDurationMs,
    });

  let commandType: string;
  let payload: unknown;

  if (targetType === 'generator') {
    commandType = RUNTIME_COMMAND_TYPES.TOGGLE_GENERATOR;
    payload = {
      generatorId: targetId,
      enabled: automation.targetEnabled ?? true,
    };
  } else if (targetType === 'upgrade') {
    commandType = RUNTIME_COMMAND_TYPES.PURCHASE_UPGRADE;
    payload = { upgradeId: targetId };
  } else if (targetType === 'purchaseGenerator') {
    commandType = RUNTIME_COMMAND_TYPES.PURCHASE_GENERATOR;
    const rawCount = automation.targetCount
      ? evaluateNumericFormula(automation.targetCount, evaluationContext)
      : 1;
    const count = Number.isFinite(rawCount)
      ? Math.max(1, Math.floor(rawCount))
      : 1;
    payload = { generatorId: targetId, count };
  } else if (targetType === 'collectResource') {
    commandType = RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE;
    const rawAmount = automation.targetAmount
      ? evaluateNumericFormula(automation.targetAmount, evaluationContext)
      : 1;
    const amount =
      Number.isFinite(rawAmount) && rawAmount > 0 ? rawAmount : 0;
    payload = { resourceId: targetId, amount };
  } else if (targetType === 'system') {
    commandType = mapSystemTargetToCommandType(
      systemTargetId ?? 'system:unknown',
    );
    payload = {};
  } else {
    const exhaustiveCheck: never = targetType;
    throw new Error(`Unknown target type: ${exhaustiveCheck}`);
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
