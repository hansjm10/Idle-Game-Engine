import { randomUUID } from 'node:crypto';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import canonicalize from 'canonicalize';

import { generateMsdfFontAssetFiles } from '../artifacts/fonts.js';
import { createGeneratedModuleSource } from '../artifacts/module.js';
import type {
  ArtifactWriterOptions,
  ArtifactFileKind,
  FileWriteOperation,
  PackArtifactResult,
  WorkspaceArtifactWriteResult,
  WorkspaceFS,
} from '../types.js';
import type { NormalizedFontAsset } from '@idle-engine/content-schema';

interface ArtifactPaths {
  readonly jsonPath: string;
  readonly modulePath: string;
  readonly assetsDir: string;
}

interface ExistingArtifactsRecord {
  readonly json: Set<string>;
  readonly module: Set<string>;
  readonly assets: Set<string>;
}

const JSON_SUFFIX = '.normalized.json';
const MODULE_SUFFIX = '.generated.ts';
const ASSETS_SUFFIX = '.assets';

export async function writeWorkspaceArtifacts(
  workspace: WorkspaceFS,
  results: readonly PackArtifactResult[],
  options: ArtifactWriterOptions = {},
): Promise<WorkspaceArtifactWriteResult> {
  const operations: FileWriteOperation[] = [];
  const existingArtifacts = await collectExistingArtifacts(workspace.rootDirectory);

  for (const result of results) {
    const paths = resolveArtifactPaths(result);

    if (result.status === 'compiled') {
      const jsonContent = toBuffer(`${result.artifact.canonicalJson}\n`);
      const moduleSource = ensureTrailingNewline(
        createGeneratedModuleSource({
          packSlug: result.packSlug,
          artifact: result.artifact,
        }),
      );
      const moduleContent = toBuffer(moduleSource);

      const jsonAction = await writeFileInternal(paths.jsonPath, jsonContent, options);
      const moduleAction = await writeFileInternal(paths.modulePath, moduleContent, options);

      operations.push(
        createOperation(result.packSlug, 'json', paths.jsonPath, jsonAction),
      );
      operations.push(
        createOperation(result.packSlug, 'module', paths.modulePath, moduleAction),
      );

      await writePackAssets({
        packSlug: result.packSlug,
        manifestPath: result.document.absolutePath,
        fonts: result.normalizedPack.fonts,
        assetsDir: paths.assetsDir,
        options,
        operations,
      });

      markHandled(existingArtifacts, result.packSlug, paths);
    } else {
      const jsonAction = await removeFile(paths.jsonPath, options);
      if (jsonAction !== undefined) {
        operations.push(
          createOperation(result.packSlug, 'json', paths.jsonPath, jsonAction),
        );
      }

      const moduleAction = await removeFile(paths.modulePath, options);
      if (moduleAction !== undefined) {
        operations.push(
          createOperation(result.packSlug, 'module', paths.modulePath, moduleAction),
        );
      }

      const assetsAction = await removeDirectory(paths.assetsDir, options);
      if (assetsAction !== undefined) {
        operations.push(
          createOperation(result.packSlug, 'asset', paths.assetsDir, assetsAction),
        );
      }

      markHandled(existingArtifacts, result.packSlug, paths);
    }
  }

  await pruneStaleArtifacts(existingArtifacts, options, operations);

  const relativeOperations = operations.map((operation) => ({
    ...operation,
    path: toPosixPath(
      path.relative(workspace.rootDirectory, operation.path),
    ),
  }));

  return {
    operations: relativeOperations,
  };
}

export async function writeDeterministicFile(
  targetPath: string,
  content: Uint8Array,
  options: ArtifactWriterOptions,
): Promise<'written' | 'unchanged' | 'would-write'> {
  return writeFileInternal(targetPath, content, options);
}

