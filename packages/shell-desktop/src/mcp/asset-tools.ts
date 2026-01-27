import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

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
    config: Readonly<{ title: string; description: string }>,
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

const assertString = (value: unknown, message: string): string => {
  if (typeof value !== 'string') {
    throw new TypeError(message);
  }

  return value;
};

const assertOptionalString = (value: unknown, message: string): string | undefined => {
  if (value === undefined) {
    return undefined;
  }

  return assertString(value, message);
};

const assertOptionalBoolean = (value: unknown, message: string): boolean | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (value === true || value === false) {
    return value;
  }

  throw new TypeError(message);
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

const toPosixPath = (value: string): string => value.split(path.sep).join('/');

const resolveWithinRoot = (rootPath: string, relativePath: string, message: string): string => {
  const targetPath = path.resolve(rootPath, relativePath);
  const resolvedRelativePath = path.relative(rootPath, targetPath);

  if (resolvedRelativePath.startsWith('..') || path.isAbsolute(resolvedRelativePath)) {
    throw new TypeError(message);
  }

  return targetPath;
};

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
  const targetPath = resolveWithinRoot(
    rootPath,
    relativePath,
    'Invalid asset path: path must be inside compiled assets root.',
  );

  const stat = await fsPromises.stat(targetPath);
  if (!stat.isDirectory()) {
    throw new TypeError('Invalid asset/list path: expected a directory within compiled assets root.');
  }

  const entries: AssetMcpEntry[] = [];
  let truncated = false;
  const queue: string[] = [targetPath];

  while (queue.length > 0) {
    const currentDir = queue.shift();
    if (!currentDir) {
      continue;
    }

    const dirents = await fsPromises.readdir(currentDir, { withFileTypes: true });
    dirents.sort((a, b) => a.name.localeCompare(b.name));

    for (const dirent of dirents) {
      const childPath = path.join(currentDir, dirent.name);
      const childRelativePath = toPosixPath(path.relative(rootPath, childPath));
      entries.push({ path: childRelativePath, kind: dirent.isDirectory() ? 'dir' : 'file' });

      if (entries.length >= maxEntries) {
        truncated = true;
        queue.length = 0;
        break;
      }

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
): Promise<Readonly<{ path: string; buffer: Buffer }>> {
  const targetPath = resolveWithinRoot(
    rootPath,
    relativePath,
    'Invalid asset path: path must be inside compiled assets root.',
  );

  const stat = await fsPromises.stat(targetPath);
  if (!stat.isFile()) {
    throw new TypeError('Invalid asset/read path: expected a file within compiled assets root.');
  }

  const buffer = await fsPromises.readFile(targetPath);
  return { path: toPosixPath(path.relative(rootPath, targetPath)), buffer };
}

export function registerAssetTools(server: ToolRegistrar, controller: AssetMcpController): void {
  server.registerTool(
    'asset/list',
    {
      title: 'Asset list',
      description: 'Lists compiled assets under the configured assets root directory.',
    },
    async (args: unknown) => {
      const record = assertObject(args, 'Invalid asset/list payload: expected an object');

      const requestedPath =
        assertOptionalString(record['path'], 'Invalid asset/list payload: expected { path?: string }') ?? '';

      const recursive =
        assertOptionalBoolean(record['recursive'], 'Invalid asset/list payload: expected { recursive?: boolean }') ?? false;

      const maxEntries =
        assertOptionalPositiveInt(
          record['maxEntries'],
          'Invalid asset/list payload: expected { maxEntries?: integer >= 1 }',
        ) ?? 500;

      const { entries, truncated } = await listAssets(controller.compiledAssetsRootPath, requestedPath, {
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
    'asset/read',
    {
      title: 'Asset read',
      description: 'Reads a compiled asset file from the configured assets root directory.',
    },
    async (args: unknown) => {
      const record = assertObject(args, 'Invalid asset/read payload: expected an object');
      const requestedPath = assertString(
        record['path'],
        'Invalid asset/read payload: expected { path: string }',
      );

      const maxBytes =
        assertOptionalPositiveInt(
          record['maxBytes'],
          'Invalid asset/read payload: expected { maxBytes?: integer >= 1 }',
        ) ?? 5_000_000;

      const { path: resolvedPath, buffer } = await readAsset(controller.compiledAssetsRootPath, requestedPath);

      if (buffer.byteLength > maxBytes) {
        throw new Error(`asset/read exceeded maxBytes (${buffer.byteLength} > ${maxBytes})`);
      }

      return buildTextResult({
        ok: true,
        path: resolvedPath,
        bytes: buffer.byteLength,
        dataBase64: buffer.toString('base64'),
      });
    },
  );
}

