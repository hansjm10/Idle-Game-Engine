/**
 * @fileoverview Transform System
 *
 * The TransformSystem executes content-authored transforms deterministically.
 * It supports 4 trigger types:
 * - manual: Executed only via RUN_TRANSFORM command
 * - condition: Evaluated each tick; fires when true and not in cooldown
 * - event: Fires when a subscribed event is received
 * - automation: Fires when a referenced automation executes
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
 *   resourceState: createResourceStateAdapter(progressionCoordinator.resourceState),
 *   conditionContext: progressionCoordinator.createConditionContext(),
 * });
 *
 * runtime.addSystem(system);
 * ```
 */

import type {
  TransformDefinition,
  FormulaEvaluationContext,
  NumericFormulaModel,
} from '@idle-engine/content-schema';
import { evaluateNumericFormula } from '@idle-engine/content-schema';
import type { System } from './index.js';
import { evaluateCondition } from './condition-evaluator.js';
import type { ConditionContext } from './condition-evaluator.js';
import type { RuntimeEventPayload, RuntimeEventType } from './events/runtime-event.js';
import { PRDRegistry, seededRandom } from './rng.js';
import type { EntitySystem } from './entity-system.js';
import type { ResourceStateAccessor } from './automation-system.js';
import type { EventPublisher } from './events/event-bus.js';
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
 * Default maximum outstanding batches when not specified in content.
 * Matches design doc Section 13.4.
 */
const DEFAULT_MAX_OUTSTANDING_BATCHES = 50;

/**
 * Hard cap for maxOutstandingBatches to prevent queue blowups.
 * Matches design doc Section 13.4.
 */
const HARD_CAP_MAX_OUTSTANDING_BATCHES = 1000;

/**
 * Level value used for evaluating transform formulas.
 * Consistent with automation system pattern.
 */
const STATIC_TRANSFORM_FORMULA_LEVEL = 0;

const compareStableStrings = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

/**
 * Internal state for a single transform.
 */
export interface TransformState {
  readonly id: string;
  unlocked: boolean;
  visible: boolean;
  cooldownExpiresStep: number;
  runsThisTick: number;
  batches?: TransformBatchState[];
}

export interface TransformBatchOutput {
  readonly resourceId: string;
  readonly amount: number;
}

type MissionOutcomeKind = 'success' | 'failure' | 'critical';

type MissionPreparedOutcome = Readonly<{
  readonly outputs: readonly TransformBatchOutput[];
  readonly entityExperience: number;
}>;

type MissionBatchPlan = Readonly<{
  readonly baseRate: number;
  readonly usePRD: boolean;
  readonly criticalChance?: number;
  readonly success: MissionPreparedOutcome;
  readonly failure: MissionPreparedOutcome;
  readonly critical?: MissionPreparedOutcome;
}>;

export interface TransformBatchState {
  readonly completeAtStep: number;
  readonly outputs: readonly TransformBatchOutput[];
  readonly batchId?: string;
  readonly entityInstanceIds?: readonly string[];
  readonly entityExperience?: number;
  readonly mission?: MissionBatchPlan;
}

type TransformBatchQueueEntry = TransformBatchState & {
  readonly sequence: number;
};

export interface SerializedTransformState {
  readonly id: string;
  readonly unlocked: boolean;
  readonly cooldownExpiresStep: number;
  readonly batches?: readonly {
    readonly completeAtStep: number;
    readonly outputs: readonly TransformBatchOutput[];
    readonly batchId?: string;
    readonly entityInstanceIds?: readonly string[];
    readonly entityExperience?: number;
    readonly mission?: SerializedMissionBatchPlan;
  }[];
}

function normalizeNonNegativeInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

type SerializedMissionPreparedOutcome = Readonly<{
  readonly outputs: readonly TransformBatchOutput[];
  readonly entityExperience: number;
}>;

type SerializedMissionBatchPlan = Readonly<{
  readonly baseRate: number;
  readonly usePRD: boolean;
  readonly criticalChance?: number;
  readonly success: SerializedMissionPreparedOutcome;
  readonly failure: SerializedMissionPreparedOutcome;
  readonly critical?: SerializedMissionPreparedOutcome;
}>;

const serializeMissionPreparedOutcome = (
  outcome: MissionPreparedOutcome,
): SerializedMissionPreparedOutcome => ({
  outputs: outcome.outputs.map((output) => ({
    resourceId: output.resourceId,
    amount:
      typeof output.amount === 'number' && Number.isFinite(output.amount)
        ? Math.max(0, output.amount)
        : 0,
  })),
  entityExperience:
    typeof outcome.entityExperience === 'number' &&
    Number.isFinite(outcome.entityExperience)
      ? Math.max(0, outcome.entityExperience)
      : 0,
});

const serializeMissionPlan = (plan: MissionBatchPlan): SerializedMissionBatchPlan => ({
  baseRate: clampProbability(plan.baseRate),
  usePRD: Boolean(plan.usePRD),
  ...(plan.criticalChance === undefined
    ? {}
    : { criticalChance: clampProbability(plan.criticalChance) }),
  success: serializeMissionPreparedOutcome(plan.success),
  failure: serializeMissionPreparedOutcome(plan.failure),
  ...(plan.critical ? { critical: serializeMissionPreparedOutcome(plan.critical) } : {}),
});

export function serializeTransformState(
  state: ReadonlyMap<string, TransformState>,
): readonly SerializedTransformState[] {
  if (!state || state.size === 0) {
    return [];
  }

  const values = Array.from(state.values());
  values.sort((left, right) => compareStableStrings(left.id, right.id));

  return values.map((entry) => {
    const batches = entry.batches ?? [];
    const serializedBatches =
      batches.length > 0
        ? batches.map((batch) => {
            const entityInstanceIds =
              batch.entityInstanceIds && batch.entityInstanceIds.length > 0
                ? batch.entityInstanceIds.filter(
                    (id) => typeof id === 'string' && id.trim().length > 0,
                  )
                : undefined;
            const entityExperience =
              typeof batch.entityExperience === 'number' &&
              Number.isFinite(batch.entityExperience)
                ? Math.max(0, batch.entityExperience)
                : undefined;

            const batchId =
              typeof batch.batchId === 'string' && batch.batchId.trim().length > 0
                ? batch.batchId
                : undefined;

            const mission = batch.mission ? serializeMissionPlan(batch.mission) : undefined;

            return {
              completeAtStep: normalizeNonNegativeInt(batch.completeAtStep),
              outputs: batch.outputs.map((output) => ({
                resourceId: output.resourceId,
                amount:
                  typeof output.amount === 'number' &&
                  Number.isFinite(output.amount)
                    ? Math.max(0, output.amount)
                    : 0,
              })),
              ...(batchId ? { batchId } : {}),
              ...(entityInstanceIds && entityInstanceIds.length > 0
                ? { entityInstanceIds }
                : {}),
              ...(entityExperience === undefined ? {} : { entityExperience }),
              ...(mission ? { mission } : {}),
            };
          })
        : undefined;

    return {
      id: entry.id,
      unlocked: entry.unlocked,
      cooldownExpiresStep: normalizeNonNegativeInt(entry.cooldownExpiresStep),
      ...(serializedBatches ? { batches: serializedBatches } : {}),
    };
  });
}

