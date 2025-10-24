/**
 * Deterministic fixed-timestep scheduler that coordinates foreground ticks,
 * offline catch-up, and background throttling for the Idle Engine runtime.
 *
 * The scheduler maintains an accumulator of elapsed milliseconds and executes
 * discrete simulation steps through the provided callback. Hosts may adjust
 * tick cadence by toggling background throttling or invoking offline catch-up
 * batches with hour caps to avoid runaway progression.
 */

export interface SchedulerStepExecutionContext {
  /**
   * Milliseconds of accumulated backlog remaining after the step completes.
   * Useful for diagnostics surfaces to report queue depth.
   */
  readonly backlogMs: number;
  /**
   * Whether the step is part of an offline catch-up batch.
   */
  readonly isCatchUp: boolean;
  /**
   * Whether the step is the first one executed in the current batch. Runtime
   * consumers use this flag to reset outbound event buffers exactly once.
   */
  readonly isFirstInBatch: boolean;
}

export type SchedulerStepExecutor = (
  context: SchedulerStepExecutionContext,
) => void;

export interface FixedTimestepSchedulerOptions {
  /**
   * Size of a single deterministic step in milliseconds. Defaults to 100ms as
   * described in the runtime design.
   */
  readonly stepSizeMs?: number;
  /**
   * Maximum number of steps to execute during a foreground frame. Guards
   * against spiral-of-death scenarios when large deltas accumulate.
   */
  readonly maxForegroundStepsPerFrame?: number;
  /**
   * Maximum number of steps to execute per frame when throttled (e.g. browser
   * tab in the background). The scheduler retains the remaining backlog so the
   * simulation can deterministically catch up once the shell returns to the
   * foreground.
   */
  readonly maxBackgroundStepsPerFrame?: number;
  /**
   * Maximum real world duration (ms) to simulate during offline catch-up. Any
   * overflow beyond this cap is returned to the caller so it can be persisted
   * and replayed during a subsequent session.
   */
  readonly maxOfflineCatchUpMs?: number;
  /**
   * Upper bound on the number of steps executed in a single offline batch. The
   * scheduler slices large backlogs into predictable chunks to avoid starving
   * event loops during resume.
   */
  readonly maxOfflineBatchSteps?: number;
}

export interface AdvanceResult {
  readonly executedSteps: number;
  readonly backlogMs: number;
}

export interface OfflineCatchUpResult {
  /**
   * Milliseconds requested by the caller (after clamping to non-negative).
   */
  readonly requestedMs: number;
  /**
   * Milliseconds of the provided backlog that were simulated. Always less
   * than or equal to {@link requestedMs}.
   */
  readonly simulatedMs: number;
  /**
   * Number of deterministic steps executed while replaying the backlog. May
   * include steps triggered by pre-existing accumulator residue.
   */
  readonly executedSteps: number;
  /**
   * Overflow milliseconds that exceeded the configured offline cap. Hosts
   * should persist this remainder for a future session.
   */
  readonly overflowMs: number;
  /**
   * Accumulator remainder retained by the scheduler after catch-up completes.
   * Always less than a single step.
   */
  readonly backlogMs: number;
}

const DEFAULT_STEP_MS = 100;
const DEFAULT_FOREGROUND_MAX_STEPS = 50;
const DEFAULT_BACKGROUND_MAX_STEPS = 1;
const DEFAULT_OFFLINE_MAX_MS = 12 * 60 * 60 * 1000; // 12 hours.
const DEFAULT_OFFLINE_BATCH_STEPS = 500;

export class FixedTimestepScheduler {
  private accumulatorMs = 0;
  private readonly executeStep: SchedulerStepExecutor;
  private stepSizeMs: number;
  private maxForegroundStepsPerFrame: number;
  private maxBackgroundStepsPerFrame: number;
  private readonly maxOfflineCatchUpMs: number;
  private readonly maxOfflineBatchSteps: number;
  private throttled = false;

  constructor(
    executor: SchedulerStepExecutor,
    options: FixedTimestepSchedulerOptions = {},
  ) {
    if (typeof executor !== 'function') {
      throw new Error('FixedTimestepScheduler requires an executeStep callback.');
    }

    this.executeStep = executor;
    this.stepSizeMs = resolvePositiveNumber(
      options.stepSizeMs,
      DEFAULT_STEP_MS,
    );
    this.maxForegroundStepsPerFrame = clampPositiveInteger(
      options.maxForegroundStepsPerFrame,
      DEFAULT_FOREGROUND_MAX_STEPS,
    );
    this.maxBackgroundStepsPerFrame = clampPositiveInteger(
      options.maxBackgroundStepsPerFrame,
      DEFAULT_BACKGROUND_MAX_STEPS,
    );
    this.maxOfflineCatchUpMs = resolvePositiveNumber(
      options.maxOfflineCatchUpMs,
      DEFAULT_OFFLINE_MAX_MS,
    );
    this.maxOfflineBatchSteps = clampPositiveInteger(
      options.maxOfflineBatchSteps,
      DEFAULT_OFFLINE_BATCH_STEPS,
    );
  }

