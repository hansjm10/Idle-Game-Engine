import type {
  CommandHandlerResult,
  ExecutionContext,
} from './command-dispatcher.js';
import { telemetry } from './telemetry.js';

export type ValidationError = Readonly<{
  code: string;
  message: string;
  details?: Record<string, unknown>;
}>;

const recordValidationError = (
  eventName: string,
  context: ExecutionContext,
  details: Record<string, unknown>,
): void => {
  telemetry.recordError(eventName, {
    ...details,
    step: context.step,
    priority: context.priority,
  });
};

const createValidationFailure = (
  error: ValidationError,
): CommandHandlerResult => ({
  success: false,
  error: error.details
    ? { code: error.code, message: error.message, details: error.details }
    : { code: error.code, message: error.message },
});

export const validateField = (
  isValid: boolean,
  context: ExecutionContext,
  eventName: string,
  details: Record<string, unknown>,
  error: ValidationError,
): CommandHandlerResult | undefined => {
  if (isValid) {
    return undefined;
  }

  recordValidationError(eventName, context, details);
  return createValidationFailure(error);
};

export const validateNonEmptyString = (
  value: unknown,
  context: ExecutionContext,
  eventName: string,
  details: Record<string, unknown>,
  error: ValidationError,
): CommandHandlerResult | undefined =>
  validateField(
    typeof value === 'string' && value.trim().length > 0,
    context,
    eventName,
    details,
    error,
  );

export const validatePositiveInteger = (
  value: unknown,
  context: ExecutionContext,
  eventName: string,
  details: Record<string, unknown>,
  error: ValidationError,
): CommandHandlerResult | undefined =>
  validateField(
    Number.isInteger(value) && (value as number) > 0,
    context,
    eventName,
    details,
    error,
  );

export const validatePositiveNumber = (
  value: unknown,
  context: ExecutionContext,
  eventName: string,
  details: Record<string, unknown>,
  error: ValidationError,
): CommandHandlerResult | undefined =>
  validateField(
    typeof value === 'number' && Number.isFinite(value) && value > 0,
    context,
    eventName,
    details,
    error,
  );

export const validateBoolean = (
  value: unknown,
  context: ExecutionContext,
  eventName: string,
  details: Record<string, unknown>,
  error: ValidationError,
): CommandHandlerResult | undefined =>
  validateField(
    typeof value === 'boolean',
    context,
    eventName,
    details,
    error,
  );
