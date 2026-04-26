import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestContext } from 'vitest';
import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerAssetTools } from './asset-tools.js';

type ToolHandler = (args: unknown) => Promise<unknown>;
type SymlinkType = 'dir' | 'file';

const SYMLINK_PERMISSION_SKIP_NOTE =
  'Skipping symlink-specific asset-tool assertion because this host cannot create filesystem symlinks.';

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

const getErrorCode = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
};

const isSymlinkPermissionError = (error: unknown): boolean => {
  const code = getErrorCode(error);
  return code === 'EPERM' || code === 'EACCES';
};

const createSymlinkOrSkip = async (
  context: Pick<TestContext, 'skip'>,
  targetPath: string,
  symlinkPath: string,
  type: SymlinkType,
): Promise<void> => {
  try {
    await fsPromises.symlink(targetPath, symlinkPath, type);
  } catch (error) {
    if (isSymlinkPermissionError(error)) {
      context.skip(SYMLINK_PERMISSION_SKIP_NOTE);
    }

    throw error;
  }
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

    expect(Array.from(tools.keys()).sort()).toEqual(['asset.list', 'asset.read']);
  });

  it('lists assets within the compiled assets root and blocks traversal', async () => {
    const tools = new Map<string, ToolHandler>();

    const server = {
      registerTool: vi.fn((name: string, _definition: unknown, handler: ToolHandler) => {
        tools.set(name, handler);
      }),
    };

    registerAssetTools(server, { compiledAssetsRootPath: rootDir });

    const listHandler = tools.get('asset.list');
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

    const readHandler = tools.get('asset.read');
    const parsedRead = parseToolJson(await readHandler?.({ path: 'allowed.txt' })) as {
      dataBase64?: unknown;
      bytes?: unknown;
    };

    expect(parsedRead.bytes).toBe(5);
    expect(Buffer.from(String(parsedRead.dataBase64), 'base64').toString('utf8')).toBe('hello');

    await expect(readHandler?.({ path: '../../nope.txt' })).rejects.toThrow(/inside/i);
  });

  it('rejects asset.read requests that escape the root via symlinks', async (context) => {
    const externalDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'idle-engine-asset-tools-external-'));
    try {
      const externalFile = path.join(externalDir, 'outside.txt');
      await fsPromises.writeFile(externalFile, 'external', 'utf8');
      await createSymlinkOrSkip(context, externalFile, path.join(rootDir, 'outside-link.txt'), 'file');

      const tools = new Map<string, ToolHandler>();
      const server = {
        registerTool: vi.fn((name: string, _definition: unknown, handler: ToolHandler) => {
          tools.set(name, handler);
        }),
      };

      registerAssetTools(server, { compiledAssetsRootPath: rootDir });

      const readHandler = tools.get('asset.read');
      await expect(readHandler?.({ path: 'outside-link.txt' })).rejects.toThrow(/inside/i);
    } finally {
      await fsPromises.rm(externalDir, { recursive: true, force: true });
    }
  });

  it('rejects asset.list requests that escape the root via symlinks', async (context) => {
    const externalDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'idle-engine-asset-tools-external-'));
    try {
      await fsPromises.mkdir(path.join(externalDir, 'dir'));
      await fsPromises.writeFile(path.join(externalDir, 'dir', 'outside.txt'), 'external', 'utf8');
      await createSymlinkOrSkip(context, path.join(externalDir, 'dir'), path.join(rootDir, 'outside-dir'), 'dir');

      const tools = new Map<string, ToolHandler>();
      const server = {
        registerTool: vi.fn((name: string, _definition: unknown, handler: ToolHandler) => {
          tools.set(name, handler);
        }),
      };

      registerAssetTools(server, { compiledAssetsRootPath: rootDir });

      const listHandler = tools.get('asset.list');
      await expect(listHandler?.({ path: 'outside-dir' })).rejects.toThrow(/inside/i);
    } finally {
      await fsPromises.rm(externalDir, { recursive: true, force: true });
    }
  });

  it('sets asset.list truncated only when entries are omitted', async () => {
    const tools = new Map<string, ToolHandler>();

    const server = {
      registerTool: vi.fn((name: string, _definition: unknown, handler: ToolHandler) => {
        tools.set(name, handler);
      }),
    };

    registerAssetTools(server, { compiledAssetsRootPath: rootDir });

    const listHandler = tools.get('asset.list');
    const full = parseToolJson(await listHandler?.({ maxEntries: 2 })) as { entries?: unknown; truncated?: unknown };
    expect(full.entries).toEqual([
      { path: 'allowed.txt', kind: 'file' },
      { path: 'nested', kind: 'dir' },
    ]);
    expect(full.truncated).toBe(false);

    const truncated = parseToolJson(await listHandler?.({ maxEntries: 1 })) as { entries?: unknown; truncated?: unknown };
    expect(truncated.entries).toEqual([{ path: 'allowed.txt', kind: 'file' }]);
    expect(truncated.truncated).toBe(true);

    const recursiveFull = parseToolJson(
      await listHandler?.({ recursive: true, maxEntries: 3 }),
    ) as { entries?: unknown; truncated?: unknown };
    expect(recursiveFull.entries).toEqual([
      { path: 'allowed.txt', kind: 'file' },
      { path: 'nested', kind: 'dir' },
      { path: 'nested/inner.txt', kind: 'file' },
    ]);
    expect(recursiveFull.truncated).toBe(false);
  });

  it('enforces asset.read maxBytes without reading oversized files', async () => {
    const oversizedPath = path.join(rootDir, 'oversized.bin');
    await fsPromises.writeFile(oversizedPath, Buffer.alloc(8, 1));

    const tools = new Map<string, ToolHandler>();
    const server = {
      registerTool: vi.fn((name: string, _definition: unknown, handler: ToolHandler) => {
        tools.set(name, handler);
      }),
    };

    registerAssetTools(server, { compiledAssetsRootPath: rootDir });

    const readHandler = tools.get('asset.read');
    const openSpy = vi.spyOn(fsPromises, 'open').mockImplementation(async () => {
      throw new Error('open should not be called for oversized files');
    });

    await expect(readHandler?.({ path: 'oversized.bin', maxBytes: 4 })).rejects.toThrow(/maxBytes/i);

    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });
});