async function writeFileInternal(
  targetPath: string,
  content: Uint8Array,
  options: ArtifactWriterOptions,
): Promise<'written' | 'unchanged' | 'would-write'> {
  const { check = false, clean = false } = options;
  const existing = await readFile(targetPath);
  const identical = existing !== undefined && buffersEqual(existing, content);

  if (check) {
    return identical ? 'unchanged' : 'would-write';
  }

  if (identical && !clean) {
    return 'unchanged';
  }

  await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = path.join(
    path.dirname(targetPath),
    `.tmp-${path.basename(targetPath)}-${randomUUID()}`,
  );

  try {
    await fsPromises.writeFile(tempPath, content);
    await fsPromises.rename(tempPath, targetPath);
  } finally {
    await safeUnlink(tempPath);
  }

  return 'written';
}

async function removeFile(
  targetPath: string,
  options: ArtifactWriterOptions,
): Promise<'deleted' | 'would-delete' | undefined> {
  const exists = await fileExists(targetPath);
  if (!exists) {
    return undefined;
  }
  if (options.check) {
    return 'would-delete';
  }
  await fsPromises.unlink(targetPath);
  return 'deleted';
}

async function removeDirectory(
  targetPath: string,
  options: ArtifactWriterOptions,
): Promise<'deleted' | 'would-delete' | undefined> {
  const stats = await fsPromises.stat(targetPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  });

  if (!stats) {
    return undefined;
  }

  if (!stats.isDirectory()) {
    return removeFile(targetPath, options);
  }

  if (options.check) {
    return 'would-delete';
  }

  await fsPromises.rm(targetPath, { recursive: true, force: true });
  return 'deleted';
}

function stableJson(value: unknown): string {
  const result = canonicalize(value);
  if (typeof result !== 'string') {
    throw new Error('Failed to canonicalize renderer asset manifest.');
  }
  return result;
}

