import type { CompileLogEvent } from './types.js';

export type Logger = (event: CompileLogEvent) => void;

export interface LoggerOptions {
  readonly pretty?: boolean;
  readonly stream?: NodeJS.WritableStream;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const { pretty = false, stream = process.stdout } = options;

  return (event) => {
    const serialized = JSON.stringify(event, undefined, pretty ? 2 : undefined);
    stream.write(`${serialized}\n`);
  };
}
