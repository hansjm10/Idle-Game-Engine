import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import type { AnySchema, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import * as z from 'zod/v4';

export type AssetMcpController = Readonly<{
  compiledAssetsRootPath: string;
}>;

export type AssetMcpEntry = Readonly<{
  path: string;
  kind: 'file' | 'dir';
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

const ASSET_LIST_ARGS_SCHEMA = z.object({
  path: z.string().optional(),
  recursive: z.boolean().optional(),
  maxEntries: z.number().int().min(1).optional(),
}).strict();

const ASSET_READ_ARGS_SCHEMA = z.object({
  path: z.string().min(1),
  maxBytes: z.number().int().min(1).optional(),
}).strict();

const toPosixPath = (value: string): string => value.split(path.sep).join('/');

const isPathWithinRoot = (rootPath: string, targetPath: string): boolean => {
  const resolvedRelativePath = path.relative(rootPath, targetPath);

  if (resolvedRelativePath.startsWith('..') || path.isAbsolute(resolvedRelativePath)) {
    return false;
  }

  return true;
};

const resolveLexicalWithinRoot = (rootPath: string, relativePath: string, message: string): string => {
  const targetPath = path.resolve(rootPath, relativePath);

  if (!isPathWithinRoot(rootPath, targetPath)) {
    throw new TypeError(message);
  }

  return targetPath;
};

async function resolveExistingWithinRoot(
  rootPath: string,
  relativePath: string,
  message: string,
): Promise<Readonly<{ targetPath: string; targetRealPath: string }>> {
  const targetPath = resolveLexicalWithinRoot(rootPath, relativePath, message);
  const targetRealPath = await fsPromises.realpath(targetPath);

  if (!isPathWithinRoot(rootPath, targetRealPath)) {
    throw new TypeError(message);
  }

  return { targetPath, targetRealPath };
}

async function listAssets(
  rootPath: string,
  relativePath: string,
  {
    recursive,
    maxEntries,
  }: Readonly<{
    recursive: boolean;
    maxEntries: number;
  }>,
): Promise<Readonly<{ entries: AssetMcpEntry[]; truncated: boolean }>> {
  const { targetRealPath } = await resolveExistingWithinRoot(
    rootPath,
    relativePath,
    'Invalid asset path: path must be inside compiled assets root.',
  );

  const stat = await fsPromises.stat(targetRealPath);
  if (!stat.isDirectory()) {
    throw new TypeError('Invalid asset.list path: expected a directory within compiled assets root.');
  }

  const entries: AssetMcpEntry[] = [];
  let truncated = false;
  const queue: string[] = [targetRealPath];

  while (queue.length > 0) {
    const currentDir = queue.shift()!;

    const dirents = await fsPromises.readdir(currentDir, { withFileTypes: true });
    dirents.sort((a, b) => a.name.localeCompare(b.name));

    for (const dirent of dirents) {
      if (entries.length >= maxEntries) {
        truncated = true;
        queue.length = 0;
        break;
      }

      const childPath = path.join(currentDir, dirent.name);
      const childRelativePath = toPosixPath(path.relative(rootPath, childPath));
      entries.push({ path: childRelativePath, kind: dirent.isDirectory() ? 'dir' : 'file' });

      if (recursive && dirent.isDirectory()) {
        queue.push(childPath);
      }
    }
  }

  return { entries, truncated };
}

async function readAsset(
  rootPath: string,
  relativePath: string,
  maxBytes: number,
): Promise<Readonly<{ path: string; buffer: Buffer }>> {
  const { targetPath, targetRealPath } = await resolveExistingWithinRoot(
    rootPath,
    relativePath,
    'Invalid asset path: path must be inside compiled assets root.',
  );

  const stat = await fsPromises.stat(targetRealPath);
  if (!stat.isFile()) {
    throw new TypeError('Invalid asset.read path: expected a file within compiled assets root.');
  }

  if (stat.size > maxBytes) {
    throw new Error(`asset.read exceeded maxBytes (${stat.size} > ${maxBytes})`);
  }

  const fileHandle = await fsPromises.open(targetRealPath, 'r');
  try {
    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await fileHandle.read(buffer, 0, stat.size, 0);
    return { path: toPosixPath(path.relative(rootPath, targetPath)), buffer: buffer.subarray(0, bytesRead) };
  } finally {
    await fileHandle.close();
  }
}

export function registerAssetTools(server: ToolRegistrar, controller: AssetMcpController): void {
  let compiledAssetsRootRealPathPromise: Promise<string> | undefined;
  const getCompiledAssetsRootRealPath = (): Promise<string> => {
    compiledAssetsRootRealPathPromise ??= fsPromises.realpath(controller.compiledAssetsRootPath);

    return compiledAssetsRootRealPathPromise;
  };

  server.registerTool(
    'asset.list',
    {
      title: 'Asset list',
      description: 'Lists compiled assets under the configured assets root directory.',
      inputSchema: ASSET_LIST_ARGS_SCHEMA.shape,
    },
    async (args: unknown) => {
      const parsed = ASSET_LIST_ARGS_SCHEMA.parse(args ?? {});
      const requestedPath = parsed.path ?? '';
      const recursive = parsed.recursive ?? false;
      const maxEntries = parsed.maxEntries ?? 500;

      const rootRealPath = await getCompiledAssetsRootRealPath();
      const { entries, truncated } = await listAssets(rootRealPath, requestedPath, {
        recursive,
        maxEntries,
      });

      return buildTextResult({
        ok: true,
        entries,
        truncated,
      });
    },
  );

  server.registerTool(
    'asset.read',
    {
      title: 'Asset read',
      description: 'Reads a compiled asset file from the configured assets root directory.',
      inputSchema: ASSET_READ_ARGS_SCHEMA.shape,
    },
    async (args: unknown) => {
      const parsed = ASSET_READ_ARGS_SCHEMA.parse(args);
      const requestedPath = parsed.path;
      const maxBytes = parsed.maxBytes ?? 5_000_000;

      const rootRealPath = await getCompiledAssetsRootRealPath();
      const { path: resolvedPath, buffer } = await readAsset(rootRealPath, requestedPath, maxBytes);

      return buildTextResult({
        ok: true,
        path: resolvedPath,
        bytes: buffer.byteLength,
        dataBase64: buffer.toString('base64'),
      });
    },
  );
}
