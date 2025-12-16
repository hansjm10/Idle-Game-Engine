/**
 * @fileoverview Transform System
 *
 * The TransformSystem executes content-authored transforms deterministically.
 * It supports 3 trigger types:
 * - manual: Executed only via RUN_TRANSFORM command
 * - condition: Evaluated each tick; fires when true and not in cooldown
 * - event: Fires when a subscribed event is received
 *
 * The system manages transform state (unlock/visibility, cooldowns, run counts)
 * and integrates with the IdleEngineRuntime tick loop.
 *
 * Execution is atomic: all inputs must be affordable before any are spent,
 * and outputs are applied immediately for instant mode.
 *
 * @example
 * ```typescript
 * const system = createTransformSystem({
 *   transforms: contentPack.transforms,
 *   stepDurationMs: 100,
 *   resourceState: progressionCoordinator.resourceState,
 *   conditionContext: progressionCoordinator.createConditionContext(),
 * });
 *
 * runtime.addSystem(system);
 * ```
 */

import type {
  TransformDefinition,
  FormulaEvaluationContext,
} from '@idle-engine/content-schema';
import { evaluateNumericFormula } from '@idle-engine/content-schema';
import type { System } from './index.js';
import { evaluateCondition } from './condition-evaluator.js';
import type { ConditionContext } from './condition-evaluator.js';
import type { RuntimeEventType } from './events/runtime-event.js';
import type { ResourceStateAccessor } from './automation-system.js';
import { telemetry } from './telemetry.js';

/**
 * Extended ResourceStateAccessor for transforms that supports adding amounts.
 * Transforms need to both spend inputs and produce outputs.
 */
export interface TransformResourceState extends ResourceStateAccessor {
  addAmount?(index: number, amount: number): number;
}

/**
 * Default maximum runs per tick when not specified in content.
 * Matches design doc Section 13.4.
 */
const DEFAULT_MAX_RUNS_PER_TICK = 10;

/**
 * Hard cap for maxRunsPerTick to prevent runaway loops.
 * Matches MAX_CONDITION_DEPTH pattern (packages/core/src/condition-evaluator.ts:34).
 */
const HARD_CAP_MAX_RUNS_PER_TICK = 100;

/**
 * Level value used for evaluating transform formulas.
 * Consistent with automation system pattern.
 */
const STATIC_TRANSFORM_FORMULA_LEVEL = 0;

/**
 * Internal state for a single transform.
 */
export interface TransformState {
  readonly id: string;
  unlocked: boolean;
  cooldownExpiresStep: number;
  runsThisTick: number;
}

/**
 * Serialized representation of transform state for save files and persistence.
 *
 * @see TransformState - Runtime transform state type
 * @see restoreState - Method that accepts this type for state restoration
 */
export interface SerializedTransformState {
  readonly id: string;
  readonly unlocked: boolean;
  readonly cooldownExpiresStep: number;
}

/**
 * Options for creating a TransformSystem.
 */
export interface TransformSystemOptions {
  readonly transforms: readonly TransformDefinition[];
  readonly stepDurationMs: number;
  readonly resourceState: TransformResourceState;
  readonly conditionContext?: ConditionContext;
}

/**
 * Result of attempting to execute a transform.
 */
export interface TransformExecutionResult {
  readonly success: boolean;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly details?: Record<string, unknown>;
  };
}

/**
 * Creates a formula evaluation context for transform formulas.
 */
