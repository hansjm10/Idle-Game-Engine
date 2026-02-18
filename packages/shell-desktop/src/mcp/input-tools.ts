import type { ShellControlEvent } from '../ipc.js';
import type { AnySchema, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import * as z from 'zod/v4';

export type InputMcpController = Readonly<{
  sendControlEvent: (event: ShellControlEvent) => void;
}>;

type TextToolResult = {
  content: Array<{ type: 'text'; text: string }>;
};

type ToolRegistrar = Readonly<{
  registerTool: (
    name: string,
    config: Readonly<{ title: string; description: string; inputSchema?: AnySchema | ZodRawShapeCompat }>,
    handler: (...args: unknown[]) => Promise<TextToolResult>,
  ) => void;
}>;

const buildTextResult = (value: unknown): TextToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
});

const assertObject = (value: unknown, message: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(message);
  }

  return value as Record<string, unknown>;
};

const assertOptionalFiniteNumber = (value: unknown, message: string): number | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(message);
  }

  return value;
};

const assertOptionalMetadata = (value: unknown): Readonly<Record<string, unknown>> | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Invalid input/controlEvent payload: expected { metadata?: object }');
  }

  return value as Readonly<Record<string, unknown>>;
};

const assertControlEvent = (args: unknown): ShellControlEvent => {
  const record = assertObject(args, 'Invalid input/controlEvent payload: expected an object');

  const intent = record['intent'];
  if (typeof intent !== 'string' || intent.trim().length === 0) {
    throw new TypeError('Invalid input/controlEvent payload: expected { intent: string }');
  }

  const phase = record['phase'];
  if (phase !== 'start' && phase !== 'repeat' && phase !== 'end') {
    throw new TypeError('Invalid input/controlEvent payload: expected { phase: "start" | "repeat" | "end" }');
  }

  const value = assertOptionalFiniteNumber(
    record['value'],
    'Invalid input/controlEvent payload: expected { value?: number }',
  );

  const metadata = assertOptionalMetadata(record['metadata']);

  const base = { intent, phase } satisfies ShellControlEvent;
  const withValue = value === undefined ? base : ({ ...base, value } satisfies ShellControlEvent);
  return metadata === undefined
    ? withValue
    : ({ ...withValue, metadata } satisfies ShellControlEvent);
};

export function registerInputTools(server: ToolRegistrar, controller: InputMcpController): void {
  server.registerTool(
    'input/controlEvent',
    {
      title: 'Input controlEvent',
      description: 'Injects a shell control event into the active simulation control scheme.',
      inputSchema: {
        intent: z.string(),
        phase: z.enum(['start', 'repeat', 'end']),
        value: z.number().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (args: unknown) => {
      const event = assertControlEvent(args);
      controller.sendControlEvent(event);
      return buildTextResult({ ok: true });
    },
  );
}
