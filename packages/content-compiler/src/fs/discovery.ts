import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import JSON5 from 'json5';

import type { ContentDocument, WorkspaceFS } from '../types.js';

const PACKAGES_DIRECTORY = 'packages';
const PACK_MANIFEST_FILENAMES = ['content/pack.json', 'content/pack.json5'] as const;

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fsPromises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function assertValidSlug(
  document: unknown,
  manifestPath: string,
): asserts document is { readonly metadata: { readonly id: string } } {
  const metadata = (document as { readonly metadata?: unknown })?.metadata;
  if (typeof metadata !== 'object' || metadata === null) {
    throw new Error(
      `Content pack ${manifestPath} is missing a metadata block.`,
    );
  }
  const id = (metadata as { readonly id?: unknown }).id;
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new Error(
      `Content pack ${manifestPath} must declare a non-empty metadata.id string.`,
    );
  }
}

export async function discoverContentDocuments(
  workspace: WorkspaceFS,
): Promise<readonly ContentDocument[]> {
  const rootDirectory = workspace.rootDirectory;
  const packagesRoot = path.resolve(rootDirectory, PACKAGES_DIRECTORY);

  const packages = await fsPromises.readdir(packagesRoot, { withFileTypes: true });
  const documents: ContentDocument[] = [];
  const seenSlugs = new Map<string, string>();

  for (const entry of packages) {
    if (!entry.isDirectory()) {
      continue;
    }

    const packageRoot = path.join(packagesRoot, entry.name);
    const manifestPath = await resolveManifestPath(packageRoot);
    if (manifestPath === undefined) {
      continue;
    }

    const relativePath = toPosixPath(
      path.relative(rootDirectory, manifestPath),
    );
    const absolutePath = path.resolve(manifestPath);

    let parsed: unknown;
    try {
      const raw = await fsPromises.readFile(manifestPath, 'utf8');
      parsed = parseManifest(raw, manifestPath);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to read content pack ${relativePath}: ${message}`,
      );
    }

    assertValidSlug(parsed, relativePath);
    const packSlug = parsed.metadata.id;

    const existingPath = seenSlugs.get(packSlug);
    if (existingPath !== undefined) {
      throw new Error(
        `Duplicate content pack slug "${packSlug}" found at ${relativePath} (already declared in ${existingPath}).`,
      );
    }
    seenSlugs.set(packSlug, relativePath);

    documents.push({
      absolutePath,
      relativePath,
      packSlug,
      document: parsed,
    });
  }

  documents.sort((left, right) => {
    if (left.packSlug !== right.packSlug) {
      return left.packSlug < right.packSlug ? -1 : 1;
    }
    return left.relativePath < right.relativePath ? -1 : 1;
  });

  return documents;
}

async function resolveManifestPath(packageRoot: string): Promise<string | undefined> {
  for (const filename of PACK_MANIFEST_FILENAMES) {
    const candidate = path.join(packageRoot, filename);
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function parseManifest(raw: string, manifestPath: string): unknown {
  return manifestPath.endsWith('.json5')
    ? (JSON5.parse(raw) as unknown)
    : (JSON.parse(raw) as unknown);
}