const createTransformFormulaEvaluationContext = (options: {
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
      level: STATIC_TRANSFORM_FORMULA_LEVEL,
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
 * Gets the effective maxRunsPerTick for a transform.
 * Applies default and hard cap per design doc Section 13.4.
 */
function getEffectiveMaxRunsPerTick(transform: TransformDefinition): number {
  const authored = transform.safety?.maxRunsPerTick;

  if (authored === undefined || !Number.isFinite(authored) || authored <= 0) {
    return DEFAULT_MAX_RUNS_PER_TICK;
  }

  if (authored > HARD_CAP_MAX_RUNS_PER_TICK) {
    telemetry.recordWarning('TransformMaxRunsPerTickClamped', {
      transformId: transform.id,
      authored,
      clamped: HARD_CAP_MAX_RUNS_PER_TICK,
    });
    return HARD_CAP_MAX_RUNS_PER_TICK;
  }

  return authored;
}

/**
 * Checks if a transform is currently in cooldown.
 */
export function isTransformCooldownActive(
  state: TransformState,
  currentStep: number,
): boolean {
  return currentStep < state.cooldownExpiresStep;
}

/**
 * Updates the cooldown expiration step after a transform executes.
 */
function updateTransformCooldown(
  transform: TransformDefinition,
  state: TransformState,
  currentStep: number,
  stepDurationMs: number,
  formulaContext: FormulaEvaluationContext,
): void {
  if (!transform.cooldown) {
    state.cooldownExpiresStep = 0;
    return;
  }

  const cooldownMs = evaluateNumericFormula(transform.cooldown, formulaContext);

  if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) {
    state.cooldownExpiresStep = 0;
    return;
  }

  const cooldownSteps = Math.ceil(cooldownMs / stepDurationMs);
  state.cooldownExpiresStep = currentStep + cooldownSteps + 1;
}

/**
 * Evaluates and validates input costs for a transform.
 * Returns null if any input is invalid (non-finite, negative).
 */
function evaluateInputCosts(
  transform: TransformDefinition,
  formulaContext: FormulaEvaluationContext,
): Map<string, number> | null {
  const costs = new Map<string, number>();

  for (const input of transform.inputs) {
    const amountRaw = evaluateNumericFormula(input.amount, formulaContext);

    if (!Number.isFinite(amountRaw)) {
      telemetry.recordWarning('TransformInputNonFinite', {
        transformId: transform.id,
        resourceId: input.resourceId,
        value: amountRaw,
      });
      return null;
    }

    // Clamp negative to 0 per design doc
    const amount = Math.max(0, amountRaw);
    const existing = costs.get(input.resourceId) ?? 0;
    costs.set(input.resourceId, existing + amount);
  }

  return costs;
}

/**
 * Evaluates and validates output amounts for a transform.
 * Returns null if any output is invalid (non-finite).
 */
function evaluateOutputAmounts(
  transform: TransformDefinition,
  formulaContext: FormulaEvaluationContext,
): Map<string, number> | null {
  const outputs = new Map<string, number>();

  for (const output of transform.outputs) {
    const amountRaw = evaluateNumericFormula(output.amount, formulaContext);

    if (!Number.isFinite(amountRaw)) {
      telemetry.recordWarning('TransformOutputNonFinite', {
        transformId: transform.id,
        resourceId: output.resourceId,
        value: amountRaw,
      });
      return null;
    }

    // Clamp negative to 0 per design doc
    const amount = Math.max(0, amountRaw);
    const existing = outputs.get(output.resourceId) ?? 0;
    outputs.set(output.resourceId, existing + amount);
  }

  return outputs;
}

/**
 * Checks if all input costs are affordable.
 */
function canAffordInputs(
  costs: Map<string, number>,
  resourceState: TransformResourceState,
): boolean {
  for (const [resourceId, amount] of costs) {
    if (amount === 0) continue;

    const idx = resourceState.getResourceIndex?.(resourceId) ?? -1;
    if (idx === -1) {
      return false;
    }

    const available = resourceState.getAmount(idx);
    if (available < amount) {
      return false;
    }
  }

  return true;
}

/**
 * Atomically spends all input costs.
 * Assumes canAffordInputs has already returned true.
 */
function spendInputs(
  costs: Map<string, number>,
  resourceState: TransformResourceState,
  transformId: string,
): boolean {
  // Sort by resourceId for deterministic order
  const sortedCosts = [...costs.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  );

  for (const [resourceId, amount] of sortedCosts) {
    if (amount === 0) continue;

    const idx = resourceState.getResourceIndex?.(resourceId) ?? -1;
    if (idx === -1) {
      return false;
    }

    const success = resourceState.spendAmount?.(idx, amount, {
      systemId: 'transform',
      commandId: transformId,
    });

    if (!success) {
      return false;
    }
  }

  return true;
}

/**
 * Applies all output amounts using addAmount pattern.
 */
function applyOutputs(
  outputs: Map<string, number>,
  resourceState: TransformResourceState,
): void {
  // Sort by resourceId for deterministic order
  const sortedOutputs = [...outputs.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  );

  for (const [resourceId, amount] of sortedOutputs) {
    if (amount === 0) continue;

    const idx = resourceState.getResourceIndex?.(resourceId) ?? -1;
    if (idx === -1) {
      telemetry.recordWarning('TransformOutputResourceNotFound', {
        resourceId,
      });
      continue;
    }

    // Use addAmount if available
    if (typeof resourceState.addAmount === 'function') {
      resourceState.addAmount(idx, amount);
    }
  }
}

/**
 * Creates a TransformSystem that evaluates triggers and executes transforms.
 *
 * The system initializes transform states from the provided definitions,
 * subscribes to relevant events during setup(), and evaluates triggers
 * during each tick() call.
 *
 * Unlock state is persistent: once a transform is unlocked (either via
 * initialState or unlock condition evaluation), it remains unlocked.
 *
 * @param options - Configuration options including transforms, step duration,
 *                  resource state, and optional condition context.
 * @returns A System object with additional getState()/restoreState()/executeTransform() methods.
 */
export function createTransformSystem(
  options: TransformSystemOptions,
): System & {
  getState: () => ReadonlyMap<string, TransformState>;
  restoreState: (
    state: readonly SerializedTransformState[],
    options?: { savedWorkerStep?: number; currentStep?: number },
  ) => void;
  executeTransform: (
    transformId: string,
    step: number,
    options?: { runs?: number },
  ) => TransformExecutionResult;
  getTransformDefinition: (transformId: string) => TransformDefinition | undefined;
} {
  const {
    transforms,
    stepDurationMs,
    resourceState,
    conditionContext,
  } = options;

  const transformStates = new Map<string, TransformState>();
  const transformById = new Map<string, TransformDefinition>();
  const pendingEventTriggers = new Set<string>();

  // Track which step we last reset counters for (ensures reset happens once per step)
  let lastCounterResetStep = -1;

  // Sort transforms by (order ?? 0, id) for deterministic execution order
  const sortedTransforms = [...transforms].sort((a, b) => {
    const orderA = a.order ?? 0;
    const orderB = b.order ?? 0;
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return a.id.localeCompare(b.id);
  });

  // Initialize transform states
  for (const transform of sortedTransforms) {
    transformById.set(transform.id, transform);
    transformStates.set(transform.id, {
      id: transform.id,
      unlocked: false,
      cooldownExpiresStep: 0,
      runsThisTick: 0,
    });
  }

  /**
   * Ensures runsThisTick counters are reset exactly once per step.
   * Called at the start of both executeTransform() and tick() to handle
   * the case where commands execute before tick() in the runtime loop.
   */
  const ensureCountersResetForStep = (step: number): void => {
    if (step !== lastCounterResetStep) {
      for (const state of transformStates.values()) {
        state.runsThisTick = 0;
      }
      lastCounterResetStep = step;
    }
  };

  /**
   * Attempts to execute a single run of a transform.
   */
  const executeTransformRun = (
    transform: TransformDefinition,
    state: TransformState,
    step: number,
    formulaContext: FormulaEvaluationContext,
  ): TransformExecutionResult => {
    // Only support instant mode for Phase 1
    if (transform.mode !== 'instant') {
      return {
        success: false,
        error: {
          code: 'UNSUPPORTED_MODE',
          message: `Transform mode "${transform.mode}" is not yet supported.`,
          details: { transformId: transform.id, mode: transform.mode },
        },
      };
    }

    // Evaluate input costs
    const costs = evaluateInputCosts(transform, formulaContext);
    if (costs === null) {
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT_FORMULA',
          message: 'Transform input formula evaluated to non-finite value.',
          details: { transformId: transform.id },
        },
      };
    }

    // Check affordability
    if (!canAffordInputs(costs, resourceState)) {
      return {
        success: false,
        error: {
          code: 'INSUFFICIENT_RESOURCES',
          message: 'Cannot afford transform input costs.',
          details: { transformId: transform.id },
        },
      };
    }

    // Evaluate output amounts
    const outputs = evaluateOutputAmounts(transform, formulaContext);
    if (outputs === null) {
      return {
        success: false,
        error: {
          code: 'INVALID_OUTPUT_FORMULA',
          message: 'Transform output formula evaluated to non-finite value.',
          details: { transformId: transform.id },
        },
      };
    }

    // Atomically spend inputs
    const spendSuccess = spendInputs(costs, resourceState, transform.id);
    if (!spendSuccess) {
      return {
        success: false,
        error: {
          code: 'SPEND_FAILED',
          message: 'Failed to spend transform inputs.',
          details: { transformId: transform.id },
        },
      };
    }

    // Apply outputs
    applyOutputs(outputs, resourceState);

    // Update cooldown
    updateTransformCooldown(transform, state, step, stepDurationMs, formulaContext);

    // Increment run counter
    state.runsThisTick += 1;

    return { success: true };
  };

  /**
   * Public method to execute a manual transform.
   * Called by the RUN_TRANSFORM command handler.
   */
  const executeTransform = (
    transformId: string,
    step: number,
    execOptions?: { runs?: number },
  ): TransformExecutionResult => {
    // Ensure counters are reset for this step (handles command-before-tick ordering)
    ensureCountersResetForStep(step);

    const transform = transformById.get(transformId);
    if (!transform) {
      return {
        success: false,
        error: {
          code: 'UNKNOWN_TRANSFORM',
          message: `Transform "${transformId}" not found.`,
          details: { transformId },
        },
      };
    }

    // Verify this is a manual transform
    if (transform.trigger.kind !== 'manual') {
      return {
        success: false,
        error: {
          code: 'INVALID_TRIGGER',
          message: `Transform "${transformId}" is not manually triggered.`,
          details: { transformId, triggerKind: transform.trigger.kind },
        },
      };
    }

    const state = transformStates.get(transformId);
    if (!state) {
      return {
        success: false,
        error: {
          code: 'STATE_NOT_FOUND',
          message: `Transform state for "${transformId}" not found.`,
          details: { transformId },
        },
      };
    }

    // Check unlock state
    if (!state.unlocked) {
      return {
        success: false,
        error: {
          code: 'TRANSFORM_LOCKED',
          message: `Transform "${transformId}" is not unlocked.`,
          details: { transformId },
        },
      };
    }

    // Check cooldown
    if (isTransformCooldownActive(state, step)) {
      return {
        success: false,
        error: {
          code: 'COOLDOWN_ACTIVE',
          message: `Transform "${transformId}" is in cooldown.`,
          details: {
            transformId,
            cooldownExpiresStep: state.cooldownExpiresStep,
            currentStep: step,
          },
        },
      };
    }

    const formulaContext = createTransformFormulaEvaluationContext({
      currentStep: step,
      stepDurationMs,
      resourceState,
      conditionContext,
    });

    // Execute requested number of runs (capped by safety limits)
    const requestedRuns = execOptions?.runs ?? 1;
    const maxRuns = getEffectiveMaxRunsPerTick(transform);
    const remainingBudget = maxRuns - state.runsThisTick;
    const runsToExecute = Math.min(requestedRuns, remainingBudget);

    if (runsToExecute <= 0) {
      return {
        success: false,
        error: {
          code: 'MAX_RUNS_EXCEEDED',
          message: `Transform "${transformId}" has reached max runs per tick.`,
          details: {
            transformId,
            maxRunsPerTick: maxRuns,
            runsThisTick: state.runsThisTick,
          },
        },
      };
    }

    let successfulRuns = 0;
    let lastError: TransformExecutionResult['error'];

    for (let i = 0; i < runsToExecute; i++) {
      // Re-check cooldown for subsequent runs
      if (i > 0 && isTransformCooldownActive(state, step)) {
        break;
      }

      const result = executeTransformRun(transform, state, step, formulaContext);
      if (result.success) {
        successfulRuns++;
      } else {
        lastError = result.error;
        break;
      }
    }

    if (successfulRuns === 0) {
      return {
        success: false,
        error: lastError ?? {
          code: 'EXECUTION_FAILED',
          message: 'Transform execution failed.',
          details: { transformId },
        },
      };
    }

    return { success: true };
  };

  return {
    id: 'transform-system',

    getState() {
      return new Map(transformStates);
    },

    restoreState(
      stateArray: readonly SerializedTransformState[],
      restoreOptions?: { savedWorkerStep?: number; currentStep?: number },
    ) {
      if (!stateArray || stateArray.length === 0) {
        return;
      }

      for (const restored of stateArray) {
        const existing = transformStates.get(restored.id);
        if (!existing) {
          continue;
        }

        // Compute optional step rebase
        const savedWorkerStep = restoreOptions?.savedWorkerStep;
        const targetCurrentStep = restoreOptions?.currentStep ?? 0;
        const hasValidSavedStep =
          typeof savedWorkerStep === 'number' && Number.isFinite(savedWorkerStep);

        const rebaseDelta = hasValidSavedStep
          ? targetCurrentStep - savedWorkerStep
          : 0;

        const rebasedCooldownExpires = hasValidSavedStep
          ? restored.cooldownExpiresStep + rebaseDelta
          : restored.cooldownExpiresStep;

        transformStates.set(restored.id, {
          ...existing,
          unlocked: restored.unlocked,
          cooldownExpiresStep: rebasedCooldownExpires,
          runsThisTick: 0,
        });
      }

      // Force fresh counter reset on next step after restore
      lastCounterResetStep = -1;
    },

    executeTransform,

    getTransformDefinition(transformId: string) {
      return transformById.get(transformId);
    },

    setup({ events }) {
      // Subscribe to event triggers
      for (const transform of sortedTransforms) {
        if (transform.trigger.kind === 'event') {
          events.on(transform.trigger.eventId as RuntimeEventType, () => {
            pendingEventTriggers.add(transform.id);
          });
        }
      }
    },

    tick({ step }) {
      const formulaContext = createTransformFormulaEvaluationContext({
        currentStep: step,
        stepDurationMs,
        resourceState,
        conditionContext,
      });

      // Ensure counters are reset for this step (may already be done by executeTransform)
      ensureCountersResetForStep(step);

      // Collect event triggers to retain across ticks when blocked
      const retainedEventTriggers = new Set<string>();

      // Evaluate each transform in deterministic order
      for (const transform of sortedTransforms) {
        const state = transformStates.get(transform.id);
        if (!state) continue;

        // Update unlock status (monotonic: once unlocked, stays unlocked)
        if (!state.unlocked && conditionContext) {
          if (evaluateCondition(transform.unlockCondition, conditionContext)) {
            state.unlocked = true;
          }
        } else if (!state.unlocked && !transform.unlockCondition) {
          // No unlock condition means always unlocked
          state.unlocked = true;
        }

        // Skip if not unlocked
        if (!state.unlocked) {
          continue;
        }

        // Skip manual transforms (handled by command)
        if (transform.trigger.kind === 'manual') {
          continue;
        }

        // Skip automation triggers (deferred per design doc Section 13.3)
        if (transform.trigger.kind === 'automation') {
          continue;
        }

        // Evaluate trigger
        let triggered = false;

        switch (transform.trigger.kind) {
          case 'condition': {
            if (conditionContext) {
              triggered = evaluateCondition(
                transform.trigger.condition,
                conditionContext,
              );
            }
            break;
          }
          case 'event': {
            triggered = pendingEventTriggers.has(transform.id);
            break;
          }
        }

        if (!triggered) {
          continue;
        }

        // Check cooldown
        if (isTransformCooldownActive(state, step)) {
          // Retain event trigger for next tick
          if (transform.trigger.kind === 'event') {
            retainedEventTriggers.add(transform.id);
          }
          continue;
        }

        // Check safety cap
        const maxRuns = getEffectiveMaxRunsPerTick(transform);
        if (state.runsThisTick >= maxRuns) {
          // Retain event trigger for next tick
          if (transform.trigger.kind === 'event') {
            retainedEventTriggers.add(transform.id);
          }
          continue;
        }

        // Attempt execution
        const result = executeTransformRun(transform, state, step, formulaContext);

        if (!result.success) {
          // Retain event trigger when blocked
          if (transform.trigger.kind === 'event') {
            retainedEventTriggers.add(transform.id);
          }
        }
      }

      // Clear and repopulate pending event triggers with retained items only
      pendingEventTriggers.clear();
      for (const id of retainedEventTriggers) {
        pendingEventTriggers.add(id);
      }
    },
  };
}

/**
 * Gets the current state of all transforms.
 *
 * @param system - The TransformSystem instance from which to extract state.
 * @returns A readonly map of transform IDs to their current state.
 */
export function getTransformState(
  system: ReturnType<typeof createTransformSystem>,
): ReadonlyMap<string, TransformState> {
  return system.getState();
}
