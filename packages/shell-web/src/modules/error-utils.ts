/**
 * Error handling utilities for runtime worker communication
 *
 * Provides type-safe utilities for extracting error details from unknown error
 * values, commonly used when catching errors in worker message handlers.
 */

/**
 * Type guard that checks if an error value contains a `details` property.
 *
 * @param error - The error value to check (typically from a catch block)
 * @returns True if the error is an object with a `details` property
 *
 * @example
 * ```typescript
 * try {
 *   riskyOperation();
 * } catch (error) {
 *   if (isErrorWithDetails(error)) {
 *     console.log(error.details); // Type-safe access
 *   }
 * }
 * ```
 */
export function isErrorWithDetails(
  error: unknown,
): error is { details: Record<string, unknown> } {
  return (
    error !== null &&
    typeof error === 'object' &&
    'details' in error &&
    typeof (error as { details?: unknown }).details === 'object' &&
    (error as { details?: unknown }).details !== null
  );
}

/**
 * Safely extracts the `details` property from an error value.
 *
 * @param error - The error value to extract details from
 * @returns The details object if present, otherwise undefined
 *
 * @example
 * ```typescript
 * try {
 *   exportSnapshot();
 * } catch (error) {
 *   postError({
 *     code: 'SNAPSHOT_FAILED',
 *     message: error instanceof Error ? error.message : String(error),
 *     details: extractErrorDetails(error),
 *   });
 * }
 * ```
 */
export function extractErrorDetails(
  error: unknown,
): Record<string, unknown> | undefined {
  return isErrorWithDetails(error) ? error.details : undefined;
}
