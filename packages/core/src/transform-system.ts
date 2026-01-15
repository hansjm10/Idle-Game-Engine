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
import type { MissionOutcomeKind } from './events/runtime-event-catalog.js';
import { telemetry } from './telemetry.js';
import { resolveEngineConfig, type EngineConfig, type EngineConfigOverrides } from './config.js';
import { isBoolean, isFiniteNumber, isNonBlankString } from './validation/primitives.js';

/**
 * Extended ResourceStateAccessor for transforms that supports adding amounts.
 * Transforms need to both spend inputs and produce outputs.
 */
export interface TransformResourceState extends ResourceStateAccessor {
  addAmount?(index: number, amount: number): number;
}

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

type MissionPreparedOutcome = Readonly<{
  readonly outputs: readonly TransformBatchOutput[];
  readonly entityExperience: number;
}>;

type MissionBatchPlanBase = Readonly<{
  readonly baseRate: number;
  readonly usePRD: boolean;
  readonly criticalChance?: number;
  readonly success: MissionPreparedOutcome;
  readonly failure: MissionPreparedOutcome;
  readonly critical?: MissionPreparedOutcome;
}>;

type MultiStageMissionDecisionState = Readonly<{
  readonly stageId: string;
  readonly expiresAtStep: number;
}>;

type MultiStageMissionAccumulatedModifiers = Readonly<{
  readonly successRateBonus: number;
  readonly durationMultiplier: number;
  readonly outputMultiplier: number;
}>;

type MultiStageMissionBatchPlan = MissionBatchPlanBase &
  Readonly<{
    readonly currentStageId: string;
    readonly currentStageStartStep: number;
    readonly currentStageSuccessRate: number;
    readonly currentStageCheckpoint?: MissionPreparedOutcome;
    readonly checkpointRewardsGranted: readonly string[];
    readonly pendingDecision?: MultiStageMissionDecisionState;
    readonly accumulatedModifiers: MultiStageMissionAccumulatedModifiers;
    readonly returnOnCompleteEntityInstanceIds: readonly string[];
  }>;

type MissionBatchPlan = MissionBatchPlanBase | MultiStageMissionBatchPlan;

const isMultiStageMissionPlan = (
  mission: MissionBatchPlan,
): mission is MultiStageMissionBatchPlan =>
  typeof (mission as Partial<MultiStageMissionBatchPlan>).currentStageId === 'string';

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
  if (!isFiniteNumber(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  return Math.floor(value);
}

function parseNonEmptyString(value: unknown): string | undefined {
  return isNonBlankString(value) ? value : undefined;
}

function parseEntityInstanceIds(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const ids = value.filter(
    (id): id is string => isNonBlankString(id),
  );
  return ids.length > 0 ? ids : undefined;
}

function parseOptionalEntityExperience(value: unknown): number | undefined {
  if (!isFiniteNumber(value)) {
    return undefined;
  }

  return Math.max(0, value);
}

function parseTransformBatchOutputs(value: unknown): TransformBatchOutput[] {
  const outputsArray = Array.isArray(value) ? value : [];
  const outputs: TransformBatchOutput[] = [];

  for (const outputEntry of outputsArray) {
    if (!outputEntry || typeof outputEntry !== 'object') {
      continue;
    }

    const outputRecord = outputEntry as Record<string, unknown>;
    const resourceId = outputRecord.resourceId;
    const amountValue = outputRecord.amount;

    if (!isNonBlankString(resourceId)) {
      continue;
    }

    if (!isFiniteNumber(amountValue)) {
      continue;
    }

    outputs.push({
      resourceId,
      amount: Math.max(0, amountValue),
    });
  }

  return outputs;
}

function parseMissionPreparedOutcome(value: unknown): MissionPreparedOutcome {
  if (!value || typeof value !== 'object') {
    return { outputs: [], entityExperience: 0 };
  }

  const record = value as Record<string, unknown>;
  const entityExperienceValue = record.entityExperience;
  const entityExperience =
    isFiniteNumber(entityExperienceValue)
      ? Math.max(0, entityExperienceValue)
      : 0;

  return {
    outputs: parseTransformBatchOutputs(record.outputs),
    entityExperience,
  };
}

function parseNonEmptyStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (id): id is string => isNonBlankString(id),
  );
}

function parseProbabilityOrFallback(value: unknown, fallback: number): number {
  return isFiniteNumber(value)
    ? clampProbability(value)
    : fallback;
}

function parseOptionalProbability(value: unknown): number | undefined {
  return isFiniteNumber(value)
    ? clampProbability(value)
    : undefined;
}

function parseMissionPlanBase(record: Record<string, unknown>): MissionBatchPlanBase {
  const critical =
    record.critical && typeof record.critical === 'object'
      ? parseMissionPreparedOutcome(record.critical)
      : undefined;
  const criticalChance = parseOptionalProbability(record.criticalChance);

  return {
    baseRate: parseProbabilityOrFallback(record.baseRate, 0),
    usePRD: Boolean(record.usePRD),
    ...(criticalChance === undefined ? {} : { criticalChance }),
    success: parseMissionPreparedOutcome(record.success),
    failure: parseMissionPreparedOutcome(record.failure),
    ...(critical ? { critical } : {}),
  };
}

function parsePendingDecisionState(
  value: unknown,
  rebaseDelta: number,
): MultiStageMissionDecisionState | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const stageId = parseNonEmptyString(record.stageId);
  if (!stageId) {
    return undefined;
  }

  const expiresAtRaw = normalizeNonNegativeInt(record.expiresAtStep);
  return {
    stageId,
    expiresAtStep: rebaseStepValue(expiresAtRaw, rebaseDelta),
  };
}

function parseAccumulatedModifiers(
  value: unknown,
): MultiStageMissionAccumulatedModifiers {
  if (!value || typeof value !== 'object') {
    return {
      successRateBonus: 0,
      durationMultiplier: 1,
      outputMultiplier: 1,
    };
  }

  const record = value as Record<string, unknown>;
  const successRateBonusValue = record.successRateBonus;
  const durationMultiplierValue = record.durationMultiplier;
  const outputMultiplierValue = record.outputMultiplier;

  return {
    successRateBonus:
      isFiniteNumber(successRateBonusValue)
        ? successRateBonusValue
        : 0,
    durationMultiplier:
      isFiniteNumber(durationMultiplierValue)
        ? Math.max(0, durationMultiplierValue)
        : 1,
    outputMultiplier:
      isFiniteNumber(outputMultiplierValue)
        ? Math.max(0, outputMultiplierValue)
        : 1,
  };
}

function parseMultiStageMissionPlan(
  record: Record<string, unknown>,
  basePlan: MissionBatchPlanBase,
  currentStageId: string,
  rebaseDelta: number,
): MultiStageMissionBatchPlan {
  const currentStageStartRaw = normalizeNonNegativeInt(record.currentStageStartStep);
  const currentStageStartStep = rebaseStepValue(currentStageStartRaw, rebaseDelta);

  const currentStageSuccessRate = parseProbabilityOrFallback(
    record.currentStageSuccessRate,
    basePlan.baseRate,
  );

  const currentStageCheckpoint =
    record.currentStageCheckpoint && typeof record.currentStageCheckpoint === 'object'
      ? parseMissionPreparedOutcome(record.currentStageCheckpoint)
      : undefined;

  const checkpointRewardsGranted = parseNonEmptyStringArray(record.checkpointRewardsGranted);
  const pendingDecision = parsePendingDecisionState(record.pendingDecision, rebaseDelta);
  const returnOnCompleteEntityInstanceIds = parseNonEmptyStringArray(
    record.returnOnCompleteEntityInstanceIds,
  );

  return {
    ...basePlan,
    currentStageId,
    currentStageStartStep,
    currentStageSuccessRate,
    ...(currentStageCheckpoint ? { currentStageCheckpoint } : {}),
    checkpointRewardsGranted,
    ...(pendingDecision ? { pendingDecision } : {}),
    accumulatedModifiers: parseAccumulatedModifiers(record.accumulatedModifiers),
    returnOnCompleteEntityInstanceIds,
  };
}

function parseMissionPlan(
  value: unknown,
  rebaseDelta: number,
): MissionBatchPlan | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const basePlan = parseMissionPlanBase(record);
  const currentStageId = parseNonEmptyString(record.currentStageId);

  return currentStageId
    ? parseMultiStageMissionPlan(record, basePlan, currentStageId, rebaseDelta)
    : basePlan;
}

