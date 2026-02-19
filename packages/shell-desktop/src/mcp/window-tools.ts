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

const WINDOW_RESIZE_ARGS_SCHEMA = z.object({
  width: z.number().int().min(1),
  height: z.number().int().min(1),
}).strict();

const WINDOW_DEVTOOLS_ARGS_SCHEMA = z.object({
  action: z.enum(['open', 'close', 'toggle']),
}).strict();

const WINDOW_SCREENSHOT_ARGS_SCHEMA = z.object({
  maxBytes: z.number().int().min(1).optional(),
}).strict();

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
      inputSchema: WINDOW_RESIZE_ARGS_SCHEMA.shape,
    },
    async (args: unknown) => {
      const { width, height } = WINDOW_RESIZE_ARGS_SCHEMA.parse(args);

      return buildTextResult({ ok: true, info: controller.resize(width, height) });
    },
  );

  server.registerTool(
    'window.devtools',
    {
      title: 'Window devtools',
      description: 'Opens, closes, or toggles the main window devtools.',
      inputSchema: WINDOW_DEVTOOLS_ARGS_SCHEMA.shape,
    },
    async (args: unknown) => {
      const { action } = WINDOW_DEVTOOLS_ARGS_SCHEMA.parse(args);
      return buildTextResult({ ok: true, ...controller.setDevTools(action) });
    },
  );

  server.registerTool(
    'window.screenshot',
    {
      title: 'Window screenshot',
      description: 'Captures a PNG screenshot of the main window web contents (bounded).',
      inputSchema: WINDOW_SCREENSHOT_ARGS_SCHEMA.shape,
    },
    async (args: unknown) => {
      const { maxBytes: requestedMaxBytes } = WINDOW_SCREENSHOT_ARGS_SCHEMA.parse(args ?? {});
      const maxBytes = requestedMaxBytes ?? 5_000_000;

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
