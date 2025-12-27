import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { compileContentPack } from '../compiler/pipeline.js';
import { createWorkspaceSummary } from '../artifacts/summary.js';
import { discoverContentDocuments } from '../fs/discovery.js';
import { writeWorkspaceArtifacts } from '../fs/writer.js';
import type {
  PackArtifactResult,
  WorkspaceArtifactWriteResult,
  WorkspaceFS,
  WorkspaceSummary,
} from '../types.js';

const TMP_PREFIX = 'content-compiler-summary-';

interface Workspace {
  readonly rootDirectory: string;
  writePack(packageName: string, document: Record<string, unknown>): Promise<void>;
}

async function createWorkspace(): Promise<Workspace> {
  const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), TMP_PREFIX));
  const packagesRoot = path.join(rootDirectory, 'packages');
  await fs.mkdir(packagesRoot, { recursive: true });

  return {
    rootDirectory,
    async writePack(packageName, document) {
      const packageRoot = path.join(packagesRoot, packageName, 'content');
      await fs.mkdir(packageRoot, { recursive: true });
      const manifestPath = path.join(packageRoot, 'pack.json');
      await fs.writeFile(manifestPath, JSON.stringify(document, null, 2), 'utf8');
    },
  };
}

function createPackDocument(
  id: string,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  const base = {
    metadata: {
      id,
      title: { default: `${id} title`, variants: {} },
      version: '0.0.1',
      engine: '^0.1.0',
      defaultLocale: 'en-US',
      supportedLocales: ['en-US'],
    },
    resources: [],
    generators: [],
    upgrades: [],
    metrics: [],
    achievements: [],
    automations: [],
    transforms: [],
    prestigeLayers: [],
    runtimeEvents: [],
  };

  return {
    ...base,
    ...overrides,
    metadata: {
      ...base.metadata,
      ...(overrides.metadata as Record<string, unknown> | undefined),
      id,
    },
  };
}

async function compileAllPacks(workspace: Workspace): Promise<PackArtifactResult[]> {
  const fsHandle: WorkspaceFS = { rootDirectory: workspace.rootDirectory };
  const documents = await discoverContentDocuments(fsHandle);
  const compileResults: PackArtifactResult[] = [];

  for (const document of documents) {
    compileResults.push(await compileContentPack(document, {}));
  }

  return compileResults;
}

function findSummaryEntry(summary: WorkspaceSummary, slug: string) {
  return summary.packs.find((pack) => pack.slug === slug);
}

describe('createWorkspaceSummary', () => {
  it('captures artifact metadata for compiled packs', async () => {
    const workspace = await createWorkspace();
    await workspace.writePack('alpha', createPackDocument('alpha-pack'));
    await workspace.writePack(
      'beta',
      createPackDocument('beta-pack', {
        metadata: {
          dependencies: {
            requires: [{ packId: 'alpha-pack' }],
            optional: [],
            conflicts: [],
          },
        },
      }),
    );

    const compileResults = await compileAllPacks(workspace);
    const fsHandle: WorkspaceFS = { rootDirectory: workspace.rootDirectory };
    const artifactWrites = await writeWorkspaceArtifacts(fsHandle, compileResults);
    const summary = createWorkspaceSummary({
      results: compileResults,
      artifacts: artifactWrites,
    });

    const alpha = findSummaryEntry(summary, 'alpha-pack');
    const beta = findSummaryEntry(summary, 'beta-pack');
    expect(alpha?.status).toBe('compiled');
    expect(alpha?.artifactHash).toBeDefined();
    expect(alpha?.artifacts.json).toBe(
      'packages/alpha/content/compiled/alpha-pack.normalized.json',
    );
    expect(alpha?.balance?.warningCount).toBe(0);
    expect(alpha?.balance?.errorCount).toBe(0);
    expect(beta?.dependencies.requires[0]?.packId).toBe('alpha-pack');
    expect(beta?.dependencies.requires[0]?.digest).toBeDefined();
  });

  it('records failures without artifact paths', async () => {
    const workspace = await createWorkspace();
    await workspace.writePack('gamma', createPackDocument('gamma-pack'));
    const compileResults = await compileAllPacks(workspace);
    const failure: PackArtifactResult = {
      status: 'failed',
      packSlug: 'gamma-pack',
      document: compileResults[0]!.document,
      error: new Error('normalization failed'),
      warnings: [],
      durationMs: 0,
    };
    const fsHandle: WorkspaceFS = { rootDirectory: workspace.rootDirectory };
    const artifactWrites: WorkspaceArtifactWriteResult = await writeWorkspaceArtifacts(
      fsHandle,
      [failure],
    );

    const summary = createWorkspaceSummary({
      results: [failure],
      artifacts: artifactWrites,
    });

    const entry = findSummaryEntry(summary, 'gamma-pack');
    expect(entry?.status).toBe('failed');
    expect(entry?.artifacts.json).toBeUndefined();
    expect(entry?.error).toMatch(/normalization failed/);
    expect(entry?.balance?.errorCount).toBe(0);
  });
});