function rebaseStepValue(
  value: number,
  rebaseDelta: number,
): number {
  return Math.max(0, value + rebaseDelta);
}

function parseTransformBatchEntry(
  value: unknown,
  rebaseDelta: number,
  sequence: number,
): TransformBatchQueueEntry | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const normalizedCompleteAtStep = normalizeNonNegativeInt(record.completeAtStep);
  const completeAtStep = rebaseStepValue(
    normalizedCompleteAtStep,
    rebaseDelta,
  );

  const outputs = parseTransformBatchOutputs(record.outputs);
  const batchId = parseNonEmptyString(record.batchId);
  const entityInstanceIds = parseEntityInstanceIds(record.entityInstanceIds);
  const entityExperience = parseOptionalEntityExperience(record.entityExperience);
  const mission = parseMissionPlan(record.mission, rebaseDelta);

  return {
    completeAtStep,
    outputs,
    ...(batchId ? { batchId } : {}),
    ...(entityInstanceIds ? { entityInstanceIds } : {}),
    ...(entityExperience === undefined ? {} : { entityExperience }),
    ...(mission ? { mission } : {}),
    sequence,
  };
}

function parseTransformBatchEntries(
  batchesValue: unknown,
  rebaseDelta: number,
): TransformBatchQueueEntry[] {
  if (!Array.isArray(batchesValue)) {
    return [];
  }

  const restoredBatches: TransformBatchQueueEntry[] = [];
  let sequence = 0;

  for (const batchEntry of batchesValue) {
    const parsed = parseTransformBatchEntry(
      batchEntry,
      rebaseDelta,
      sequence,
    );
    if (!parsed) {
      continue;
    }
    restoredBatches.push(parsed);
    sequence += 1;
  }

  return restoredBatches;
}

function restoreTransformStateEntry(
  entry: unknown,
  transformStates: Map<string, TransformState>,
  batchSequences: Map<string, number>,
  rebaseDelta: number,
): void {
  if (!entry || typeof entry !== 'object') {
    return;
  }

  const record = entry as Record<string, unknown>;
  const id = record.id;
  if (!isNonBlankString(id)) {
    return;
  }

  const existing = transformStates.get(id);
  if (!existing) {
    return;
  }

  const unlockedValue = record.unlocked;
  const unlocked = isBoolean(unlockedValue) ? unlockedValue : false;

  const normalizedCooldown = normalizeNonNegativeInt(record.cooldownExpiresStep);
  const rebasedCooldown = rebaseStepValue(
    normalizedCooldown,
    rebaseDelta,
  );

  existing.unlocked = existing.unlocked || unlocked;
  existing.cooldownExpiresStep = rebasedCooldown;
  existing.runsThisTick = 0;

  const batchesValue = (record as { batches?: unknown }).batches;
  if (!Array.isArray(batchesValue) || !existing.batches) {
    return;
  }

  const restoredBatches = parseTransformBatchEntries(
    batchesValue,
    rebaseDelta,
  );
  existing.batches = restoredBatches as TransformBatchState[];
  batchSequences.set(id, restoredBatches.length);
}

type SerializedMissionPreparedOutcome = Readonly<{
  readonly outputs: readonly TransformBatchOutput[];
  readonly entityExperience: number;
}>;

type SerializedMissionDecisionState = Readonly<{
  readonly stageId: string;
  readonly expiresAtStep: number;
}>;

type SerializedMultiStageMissionAccumulatedModifiers = Readonly<{
  readonly successRateBonus: number;
  readonly durationMultiplier: number;
  readonly outputMultiplier: number;
}>;

type SerializedMissionBatchPlan = Readonly<{
  readonly baseRate: number;
  readonly usePRD: boolean;
  readonly criticalChance?: number;
  readonly success: SerializedMissionPreparedOutcome;
  readonly failure: SerializedMissionPreparedOutcome;
  readonly critical?: SerializedMissionPreparedOutcome;
  readonly currentStageId?: string;
  readonly currentStageStartStep?: number;
  readonly currentStageSuccessRate?: number;
  readonly currentStageCheckpoint?: SerializedMissionPreparedOutcome;
  readonly checkpointRewardsGranted?: readonly string[];
  readonly pendingDecision?: SerializedMissionDecisionState;
  readonly accumulatedModifiers?: SerializedMultiStageMissionAccumulatedModifiers;
  readonly returnOnCompleteEntityInstanceIds?: readonly string[];
}>;

