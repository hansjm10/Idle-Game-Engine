import { RUNTIME_COMMAND_TYPES, type ToggleAutomationPayload } from './command.js';
import type { CommandDispatcher, CommandHandler } from './command-dispatcher.js';
import type { createAutomationSystem } from './automation-system.js';
import { telemetry } from './telemetry.js';

/**
 * Options for registering automation command handlers.
 */
export interface AutomationCommandHandlerOptions {
  readonly dispatcher: CommandDispatcher;
  readonly automationSystem: ReturnType<typeof createAutomationSystem>;
}

/**
 * Registers command handlers for automation control commands.
 *
 * Currently registers:
 * - TOGGLE_AUTOMATION: Enable/disable automation by ID
 *
 * @param options - Configuration with dispatcher and automation system
 *
 * @example
 * ```typescript
 * registerAutomationCommandHandlers({
 *   dispatcher: runtime.getCommandDispatcher(),
 *   automationSystem,
 * });
 * ```
 */
export function registerAutomationCommandHandlers(
  options: AutomationCommandHandlerOptions,
): void {
  const { dispatcher, automationSystem } = options;

  dispatcher.register<ToggleAutomationPayload>(
    RUNTIME_COMMAND_TYPES.TOGGLE_AUTOMATION,
    createToggleAutomationHandler(automationSystem),
  );
}

/**
 * Creates a command handler for toggling automation enabled state.
 *
 * Validates payload, updates automation state, and publishes automation:toggled event.
 * Handles invalid payloads and non-existent automations gracefully with telemetry.
 *
 * @param automationSystem - The automation system to modify
 * @returns Command handler function
 */
function createToggleAutomationHandler(
  automationSystem: ReturnType<typeof createAutomationSystem>,
): CommandHandler<ToggleAutomationPayload> {
  return (payload, context) => {
    // Validate payload
    if (
      typeof payload.automationId !== 'string' ||
      payload.automationId.trim().length === 0
    ) {
      telemetry.recordError('ToggleAutomationInvalidId', {
        automationId: payload.automationId,
        step: context.step,
        priority: context.priority,
      });
      return {
        success: false,
        error: {
          code: 'INVALID_AUTOMATION_ID',
          message: 'Automation id must be a non-empty string.',
        },
      };
    }

    if (typeof payload.enabled !== 'boolean') {
      telemetry.recordError('ToggleAutomationInvalidEnabled', {
        automationId: payload.automationId,
        enabled: payload.enabled,
        step: context.step,
        priority: context.priority,
      });
      return {
        success: false,
        error: {
          code: 'INVALID_AUTOMATION_ENABLED',
          message: 'Automation enabled flag must be a boolean.',
        },
      };
    }

    // Get automation state
    const state = automationSystem.getState();
    const automationState = state.get(payload.automationId);

    if (!automationState) {
      telemetry.recordWarning('ToggleAutomationNotFound', {
        automationId: payload.automationId,
        step: context.step,
        priority: context.priority,
      });
      return {
        success: false,
        error: {
          code: 'UNKNOWN_AUTOMATION',
          message: 'Automation not found.',
          details: {
            automationId: payload.automationId,
          },
        },
      };
    }

    // Update state directly (mutable operation on internal state)
    automationState.enabled = payload.enabled;

    // Publish event
    context.events.publish(
      'automation:toggled',
      {
        automationId: payload.automationId,
        enabled: payload.enabled,
      },
      { issuedAt: context.timestamp },
    );
  };
}
