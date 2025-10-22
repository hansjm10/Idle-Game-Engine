import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { discoverContentDocuments } from '../fs/discovery.js';
import { compileContentPack, compileWorkspacePacks } from '../compiler/pipeline.js';
import type { CompileOptions, ContentDocument, WorkspaceFS } from '../types.js';

const TMP_PREFIX = 'content-compiler-';

interface WorkspaceBuilder {
  readonly rootDirectory: string;
  writePack(packageName: string, document: Record<string, unknown>): Promise<void>;
}

async function createWorkspace(): Promise<WorkspaceBuilder> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), TMP_PREFIX));
  const packagesRoot = path.join(workspaceRoot, 'packages');
  await fs.mkdir(packagesRoot, { recursive: true });

  return {
    rootDirectory: workspaceRoot,
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
  const baseDocument = {
    metadata: {
      id,
      title: { default: `${id} title`, variants: {} },
      version: '0.0.1',
      engine: '^0.1.0',
      defaultLocale: 'en-US',
      supportedLocales: ['en-US'],
      ...(overrides.metadata as Record<string, unknown> | undefined),
    },
    resources: [],
    generators: [],
    upgrades: [],
    metrics: [],
    achievements: [],
    automations: [],
    transforms: [],
    prestigeLayers: [],
    guildPerks: [],
    runtimeEvents: [],
  };

  return {
    ...baseDocument,
    ...overrides,
    metadata: {
      ...baseDocument.metadata,
      ...(overrides.metadata as Record<string, unknown> | undefined),
      id,
    },
  };
}

function createContentDocument(
  document: Record<string, unknown>,
  slug: string,
): ContentDocument {
  return {
    absolutePath: `/virtual/${slug}.json`,
    relativePath: `${slug}.json`,
    packSlug: slug,
    document,
  };
}