const serializeMissionPreparedOutcome = (
  outcome: MissionPreparedOutcome,
): SerializedMissionPreparedOutcome => ({
  outputs: outcome.outputs.map((output) => ({
    resourceId: output.resourceId,
    amount:
      isFiniteNumber(output.amount)
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
  ...(isMultiStageMissionPlan(plan)
    ? {
        currentStageId: plan.currentStageId,
        currentStageStartStep: normalizeNonNegativeInt(plan.currentStageStartStep),
        currentStageSuccessRate: clampProbability(plan.currentStageSuccessRate),
        ...(plan.currentStageCheckpoint
          ? { currentStageCheckpoint: serializeMissionPreparedOutcome(plan.currentStageCheckpoint) }
          : {}),
        checkpointRewardsGranted: plan.checkpointRewardsGranted.filter(
          (id) => typeof id === 'string' && id.trim().length > 0,
        ),
        ...(plan.pendingDecision
          ? {
              pendingDecision: {
                stageId: plan.pendingDecision.stageId,
                expiresAtStep: normalizeNonNegativeInt(plan.pendingDecision.expiresAtStep),
              },
            }
          : {}),
        accumulatedModifiers: {
          successRateBonus: Number.isFinite(plan.accumulatedModifiers.successRateBonus)
            ? plan.accumulatedModifiers.successRateBonus
            : 0,
          durationMultiplier: Number.isFinite(plan.accumulatedModifiers.durationMultiplier)
            ? Math.max(0, plan.accumulatedModifiers.durationMultiplier)
            : 1,
          outputMultiplier: Number.isFinite(plan.accumulatedModifiers.outputMultiplier)
            ? Math.max(0, plan.accumulatedModifiers.outputMultiplier)
            : 1,
        },
        returnOnCompleteEntityInstanceIds: plan.returnOnCompleteEntityInstanceIds.filter(
          (id) => typeof id === 'string' && id.trim().length > 0,
        ),
      }
    : {}),
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
  readonly config?: EngineConfigOverrides;
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
function getEffectiveMaxRunsPerTick(
  transform: TransformDefinition,
  limits: EngineConfig['limits'],
): number {
  const authored = transform.safety?.maxRunsPerTick;

  if (authored === undefined || !Number.isFinite(authored) || authored <= 0) {
    return limits.maxRunsPerTick;
  }

  if (authored > limits.maxRunsPerTickHardCap) {
    telemetry.recordWarning('TransformMaxRunsPerTickClamped', {
      transformId: transform.id,
      authored,
      clamped: limits.maxRunsPerTickHardCap,
    });
    return limits.maxRunsPerTickHardCap;
  }

  return authored;
}

/**
 * Gets the effective maxOutstandingBatches for a transform.
 * Applies default and hard cap per design doc Section 13.4.
 */
function getEffectiveMaxOutstandingBatches(
  transform: TransformDefinition,
  limits: EngineConfig['limits'],
): number {
  const authored = transform.safety?.maxOutstandingBatches;

  if (authored === undefined || !Number.isFinite(authored) || authored <= 0) {
    return limits.maxOutstandingBatches;
  }

  if (authored > limits.maxOutstandingBatchesHardCap) {
    telemetry.recordWarning('TransformMaxOutstandingBatchesClamped', {
      transformId: transform.id,
      authored,
      clamped: limits.maxOutstandingBatchesHardCap,
    });
    return limits.maxOutstandingBatchesHardCap;
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

type MissionStageDefinition = NonNullable<TransformDefinition['stages']>[number];

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

type MissionPreparedOutcomeResult =
  | { readonly ok: true; readonly prepared: MissionPreparedOutcome }
  | { readonly ok: false; readonly result: TransformExecutionResult };

const isPreparedMissionOutcomeResult = (
  outcome: MissionPreparedOutcomeResult | undefined,
): outcome is Extract<MissionPreparedOutcomeResult, { readonly ok: true }> =>
  outcome?.ok === true;

const prepareMissionOutcomePlan = (
  transform: TransformDefinition,
  outcome: MissionOutcome | undefined,
  formulaContext: FormulaEvaluationContext,
  resourceState: TransformResourceState,
): MissionPreparedOutcomeResult => {
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

  const experience = evaluateMissionOutcomeExperience(transform, outcome, formulaContext);
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

function returnMissionEntities(
  entityInstanceIds: readonly string[],
  transformId: string,
  step: number,
  entitySystem?: EntitySystem,
): void {
  if (!entityInstanceIds || entityInstanceIds.length === 0) {
    return;
  }

  if (!entitySystem) {
    telemetry.recordWarning('MissionOutcomeReturnMissingEntitySystem', {
      transformId,
    });
    return;
  }

  for (const instanceId of entityInstanceIds) {
    try {
      entitySystem.returnFromMission(instanceId);
    } catch (error) {
      telemetry.recordWarning('MissionOutcomeReturnFailed', {
        transformId,
        instanceId,
        step,
        error: String(error),
      });
    }
  }
}

interface MissionOutcomeResult {
  readonly outcomeKind: MissionOutcomeKind;
  readonly critical: boolean;
  readonly success: boolean;
  readonly outcome: MissionPreparedOutcome;
}

function determineMissionOutcome(
  mission: MissionBatchPlan,
  transformId: string,
  prdRegistry: PRDRegistry | undefined,
): MissionOutcomeResult {
  const baseRate = clampProbability(mission.baseRate);
  const success = mission.usePRD
    ? (prdRegistry ?? new PRDRegistry(seededRandom)).getOrCreate(transformId, baseRate).roll()
    : seededRandom() < baseRate;

  if (!success) {
    return { outcomeKind: 'failure', critical: false, success: false, outcome: mission.failure };
  }

  const criticalOutcome = mission.critical;
  const criticalChance = mission.criticalChance;
  if (
    criticalOutcome !== undefined &&
    criticalChance !== undefined &&
    seededRandom() < clampProbability(criticalChance)
  ) {
    return { outcomeKind: 'critical', critical: true, success: true, outcome: criticalOutcome };
  }

  return { outcomeKind: 'success', critical: false, success: true, outcome: mission.success };
}

function scaleMissionPreparedOutcome(
  outcome: MissionPreparedOutcome,
  multiplier: number,
): MissionPreparedOutcome {
  const safeMultiplier =
    typeof multiplier === 'number' && Number.isFinite(multiplier) ? Math.max(0, multiplier) : 0;

  return {
    outputs: outcome.outputs.map((output) => ({
      resourceId: output.resourceId,
      amount:
        typeof output.amount === 'number' && Number.isFinite(output.amount)
          ? Math.max(0, output.amount * safeMultiplier)
          : 0,
    })),
    entityExperience:
      typeof outcome.entityExperience === 'number' && Number.isFinite(outcome.entityExperience)
        ? Math.max(0, outcome.entityExperience * safeMultiplier)
        : 0,
  };
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
  type: 'mission:stage-completed',
  payload: RuntimeEventPayload<'mission:stage-completed'>,
  transformId: string,
): void;
function publishMissionEvent(
  publisher: EventPublisher | undefined,
  type: 'mission:decision-required',
  payload: RuntimeEventPayload<'mission:decision-required'>,
  transformId: string,
): void;
function publishMissionEvent(
  publisher: EventPublisher | undefined,
  type: 'mission:decision-made',
  payload: RuntimeEventPayload<'mission:decision-made'>,
  transformId: string,
): void;
function publishMissionEvent(
  publisher: EventPublisher | undefined,
  type:
    | 'mission:started'
    | 'mission:completed'
    | 'mission:stage-completed'
    | 'mission:decision-required'
    | 'mission:decision-made',
  payload: RuntimeEventPayload<
    | 'mission:started'
    | 'mission:completed'
    | 'mission:stage-completed'
    | 'mission:decision-required'
    | 'mission:decision-made'
  >,
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

function completeMissionBatch(
  entry: TransformBatchQueueEntry,
  transformId: string,
  resourceState: TransformResourceState,
  step: number,
  entitySystem: EntitySystem | undefined,
  prdRegistry: PRDRegistry | undefined,
  events: EventPublisher | undefined,
): void {
  const mission = entry.mission!;
  const result = determineMissionOutcome(mission, transformId, prdRegistry);

  applyBatchOutputs(result.outcome.outputs, resourceState, transformId);
  grantEntityExperience(
    result.outcome.entityExperience,
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
      outcomeKind: result.outcomeKind,
      success: result.success,
      critical: result.critical,
      outputs: result.outcome.outputs.map((output) => ({
        resourceId: output.resourceId,
        amount: output.amount,
      })),
      entityExperience: result.outcome.entityExperience,
      entityInstanceIds: entry.entityInstanceIds ?? [],
    },
    transformId,
  );
}

type CompleteMultiStageMissionParams = Readonly<{
  readonly entry: TransformBatchQueueEntry;
  readonly mission: MultiStageMissionBatchPlan;
  readonly transformId: string;
  readonly resourceState: TransformResourceState;
  readonly step: number;
  readonly outcomeKind: MissionOutcomeKind;
  readonly outcome: MissionPreparedOutcome;
  readonly entitySystem?: EntitySystem;
  readonly events?: EventPublisher;
}>;

function completeMultiStageMission(
  params: CompleteMultiStageMissionParams,
): void {
  const {
    entry,
    mission,
    transformId,
    resourceState,
    step,
    outcomeKind,
    outcome,
    entitySystem,
    events,
  } = params;
  const scaledOutcome = scaleMissionPreparedOutcome(
    outcome,
    mission.accumulatedModifiers.outputMultiplier,
  );

  applyBatchOutputs(scaledOutcome.outputs, resourceState, transformId);
  grantEntityExperience(
    scaledOutcome.entityExperience,
    entry.entityInstanceIds,
    step,
    transformId,
    entitySystem,
  );
  returnMissionEntities(
    mission.returnOnCompleteEntityInstanceIds,
    transformId,
    step,
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
      success: outcomeKind !== 'failure',
      critical: outcomeKind === 'critical',
      outputs: scaledOutcome.outputs.map((output) => ({
        resourceId: output.resourceId,
        amount: output.amount,
      })),
      entityExperience: scaledOutcome.entityExperience,
      entityInstanceIds: entry.entityInstanceIds ?? [],
    },
    transformId,
  );
}

function completeStandardBatch(
  entry: TransformBatchQueueEntry,
  transformId: string,
  resourceState: TransformResourceState,
  step: number,
  entitySystem: EntitySystem | undefined,
): void {
  applyBatchOutputs(entry.outputs, resourceState, transformId);
  grantEntityExperience(
    entry.entityExperience ?? 0,
    entry.entityInstanceIds,
    step,
    transformId,
    entitySystem,
  );
}

type MissionDecisionDefinition = NonNullable<MissionStageDefinition['decision']>;
type MissionDecisionOptionDefinition = MissionDecisionDefinition['options'][number];

type DeliverDueBatchesContext = Readonly<{
  readonly transform: TransformDefinition;
  readonly batches: TransformBatchQueueEntry[];
  readonly resourceState: TransformResourceState;
  readonly step: number;
  readonly stepDurationMs: number;
  readonly formulaContext: FormulaEvaluationContext;
  readonly conditionContext?: ConditionContext;
  readonly entitySystem?: EntitySystem;
  readonly prdRegistry?: PRDRegistry;
  readonly events?: EventPublisher;
}>;

type MissionDecisionOptionView = Readonly<{
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
}>;

type ScheduleMultiStageMissionStageParams = Readonly<{
  readonly transform: TransformDefinition;
  readonly mission: MultiStageMissionBatchPlan;
  readonly stageId: string;
  readonly step: number;
  readonly stepDurationMs: number;
  readonly formulaContext: FormulaEvaluationContext;
  readonly resourceState: TransformResourceState;
}>;

type ScheduleMultiStageMissionStageResult =
  | {
      readonly ok: true;
      readonly mission: MultiStageMissionBatchPlan;
      readonly completeAtStep: number;
    }
  | { readonly ok: false; readonly result: TransformExecutionResult };

function evaluateOptionalFormula(
  formula: NumericFormulaModel | undefined,
  formulaContext: FormulaEvaluationContext,
): number | undefined {
  if (!formula) {
    return undefined;
  }

  const value = evaluateNumericFormula(formula, formulaContext);
  return Number.isFinite(value) ? value : undefined;
}

function applyMissionDecisionModifiers(
  current: MultiStageMissionAccumulatedModifiers,
  modifiers: MissionDecisionOptionDefinition['modifiers'],
  formulaContext: FormulaEvaluationContext,
): MultiStageMissionAccumulatedModifiers {
  if (!modifiers) {
    return current;
  }

  const successRateBonusValue = evaluateOptionalFormula(
    modifiers.successRateBonus,
    formulaContext,
  );
  const durationMultiplierValue = evaluateOptionalFormula(
    modifiers.durationMultiplier,
    formulaContext,
  );
  const outputMultiplierValue = evaluateOptionalFormula(
    modifiers.outputMultiplier,
    formulaContext,
  );

  const currentSuccessRateBonus = Number.isFinite(current.successRateBonus)
    ? current.successRateBonus
    : 0;
  const currentDurationMultiplier = Number.isFinite(current.durationMultiplier)
    ? current.durationMultiplier
    : 1;
  const currentOutputMultiplier = Number.isFinite(current.outputMultiplier)
    ? current.outputMultiplier
    : 1;

  return {
    successRateBonus:
      currentSuccessRateBonus +
      (typeof successRateBonusValue === 'number' ? successRateBonusValue : 0),
    durationMultiplier:
      currentDurationMultiplier *
      (typeof durationMultiplierValue === 'number'
        ? Math.max(0, durationMultiplierValue)
        : 1),
    outputMultiplier:
      currentOutputMultiplier *
      (typeof outputMultiplierValue === 'number'
        ? Math.max(0, outputMultiplierValue)
        : 1),
  };
}

function calculateDurationStepsFromMs(
  durationMs: number,
  stepDurationMs: number,
): number {
  if (stepDurationMs <= 0 || !Number.isFinite(stepDurationMs)) {
    return 0;
  }
  return Math.ceil(Math.max(0, durationMs) / stepDurationMs);
}

function scheduleMultiStageMissionStage(
  params: ScheduleMultiStageMissionStageParams,
): ScheduleMultiStageMissionStageResult {
  const {
    transform,
    mission,
    stageId,
    step,
    stepDurationMs,
    formulaContext,
    resourceState,
  } = params;
  const transformId = transform.id;

  const stage = transform.stages?.find((candidate) => candidate.id === stageId);
  if (!stage) {
    return {
      ok: false,
      result: {
        success: false,
        error: {
          code: 'INVALID_STAGE',
          message: 'Mission stage definition missing for multi-stage mission.',
          details: { transformId, stageId },
        },
      },
    };
  }

  const durationMsRaw = evaluateNumericFormula(stage.duration, formulaContext);
  if (!Number.isFinite(durationMsRaw)) {
    return {
      ok: false,
      result: {
        success: false,
        error: {
          code: 'INVALID_DURATION_FORMULA',
          message: 'Mission stage duration formula evaluated to non-finite value.',
          details: { transformId, stageId: stage.id },
        },
      },
    };
  }

  const durationMultiplier = mission.accumulatedModifiers.durationMultiplier;
  const durationMsScaled =
    Number.isFinite(durationMultiplier) && durationMultiplier >= 0
      ? durationMsRaw * durationMultiplier
      : durationMsRaw;

  if (!Number.isFinite(durationMsScaled)) {
    return {
      ok: false,
      result: {
        success: false,
        error: {
          code: 'INVALID_DURATION_FORMULA',
          message: 'Mission stage duration multiplier evaluated to non-finite value.',
          details: { transformId, stageId: stage.id },
        },
      },
    };
  }

  const durationSteps = calculateDurationStepsFromMs(durationMsScaled, stepDurationMs);

  const successRateRaw = stage.stageSuccessRate
    ? evaluateNumericFormula(stage.stageSuccessRate, formulaContext)
    : mission.baseRate;
  if (!Number.isFinite(successRateRaw)) {
    return {
      ok: false,
      result: {
        success: false,
        error: {
          code: 'INVALID_SUCCESS_RATE',
          message: 'Mission stage success rate evaluated to non-finite value.',
          details: { transformId, stageId: stage.id },
        },
      },
    };
  }

  const successRateBonus = mission.accumulatedModifiers.successRateBonus;
  const currentStageSuccessRate = clampProbability(
    clampProbability(successRateRaw) +
      (Number.isFinite(successRateBonus) ? successRateBonus : 0),
  );

  let checkpointPrepared: MissionPreparedOutcome | undefined;
  if (stage.checkpoint) {
    const prepared = prepareMissionOutcomePlan(
      transform,
      stage.checkpoint as unknown as MissionOutcome,
      formulaContext,
      resourceState,
    );
    if (!prepared.ok) {
      return { ok: false, result: prepared.result };
    }
    checkpointPrepared = scaleMissionPreparedOutcome(
      prepared.prepared,
      mission.accumulatedModifiers.outputMultiplier,
    );
  }

  const updatedMission: MultiStageMissionBatchPlan = {
    ...mission,
    currentStageId: stage.id,
    currentStageStartStep: step,
    currentStageSuccessRate,
    currentStageCheckpoint: checkpointPrepared,
    pendingDecision: undefined,
  };

  return {
    ok: true,
    mission: updatedMission,
    completeAtStep: step + durationSteps,
  };
}

function rollMissionStageSuccess(
  mission: MultiStageMissionBatchPlan,
  transformId: string,
  prdRegistry: PRDRegistry | undefined,
): boolean {
  const successRate = clampProbability(mission.currentStageSuccessRate);
  if (mission.usePRD) {
    const registry = prdRegistry ?? new PRDRegistry(seededRandom);
    return registry.getOrCreate(transformId, successRate).roll();
  }
  return seededRandom() < successRate;
}

function buildDecisionOptionViews(
  decision: MissionDecisionDefinition,
  conditionContext: ConditionContext | undefined,
): MissionDecisionOptionView[] {
  return decision.options.map((option) => ({
    id: option.id,
    label: option.label.default,
    available: option.condition
      ? Boolean(conditionContext && evaluateCondition(option.condition, conditionContext))
      : true,
  }));
}

function selectAvailableDecisionOption(
  decision: MissionDecisionDefinition,
  optionViews: readonly MissionDecisionOptionView[],
): MissionDecisionOptionDefinition | undefined {
  const availableOptionIds = new Set(
    optionViews.filter((option) => option.available).map((option) => option.id),
  );
  const defaultOption = decision.options.find(
    (option) => option.id === decision.defaultOption,
  );

  if (defaultOption && availableOptionIds.has(defaultOption.id)) {
    return defaultOption;
  }

  return decision.options.find((option) => availableOptionIds.has(option.id));
}

function calculateDecisionTimeoutSteps(
  timeoutMs: number,
  stepDurationMs: number,
): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs === Number.POSITIVE_INFINITY) {
    return Number.MAX_SAFE_INTEGER;
  }
  return calculateDurationStepsFromMs(timeoutMs, stepDurationMs);
}

function completeMultiStageMissionFromDueBatch(
  context: DeliverDueBatchesContext,
  entry: TransformBatchQueueEntry,
  mission: MultiStageMissionBatchPlan,
  outcomeKind: MissionOutcomeKind,
  outcome: MissionPreparedOutcome,
): void {
  completeMultiStageMission({
    entry,
    mission,
    transformId: context.transform.id,
    resourceState: context.resourceState,
    step: context.step,
    outcomeKind,
    outcome,
    entitySystem: context.entitySystem,
    events: context.events,
  });
}

function completeMultiStageMissionFailure(
  context: DeliverDueBatchesContext,
  entry: TransformBatchQueueEntry,
  mission: MultiStageMissionBatchPlan,
): void {
  completeMultiStageMissionFromDueBatch(
    context,
    entry,
    mission,
    'failure',
    mission.failure,
  );
}

function rescheduleMissionEntry(
  context: DeliverDueBatchesContext,
  entry: TransformBatchQueueEntry,
  mission: MultiStageMissionBatchPlan,
  nextStageId: string,
): boolean {
  const nextStageResult = scheduleMultiStageMissionStage({
    transform: context.transform,
    mission,
    stageId: nextStageId,
    step: context.step,
    stepDurationMs: context.stepDurationMs,
    formulaContext: context.formulaContext,
    resourceState: context.resourceState,
  });

  if (!nextStageResult.ok) {
    completeMultiStageMissionFailure(context, entry, mission);
    return false;
  }

  insertBatch(context.batches, {
    ...entry,
    completeAtStep: nextStageResult.completeAtStep,
    mission: nextStageResult.mission,
  });
  return true;
}

function resolveMissionCompletionOutcomeKind(
  mission: MultiStageMissionBatchPlan,
): { readonly outcomeKind: MissionOutcomeKind; readonly baseOutcome: MissionPreparedOutcome } {
  const criticalChance = mission.criticalChance;
  const criticalOutcome =
    mission.critical &&
    criticalChance !== undefined &&
    seededRandom() < clampProbability(criticalChance)
      ? mission.critical
      : undefined;

  return {
    outcomeKind: criticalOutcome ? 'critical' : 'success',
    baseOutcome: criticalOutcome ?? mission.success,
  };
}

function maybeResolveStageSuccessOverride(
  context: DeliverDueBatchesContext,
  stage: MissionStageDefinition,
  outcomeKind: MissionOutcomeKind,
): MissionPreparedOutcomeResult | undefined {
  if (outcomeKind !== 'success' || !stage.stageOutcomes?.success) {
    return undefined;
  }

  return prepareMissionOutcomePlan(
    context.transform,
    stage.stageOutcomes.success as unknown as MissionOutcome,
    context.formulaContext,
    context.resourceState,
  );
}

function completeMultiStageMissionAfterSuccessStage(
  context: DeliverDueBatchesContext,
  entry: TransformBatchQueueEntry,
  mission: MultiStageMissionBatchPlan,
  stage: MissionStageDefinition,
): void {
  const { outcomeKind, baseOutcome } = resolveMissionCompletionOutcomeKind(mission);
  const overrideOutcome = maybeResolveStageSuccessOverride(
    context,
    stage,
    outcomeKind,
  );

  if (overrideOutcome && !overrideOutcome.ok) {
    telemetry.recordWarning('MissionStageOutcomeOverrideInvalid', {
      transformId: context.transform.id,
      stageId: stage.id,
      outcomeKind,
      errorCode: overrideOutcome.result.error?.code,
    });
    completeMultiStageMissionFailure(context, entry, mission);
    return;
  }

  const resolvedOutcome = isPreparedMissionOutcomeResult(overrideOutcome)
    ? overrideOutcome.prepared
    : baseOutcome;
  completeMultiStageMissionFromDueBatch(
    context,
    entry,
    mission,
    outcomeKind,
    resolvedOutcome,
  );
}

function handlePendingDecisionBatch(
  context: DeliverDueBatchesContext,
  entry: TransformBatchQueueEntry,
  mission: MultiStageMissionBatchPlan,
  stage: MissionStageDefinition,
): void {
  if (!stage.decision) {
    completeMultiStageMissionFailure(context, entry, mission);
    return;
  }

  const optionViews = buildDecisionOptionViews(stage.decision, context.conditionContext);
  const chosenOption = selectAvailableDecisionOption(stage.decision, optionViews);
  if (!chosenOption) {
    completeMultiStageMissionFailure(context, entry, mission);
    return;
  }

  const updatedMissionAfterDecision: MultiStageMissionBatchPlan = {
    ...mission,
    accumulatedModifiers: applyMissionDecisionModifiers(
      mission.accumulatedModifiers,
      chosenOption.modifiers,
      context.formulaContext,
    ),
    pendingDecision: undefined,
  };

  publishMissionEvent(
    context.events,
    'mission:decision-made',
    {
      transformId: context.transform.id,
      batchId: entry.batchId ?? `${entry.sequence}`,
      stageId: stage.id,
      optionId: chosenOption.id,
      nextStageId: chosenOption.nextStage,
    },
    context.transform.id,
  );

  if (chosenOption.nextStage === null) {
    completeMultiStageMissionAfterSuccessStage(
      context,
      entry,
      updatedMissionAfterDecision,
      stage,
    );
    return;
  }

  rescheduleMissionEntry(
    context,
    entry,
    updatedMissionAfterDecision,
    chosenOption.nextStage,
  );
}

function applyStageCheckpointRewards(
  context: DeliverDueBatchesContext,
  entry: TransformBatchQueueEntry,
  mission: MultiStageMissionBatchPlan,
  stage: MissionStageDefinition,
  success: boolean,
): {
  readonly checkpointOutputs?: readonly TransformBatchOutput[];
  readonly checkpointRewardsGranted: readonly string[];
} {
  if (
    !success ||
    !mission.currentStageCheckpoint ||
    mission.checkpointRewardsGranted.includes(stage.id)
  ) {
    return { checkpointRewardsGranted: mission.checkpointRewardsGranted };
  }

  applyBatchOutputs(
    mission.currentStageCheckpoint.outputs,
    context.resourceState,
    context.transform.id,
  );
  grantEntityExperience(
    mission.currentStageCheckpoint.entityExperience,
    entry.entityInstanceIds,
    context.step,
    context.transform.id,
    context.entitySystem,
  );

  return {
    checkpointOutputs: mission.currentStageCheckpoint.outputs,
    checkpointRewardsGranted: Object.freeze([
      ...mission.checkpointRewardsGranted,
      stage.id,
    ]),
  };
}

function publishMissionStageCompleted(
  context: DeliverDueBatchesContext,
  entry: TransformBatchQueueEntry,
  stage: MissionStageDefinition,
  checkpointOutputs: readonly TransformBatchOutput[] | undefined,
): void {
  publishMissionEvent(
    context.events,
    'mission:stage-completed',
    {
      transformId: context.transform.id,
      batchId: entry.batchId ?? `${entry.sequence}`,
      stageId: stage.id,
      ...(checkpointOutputs
        ? {
            checkpoint: {
              outputs: checkpointOutputs.map((output) => ({
                resourceId: output.resourceId,
                amount: output.amount,
              })),
            },
          }
        : {}),
    },
    context.transform.id,
  );
}

function completeMultiStageMissionOnStageFailure(
  context: DeliverDueBatchesContext,
  entry: TransformBatchQueueEntry,
  mission: MultiStageMissionBatchPlan,
  stage: MissionStageDefinition,
): void {
  const overrideOutcome = stage.stageOutcomes?.failure
    ? prepareMissionOutcomePlan(
        context.transform,
        stage.stageOutcomes.failure as unknown as MissionOutcome,
        context.formulaContext,
        context.resourceState,
      )
    : undefined;

  if (overrideOutcome && !overrideOutcome.ok) {
    telemetry.recordWarning('MissionStageOutcomeOverrideInvalid', {
      transformId: context.transform.id,
      stageId: stage.id,
      outcomeKind: 'failure',
      errorCode: overrideOutcome.result.error?.code,
    });
  }

  const failureOutcome = isPreparedMissionOutcomeResult(overrideOutcome)
    ? overrideOutcome.prepared
    : mission.failure;

  completeMultiStageMissionFromDueBatch(context, entry, mission, 'failure', failureOutcome);
}

function scheduleMissionDecision(
  context: DeliverDueBatchesContext,
  entry: TransformBatchQueueEntry,
  mission: MultiStageMissionBatchPlan,
  stage: MissionStageDefinition,
  decision: MissionDecisionDefinition,
  checkpointRewardsGranted: readonly string[],
): void {
  const timeout = decision.timeout;
  const timeoutMs = timeout
    ? evaluateNumericFormula(timeout, context.formulaContext)
    : Number.POSITIVE_INFINITY;
  const timeoutSteps = calculateDecisionTimeoutSteps(timeoutMs, context.stepDurationMs);
  const expiresAtStep =
    timeoutSteps === Number.MAX_SAFE_INTEGER
      ? Number.MAX_SAFE_INTEGER
      : context.step + timeoutSteps;

  const optionViews = buildDecisionOptionViews(decision, context.conditionContext);

  publishMissionEvent(
    context.events,
    'mission:decision-required',
    {
      transformId: context.transform.id,
      batchId: entry.batchId ?? `${entry.sequence}`,
      stageId: stage.id,
      prompt: decision.prompt.default,
      options: optionViews,
      expiresAtStep,
    },
    context.transform.id,
  );

  const updatedMission: MultiStageMissionBatchPlan = {
    ...mission,
    checkpointRewardsGranted,
    pendingDecision: { stageId: stage.id, expiresAtStep },
  };

  insertBatch(context.batches, {
    ...entry,
    completeAtStep: expiresAtStep,
    mission: updatedMission,
  });
}

function handleStageCompletionBatch(
  context: DeliverDueBatchesContext,
  entry: TransformBatchQueueEntry,
  mission: MultiStageMissionBatchPlan,
  stage: MissionStageDefinition,
): void {
  const success = rollMissionStageSuccess(
    mission,
    context.transform.id,
    context.prdRegistry,
  );

  const checkpointResult = applyStageCheckpointRewards(
    context,
    entry,
    mission,
    stage,
    success,
  );

  publishMissionStageCompleted(
    context,
    entry,
    stage,
    checkpointResult.checkpointOutputs,
  );

  const missionAfterCheckpoint: MultiStageMissionBatchPlan = {
    ...mission,
    checkpointRewardsGranted: checkpointResult.checkpointRewardsGranted,
  };

  if (!success) {
    completeMultiStageMissionOnStageFailure(
      context,
      entry,
      missionAfterCheckpoint,
      stage,
    );
    return;
  }

  if (stage.decision) {
    scheduleMissionDecision(
      context,
      entry,
      missionAfterCheckpoint,
      stage,
      stage.decision,
      checkpointResult.checkpointRewardsGranted,
    );
    return;
  }

  const nextStageId = stage.nextStage ?? null;
  if (nextStageId === null) {
    completeMultiStageMissionAfterSuccessStage(
      context,
      entry,
      missionAfterCheckpoint,
      stage,
    );
    return;
  }

  rescheduleMissionEntry(context, entry, missionAfterCheckpoint, nextStageId);
}

function deliverDueMultiStageMissionBatch(
  context: DeliverDueBatchesContext,
  entry: TransformBatchQueueEntry,
  mission: MultiStageMissionBatchPlan,
): void {
  const stageId = mission.pendingDecision?.stageId ?? mission.currentStageId;
  const stage = context.transform.stages?.find(
    (candidate) => candidate.id === stageId,
  );

  if (!stage) {
    completeMultiStageMissionFailure(context, entry, mission);
    return;
  }

  if (mission.pendingDecision) {
    handlePendingDecisionBatch(context, entry, mission, stage);
    return;
  }

  handleStageCompletionBatch(context, entry, mission, stage);
}

function deliverDueBatchEntry(
  context: DeliverDueBatchesContext,
  entry: TransformBatchQueueEntry,
): void {
  const transformId = context.transform.id;

  if (context.transform.mode !== 'mission' || !entry.mission) {
    completeStandardBatch(
      entry,
      transformId,
      context.resourceState,
      context.step,
      context.entitySystem,
    );
    return;
  }

  const missionPlan = entry.mission;
  if (
    !isMultiStageMissionPlan(missionPlan) ||
    !context.transform.stages ||
    context.transform.stages.length === 0
  ) {
    completeMissionBatch(
      entry,
      transformId,
      context.resourceState,
      context.step,
      context.entitySystem,
      context.prdRegistry,
      context.events,
    );
    return;
  }

  deliverDueMultiStageMissionBatch(context, entry, missionPlan);
}

function deliverDueBatches(context: DeliverDueBatchesContext): void {
  const { batches, step } = context;
  if (batches.length === 0) {
    return;
  }

  while (batches.length > 0 && batches[0].completeAtStep <= step) {
    const entry = batches.shift();
    if (!entry) {
      return;
    }

    deliverDueBatchEntry(context, entry);
  }
}

function isEventBasedTrigger(transform: TransformDefinition): boolean {
  return transform.trigger.kind === 'event' || transform.trigger.kind === 'automation';
}

function evaluateTrigger(
  transform: TransformDefinition,
  pendingEventTriggers: Set<string>,
  conditionContext: ConditionContext | undefined,
): boolean {
  switch (transform.trigger.kind) {
    case 'condition':
      return conditionContext
        ? evaluateCondition(transform.trigger.condition, conditionContext)
        : false;
    case 'event':
    case 'automation':
      return pendingEventTriggers.has(transform.id);
    default:
      return false;
  }
}

function updateTransformUnlockStatus(
  transform: TransformDefinition,
  state: TransformState,
  conditionContext: ConditionContext | undefined,
): void {
  if (state.unlocked) {
    return;
  }
  if (!transform.unlockCondition) {
    state.unlocked = true;
    return;
  }
  if (conditionContext && evaluateCondition(transform.unlockCondition, conditionContext)) {
    state.unlocked = true;
  }
}

type ProcessTransformResult = 'skipped' | 'blocked' | 'executed';

function processTriggeredTransform(
  transform: TransformDefinition,
  state: TransformState,
  step: number,
  formulaContext: FormulaEvaluationContext,
  events: EventPublisher | undefined,
  limits: EngineConfig['limits'],
  executeTransformRun: (
    transform: TransformDefinition,
    state: TransformState,
    step: number,
    formulaContext: FormulaEvaluationContext,
    events: EventPublisher | undefined,
  ) => TransformExecutionResult,
): ProcessTransformResult {
  if (isTransformCooldownActive(state, step)) {
    return 'blocked';
  }

  const maxRuns = getEffectiveMaxRunsPerTick(transform, limits);
  if (state.runsThisTick >= maxRuns) {
    return 'blocked';
  }

  const result = executeTransformRun(transform, state, step, formulaContext, events);
  return result.success ? 'executed' : 'blocked';
}

type DeliverAllDueBatchesContext = Readonly<{
  readonly sortedTransforms: readonly TransformDefinition[];
  readonly transformStates: Map<string, TransformState>;
  readonly resourceState: TransformResourceState;
  readonly step: number;
  readonly stepDurationMs: number;
  readonly formulaContext: FormulaEvaluationContext;
  readonly conditionContext?: ConditionContext;
  readonly entitySystem?: EntitySystem;
  readonly prdRegistry: PRDRegistry;
  readonly events?: EventPublisher;
}>;

function deliverAllDueBatches(context: DeliverAllDueBatchesContext): void {
  for (const transform of context.sortedTransforms) {
    const state = context.transformStates.get(transform.id);
    const batches = (state?.batches ?? []) as TransformBatchQueueEntry[];
    if (batches.length === 0) {
      continue;
    }

    deliverDueBatches({
      transform,
      batches,
      resourceState: context.resourceState,
      step: context.step,
      stepDurationMs: context.stepDurationMs,
      formulaContext: context.formulaContext,
      conditionContext: context.conditionContext,
      entitySystem: context.entitySystem,
      prdRegistry: context.prdRegistry,
      events: context.events,
    });
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
  makeMissionDecision: (
    transformId: string,
    batchId: string,
    stageId: string,
    optionId: string,
    step: number,
    options?: { events?: EventPublisher },
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
  const limits = resolveEngineConfig(options.config).limits;

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

  const resolveMissionDurationSteps = (
    transform: TransformDefinition,
    formulaContext: FormulaEvaluationContext,
  ): { ok: true; durationSteps: number } | { ok: false; result: TransformExecutionResult } => {
    const stages = transform.mode === 'mission' ? transform.stages : undefined;
    if (stages?.length) {
      const initialStageId = transform.initialStage ?? stages[0]?.id;
      const initialStage =
        stages.find((stage) => stage.id === initialStageId) ?? stages[0];
      if (!initialStage) {
        return {
          ok: false,
          result: {
            success: false,
            error: {
              code: 'INVALID_STAGE',
              message: 'Mission stage definition missing for multi-stage mission.',
              details: { transformId: transform.id, stageId: initialStageId },
            },
          },
        };
      }

      const durationMs = evaluateNumericFormula(initialStage.duration, formulaContext);
      if (!Number.isFinite(durationMs)) {
        return {
          ok: false,
          result: {
            success: false,
            error: {
              code: 'INVALID_DURATION_FORMULA',
              message: 'Mission stage duration formula evaluated to non-finite value.',
              details: { transformId: transform.id, stageId: initialStage.id },
            },
          },
        };
      }

      const durationSteps = calculateDurationStepsFromMs(durationMs, stepDurationMs);
      return { ok: true, durationSteps };
    }

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

    return { ok: true, durationSteps };
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
    const durationResult = resolveMissionDurationSteps(transform, formulaContext);
    if (!durationResult.ok) {
      return durationResult;
    }
    const durationSteps = durationResult.durationSteps;

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

      const successOutcome = prepareMissionOutcomePlan(
        transform,
        missionOutcomes?.success,
        formulaContext,
        resourceState,
      );
      if (!successOutcome.ok) {
        return { ok: false, result: successOutcome.result };
      }

      // Missing failure outcome means no rewards on failure.
      const failureOutcome = missionOutcomes?.failure
        ? prepareMissionOutcomePlan(
            transform,
            missionOutcomes?.failure,
            formulaContext,
            resourceState,
          )
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

        const criticalPrepared = prepareMissionOutcomePlan(
          transform,
          missionOutcomes.critical,
          formulaContext,
          resourceState,
        );
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

    type MissionPlanForRunResult =
      | {
          readonly ok: true;
          readonly missionPlan: MissionBatchPlan;
          readonly hasStages: boolean;
        }
      | { readonly ok: false; readonly result: TransformExecutionResult };

    const buildMissionPlanForRun = (
      params: Readonly<{
        readonly transform: TransformDefinition;
        readonly basePlan: MissionBatchPlanBase;
        readonly assignmentResult: MissionAssignmentSuccess;
        readonly formulaContext: FormulaEvaluationContext;
        readonly step: number;
      }>,
    ): MissionPlanForRunResult => {
      const { transform, basePlan, assignmentResult, formulaContext, step } = params;
      const stages = transform.stages;
      if (!stages?.length) {
        return { ok: true, missionPlan: basePlan, hasStages: false };
      }

      const initialStageCandidate = transform.initialStage ?? stages[0]?.id;
      const initialStage =
        stages.find((stage) => stage.id === initialStageCandidate) ?? stages[0];
      if (!initialStage) {
        return {
          ok: false,
          result: {
            success: false,
            error: {
              code: 'INVALID_STAGE',
              message: 'Mission stage definition missing for multi-stage mission.',
              details: { transformId: transform.id, stageId: initialStageCandidate },
            },
          },
        };
      }

      const stageSuccessRateRaw = initialStage.stageSuccessRate
        ? evaluateNumericFormula(initialStage.stageSuccessRate, formulaContext)
        : basePlan.baseRate;
      if (!Number.isFinite(stageSuccessRateRaw)) {
        return {
          ok: false,
          result: {
            success: false,
            error: {
              code: 'INVALID_SUCCESS_RATE',
              message: 'Mission stage success rate evaluated to non-finite value.',
              details: { transformId: transform.id, stageId: initialStage.id },
            },
          },
        };
      }

      const accumulatedModifiers: MultiStageMissionAccumulatedModifiers = {
        successRateBonus: 0,
        durationMultiplier: 1,
        outputMultiplier: 1,
      };

      const currentStageSuccessRate = clampProbability(
        clampProbability(stageSuccessRateRaw) + accumulatedModifiers.successRateBonus,
      );

      let checkpointPrepared: MissionPreparedOutcome | undefined;
      if (initialStage.checkpoint) {
        const checkpointResult = prepareMissionOutcomePlan(
          transform,
          initialStage.checkpoint as unknown as MissionOutcome,
          formulaContext,
          resourceState,
        );
        if (!checkpointResult.ok) {
          return { ok: false, result: checkpointResult.result };
        }
        checkpointPrepared = scaleMissionPreparedOutcome(checkpointResult.prepared, 1);
      }

      const returnOnCompleteEntityInstanceIds = assignmentResult.instanceIds
        .filter((instanceId) => assignmentResult.assignments.get(instanceId) ?? true)
        .sort(compareStableStrings);

      return {
        ok: true,
        missionPlan: {
          ...basePlan,
          currentStageId: initialStage.id,
          currentStageStartStep: step,
          currentStageSuccessRate,
          ...(checkpointPrepared ? { currentStageCheckpoint: checkpointPrepared } : {}),
          checkpointRewardsGranted: [],
          accumulatedModifiers,
          returnOnCompleteEntityInstanceIds,
        },
        hasStages: true,
      };
    };

    const assignMissionEntitiesToBatch = (
      params: Readonly<{
        readonly missionEntitySystem: EntitySystem;
        readonly assignmentResult: MissionAssignmentSuccess;
        readonly transformId: string;
        readonly batchId: string;
        readonly deployedAtStep: number;
        readonly completeAtStep: number;
        readonly hasStages: boolean;
      }>,
    ): void => {
      for (const instanceId of params.assignmentResult.instanceIds) {
        const returnOnComplete =
          params.assignmentResult.assignments.get(instanceId) ?? true;
        let returnStep = Number.MAX_SAFE_INTEGER;
        if (!params.hasStages && returnOnComplete) {
          returnStep = params.completeAtStep;
        }

        params.missionEntitySystem.assignToMission(instanceId, {
          missionId: params.transformId,
          batchId: params.batchId,
          deployedAtStep: params.deployedAtStep,
          returnStep,
        });
      }
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
      const maxOutstanding = getEffectiveMaxOutstandingBatches(transform, limits);
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

      const basePlan: MissionBatchPlanBase = planResult.plan;
      const missionPlanResult = buildMissionPlanForRun({
        transform,
        basePlan,
        assignmentResult: inputsResult.assignmentResult,
        formulaContext,
        step,
      });
      if (!missionPlanResult.ok) {
        return missionPlanResult.result;
      }

      assignMissionEntitiesToBatch({
        missionEntitySystem,
        assignmentResult: inputsResult.assignmentResult,
        transformId: transform.id,
        batchId,
        deployedAtStep: step,
        completeAtStep,
        hasStages: missionPlanResult.hasStages,
      });

      const batchEntry: TransformBatchQueueEntry = {
        completeAtStep,
        sequence,
        batchId,
        outputs: [],
        ...(inputsResult.assignmentResult.instanceIds.length > 0
          ? { entityInstanceIds: inputsResult.assignmentResult.instanceIds }
          : {}),
        mission: missionPlanResult.missionPlan,
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
      const maxOutstanding = getEffectiveMaxOutstandingBatches(transform, limits);
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

  const processTransformTick = (
    transform: TransformDefinition,
    step: number,
    formulaContext: ReturnType<typeof createTransformFormulaEvaluationContext>,
    events: EventPublisher,
    retainedEventTriggers: Set<string>,
  ): void => {
    const state = transformStates.get(transform.id);
    if (!state) {
      return;
    }

    // Update visibility each tick (default visible when no context is provided)
    state.visible = conditionContext
      ? evaluateCondition(transform.visibilityCondition, conditionContext)
      : true;

    updateTransformUnlockStatus(transform, state, conditionContext);

    const isEventBased = isEventBasedTrigger(transform);
    const isEventPending = isEventBased && pendingEventTriggers.has(transform.id);

    // Skip if not unlocked
    if (!state.unlocked) {
      if (isEventPending) {
        retainedEventTriggers.add(transform.id);
      }
      return;
    }

    // Skip manual transforms (handled by command)
    if (transform.trigger.kind === 'manual') {
      return;
    }

    const triggered = evaluateTrigger(transform, pendingEventTriggers, conditionContext);
    if (!triggered) {
      return;
    }

    const result = processTriggeredTransform(
      transform,
      state,
      step,
      formulaContext,
      events,
      limits,
      executeTransformRun,
    );

    if (result === 'blocked' && isEventBased) {
      retainedEventTriggers.add(transform.id);
    }
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
    const maxRuns = getEffectiveMaxRunsPerTick(transform, limits);
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

  type MissionDecisionBatchContext = Readonly<{
    readonly transform: TransformDefinition;
    readonly stage: MissionStageDefinition;
    readonly option: MissionDecisionOptionDefinition;
    readonly entry: TransformBatchQueueEntry;
    readonly mission: MultiStageMissionBatchPlan;
    readonly batchQueue: TransformBatchQueueEntry[];
    readonly entryIndex: number;
  }>;

  type MissionDecisionBatchContextResult =
    | { readonly ok: true; readonly context: MissionDecisionBatchContext }
    | { readonly ok: false; readonly result: TransformExecutionResult };

  const resolveMissionDecisionBatchContext = (
    transformId: string,
    batchId: string,
    stageId: string,
    optionId: string,
  ): MissionDecisionBatchContextResult => {
    const transform = transformById.get(transformId);
    if (!transform) {
      return {
        ok: false,
        result: {
          success: false,
          error: {
            code: 'UNKNOWN_TRANSFORM',
            message: `Transform "${transformId}" not found.`,
            details: { transformId },
          },
        },
      };
    }

    if (transform.mode !== 'mission' || !transform.stages?.length) {
      return {
        ok: false,
        result: {
          success: false,
          error: {
            code: 'INVALID_TRANSFORM_MODE',
            message: 'Transform is not a multi-stage mission.',
            details: { transformId, mode: transform.mode },
          },
        },
      };
    }

    const state = transformStates.get(transformId);
    if (!state?.batches) {
      return {
        ok: false,
        result: {
          success: false,
          error: {
            code: 'STATE_NOT_FOUND',
            message: `Transform state for "${transformId}" not found.`,
            details: { transformId },
          },
        },
      };
    }

    const batchQueue = state.batches as TransformBatchQueueEntry[];
    const entryIndex = batchQueue.findIndex((entry) => entry.batchId === batchId);
    if (entryIndex === -1) {
      return {
        ok: false,
        result: {
          success: false,
          error: {
            code: 'UNKNOWN_MISSION_BATCH',
            message: 'Mission batch not found.',
            details: { transformId, batchId },
          },
        },
      };
    }

    const entry = batchQueue[entryIndex];
    if (!entry) {
      return {
        ok: false,
        result: {
          success: false,
          error: {
            code: 'UNKNOWN_MISSION_BATCH',
            message: 'Mission batch not found.',
            details: { transformId, batchId },
          },
        },
      };
    }

    const mission = entry.mission;
    if (!mission || !isMultiStageMissionPlan(mission)) {
      return {
        ok: false,
        result: {
          success: false,
          error: {
            code: 'INVALID_MISSION_BATCH',
            message: 'Mission batch does not contain multi-stage mission state.',
            details: { transformId, batchId },
          },
        },
      };
    }

    if (!mission.pendingDecision) {
      return {
        ok: false,
        result: {
          success: false,
          error: {
            code: 'NO_PENDING_DECISION',
            message: 'Mission batch does not have a pending decision.',
            details: { transformId, batchId },
          },
        },
      };
    }

    if (mission.pendingDecision.stageId !== stageId) {
      return {
        ok: false,
        result: {
          success: false,
          error: {
            code: 'DECISION_STAGE_MISMATCH',
            message: 'Decision stage id does not match the pending decision stage.',
            details: {
              transformId,
              batchId,
              expectedStageId: mission.pendingDecision.stageId,
              stageId,
            },
          },
        },
      };
    }

    const stage = transform.stages.find((candidate) => candidate.id === stageId);
    if (!stage?.decision) {
      return {
        ok: false,
        result: {
          success: false,
          error: {
            code: 'INVALID_STAGE',
            message: 'Stage definition missing a decision block.',
            details: { transformId, batchId, stageId },
          },
        },
      };
    }

    const option = stage.decision.options.find(
      (candidate) => candidate.id === optionId,
    );
    if (!option) {
      return {
        ok: false,
        result: {
          success: false,
          error: {
            code: 'UNKNOWN_DECISION_OPTION',
            message: 'Decision option id not found.',
            details: { transformId, batchId, stageId, optionId },
          },
        },
      };
    }

    return {
      ok: true,
      context: {
        transform,
        stage,
        option,
        entry,
        mission,
        batchQueue,
        entryIndex,
      },
    };
  };

  const makeMissionDecision = (
    transformId: string,
    batchId: string,
    stageId: string,
    optionId: string,
    step: number,
    decisionOptions?: { events?: EventPublisher },
  ): TransformExecutionResult => {
    const contextResult = resolveMissionDecisionBatchContext(
      transformId,
      batchId,
      stageId,
      optionId,
    );
    if (!contextResult.ok) {
      return contextResult.result;
    }

    const { transform, stage, option, entry, mission, batchQueue, entryIndex } =
      contextResult.context;

    const available = option.condition
      ? Boolean(conditionContext && evaluateCondition(option.condition, conditionContext))
      : true;
    if (!available) {
      return {
        success: false,
        error: {
          code: 'DECISION_OPTION_UNAVAILABLE',
          message: 'Decision option is not available.',
          details: { transformId, batchId, stageId, optionId },
        },
      };
    }

    const formulaContext = createTransformFormulaEvaluationContext({
      currentStep: step,
      stepDurationMs,
      resourceState,
      conditionContext,
    });

    const missionAfterDecision: MultiStageMissionBatchPlan = {
      ...mission,
      accumulatedModifiers: applyMissionDecisionModifiers(
        mission.accumulatedModifiers,
        option.modifiers,
        formulaContext,
      ),
      pendingDecision: undefined,
    };

    if (option.nextStage === null) {
      const { outcomeKind, baseOutcome } =
        resolveMissionCompletionOutcomeKind(missionAfterDecision);

      const overrideOutcome =
        outcomeKind === 'success' && stage.stageOutcomes?.success
          ? prepareMissionOutcomePlan(
              transform,
              stage.stageOutcomes.success as unknown as MissionOutcome,
              formulaContext,
              resourceState,
            )
          : undefined;

      if (overrideOutcome && !overrideOutcome.ok) {
        return overrideOutcome.result;
      }

      const resolvedOutcome = isPreparedMissionOutcomeResult(overrideOutcome)
        ? overrideOutcome.prepared
        : baseOutcome;

      batchQueue.splice(entryIndex, 1);

      publishMissionEvent(
        decisionOptions?.events,
        'mission:decision-made',
        {
          transformId,
          batchId,
          stageId,
          optionId,
          nextStageId: option.nextStage,
        },
        transformId,
      );

      completeMultiStageMission({
        entry,
        mission: missionAfterDecision,
        transformId,
        resourceState,
        step,
        outcomeKind,
        outcome: resolvedOutcome,
        entitySystem,
        events: decisionOptions?.events,
      });

      return { success: true };
    }

    const nextStageResult = scheduleMultiStageMissionStage({
      transform,
      mission: missionAfterDecision,
      stageId: option.nextStage,
      step,
      stepDurationMs,
      formulaContext,
      resourceState,
    });
    if (!nextStageResult.ok) {
      return nextStageResult.result;
    }

    const updatedEntry: TransformBatchQueueEntry = {
      ...entry,
      completeAtStep: nextStageResult.completeAtStep,
      mission: nextStageResult.mission,
    };

    batchQueue.splice(entryIndex, 1);

    publishMissionEvent(
      decisionOptions?.events,
      'mission:decision-made',
      {
        transformId,
        batchId,
        stageId,
        optionId,
        nextStageId: option.nextStage,
      },
      transformId,
    );

    insertBatch(batchQueue, updatedEntry);
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
      const rebaseDelta =
        typeof savedWorkerStep === 'number' && Number.isFinite(savedWorkerStep)
          ? targetCurrentStep - savedWorkerStep
          : 0;

      for (const entry of stateArray) {
        restoreTransformStateEntry(
          entry,
          transformStates,
          batchSequences,
          rebaseDelta,
        );
      }
    },

    executeTransform,

    makeMissionDecision,

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
      deliverAllDueBatches({
        sortedTransforms,
        transformStates,
        resourceState,
        step,
        stepDurationMs,
        formulaContext,
        conditionContext,
        entitySystem,
        prdRegistry,
        events,
      });

      // Collect event triggers to retain across ticks when blocked
      const retainedEventTriggers = new Set<string>();

      // Evaluate each transform in deterministic order
      for (const transform of sortedTransforms) {
        processTransformTick(transform, step, formulaContext, events, retainedEventTriggers);
      }

      // Deliver any same-step batches scheduled during trigger evaluation.
      deliverAllDueBatches({
        sortedTransforms,
        transformStates,
        resourceState,
        step,
        stepDurationMs,
        formulaContext,
        conditionContext,
        entitySystem,
        prdRegistry,
        events,
      });

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