async function writePackAssets(input: Readonly<{
  packSlug: string;
  manifestPath: string;
  fonts: readonly NormalizedFontAsset[];
  assetsDir: string;
  options: ArtifactWriterOptions;
  operations: FileWriteOperation[];
}>): Promise<void> {
  if (input.fonts.length === 0) {
    const action = await removeDirectory(input.assetsDir, input.options);
    if (action !== undefined) {
      input.operations.push(
        createOperation(input.packSlug, 'asset', input.assetsDir, action),
      );
    }
    return;
  }

  const manifestDir = path.dirname(input.manifestPath);
  const fontsRoot = path.join(input.assetsDir, 'fonts');
  const expectedFontDirs = new Set<string>();
  const assets: Array<{ id: string; kind: 'font'; contentHash: string }> = [];

  for (const font of input.fonts) {
    const encodedId = encodeURIComponent(font.id);
    const fontDir = path.join(fontsRoot, encodedId);
    expectedFontDirs.add(path.resolve(fontDir));

    const sourcePath = path.resolve(manifestDir, font.source);
    const relative = path.relative(manifestDir, sourcePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Font ${font.id} source escapes pack root: ${font.source}`);
    }

    const generated = await generateMsdfFontAssetFiles({
      font,
      sourcePath,
    });

    assets.push({
      id: font.id,
      kind: 'font',
      contentHash: generated.contentHash,
    });

    const atlasPath = path.join(fontDir, 'atlas.png');
    const metadataPath = path.join(fontDir, 'font.json');

    const atlasAction = await writeFileInternal(atlasPath, generated.atlasPng, input.options);
    input.operations.push(
      createOperation(input.packSlug, 'asset', atlasPath, atlasAction),
    );

    const metadataContent = toBuffer(ensureTrailingNewline(generated.metadataJson));
    const metadataAction = await writeFileInternal(metadataPath, metadataContent, input.options);
    input.operations.push(
      createOperation(input.packSlug, 'asset', metadataPath, metadataAction),
    );
  }

  assets.sort((left, right) => left.id.localeCompare(right.id));

  const rendererManifest = {
    schemaVersion: 4,
    assets,
  };
  const manifestJson = stableJson(rendererManifest);
  const rendererManifestPath = path.join(input.assetsDir, 'renderer-assets.manifest.json');
  const rendererManifestAction = await writeFileInternal(
    rendererManifestPath,
    toBuffer(`${manifestJson}\n`),
    input.options,
  );
  input.operations.push(
    createOperation(input.packSlug, 'asset', rendererManifestPath, rendererManifestAction),
  );

  await pruneStaleFontDirs({
    packSlug: input.packSlug,
    fontsRoot,
    expectedFontDirs,
    options: input.options,
    operations: input.operations,
  });
}

async function pruneStaleFontDirs(input: Readonly<{
  packSlug: string;
  fontsRoot: string;
  expectedFontDirs: ReadonlySet<string>;
  options: ArtifactWriterOptions;
  operations: FileWriteOperation[];
}>): Promise<void> {
  const entries = await readDirSafe(input.fontsRoot);
  for (const entry of entries) {
    const entryPath = path.resolve(path.join(input.fontsRoot, entry.name));
    if (!entry.isDirectory()) {
      const action = await removeFile(entryPath, input.options);
      if (action !== undefined) {
        input.operations.push(
          createOperation(input.packSlug, 'asset', entryPath, action),
        );
      }
      continue;
    }

    if (input.expectedFontDirs.has(entryPath)) {
      continue;
    }

    const action = await removeDirectory(entryPath, input.options);
    if (action !== undefined) {
      input.operations.push(
        createOperation(input.packSlug, 'asset', entryPath, action),
      );
    }
  }
}

async function pruneStaleArtifacts(
  artifacts: Map<string, ExistingArtifactsRecord>,
  options: ArtifactWriterOptions,
  operations: FileWriteOperation[],
): Promise<void> {
  for (const [slug, record] of artifacts.entries()) {
    for (const jsonPath of record.json) {
      const action = await removeFile(jsonPath, options);
      if (action !== undefined) {
        operations.push(createOperation(slug, 'json', jsonPath, action));
      }
    }

    for (const modulePath of record.module) {
      const action = await removeFile(modulePath, options);
      if (action !== undefined) {
        operations.push(createOperation(slug, 'module', modulePath, action));
      }
    }

    for (const assetsDir of record.assets) {
      const action = await removeDirectory(assetsDir, options);
      if (action !== undefined) {
        operations.push(createOperation(slug, 'asset', assetsDir, action));
      }
    }
  }
}

function createOperation(
  slug: string,
  kind: ArtifactFileKind,
  targetPath: string,
  action: FileWriteOperation['action'],
): FileWriteOperation {
  return {
    slug,
    kind,
    path: targetPath,
    action,
  };
}

function resolveArtifactPaths(result: PackArtifactResult): ArtifactPaths {
  const manifestDir = path.dirname(result.document.absolutePath);
  const packageRoot = path.dirname(manifestDir);
  const compiledDir = path.join(manifestDir, 'compiled');
  const jsonPath = path.join(compiledDir, `${result.packSlug}${JSON_SUFFIX}`);
  const assetsDir = path.join(compiledDir, `${result.packSlug}${ASSETS_SUFFIX}`);
  const moduleDir = path.join(packageRoot, 'src', 'generated');
  const modulePath = path.join(moduleDir, `${result.packSlug}${MODULE_SUFFIX}`);

  return {
    jsonPath: path.resolve(jsonPath),
    assetsDir: path.resolve(assetsDir),
    modulePath: path.resolve(modulePath),
  };
}

async function collectExistingArtifacts(
  workspaceRoot: string,
): Promise<Map<string, ExistingArtifactsRecord>> {
  const artifacts = new Map<string, ExistingArtifactsRecord>();
  const packagesPath = path.join(workspaceRoot, 'packages');

  const packageEntries = await readDirSafe(packagesPath);
  for (const entry of packageEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const packageRoot = path.join(packagesPath, entry.name);
    const compiledDir = path.join(packageRoot, 'content', 'compiled');
    const generatedDir = path.join(packageRoot, 'src', 'generated');

    const compiledFiles = await collectArtifactFiles(compiledDir, JSON_SUFFIX);
    for (const filePath of compiledFiles) {
      const slug = slugFromArtifactPath(compiledDir, filePath, JSON_SUFFIX);
      const record = ensureRecord(artifacts, slug);
      record.json.add(filePath);
    }

    const assetsDirs = await collectArtifactDirectories(compiledDir, ASSETS_SUFFIX);
    for (const dirPath of assetsDirs) {
      const slug = slugFromArtifactPath(compiledDir, dirPath, ASSETS_SUFFIX);
      const record = ensureRecord(artifacts, slug);
      record.assets.add(dirPath);
    }

    const generatedFiles = await collectArtifactFiles(generatedDir, MODULE_SUFFIX);
    for (const filePath of generatedFiles) {
      const slug = slugFromArtifactPath(generatedDir, filePath, MODULE_SUFFIX);
      const record = ensureRecord(artifacts, slug);
      record.module.add(filePath);
    }
  }

  return artifacts;
}

async function collectArtifactFiles(
  rootDirectory: string,
  suffix: string,
): Promise<string[]> {
  const files: string[] = [];
  const pending: string[] = [rootDirectory];

  while (pending.length > 0) {
    const currentDir = pending.pop();
    if (!currentDir) {
      continue;
    }

    const entries = await readDirSafe(currentDir);
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(suffix)) {
        continue;
      }
      files.push(path.resolve(entryPath));
    }
  }

  return files;
}

async function collectArtifactDirectories(
  rootDirectory: string,
  suffix: string,
): Promise<string[]> {
  const dirs: string[] = [];
  const pending: string[] = [rootDirectory];

  while (pending.length > 0) {
    const currentDir = pending.pop();
    if (!currentDir) {
      continue;
    }

    const entries = await readDirSafe(currentDir);
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const entryPath = path.join(currentDir, entry.name);
      if (entry.name.endsWith(suffix)) {
        dirs.push(path.resolve(entryPath));
        continue;
      }
      pending.push(entryPath);
    }
  }

  return dirs;
}

function slugFromArtifactPath(
  rootDirectory: string,
  artifactPath: string,
  suffix: string,
): string {
  const relativePath = path.relative(rootDirectory, artifactPath);
  const slugPath = relativePath.slice(0, -suffix.length);
  return toPosixPath(slugPath);
}

function ensureRecord(
  artifacts: Map<string, ExistingArtifactsRecord>,
  slug: string,
): ExistingArtifactsRecord {
  let record = artifacts.get(slug);
  if (record === undefined) {
    record = {
      json: new Set(),
      module: new Set(),
      assets: new Set(),
    };
    artifacts.set(slug, record);
  }
  return record;
}

function markHandled(
  artifacts: Map<string, ExistingArtifactsRecord>,
  slug: string,
  paths: ArtifactPaths,
): void {
  const record = artifacts.get(slug);
  if (!record) {
    return;
  }
  record.json.delete(paths.jsonPath);
  record.module.delete(paths.modulePath);
  record.assets.delete(paths.assetsDir);
  if (record.json.size === 0 && record.module.size === 0 && record.assets.size === 0) {
    artifacts.delete(slug);
  }
}

async function readDirSafe(target: string) {
  try {
    return await fsPromises.readdir(target, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function readFile(targetPath: string): Promise<Uint8Array | undefined> {
  try {
    return await fsPromises.readFile(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fsPromises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function safeUnlink(targetPath: string): Promise<void> {
  try {
    await fsPromises.unlink(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
}

function buffersEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function toBuffer(content: string): Uint8Array {
  return Buffer.from(content, 'utf8');
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}