describe('content compiler pipeline', () => {
  it('discovers pack documents relative to the workspace root', async () => {
    const workspace = await createWorkspace();
    await workspace.writePack('alpha', createPackDocument('alpha-pack'));
    const fsHandle: WorkspaceFS = { rootDirectory: workspace.rootDirectory };

    const documents = await discoverContentDocuments(fsHandle);

    expect(documents).toHaveLength(1);
    const [document] = documents;
    expect(document.packSlug).toBe('alpha-pack');
    expect(document.relativePath).toBe('packages/alpha/content/pack.json');
    expect(document.absolutePath.endsWith('/alpha/content/pack.json')).toBe(true);
  });

  it('throws when duplicate slugs are discovered', async () => {
    const workspace = await createWorkspace();
    const duplicate = createPackDocument('shared-pack');
    await workspace.writePack('alpha', duplicate);
    await workspace.writePack('beta', duplicate);
    const fsHandle: WorkspaceFS = { rootDirectory: workspace.rootDirectory };

    await expect(discoverContentDocuments(fsHandle)).rejects.toThrow(
      /Duplicate content pack slug/,
    );
  });

  it('rejects packs without a metadata id', async () => {
    const workspace = await createWorkspace();
    const invalidDocument = {
      metadata: {},
      resources: [],
      generators: [],
      upgrades: [],
      metrics: [],
      achievements: [],
      automations: [],
      transforms: [],
      prestigeLayers: [],
      guildPerks: [],
      runtimeEvents: [],
    };
    await workspace.writePack('invalid', invalidDocument);
    const fsHandle: WorkspaceFS = { rootDirectory: workspace.rootDirectory };

    await expect(discoverContentDocuments(fsHandle)).rejects.toThrow(
      /must declare a non-empty metadata\.id/,
    );
  });

  it('compiles a document once and preserves schema warnings', async () => {
    const document = createPackDocument('warning-pack', {
      metadata: {
        dependencies: {
          requires: [],
          optional: [{ packId: 'missing-pack' }],
          conflicts: [],
        },
      },
    });
    const result = await compileContentPack(
      createContentDocument(document, 'warning-pack'),
      { schema: { activePackIds: ['existing-pack'] } },
    );

    expect(result.status).toBe('compiled');
    if (result.status !== 'compiled') return;
    expect(result.normalizedPack.metadata.id).toBe('warning-pack');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.code).toBe('dependencies.optionalMissing');
  });

  it('returns a failure result when schema parsing throws', async () => {
    const invalidDocument = {
      metadata: {
        id: 'broken-pack',
        title: { default: 'Broken', variants: {} },
      },
    } as unknown as Record<string, unknown>;

    const result = await compileContentPack(
      createContentDocument(invalidDocument, 'broken-pack'),
      {},
    );

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).toMatch(/engine/i);
  });

  it('orders workspace compilation based on requires dependencies', async () => {
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
    const fsHandle: WorkspaceFS = { rootDirectory: workspace.rootDirectory };
    const options: CompileOptions = {};

    const result = await compileWorkspacePacks(fsHandle, options);

    expect(result.packs).toHaveLength(2);
    expect(result.packs[0]?.packSlug).toBe('alpha-pack');
    expect(result.packs[1]?.packSlug).toBe('beta-pack');
    expect(result.packs.every((pack) => pack.status === 'compiled')).toBe(true);
  });

  it('marks packs with missing requires dependencies as failures', async () => {
    const workspace = await createWorkspace();
    await workspace.writePack('alpha', createPackDocument('alpha-pack'));
    await workspace.writePack(
      'gamma',
      createPackDocument('gamma-pack', {
        metadata: {
          dependencies: {
            requires: [{ packId: 'missing-pack' }],
            optional: [],
            conflicts: [],
          },
        },
      }),
    );
    const fsHandle: WorkspaceFS = { rootDirectory: workspace.rootDirectory };

    const result = await compileWorkspacePacks(fsHandle, {});

    expect(result.packs).toHaveLength(2);
    const failure = result.packs.find((pack) => pack.packSlug === 'gamma-pack');
    expect(failure?.status).toBe('failed');
    if (failure?.status !== 'failed') return;
    expect(failure.error.message).toMatch(/requires missing dependencies/i);
  });

  it('marks packs as failed when required dependencies fail compilation', async () => {
    const workspace = await createWorkspace();
    const invalidDocument = {
      metadata: {
        id: 'alpha-pack',
        title: { default: 'Broken Alpha', variants: {} },
      },
    } as unknown as Record<string, unknown>;
    await workspace.writePack('alpha', invalidDocument);
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
    const fsHandle: WorkspaceFS = { rootDirectory: workspace.rootDirectory };

    const result = await compileWorkspacePacks(fsHandle, {});

    expect(result.packs).toHaveLength(2);
    const alpha = result.packs.find((pack) => pack.packSlug === 'alpha-pack');
    const beta = result.packs.find((pack) => pack.packSlug === 'beta-pack');
    expect(alpha?.status).toBe('failed');
    expect(beta?.status).toBe('failed');
    if (beta?.status !== 'failed') return;
    expect(beta.error.message).toMatch(/failed to compile/i);
  });

  it('reports dependency cycles without invoking the schema parser', async () => {
    const workspace = await createWorkspace();
    await workspace.writePack(
      'cycle-a',
      createPackDocument('cycle-a', {
        metadata: {
          dependencies: {
            requires: [{ packId: 'cycle-b' }],
            optional: [],
            conflicts: [],
          },
        },
      }),
    );
    await workspace.writePack(
      'cycle-b',
      createPackDocument('cycle-b', {
        metadata: {
          dependencies: {
            requires: [{ packId: 'cycle-a' }],
            optional: [],
            conflicts: [],
          },
        },
      }),
    );
    const fsHandle: WorkspaceFS = { rootDirectory: workspace.rootDirectory };

    const result = await compileWorkspacePacks(fsHandle, {});

    expect(result.packs).toHaveLength(2);
    result.packs.forEach((pack) => {
      expect(pack.status).toBe('failed');
      if (pack.status !== 'failed') return;
      expect(pack.error.message).toMatch(/Dependency cycle detected/);
    });
  });
});
