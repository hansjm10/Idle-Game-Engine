/**
 * Checks if running in development mode for error reporting behavior.
 *
 * Uses safe global access pattern to work in all JavaScript environments
 * (browser, Node.js, Deno, web workers, etc.).
 */
export function isDevelopmentMode(): boolean {
  const globalObject = globalThis as {
    readonly process?: {
      readonly env?: Record<string, string | undefined>;
    };
  };

  const nodeEnv = globalObject.process?.env?.NODE_ENV;
  return nodeEnv !== 'production';
}
