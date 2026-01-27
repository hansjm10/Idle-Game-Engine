import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerAssetTools } from './asset-tools.js';

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

describe('shell-desktop MCP asset tools', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'idle-engine-asset-tools-'));
    await fsPromises.writeFile(path.join(rootDir, 'allowed.txt'), 'hello', 'utf8');
    await fsPromises.mkdir(path.join(rootDir, 'nested'));
    await fsPromises.writeFile(path.join(rootDir, 'nested', 'inner.txt'), 'world', 'utf8');
  });

  afterEach(async () => {
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  it('registers the asset tool surface', () => {
    const tools = new Map<string, ToolHandler>();

    const server = {
      registerTool: vi.fn((name: string, _definition: unknown, handler: ToolHandler) => {
        tools.set(name, handler);
      }),
    };

    registerAssetTools(server, { compiledAssetsRootPath: rootDir });

    expect(Array.from(tools.keys()).sort()).toEqual(['asset/list', 'asset/read']);
  });

  it('lists assets within the compiled assets root and blocks traversal', async () => {
    const tools = new Map<string, ToolHandler>();

    const server = {
      registerTool: vi.fn((name: string, _definition: unknown, handler: ToolHandler) => {
        tools.set(name, handler);
      }),
    };

    registerAssetTools(server, { compiledAssetsRootPath: rootDir });

    const listHandler = tools.get('asset/list');
    const parsedList = parseToolJson(await listHandler?.({})) as { entries?: unknown };
    expect(parsedList.entries).toEqual([
      { path: 'allowed.txt', kind: 'file' },
      { path: 'nested', kind: 'dir' },
    ]);

    const nestedList = parseToolJson(await listHandler?.({ path: 'nested', recursive: true })) as { entries?: unknown };
    expect(nestedList.entries).toEqual([{ path: 'nested/inner.txt', kind: 'file' }]);

    await expect(listHandler?.({ path: '../' })).rejects.toThrow(/inside/i);
  });

  it('reads assets within the compiled assets root and blocks traversal', async () => {
    const tools = new Map<string, ToolHandler>();

    const server = {
      registerTool: vi.fn((name: string, _definition: unknown, handler: ToolHandler) => {
        tools.set(name, handler);
      }),
    };

    registerAssetTools(server, { compiledAssetsRootPath: rootDir });

    const readHandler = tools.get('asset/read');
    const parsedRead = parseToolJson(await readHandler?.({ path: 'allowed.txt' })) as {
      dataBase64?: unknown;
      bytes?: unknown;
    };

    expect(parsedRead.bytes).toBe(5);
    expect(Buffer.from(String(parsedRead.dataBase64), 'base64').toString('utf8')).toBe('hello');

    await expect(readHandler?.({ path: '../../nope.txt' })).rejects.toThrow(/inside/i);
  });
});

