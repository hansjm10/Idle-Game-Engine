import { RUNTIME_COMMAND_TYPES, type RunTransformPayload } from './command.js';
import type { CommandDispatcher, CommandHandler } from './command-dispatcher.js';
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
    if (
      typeof payload.transformId !== 'string' ||
      payload.transformId.trim().length === 0
    ) {
      telemetry.recordError('RunTransformInvalidId', {
        transformId: payload.transformId,
        step: context.step,
        priority: context.priority,
      });
      return {
        success: false,
        error: {
          code: 'INVALID_TRANSFORM_ID',
          message: 'Transform id must be a non-empty string.',
        },
      };
    }

    // Validate runs parameter if provided
    if (payload.runs !== undefined) {
      if (
        typeof payload.runs !== 'number' ||
        !Number.isFinite(payload.runs) ||
        payload.runs < 1
      ) {
        telemetry.recordError('RunTransformInvalidRuns', {
          transformId: payload.transformId,
          runs: payload.runs,
          step: context.step,
          priority: context.priority,
        });
        return {
          success: false,
          error: {
            code: 'INVALID_RUNS',
            message: 'Runs must be a positive integer.',
          },
        };
      }
    }

    // Execute transform
    const result = transformSystem.executeTransform(
      payload.transformId,
      context.step,
      { runs: payload.runs },
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
