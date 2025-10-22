import type { CompileLogEvent } from './types.js';

export type Logger = (event: CompileLogEvent) => void;

export function createLogger(): Logger {
  return (event) => {
    throw new Error(`Logger not implemented. Tried to log event ${event.name}`);
  };
}
