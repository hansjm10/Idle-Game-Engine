import {
  RUNTIME_COMMAND_TYPES,
  type MakeMissionDecisionPayload,
  type RunTransformPayload,
} from './command.js';
import type { CommandDispatcher, CommandHandler } from './command-dispatcher.js';
import {
  validateNonEmptyString,
  validatePositiveInteger,
} from './command-validation.js';
import type { createTransformSystem } from './transform-system.js';
import { telemetry } from './telemetry.js';

/**
 * Options for registering transform command handlers.
 */
export interface TransformCommandHandlerOptions {
  readonly dispatcher: CommandDispatcher;
  readonly transformSystem: ReturnType<typeof createTransformSystem>;
}

/**
 * Registers command handlers for transform control commands.
 *
 * Currently registers:
 * - RUN_TRANSFORM: Execute a manual transform by ID
 * - MAKE_MISSION_DECISION: Submit a stage decision option
 *
 * @param options - Configuration with dispatcher and transform system
 *
 * @example
 * ```typescript
 * registerTransformCommandHandlers({
 *   dispatcher: runtime.getCommandDispatcher(),
 *   transformSystem,
 * });
 * ```
 */
export function registerTransformCommandHandlers(
  options: TransformCommandHandlerOptions,
): void {
  const { dispatcher, transformSystem } = options;

  dispatcher.register<RunTransformPayload>(
    RUNTIME_COMMAND_TYPES.RUN_TRANSFORM,
    createRunTransformHandler(transformSystem),
  );

  dispatcher.register<MakeMissionDecisionPayload>(
    RUNTIME_COMMAND_TYPES.MAKE_MISSION_DECISION,
    createMakeMissionDecisionHandler(transformSystem),
  );
}

/**
 * Creates a command handler for executing manual transforms.
 *
 * Validates payload, checks transform state, and executes the transform.
 * Handles invalid payloads and execution failures gracefully with telemetry.
 *
 * @param transformSystem - The transform system to execute against
 * @returns Command handler function
 */
function createRunTransformHandler(
  transformSystem: ReturnType<typeof createTransformSystem>,
): CommandHandler<RunTransformPayload> {
  return (payload, context) => {
    // Validate payload
    const invalidTransformId = validateNonEmptyString(
      payload.transformId,
      context,
      'RunTransformInvalidId',
      { transformId: payload.transformId },
      {
        code: 'INVALID_TRANSFORM_ID',
        message: 'Transform id must be a non-empty string.',
      },
    );
    if (invalidTransformId) {
      return invalidTransformId;
    }

    // Validate runs parameter if provided
    if (payload.runs !== undefined) {
      const invalidRuns = validatePositiveInteger(
        payload.runs,
        context,
        'RunTransformInvalidRuns',
        {
          transformId: payload.transformId,
          runs: payload.runs,
        },
        {
          code: 'INVALID_RUNS',
          message: 'Runs must be a positive integer.',
        },
      );
      if (invalidRuns) {
        return invalidRuns;
      }
    }

    // Execute transform
    const result = transformSystem.executeTransform(
      payload.transformId,
      context.step,
      { runs: payload.runs, events: context.events },
    );

    if (!result.success) {
      telemetry.recordWarning('RunTransformFailed', {
        transformId: payload.transformId,
        step: context.step,
        priority: context.priority,
        errorCode: result.error?.code,
        errorMessage: result.error?.message,
      });
      return {
        success: false,
        error: result.error ?? {
          code: 'EXECUTION_FAILED',
          message: 'Transform execution failed.',
        },
      };
    }

    return { success: true };
  };
}

function createMakeMissionDecisionHandler(
  transformSystem: ReturnType<typeof createTransformSystem>,
): CommandHandler<MakeMissionDecisionPayload> {
  return (payload, context) => {
    const invalidTransformId = validateNonEmptyString(
      payload.transformId,
      context,
      'MakeMissionDecisionInvalidTransformId',
      { transformId: payload.transformId },
      {
        code: 'INVALID_TRANSFORM_ID',
        message: 'Transform id must be a non-empty string.',
      },
    );
    if (invalidTransformId) {
      return invalidTransformId;
    }

    const invalidBatchId = validateNonEmptyString(
      payload.batchId,
      context,
      'MakeMissionDecisionInvalidBatchId',
      { transformId: payload.transformId, batchId: payload.batchId },
      {
        code: 'INVALID_BATCH_ID',
        message: 'Batch id must be a non-empty string.',
      },
    );
    if (invalidBatchId) {
      return invalidBatchId;
    }

    const invalidStageId = validateNonEmptyString(
      payload.stageId,
      context,
      'MakeMissionDecisionInvalidStageId',
      {
        transformId: payload.transformId,
        batchId: payload.batchId,
        stageId: payload.stageId,
      },
      {
        code: 'INVALID_STAGE_ID',
        message: 'Stage id must be a non-empty string.',
      },
    );
    if (invalidStageId) {
      return invalidStageId;
    }

    const invalidOptionId = validateNonEmptyString(
      payload.optionId,
      context,
      'MakeMissionDecisionInvalidOptionId',
      {
        transformId: payload.transformId,
        batchId: payload.batchId,
        stageId: payload.stageId,
        optionId: payload.optionId,
      },
      {
        code: 'INVALID_OPTION_ID',
        message: 'Option id must be a non-empty string.',
      },
    );
    if (invalidOptionId) {
      return invalidOptionId;
    }

    const result = transformSystem.makeMissionDecision(
      payload.transformId,
      payload.batchId,
      payload.stageId,
      payload.optionId,
      context.step,
      { events: context.events },
    );

    if (!result.success) {
      telemetry.recordWarning('MakeMissionDecisionFailed', {
        transformId: payload.transformId,
        batchId: payload.batchId,
        stageId: payload.stageId,
        optionId: payload.optionId,
        step: context.step,
        priority: context.priority,
        errorCode: result.error?.code,
        errorMessage: result.error?.message,
      });
      return {
        success: false,
        error: result.error ?? {
          code: 'EXECUTION_FAILED',
          message: 'Mission decision execution failed.',
        },
      };
    }

    return { success: true };
  };
}
