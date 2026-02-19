import * as z from 'zod/v4';
import type { AnySchema, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';

export type WindowMcpBounds = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type WindowMcpInfo = Readonly<{
  bounds: WindowMcpBounds;
  url?: string;
  devToolsOpen: boolean;
}>;

export type WindowMcpDevToolsAction = 'open' | 'close' | 'toggle';

export type WindowMcpController = Readonly<{
  getInfo: () => WindowMcpInfo;
  resize: (width: number, height: number) => WindowMcpInfo;
  setDevTools: (action: WindowMcpDevToolsAction) => Readonly<{ devToolsOpen: boolean }>;
  captureScreenshotPng: () => Promise<Buffer>;
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

const assertPositiveInt = (value: unknown, message: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(message);
  }

  const parsed = Math.floor(value);
  if (parsed !== value || parsed < 1) {
    throw new TypeError(message);
  }

  return parsed;
};

const assertOptionalPositiveInt = (value: unknown, message: string): number | undefined => {
  if (value === undefined) {
    return undefined;
  }

  return assertPositiveInt(value, message);
};

const assertDevToolsAction = (value: unknown): WindowMcpDevToolsAction => {
  if (value === 'open' || value === 'close' || value === 'toggle') {
    return value;
  }
  throw new TypeError('Invalid window.devtools payload: expected { action: "open" | "close" | "toggle" }');
};

export function registerWindowTools(server: ToolRegistrar, controller: WindowMcpController): void {
  server.registerTool(
    'window.info',
    {
      title: 'Window info',
      description: 'Returns basic information about the main window (bounds, url, devtools state).',
    },
    async () => buildTextResult(controller.getInfo()),
  );

  server.registerTool(
    'window.resize',
    {
      title: 'Window resize',
      description: 'Resizes the main window to the requested width/height.',
      inputSchema: {
        width: z.number(),
        height: z.number(),
      },
    },
    async (args: unknown) => {
      const record = assertObject(args, 'Invalid window.resize payload: expected an object');
      const width = assertPositiveInt(
        record['width'],
        'Invalid window.resize payload: expected { width: integer >= 1, height: integer >= 1 }',
      );
      const height = assertPositiveInt(
        record['height'],
        'Invalid window.resize payload: expected { width: integer >= 1, height: integer >= 1 }',
      );

      return buildTextResult({ ok: true, info: controller.resize(width, height) });
    },
  );

  server.registerTool(
    'window.devtools',
    {
      title: 'Window devtools',
      description: 'Opens, closes, or toggles the main window devtools.',
      inputSchema: {
        action: z.enum(['open', 'close', 'toggle']),
      },
    },
    async (args: unknown) => {
      const record = assertObject(args, 'Invalid window.devtools payload: expected an object');
      const action = assertDevToolsAction(record['action']);
      return buildTextResult({ ok: true, ...controller.setDevTools(action) });
    },
  );

  server.registerTool(
    'window.screenshot',
    {
      title: 'Window screenshot',
      description: 'Captures a PNG screenshot of the main window web contents (bounded).',
      inputSchema: {
        maxBytes: z.number().optional(),
      },
    },
    async (args: unknown) => {
      const record = assertObject(args, 'Invalid window.screenshot payload: expected an object');

      const maxBytes =
        assertOptionalPositiveInt(
          record['maxBytes'],
          'Invalid window.screenshot payload: expected { maxBytes?: integer >= 1 }',
        ) ?? 5_000_000;

      const buffer = await controller.captureScreenshotPng();

      if (buffer.byteLength > maxBytes) {
        throw new Error(`window.screenshot exceeded maxBytes (${buffer.byteLength} > ${maxBytes})`);
      }

      return buildTextResult({
        ok: true,
        format: 'png',
        bytes: buffer.byteLength,
        dataBase64: buffer.toString('base64'),
      });
    },
  );
}