  setStepSize(stepSizeMs: number): void {
    this.stepSizeMs = resolvePositiveNumber(stepSizeMs, this.stepSizeMs);
  }

  setForegroundStepLimit(limit: number): void {
    this.maxForegroundStepsPerFrame = clampPositiveInteger(
      limit,
      this.maxForegroundStepsPerFrame,
    );
  }

  setBackgroundStepLimit(limit: number): void {
    this.maxBackgroundStepsPerFrame = clampPositiveInteger(
      limit,
      this.maxBackgroundStepsPerFrame,
    );
  }

  setThrottled(throttled: boolean): void {
    this.throttled = Boolean(throttled);
  }

  advance(deltaMs: number): AdvanceResult {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
      return {
        executedSteps: 0,
        backlogMs: this.accumulatorMs,
      };
    }

    this.accumulatorMs += deltaMs;
    const stepsAvailable = Math.floor(this.accumulatorMs / this.stepSizeMs);

    const maxSteps = this.throttled
      ? this.maxBackgroundStepsPerFrame
      : this.maxForegroundStepsPerFrame;

    const stepsToExecute = Math.min(stepsAvailable, maxSteps);
    if (stepsToExecute <= 0) {
      return {
        executedSteps: 0,
        backlogMs: this.accumulatorMs,
      };
    }

    for (let index = 0; index < stepsToExecute; index += 1) {
      this.accumulatorMs -= this.stepSizeMs;
      this.executeStep({
        backlogMs: this.accumulatorMs,
        isCatchUp: false,
        isFirstInBatch: index === 0,
      });
    }

    return {
      executedSteps: stepsToExecute,
      backlogMs: this.accumulatorMs,
    };
  }

  catchUp(elapsedMs: number): OfflineCatchUpResult {
    const normalizedRequest = Number.isFinite(elapsedMs)
      ? Math.max(0, elapsedMs)
      : 0;

    if (normalizedRequest <= 0) {
      return {
        requestedMs: 0,
        simulatedMs: 0,
        executedSteps: 0,
        overflowMs: 0,
        backlogMs: this.accumulatorMs,
      };
    }

    const priorAccumulator = this.accumulatorMs;
    const clampedRequest = Math.min(
      normalizedRequest,
      this.maxOfflineCatchUpMs,
    );
    const overflowMs = normalizedRequest - clampedRequest;

    this.accumulatorMs += clampedRequest;

    const totalStepsToExecute = Math.floor(
      this.accumulatorMs / this.stepSizeMs,
    );

    let executedSteps = 0;

    while (executedSteps < totalStepsToExecute) {
      const batchSteps = Math.min(
        this.maxOfflineBatchSteps,
        totalStepsToExecute - executedSteps,
      );

      for (let index = 0; index < batchSteps; index += 1) {
        this.accumulatorMs -= this.stepSizeMs;
        executedSteps += 1;
        this.executeStep({
          backlogMs: this.accumulatorMs,
          isCatchUp: true,
          isFirstInBatch: index === 0,
        });
      }
    }

    const totalSimulatedMs = executedSteps * this.stepSizeMs;
    const consumedFromPriorBacklog = Math.min(
      priorAccumulator,
      totalSimulatedMs,
    );
    const simulatedFromRequest = Math.min(
      clampedRequest,
      Math.max(0, totalSimulatedMs - consumedFromPriorBacklog),
    );

    return {
      requestedMs: normalizedRequest,
      simulatedMs: simulatedFromRequest,
      executedSteps,
      overflowMs,
      backlogMs: this.accumulatorMs,
    };
  }

  getAccumulatorMs(): number {
    return this.accumulatorMs;
  }

  getStepSizeMs(): number {
    return this.stepSizeMs;
  }
}

function resolvePositiveNumber(
  value: number | undefined,
  fallback: number,
): number {
  if (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0
  ) {
    return value;
  }
  return fallback;
}

function clampPositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  if (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0
  ) {
    return Math.max(1, Math.floor(value));
  }
  return Math.max(1, Math.floor(fallback));
}
