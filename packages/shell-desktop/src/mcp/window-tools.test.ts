import { describe, expect, it, vi } from 'vitest';
import { registerWindowTools, type WindowMcpController } from './window-tools.js';

type ToolHandler = (args: unknown) => Promise<unknown>;

const parseToolJson = (result: unknown): unknown => {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new Error('Expected tool result to be an object');
  }

  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error('Expected tool result to have content');
  }

  const first = content[0] as { type?: unknown; text?: unknown };
  if (first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error('Expected tool result content[0] to be text');
  }

  return JSON.parse(first.text) as unknown;
};

describe('shell-desktop MCP window tools', () => {
  it('registers the window tool surface', () => {
    const tools = new Map<string, ToolHandler>();

    const server = {
      registerTool: vi.fn((name: string, _definition: unknown, handler: ToolHandler) => {
        tools.set(name, handler);
      }),
    };

    registerWindowTools(server, {
      getInfo: () => ({
        bounds: { x: 0, y: 0, width: 1200, height: 800 },
        url: 'app://idle-engine',
        devToolsOpen: false,
      }),
      resize: (_width: number, _height: number) => ({
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        url: 'app://idle-engine',
        devToolsOpen: false,
      }),
      setDevTools: (_action: 'open' | 'close' | 'toggle') => ({ devToolsOpen: true }),
      captureScreenshotPng: async () => Buffer.from([1, 2, 3]),
    } satisfies WindowMcpController);

    expect(Array.from(tools.keys()).sort()).toEqual([
      'window/devtools',
      'window/info',
      'window/resize',
      'window/screenshot',
    ]);
  });

  it('bridges handlers to the window controller', async () => {
    const tools = new Map<string, ToolHandler>();

    const controller: WindowMcpController = {
      getInfo: vi.fn(() => ({
        bounds: { x: 10, y: 20, width: 1200, height: 800 },
        url: 'app://idle-engine',
        devToolsOpen: false,
      })),
      resize: vi.fn((_width: number, _height: number) => ({
        bounds: { x: 10, y: 20, width: 800, height: 600 },
        url: 'app://idle-engine',
        devToolsOpen: false,
      })),
      setDevTools: vi.fn((_action: 'open' | 'close' | 'toggle') => ({ devToolsOpen: true })),
      captureScreenshotPng: vi.fn(async () => Buffer.from([1, 2, 3])),
    };

    const server = {
      registerTool: vi.fn((name: string, _definition: unknown, handler: ToolHandler) => {
        tools.set(name, handler);
      }),
    };

    registerWindowTools(server, controller);

    const infoHandler = tools.get('window/info');
    await expect(infoHandler?.({})).resolves.toBeDefined();
    expect(controller.getInfo).toHaveBeenCalledTimes(1);

    const resizeHandler = tools.get('window/resize');
    await expect(resizeHandler?.({ width: 640, height: 480 })).resolves.toBeDefined();
    expect(controller.resize).toHaveBeenCalledWith(640, 480);

    const devToolsHandler = tools.get('window/devtools');
    await expect(devToolsHandler?.({ action: 'open' })).resolves.toBeDefined();
    expect(controller.setDevTools).toHaveBeenCalledWith('open');

    const screenshotHandler = tools.get('window/screenshot');
    const rawScreenshot = await screenshotHandler?.({ maxBytes: 10 });
    expect(controller.captureScreenshotPng).toHaveBeenCalledTimes(1);

    const screenshot = parseToolJson(rawScreenshot) as { ok?: unknown; dataBase64?: unknown; format?: unknown };
    expect(screenshot).toEqual(expect.objectContaining({ ok: true, format: 'png', dataBase64: 'AQID' }));
  });

  it('rejects invalid window tool payloads and bounds screenshots', async () => {
    const tools = new Map<string, ToolHandler>();

    const controller: WindowMcpController = {
      getInfo: () => ({
        bounds: { x: 0, y: 0, width: 1200, height: 800 },
        url: 'app://idle-engine',
        devToolsOpen: false,
      }),
      resize: () => ({
        bounds: { x: 0, y: 0, width: 1200, height: 800 },
        url: 'app://idle-engine',
        devToolsOpen: false,
      }),
      setDevTools: () => ({ devToolsOpen: false }),
      captureScreenshotPng: async () => Buffer.from([1, 2, 3, 4, 5, 6]),
    };

    const server = {
      registerTool: vi.fn((name: string, _definition: unknown, handler: ToolHandler) => {
        tools.set(name, handler);
      }),
    };

    registerWindowTools(server, controller);

    const resizeHandler = tools.get('window/resize');
    await expect(resizeHandler?.({})).rejects.toThrow(/width/);
    await expect(resizeHandler?.({ width: 0, height: 10 })).rejects.toThrow(/width/);
    await expect(resizeHandler?.({ width: 100, height: -1 })).rejects.toThrow(/height/);

    const devToolsHandler = tools.get('window/devtools');
    await expect(devToolsHandler?.({})).rejects.toThrow(/action/);
    await expect(devToolsHandler?.({ action: 'nope' })).rejects.toThrow(/action/);

    const screenshotHandler = tools.get('window/screenshot');
    await expect(screenshotHandler?.({ maxBytes: 5 })).rejects.toThrow(/maxBytes/);
    await expect(screenshotHandler?.({ maxBytes: 0 })).rejects.toThrow(/maxBytes/);
  });
});