/**
 * Options for creating a TransformSystem.
 */
export interface TransformSystemOptions {
  readonly transforms: readonly TransformDefinition[];
  readonly stepDurationMs: number;
  readonly resourceState: TransformResourceState;
  readonly conditionContext?: ConditionContext;
  readonly entitySystem?: EntitySystem;
  readonly prdRegistry?: PRDRegistry;
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

export type TransformEndpointView = Readonly<{
  resourceId: string;
  amount: number;
}>;

export type TransformView = Readonly<{
  id: string;
  displayName: string;
  description: string;
  mode: TransformDefinition['mode'];
  unlocked: boolean;
  visible: boolean;
  cooldownRemainingMs: number;
  isOnCooldown: boolean;
  canAfford: boolean;
  inputs: readonly TransformEndpointView[];
  outputs: readonly TransformEndpointView[];
  outstandingBatches?: number;
  nextBatchReadyAtStep?: number;
}>;

export type TransformSnapshot = Readonly<{
  step: number;
  publishedAt: number;
  transforms: readonly TransformView[];
}>;

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
 * Gets the effective maxOutstandingBatches for a transform.
 * Applies default and hard cap per design doc Section 13.4.
 */
function getEffectiveMaxOutstandingBatches(transform: TransformDefinition): number {
  const authored = transform.safety?.maxOutstandingBatches;

  if (authored === undefined || !Number.isFinite(authored) || authored <= 0) {
    return DEFAULT_MAX_OUTSTANDING_BATCHES;
  }

  if (authored > HARD_CAP_MAX_OUTSTANDING_BATCHES) {
    telemetry.recordWarning('TransformMaxOutstandingBatchesClamped', {
      transformId: transform.id,
      authored,
      clamped: HARD_CAP_MAX_OUTSTANDING_BATCHES,
    });
    return HARD_CAP_MAX_OUTSTANDING_BATCHES;
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
 * Evaluates and normalizes batch duration into steps.
 */
function evaluateBatchDurationSteps(
  transform: TransformDefinition,
  stepDurationMs: number,
  formulaContext: FormulaEvaluationContext,
): number | null {
  if (!transform.duration) {
    return null;
  }

  const durationMs = evaluateNumericFormula(transform.duration, formulaContext);
  if (!Number.isFinite(durationMs)) {
    telemetry.recordWarning('TransformDurationNonFinite', {
      transformId: transform.id,
      value: durationMs,
    });
    return null;
  }

  const normalized = Math.max(0, durationMs);
  if (stepDurationMs <= 0 || !Number.isFinite(stepDurationMs)) {
    return 0;
  }

  return Math.ceil(normalized / stepDurationMs);
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

const clampProbability = (value: number): number =>
  Math.min(1, Math.max(0, value));

const normalizeFiniteNumber = (value: number): number =>
  Number.isFinite(value) ? value : 0;

type MissionAssignmentResult =
  | {
      readonly ok: true;
      readonly instanceIds: readonly string[];
      readonly assignments: ReadonlyMap<string, boolean>;
    }
  | {
      readonly ok: false;
      readonly error: TransformExecutionResult['error'];
    };

type MissionAssignmentSuccess = Extract<MissionAssignmentResult, { readonly ok: true }>;

type MissionOutcome = NonNullable<TransformDefinition['outcomes']>['success'];

const selectMissionEntities = (
  transform: TransformDefinition,
  entitySystem: EntitySystem,
  formulaContext: FormulaEvaluationContext,
): MissionAssignmentResult => {
  const requirements = transform.entityRequirements ?? [];
  if (requirements.length === 0) {
    return {
      ok: false,
      error: {
        code: 'MISSING_ENTITY_REQUIREMENTS',
        message: 'Mission transforms must declare entity requirements.',
        details: { transformId: transform.id },
      },
    };
  }

  const usedIds = new Set<string>();
  const assignedIds: string[] = [];
  const returnOnCompleteByInstance = new Map<string, boolean>();

  for (const requirement of requirements) {
    const rawCount = evaluateNumericFormula(requirement.count, formulaContext);
    if (!Number.isFinite(rawCount)) {
      return {
        ok: false,
        error: {
          code: 'INVALID_ENTITY_COUNT',
          message: 'Mission entity requirement count is non-finite.',
          details: { transformId: transform.id, entityId: requirement.entityId },
        },
      };
    }
    const count = Math.max(0, Math.floor(rawCount));
    if (count === 0) {
      continue;
    }

    let candidates = entitySystem
      .getAvailableInstances(requirement.entityId)
      .filter((instance) => !usedIds.has(instance.instanceId));

    if (requirement.minStats) {
      const minStats = Object.entries(requirement.minStats)
        .filter((entry): entry is [string, NumericFormulaModel] =>
          Boolean(entry[1]),
        )
        .map(([statId, formula]) => {
          const value = evaluateNumericFormula(formula, formulaContext);
          if (!Number.isFinite(value)) {
            return null;
          }
          return { statId, value };
        });
      if (minStats.includes(null)) {
        return {
          ok: false,
          error: {
            code: 'INVALID_ENTITY_STAT_REQUIREMENT',
            message: 'Mission stat requirement evaluated to non-finite value.',
            details: { transformId: transform.id },
          },
        };
      }

      candidates = candidates.filter((instance) =>
        (minStats as Array<{ statId: string; value: number }>).every(
          ({ statId, value }) => (instance.stats[statId] ?? 0) >= value,
        ),
      );
    }

    const preferHighStats = requirement.preferHighStats ?? [];
    candidates.sort((left, right) => {
      for (const statId of preferHighStats) {
        const diff = (right.stats[statId] ?? 0) - (left.stats[statId] ?? 0);
        if (diff !== 0) {
          return diff > 0 ? 1 : -1;
        }
      }
      return compareStableStrings(left.instanceId, right.instanceId);
    });

    if (candidates.length < count) {
      return {
        ok: false,
        error: {
          code: 'INSUFFICIENT_ENTITIES',
          message: 'Not enough available entities for mission requirements.',
          details: {
            transformId: transform.id,
            entityId: requirement.entityId,
            required: count,
            available: candidates.length,
          },
        },
      };
    }

    for (const instance of candidates.slice(0, count)) {
      usedIds.add(instance.instanceId);
      assignedIds.push(instance.instanceId);
      returnOnCompleteByInstance.set(
        instance.instanceId,
        requirement.returnOnComplete !== false,
      );
    }
  }

  return {
    ok: true,
    instanceIds: assignedIds,
    assignments: returnOnCompleteByInstance,
  };
};

const evaluateMissionOutcomeOutputs = (
  transform: TransformDefinition,
  outcome: MissionOutcome | undefined,
  formulaContext: FormulaEvaluationContext,
): Map<string, number> | null => {
  if (!outcome) {
    return new Map();
  }

  const outputs = new Map<string, number>();
  for (const output of outcome.outputs) {
    const amountRaw = evaluateNumericFormula(output.amount, formulaContext);
    if (!Number.isFinite(amountRaw)) {
      telemetry.recordWarning('TransformOutputNonFinite', {
        transformId: transform.id,
        resourceId: output.resourceId,
        value: amountRaw,
      });
      return null;
    }
    const amount = Math.max(0, amountRaw);
    const existing = outputs.get(output.resourceId) ?? 0;
    outputs.set(output.resourceId, existing + amount);
  }

  return outputs;
};

const evaluateMissionOutcomeExperience = (
  transform: TransformDefinition,
  outcome: MissionOutcome | undefined,
  formulaContext: FormulaEvaluationContext,
): number | null => {
  if (!outcome?.entityExperience) {
    return 0;
  }
  const value = evaluateNumericFormula(outcome.entityExperience, formulaContext);
  if (!Number.isFinite(value)) {
    telemetry.recordWarning('MissionOutcomeExperienceNonFinite', {
      transformId: transform.id,
      value,
    });
    return null;
  }
  return Math.max(0, value);
};

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

function isZeroInputCost(costs: Map<string, number>): boolean {
  for (const amount of costs.values()) {
    if (amount !== 0) {
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
    compareStableStrings(a[0], b[0]),
  );

  const spent: Array<{ readonly idx: number; readonly amount: number }> = [];

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
      if (typeof resourceState.addAmount === 'function') {
        for (let i = spent.length - 1; i >= 0; i--) {
          const entry = spent[i];
          resourceState.addAmount(entry.idx, entry.amount);
        }
      }
      return false;
    }

    spent.push({ idx, amount });
  }

  return true;
}

type PreparedResourceDelta = {
  readonly resourceId: string;
  readonly resourceIndex: number;
  readonly amount: number;
};

type PreparedOutputsResult =
  | { readonly ok: true; readonly outputs: readonly PreparedResourceDelta[] }
  | { readonly ok: false; readonly error: TransformExecutionResult['error'] };

function prepareOutputs(
  outputs: Map<string, number>,
  resourceState: TransformResourceState,
  transformId: string,
): PreparedOutputsResult {
  const sortedOutputs = [...outputs.entries()].sort((a, b) =>
    compareStableStrings(a[0], b[0]),
  );

  const prepared: PreparedResourceDelta[] = [];
  for (const [resourceId, amount] of sortedOutputs) {
    if (amount === 0) continue;

    if (!resourceState.getResourceIndex) {
      return {
        ok: false,
        error: {
          code: 'RESOURCE_STATE_MISSING_INDEXER',
          message: 'Resource state does not support resource id lookups.',
          details: { transformId },
        },
      };
    }

    const idx = resourceState.getResourceIndex(resourceId);
    if (idx === -1) {
      return {
        ok: false,
        error: {
          code: 'OUTPUT_RESOURCE_NOT_FOUND',
          message: `Output resource "${resourceId}" not found.`,
          details: { transformId, resourceId },
        },
      };
    }

    if (typeof resourceState.addAmount !== 'function') {
      return {
        ok: false,
        error: {
          code: 'RESOURCE_STATE_MISSING_ADD_AMOUNT',
          message: 'Resource state does not support applying transform outputs.',
          details: { transformId },
        },
      };
    }

    prepared.push({ resourceId, resourceIndex: idx, amount });
  }

  return { ok: true, outputs: prepared };
}

/**
 * Applies all output amounts using addAmount pattern.
 */
function applyOutputs(
  outputs: readonly PreparedResourceDelta[],
  resourceState: TransformResourceState,
): void {
  if (outputs.length === 0) {
    return;
  }

  if (typeof resourceState.addAmount !== 'function') {
    telemetry.recordWarning('TransformOutputApplyUnsupported', {});
    return;
  }

  for (const output of outputs) {
    if (output.amount === 0) continue;
    resourceState.addAmount(output.resourceIndex, output.amount);
  }
}

/**
 * Applies batch outputs by resolving resource ids to indices at delivery time.
 */
function applyBatchOutputs(
  outputs: readonly TransformBatchOutput[],
  resourceState: TransformResourceState,
  transformId: string,
): void {
  if (outputs.length === 0) {
    return;
  }

  if (
    typeof resourceState.addAmount !== 'function' ||
    typeof resourceState.getResourceIndex !== 'function'
  ) {
    telemetry.recordWarning('TransformBatchOutputApplyUnsupported', {
      transformId,
    });
    return;
  }

  for (const output of outputs) {
    if (output.amount === 0) continue;
    const idx = resourceState.getResourceIndex(output.resourceId);
    if (idx === -1) {
      telemetry.recordWarning('TransformBatchOutputMissingResource', {
        transformId,
        resourceId: output.resourceId,
      });
      continue;
    }
    resourceState.addAmount(idx, output.amount);
  }
}

function insertBatch(
  batches: TransformBatchQueueEntry[],
  entry: TransformBatchQueueEntry,
): void {
  let low = 0;
  let high = batches.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const other = batches[mid];
    if (
      other.completeAtStep < entry.completeAtStep ||
      (other.completeAtStep === entry.completeAtStep &&
        other.sequence < entry.sequence)
    ) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  batches.splice(low, 0, entry);
}

function grantEntityExperience(
  entityExperience: number,
  entityInstanceIds: readonly string[] | undefined,
  step: number,
  transformId: string,
  entitySystem?: EntitySystem,
): void {
  if (
    entityExperience === undefined ||
    entityExperience <= 0 ||
    entityInstanceIds === undefined ||
    entityInstanceIds.length === 0
  ) {
    return;
  }

  if (entitySystem) {
    for (const instanceId of entityInstanceIds) {
      try {
        entitySystem.addExperience(instanceId, entityExperience, step);
      } catch (error) {
        telemetry.recordWarning('MissionOutcomeExperienceGrantFailed', {
          transformId,
          instanceId,
          step,
          amount: entityExperience,
          error: String(error),
        });
      }
    }
    return;
  }

  telemetry.recordWarning('MissionOutcomeExperienceMissingEntitySystem', {
    transformId,
  });
}

function publishMissionEvent(
  publisher: EventPublisher | undefined,
  type: 'mission:started',
  payload: RuntimeEventPayload<'mission:started'>,
  transformId: string,
): void;
function publishMissionEvent(
  publisher: EventPublisher | undefined,
  type: 'mission:completed',
  payload: RuntimeEventPayload<'mission:completed'>,
  transformId: string,
): void;
function publishMissionEvent(
  publisher: EventPublisher | undefined,
  type: 'mission:started' | 'mission:completed',
  payload: RuntimeEventPayload<'mission:started' | 'mission:completed'>,
  transformId: string,
): void {
  if (!publisher) {
    return;
  }

  try {
    publisher.publish(type, payload);
  } catch (error) {
    telemetry.recordWarning('MissionEventPublishFailed', {
      transformId,
      type,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function deliverDueBatches(
  transform: TransformDefinition,
  batches: TransformBatchQueueEntry[],
  resourceState: TransformResourceState,
  step: number,
  entitySystem?: EntitySystem,
  prdRegistry?: PRDRegistry,
  events?: EventPublisher,
): void {
  if (batches.length === 0) {
    return;
  }

  const transformId = transform.id;
  let writeIndex = 0;
  for (let readIndex = 0; readIndex < batches.length; readIndex += 1) {
    const entry = batches[readIndex];
    if (entry.completeAtStep <= step) {
      if (transform.mode === 'mission' && entry.mission) {
        const mission = entry.mission;
        const baseRate = clampProbability(mission.baseRate);
        const usePRD = mission.usePRD;

        const success = usePRD
          ? (prdRegistry ?? new PRDRegistry(seededRandom))
              .getOrCreate(transformId, baseRate)
              .roll()
          : seededRandom() < baseRate;

        let outcomeKind: MissionOutcomeKind;
        let critical = false;
        let outcome: MissionPreparedOutcome;

        if (
          success &&
          mission.critical !== undefined &&
          mission.criticalChance !== undefined &&
          seededRandom() < clampProbability(mission.criticalChance)
        ) {
          outcomeKind = 'critical';
          critical = true;
          outcome = mission.critical;
        } else if (success) {
          outcomeKind = 'success';
          outcome = mission.success;
        } else {
          outcomeKind = 'failure';
          outcome = mission.failure;
        }

        applyBatchOutputs(outcome.outputs, resourceState, transformId);

        grantEntityExperience(
          outcome.entityExperience,
          entry.entityInstanceIds,
          step,
          transformId,
          entitySystem,
        );

        publishMissionEvent(
          events,
          'mission:completed',
          {
            transformId,
            batchId: entry.batchId ?? `${entry.sequence}`,
            completedAtStep: step,
            outcomeKind,
            success,
            critical,
            outputs: outcome.outputs.map((output) => ({
              resourceId: output.resourceId,
              amount: output.amount,
            })),
            entityExperience: outcome.entityExperience,
            entityInstanceIds: entry.entityInstanceIds ?? [],
          },
          transformId,
        );
      } else {
        applyBatchOutputs(entry.outputs, resourceState, transformId);
        grantEntityExperience(
          entry.entityExperience ?? 0,
          entry.entityInstanceIds,
          step,
          transformId,
          entitySystem,
        );
      }
      continue;
    }

    if (writeIndex !== readIndex) {
      batches[writeIndex] = entry;
    }
    writeIndex += 1;
  }

  if (writeIndex === 0) {
    batches.length = 0;
  } else if (writeIndex < batches.length) {
    batches.length = writeIndex;
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
 * @returns A System object with additional getState()/executeTransform() methods.
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
    options?: { runs?: number; events?: EventPublisher },
  ) => TransformExecutionResult;
  getTransformDefinition: (transformId: string) => TransformDefinition | undefined;
} {
  const {
    transforms,
    stepDurationMs,
    resourceState,
    conditionContext,
    entitySystem,
    prdRegistry: providedPrdRegistry,
  } = options;

  const prdRegistry = providedPrdRegistry ?? new PRDRegistry(seededRandom);

  const transformStates = new Map<string, TransformState>();
  const transformById = new Map<string, TransformDefinition>();
  const pendingEventTriggers = new Set<string>();
  const batchSequences = new Map<string, number>();

  // Track which step we last reset counters for (ensures reset happens once per step)
  let lastCounterResetStep = -1;

  // Sort transforms by (order ?? 0, id) for deterministic execution order
  const sortedTransforms = [...transforms].sort((a, b) => {
    const orderA = a.order ?? 0;
    const orderB = b.order ?? 0;
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return compareStableStrings(a.id, b.id);
  });

  // Initialize transform states
  for (const transform of sortedTransforms) {
    transformById.set(transform.id, transform);
    transformStates.set(transform.id, {
      id: transform.id,
      unlocked: !transform.unlockCondition,
      visible: true,
      cooldownExpiresStep: 0,
      runsThisTick: 0,
      ...(transform.mode === 'batch' || transform.mode === 'mission'
        ? { batches: [] }
        : {}),
    });
    batchSequences.set(transform.id, 0);
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
  const calculateMissionScopedStatValue = (
    entityScope: string | undefined,
    values: readonly number[],
  ): number => {
    if (values.length === 0) {
      return 0;
    }

    const sum = values.reduce((total, value) => total + value, 0);
    switch (entityScope) {
      case 'sum': {
        return sum;
      }
      case 'min': {
        return Math.min(...values);
      }
      case 'max': {
        return Math.max(...values);
      }
      default: {
        return sum / values.length;
      }
    }
  };

    const calculateMissionSuccessRate = (
      transform: TransformDefinition,
      instanceIds: readonly string[],
      formulaContext: FormulaEvaluationContext,
      missionEntitySystem: EntitySystem,
    ): { ok: true; baseRate: number } | { ok: false; result: TransformExecutionResult } => {
    const successRate = transform.successRate;
    let baseRate = 1;

    if (successRate?.baseRate) {
      const raw = evaluateNumericFormula(successRate.baseRate, formulaContext);
      if (!Number.isFinite(raw)) {
        return {
          ok: false,
          result: {
            success: false,
            error: {
              code: 'INVALID_SUCCESS_RATE',
              message: 'Mission success rate evaluated to non-finite value.',
              details: { transformId: transform.id },
            },
          },
        };
      }
      baseRate = clampProbability(raw);
    }

    if (successRate?.statModifiers) {
      for (const modifier of successRate.statModifiers) {
        const weightRaw = evaluateNumericFormula(modifier.weight, formulaContext);
        if (!Number.isFinite(weightRaw)) {
          return {
            ok: false,
            result: {
              success: false,
              error: {
                code: 'INVALID_SUCCESS_RATE',
                message: 'Mission success rate modifier evaluated to non-finite value.',
                details: { transformId: transform.id, statId: modifier.stat },
              },
            },
          };
        }

        const values = instanceIds.map((id) => {
          const instance = missionEntitySystem.getInstanceState(id);
          return instance?.stats[modifier.stat] ?? 0;
        });

        const statValue = calculateMissionScopedStatValue(
          modifier.entityScope,
          values,
        );
        baseRate += normalizeFiniteNumber(weightRaw) * statValue;
      }
      baseRate = clampProbability(baseRate);
    }

      return { ok: true, baseRate };
    };

	  const prepareMissionInputs = (
	    transform: TransformDefinition,
	    formulaContext: FormulaEvaluationContext,
	    missionEntitySystem: EntitySystem,
	  ):
      | {
          readonly ok: true;
          readonly durationSteps: number;
          readonly assignmentResult: MissionAssignmentSuccess;
          readonly costs: Map<string, number>;
        }
      | { readonly ok: false; readonly result: TransformExecutionResult } => {
      const durationSteps = evaluateBatchDurationSteps(
        transform,
        stepDurationMs,
        formulaContext,
      );
      if (durationSteps === null) {
        return {
          ok: false,
          result: {
            success: false,
            error: {
              code: 'INVALID_DURATION_FORMULA',
              message: 'Transform duration formula evaluated to non-finite value.',
              details: { transformId: transform.id },
            },
          },
        };
      }

      const assignmentResult = selectMissionEntities(
        transform,
        missionEntitySystem,
        formulaContext,
      );
      if (!assignmentResult.ok) {
        return {
          ok: false,
          result: { success: false, error: assignmentResult.error },
        };
      }

      const costs = evaluateInputCosts(transform, formulaContext);
      if (costs === null) {
        return {
          ok: false,
          result: {
            success: false,
            error: {
              code: 'INVALID_INPUT_FORMULA',
              message: 'Transform input formula evaluated to non-finite value.',
              details: { transformId: transform.id },
            },
          },
        };
      }

      if (!canAffordInputs(costs, resourceState)) {
        return {
          ok: false,
          result: {
            success: false,
            error: {
              code: 'INSUFFICIENT_RESOURCES',
              message: 'Cannot afford transform input costs.',
              details: { transformId: transform.id },
            },
          },
        };
      }

      return {
        ok: true,
        durationSteps,
        assignmentResult,
        costs,
      };
    };

    const prepareMissionPlan = (
      transform: TransformDefinition,
      assignmentResult: MissionAssignmentSuccess,
      formulaContext: FormulaEvaluationContext,
      missionEntitySystem: EntitySystem,
    ):
      | {
          readonly ok: true;
          readonly plan: MissionBatchPlan;
        }
      | { readonly ok: false; readonly result: TransformExecutionResult } => {
      const successRate = calculateMissionSuccessRate(
        transform,
        assignmentResult.instanceIds,
        formulaContext,
        missionEntitySystem,
      );
      if (!successRate.ok) {
        return { ok: false, result: successRate.result };
      }

      const baseRate = successRate.baseRate;
      const usePRD = Boolean(transform.successRate?.usePRD);
      if (usePRD) {
        prdRegistry.getOrCreate(transform.id, baseRate);
      }

      const missionOutcomes = transform.outcomes;

      const prepareOutcome = (
        outcome: MissionOutcome | undefined,
      ):
        | { readonly ok: true; readonly prepared: MissionPreparedOutcome }
        | { readonly ok: false; readonly result: TransformExecutionResult } => {
        const outputs = evaluateMissionOutcomeOutputs(transform, outcome, formulaContext);
        if (outputs === null) {
          return {
            ok: false,
            result: {
              success: false,
              error: {
                code: 'INVALID_OUTPUT_FORMULA',
                message: 'Transform output formula evaluated to non-finite value.',
                details: { transformId: transform.id },
              },
            },
          };
        }

        const experience = evaluateMissionOutcomeExperience(
          transform,
          outcome,
          formulaContext,
        );
        if (experience === null) {
          return {
            ok: false,
            result: {
              success: false,
              error: {
                code: 'INVALID_OUTPUT_FORMULA',
                message: 'Mission experience formula evaluated to non-finite value.',
                details: { transformId: transform.id },
              },
            },
          };
        }

        const preparedOutputs = prepareOutputs(outputs, resourceState, transform.id);
        if (!preparedOutputs.ok) {
          return {
            ok: false,
            result: { success: false, error: preparedOutputs.error },
          };
        }

        return {
          ok: true,
          prepared: {
            outputs: preparedOutputs.outputs.map((output) => ({
              resourceId: output.resourceId,
              amount: output.amount,
            })),
            entityExperience: experience,
          },
        };
      };

      const successOutcome = prepareOutcome(missionOutcomes?.success);
      if (!successOutcome.ok) {
        return { ok: false, result: successOutcome.result };
      }

      // Missing failure outcome means no rewards on failure.
      const failureOutcome = missionOutcomes?.failure
        ? prepareOutcome(missionOutcomes?.failure)
        : ({ ok: true, prepared: { outputs: [], entityExperience: 0 } } as const);
      if (!failureOutcome.ok) {
        return { ok: false, result: failureOutcome.result };
      }

      let criticalChance: number | undefined;
      let criticalOutcome: MissionPreparedOutcome | undefined;

      if (missionOutcomes?.critical) {
        const chanceRaw = evaluateNumericFormula(
          missionOutcomes.critical.chance,
          formulaContext,
        );
        if (!Number.isFinite(chanceRaw)) {
          return {
            ok: false,
            result: {
              success: false,
              error: {
                code: 'INVALID_SUCCESS_RATE',
                message: 'Mission critical chance evaluated to non-finite value.',
                details: { transformId: transform.id },
              },
            },
          };
        }
        criticalChance = clampProbability(chanceRaw);

        const criticalPrepared = prepareOutcome(missionOutcomes.critical);
        if (!criticalPrepared.ok) {
          return { ok: false, result: criticalPrepared.result };
        }
        criticalOutcome = criticalPrepared.prepared;
      }

      return {
        ok: true,
        plan: {
          baseRate,
          usePRD,
          ...(criticalChance === undefined ? {} : { criticalChance }),
          success: successOutcome.prepared,
          failure: failureOutcome.prepared,
          ...(criticalOutcome ? { critical: criticalOutcome } : {}),
        },
      };
    };

    const executeMissionTransformRun = (
      transform: TransformDefinition,
      state: TransformState,
      step: number,
      formulaContext: FormulaEvaluationContext,
      missionEntitySystem: EntitySystem,
      events?: EventPublisher,
    ): TransformExecutionResult => {
	    const inputsResult = prepareMissionInputs(
	      transform,
	      formulaContext,
	      missionEntitySystem,
	    );
      if (!inputsResult.ok) {
        return inputsResult.result;
      }

      const planResult = prepareMissionPlan(
        transform,
        inputsResult.assignmentResult,
        formulaContext,
        missionEntitySystem,
      );
      if (!planResult.ok) {
        return planResult.result;
      }

      state.batches ??= [];
      const batchQueue = state.batches as TransformBatchQueueEntry[];
      const maxOutstanding = getEffectiveMaxOutstandingBatches(transform);
      if (batchQueue.length >= maxOutstanding) {
        return {
          success: false,
          error: {
            code: 'MAX_OUTSTANDING_BATCHES',
            message: 'Transform has reached the outstanding batch cap.',
            details: {
              transformId: transform.id,
              maxOutstandingBatches: maxOutstanding,
              outstandingBatches: batchQueue.length,
            },
          },
        };
      }

      const spendSuccess = spendInputs(
        inputsResult.costs,
        resourceState,
        transform.id,
      );
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

      const completeAtStep = step + inputsResult.durationSteps;
      const sequence = batchSequences.get(transform.id) ?? 0;
      batchSequences.set(transform.id, sequence + 1);
      const batchId = `${sequence}`;

      for (const instanceId of inputsResult.assignmentResult.instanceIds) {
        const returnOnComplete =
          inputsResult.assignmentResult.assignments.get(instanceId) ?? true;
        const returnStep = returnOnComplete
          ? completeAtStep
          : Number.MAX_SAFE_INTEGER;
        missionEntitySystem.assignToMission(instanceId, {
          missionId: transform.id,
          batchId,
          deployedAtStep: step,
          returnStep,
        });
      }

      const batchEntry: TransformBatchQueueEntry = {
        completeAtStep,
        sequence,
        batchId,
        outputs: [],
        ...(inputsResult.assignmentResult.instanceIds.length > 0
          ? { entityInstanceIds: inputsResult.assignmentResult.instanceIds }
          : {}),
        mission: planResult.plan,
      };

      insertBatch(batchQueue, batchEntry);

      publishMissionEvent(
        events,
        'mission:started',
        {
          transformId: transform.id,
          batchId,
          startedAtStep: step,
          completeAtStep,
          entityInstanceIds: inputsResult.assignmentResult.instanceIds,
        },
        transform.id,
      );

      updateTransformCooldown(transform, state, step, stepDurationMs, formulaContext);
      state.runsThisTick += 1;
      return { success: true };
    };

  const executeNonMissionTransformRun = (
    transform: TransformDefinition,
    state: TransformState,
    step: number,
    formulaContext: FormulaEvaluationContext,
  ): TransformExecutionResult => {
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

    const preparedOutputs = prepareOutputs(outputs, resourceState, transform.id);
    if (!preparedOutputs.ok) {
      return { success: false, error: preparedOutputs.error };
    }

    if (transform.mode === 'batch') {
      const durationSteps = evaluateBatchDurationSteps(
        transform,
        stepDurationMs,
        formulaContext,
      );
      if (durationSteps === null) {
        return {
          success: false,
          error: {
            code: 'INVALID_DURATION_FORMULA',
            message: 'Transform duration formula evaluated to non-finite value.',
            details: { transformId: transform.id },
          },
        };
      }

      state.batches ??= [];
      const batchQueue = state.batches as TransformBatchQueueEntry[];
      const maxOutstanding = getEffectiveMaxOutstandingBatches(transform);
      if (batchQueue.length >= maxOutstanding) {
        return {
          success: false,
          error: {
            code: 'MAX_OUTSTANDING_BATCHES',
            message: 'Transform has reached the outstanding batch cap.',
            details: {
              transformId: transform.id,
              maxOutstandingBatches: maxOutstanding,
              outstandingBatches: batchQueue.length,
            },
          },
        };
      }

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

      const completeAtStep = step + durationSteps;
      const sequence = batchSequences.get(transform.id) ?? 0;
      batchSequences.set(transform.id, sequence + 1);

      const batchEntry: TransformBatchQueueEntry = {
        completeAtStep,
        sequence,
        outputs: preparedOutputs.outputs.map((output) => ({
          resourceId: output.resourceId,
          amount: output.amount,
        })),
      };

      insertBatch(batchQueue, batchEntry);
      updateTransformCooldown(transform, state, step, stepDurationMs, formulaContext);
      state.runsThisTick += 1;
      return { success: true };
    }

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

    applyOutputs(preparedOutputs.outputs, resourceState);
    updateTransformCooldown(transform, state, step, stepDurationMs, formulaContext);
    state.runsThisTick += 1;
    return { success: true };
  };

  const executeTransformRun = (
    transform: TransformDefinition,
    state: TransformState,
    step: number,
    formulaContext: FormulaEvaluationContext,
    events?: EventPublisher,
  ): TransformExecutionResult => {
    if (transform.mode === 'continuous') {
      return {
        success: false,
        error: {
          code: 'UNSUPPORTED_MODE',
          message: `Transform mode "${transform.mode}" is not yet supported.`,
          details: { transformId: transform.id, mode: transform.mode },
        },
      };
    }

    if (transform.mode === 'mission') {
      if (entitySystem) {
        return executeMissionTransformRun(
          transform,
          state,
          step,
          formulaContext,
          entitySystem,
          events,
        );
      }

      return {
        success: false,
        error: {
          code: 'MISSING_ENTITY_SYSTEM',
          message: 'Mission transforms require an entity system.',
          details: { transformId: transform.id },
        },
      };
    }

    return executeNonMissionTransformRun(transform, state, step, formulaContext);
  };

  /**
   * Public method to execute a manual transform.
   * Called by the RUN_TRANSFORM command handler.
   */
  const executeTransform = (
    transformId: string,
    step: number,
    execOptions?: { runs?: number; events?: EventPublisher },
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

    // Validate runs parameter if provided (defensive; handler also validates)
    if (execOptions?.runs !== undefined) {
      const runs = execOptions.runs;
      if (
        typeof runs !== 'number' ||
        !Number.isFinite(runs) ||
        !Number.isInteger(runs) ||
        runs < 1
      ) {
        return {
          success: false,
          error: {
            code: 'INVALID_RUNS',
            message: 'Runs must be a positive integer.',
            details: { transformId, runs },
          },
        };
      }
    }

    // Update unlock status when executing manually (command phase may precede tick)
    if (!state.unlocked) {
      if (conditionContext) {
        if (evaluateCondition(transform.unlockCondition, conditionContext)) {
          state.unlocked = true;
        }
      } else if (!transform.unlockCondition) {
        state.unlocked = true;
      }
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

      const result = executeTransformRun(
        transform,
        state,
        step,
        formulaContext,
        execOptions?.events,
      );
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

      const savedWorkerStep = restoreOptions?.savedWorkerStep;
      const targetCurrentStep = restoreOptions?.currentStep ?? 0;
      const hasValidSavedStep =
        typeof savedWorkerStep === 'number' && Number.isFinite(savedWorkerStep);

      const rebaseDelta = hasValidSavedStep
        ? targetCurrentStep - savedWorkerStep
        : 0;

      for (const entry of stateArray) {
        if (!entry || typeof entry !== 'object') {
          continue;
        }

        const record = entry as unknown as Record<string, unknown>;
        const id = record.id;
        if (typeof id !== 'string' || id.trim().length === 0) {
          continue;
        }

        const existing = transformStates.get(id);
        if (!existing) {
          continue;
        }

        const unlockedValue = record.unlocked;
        const unlocked =
          typeof unlockedValue === 'boolean' ? unlockedValue : false;

        const normalizedCooldown = normalizeNonNegativeInt(
          record.cooldownExpiresStep,
        );
        const rebasedCooldown = hasValidSavedStep
          ? Math.max(0, normalizedCooldown + rebaseDelta)
          : normalizedCooldown;

        existing.unlocked = existing.unlocked || unlocked;
        existing.cooldownExpiresStep = rebasedCooldown;
        existing.runsThisTick = 0;

        const batchesValue = (record as { batches?: unknown }).batches;
        if (Array.isArray(batchesValue) && existing.batches) {
          const restoredBatches: TransformBatchQueueEntry[] = [];
          let sequence = 0;

          for (const batchEntry of batchesValue) {
            if (!batchEntry || typeof batchEntry !== 'object') {
              continue;
            }

            const batchRecord = batchEntry as Record<string, unknown>;
            const normalizedCompleteAtStep = normalizeNonNegativeInt(
              batchRecord.completeAtStep,
            );
            const rebasedCompleteAtStep = hasValidSavedStep
              ? Math.max(0, normalizedCompleteAtStep + rebaseDelta)
              : normalizedCompleteAtStep;

            const outputsValue = batchRecord.outputs;
            const outputs: TransformBatchOutput[] = [];
            const entityInstanceIdsValue = batchRecord.entityInstanceIds;
            const entityInstanceIds = Array.isArray(entityInstanceIdsValue)
              ? entityInstanceIdsValue.filter(
                  (id): id is string =>
                    typeof id === 'string' && id.trim().length > 0,
                )
              : undefined;
            const entityExperienceValue = batchRecord.entityExperience;
            const entityExperience =
              typeof entityExperienceValue === 'number' &&
              Number.isFinite(entityExperienceValue)
                ? Math.max(0, entityExperienceValue)
                : undefined;

            const batchIdValue = batchRecord.batchId;
            const batchId =
              typeof batchIdValue === 'string' && batchIdValue.trim().length > 0
                ? batchIdValue
                : undefined;

            const parseOutputs = (value: unknown): TransformBatchOutput[] => {
              const outputsArray = Array.isArray(value) ? value : [];
              const outputs: TransformBatchOutput[] = [];

              for (const outputEntry of outputsArray) {
                if (!outputEntry || typeof outputEntry !== 'object') {
                  continue;
                }

                const outputRecord = outputEntry as Record<string, unknown>;
                const resourceId = outputRecord.resourceId;
                const amountValue = outputRecord.amount;

                if (typeof resourceId !== 'string' || resourceId.trim().length === 0) {
                  continue;
                }

                if (typeof amountValue !== 'number' || !Number.isFinite(amountValue)) {
                  continue;
                }

                outputs.push({
                  resourceId,
                  amount: Math.max(0, amountValue),
                });
              }

              return outputs;
            };

            const parseMissionOutcome = (value: unknown): MissionPreparedOutcome => {
              if (!value || typeof value !== 'object') {
                return { outputs: [], entityExperience: 0 };
              }

              const record = value as Record<string, unknown>;
              const entityExperienceValue = record.entityExperience;
              const entityExperience =
                typeof entityExperienceValue === 'number' &&
                Number.isFinite(entityExperienceValue)
                  ? Math.max(0, entityExperienceValue)
                  : 0;

              return {
                outputs: parseOutputs(record.outputs),
                entityExperience,
              };
            };

            let mission: MissionBatchPlan | undefined;
            const missionValue = batchRecord.mission;
            if (missionValue && typeof missionValue === 'object') {
              const missionRecord = missionValue as Record<string, unknown>;
              const baseRateValue = missionRecord.baseRate;
              const baseRate =
                typeof baseRateValue === 'number' && Number.isFinite(baseRateValue)
                  ? clampProbability(baseRateValue)
                  : 0;

              const criticalChanceValue = missionRecord.criticalChance;
              const criticalChance =
                typeof criticalChanceValue === 'number' &&
                Number.isFinite(criticalChanceValue)
                  ? clampProbability(criticalChanceValue)
                  : undefined;

              const criticalValue = missionRecord.critical;
              const critical =
                criticalValue && typeof criticalValue === 'object'
                  ? parseMissionOutcome(criticalValue)
                  : undefined;

              mission = {
                baseRate,
                usePRD: Boolean(missionRecord.usePRD),
                ...(criticalChance === undefined ? {} : { criticalChance }),
                success: parseMissionOutcome(missionRecord.success),
                failure: parseMissionOutcome(missionRecord.failure),
                ...(critical ? { critical } : {}),
              };
            }

            outputs.push(...parseOutputs(outputsValue));

            restoredBatches.push({
              completeAtStep: rebasedCompleteAtStep,
              outputs,
              ...(batchId ? { batchId } : {}),
              ...(entityInstanceIds && entityInstanceIds.length > 0
                ? { entityInstanceIds }
                : {}),
              ...(entityExperience === undefined ? {} : { entityExperience }),
              ...(mission ? { mission } : {}),
              sequence,
            });
            sequence += 1;
          }

          existing.batches = restoredBatches as TransformBatchState[];
          batchSequences.set(id, restoredBatches.length);
        }
      }
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

        if (transform.trigger.kind === 'automation') {
          const automationId = transform.trigger.automationId;
          events.on('automation:fired', (event) => {
            if (event.payload.automationId === automationId) {
              pendingEventTriggers.add(transform.id);
            }
          });
        }
      }
    },

    tick({ step, events }) {
      const formulaContext = createTransformFormulaEvaluationContext({
        currentStep: step,
        stepDurationMs,
        resourceState,
        conditionContext,
      });

      // Ensure counters are reset for this step (may already be done by executeTransform)
      ensureCountersResetForStep(step);

      // Deliver any batches that are due before evaluating triggers.
      for (const transform of sortedTransforms) {
        const state = transformStates.get(transform.id);
        const batches = (state?.batches ?? []) as TransformBatchQueueEntry[];
        if (batches.length === 0) continue;
        deliverDueBatches(
          transform,
          batches,
          resourceState,
          step,
          entitySystem,
          prdRegistry,
          events,
        );
      }

      // Collect event triggers to retain across ticks when blocked
      const retainedEventTriggers = new Set<string>();

      // Evaluate each transform in deterministic order
      for (const transform of sortedTransforms) {
        const state = transformStates.get(transform.id);
        if (!state) continue;

        // Update visibility each tick (default visible when no context is provided)
        state.visible = conditionContext
          ? evaluateCondition(transform.visibilityCondition, conditionContext)
          : true;

        // Update unlock status (monotonic: once unlocked, stays unlocked)
        if (!state.unlocked && conditionContext) {
          if (evaluateCondition(transform.unlockCondition, conditionContext)) {
            state.unlocked = true;
          }
        } else if (!state.unlocked && !transform.unlockCondition) {
          // No unlock condition means always unlocked
          state.unlocked = true;
        }

        const isEventPending =
          (transform.trigger.kind === 'event' ||
            transform.trigger.kind === 'automation') &&
          pendingEventTriggers.has(transform.id);

        // Skip if not unlocked
        if (!state.unlocked) {
          // Retain pending event triggers when blocked by unlock state
          if (isEventPending) {
            retainedEventTriggers.add(transform.id);
          }
          continue;
        }

        // Skip manual transforms (handled by command)
        if (transform.trigger.kind === 'manual') {
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
          case 'automation': {
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
          if (
            transform.trigger.kind === 'event' ||
            transform.trigger.kind === 'automation'
          ) {
            retainedEventTriggers.add(transform.id);
          }
          continue;
        }

        // Check safety cap
        const maxRuns = getEffectiveMaxRunsPerTick(transform);
        if (state.runsThisTick >= maxRuns) {
          // Retain event trigger for next tick
          if (
            transform.trigger.kind === 'event' ||
            transform.trigger.kind === 'automation'
          ) {
            retainedEventTriggers.add(transform.id);
          }
          continue;
        }

        // Attempt execution
        const result = executeTransformRun(
          transform,
          state,
          step,
          formulaContext,
          events,
        );

        if (!result.success) {
          // Retain event trigger when blocked
          if (
            transform.trigger.kind === 'event' ||
            transform.trigger.kind === 'automation'
          ) {
            retainedEventTriggers.add(transform.id);
          }
        }
      }

      // Deliver any same-step batches scheduled during trigger evaluation.
      for (const transform of sortedTransforms) {
        const state = transformStates.get(transform.id);
        const batches = (state?.batches ?? []) as TransformBatchQueueEntry[];
        if (batches.length === 0) continue;
        deliverDueBatches(
          transform,
          batches,
          resourceState,
          step,
          entitySystem,
          prdRegistry,
          events,
        );
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

export function buildTransformSnapshot(
  step: number,
  publishedAt: number,
  options: {
    readonly transforms: readonly TransformDefinition[];
    readonly state: ReadonlyMap<string, TransformState>;
    readonly stepDurationMs: number;
    readonly resourceState?: TransformResourceState;
    readonly conditionContext?: ConditionContext;
  },
): TransformSnapshot {
  const formulaContext = createTransformFormulaEvaluationContext({
    currentStep: step,
    stepDurationMs: options.stepDurationMs,
    resourceState: options.resourceState,
    conditionContext: options.conditionContext,
  });

  const sortedTransforms = [...options.transforms].sort((left, right) => {
    const orderA = left.order ?? 0;
    const orderB = right.order ?? 0;
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return compareStableStrings(left.id, right.id);
  });

  const toEndpointViews = (
    values: Map<string, number> | null,
  ): TransformEndpointView[] => {
    if (!values || values.size === 0) {
      return [];
    }

    const entries = [...values.entries()].sort((a, b) =>
      compareStableStrings(a[0], b[0]),
    );
    return entries.map(([resourceId, amount]) => ({
      resourceId,
      amount,
    }));
  };

  const views: TransformView[] = [];
  for (const transform of sortedTransforms) {
    const state = options.state.get(transform.id);
    const unlocked = state?.unlocked ?? false;
    const visible = state?.visible ?? true;
    const cooldownExpiresStep = state?.cooldownExpiresStep ?? 0;
    const cooldownRemainingMs = Math.max(
      0,
      (cooldownExpiresStep - step) * options.stepDurationMs,
    );
    const inputCosts = evaluateInputCosts(transform, formulaContext);
    const inputs = toEndpointViews(inputCosts);
    const outputs = toEndpointViews(
      evaluateOutputAmounts(transform, formulaContext),
    );
    let canAfford = false;
    if (inputCosts) {
      canAfford = options.resourceState
        ? canAffordInputs(inputCosts, options.resourceState)
        : isZeroInputCost(inputCosts);
    }
    const isOnCooldown = cooldownRemainingMs > 0;

    const batches = state?.batches ?? [];
    const nextBatchReadyAtStep =
      (transform.mode === 'batch' || transform.mode === 'mission') &&
      batches.length > 0
        ? batches[0].completeAtStep
        : undefined;

    views.push(
      Object.freeze({
        id: transform.id,
        displayName: transform.name.default,
        description: transform.description.default,
        mode: transform.mode,
        unlocked,
        visible,
        cooldownRemainingMs,
        isOnCooldown,
        canAfford,
        inputs,
        outputs,
        ...(transform.mode === 'batch' || transform.mode === 'mission'
          ? {
              outstandingBatches: batches.length,
              ...(nextBatchReadyAtStep !== undefined
                ? { nextBatchReadyAtStep }
                : {}),
            }
          : {}),
      }),
    );
  }

  return Object.freeze({
    step,
    publishedAt,
    transforms: Object.freeze(views),
  });
}
