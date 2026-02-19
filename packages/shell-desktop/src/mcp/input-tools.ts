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

const INPUT_CONTROL_EVENT_ARGS_SCHEMA = z.object({
  intent: z.string().refine((value) => value.trim().length > 0, {
    message: 'Invalid input.controlEvent payload: expected { intent: string }',
  }),
  phase: z.enum(['start', 'repeat', 'end']),
  value: z.number().finite().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

const assertControlEvent = (args: unknown): ShellControlEvent => {
  const { intent, phase, value, metadata } = INPUT_CONTROL_EVENT_ARGS_SCHEMA.parse(args);

  const base = { intent, phase } satisfies ShellControlEvent;
  const withValue = value === undefined ? base : ({ ...base, value } satisfies ShellControlEvent);
  return metadata === undefined
    ? withValue
    : ({ ...withValue, metadata } satisfies ShellControlEvent);
};

export function registerInputTools(server: ToolRegistrar, controller: InputMcpController): void {
  server.registerTool(
    'input.controlEvent',
    {
      title: 'Input controlEvent',
      description: 'Injects a shell control event into the active simulation control scheme.',
      inputSchema: INPUT_CONTROL_EVENT_ARGS_SCHEMA.shape,
    },
    async (args: unknown) => {
      const event = assertControlEvent(args);
      controller.sendControlEvent(event);
      return buildTextResult({ ok: true });
    },
  );
}
