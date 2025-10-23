import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { compileContentPack } from '../compiler/pipeline.js';
import { createGeneratedModuleSource } from '../artifacts/module.js';
import { discoverContentDocuments } from '../fs/discovery.js';
import { writeWorkspaceArtifacts } from '../fs/writer.js';
import type {
  PackArtifactResult,
  WorkspaceArtifactWriteResult,
  WorkspaceFS,
} from '../types.js';

const TMP_PREFIX = 'content-compiler-writer-';

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

function createPackDocument(id: string): Record<string, unknown> {
  return {
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
    guildPerks: [],
    runtimeEvents: [],
  };
}

async function compileFirstPack(workspace: Workspace): Promise<PackArtifactResult> {
  const fsHandle: WorkspaceFS = { rootDirectory: workspace.rootDirectory };
  const documents = await discoverContentDocuments(fsHandle);
  if (documents.length === 0) {
    throw new Error('No content documents discovered.');
  }
  return compileContentPack(documents[0]!, {});
}

function findOperation(
  result: WorkspaceArtifactWriteResult,
  slug: string,
  kind: 'json' | 'module',
) {
  return result.operations.find(
    (operation) => operation.slug === slug && operation.kind === kind,
  );
}

describe('writeWorkspaceArtifacts', () => {
  it('writes artifacts for compiled packs', async () => {
    const workspace = await createWorkspace();
    await workspace.writePack('alpha', createPackDocument('sample-pack'));
    const packResult = await compileFirstPack(workspace);
    if (packResult.status !== 'compiled') throw new Error('Expected compilation success');

    const fsHandle: WorkspaceFS = { rootDirectory: workspace.rootDirectory };
    const writeResult = await writeWorkspaceArtifacts(fsHandle, [packResult]);

    const jsonOperation = findOperation(writeResult, 'sample-pack', 'json');
    const moduleOperation = findOperation(writeResult, 'sample-pack', 'module');
    expect(jsonOperation?.action).toBe('written');
    expect(moduleOperation?.action).toBe('written');

    const jsonPath = path.join(workspace.rootDirectory, jsonOperation!.path);
    const modulePath = path.join(workspace.rootDirectory, moduleOperation!.path);
    const jsonContent = await fs.readFile(jsonPath, 'utf8');
    const moduleContent = await fs.readFile(modulePath, 'utf8');

    expect(jsonContent).toBe(`${packResult.artifact.canonicalJson}\n`);
    expect(moduleContent).toBe(
      createGeneratedModuleSource({
        packSlug: packResult.packSlug,
        artifact: packResult.artifact,
      }),
    );

    const generatedDir = path.dirname(modulePath);
    const tmpFiles = (await fs.readdir(generatedDir)).filter((name) =>
      name.startsWith('.tmp-'),
    );
    expect(tmpFiles).toHaveLength(0);
  });

  it('does not rewrite identical artifacts', async () => {
    const workspace = await createWorkspace();
    await workspace.writePack('alpha', createPackDocument('stable-pack'));
    const packResult = await compileFirstPack(workspace);
    if (packResult.status !== 'compiled') throw new Error('Expected compilation success');

    const fsHandle: WorkspaceFS = { rootDirectory: workspace.rootDirectory };
    await writeWorkspaceArtifacts(fsHandle, [packResult]);
    const secondWrite = await writeWorkspaceArtifacts(fsHandle, [packResult]);

    const jsonOperation = findOperation(secondWrite, 'stable-pack', 'json');
    const moduleOperation = findOperation(secondWrite, 'stable-pack', 'module');
    expect(jsonOperation?.action).toBe('unchanged');
    expect(moduleOperation?.action).toBe('unchanged');
  });

  it('reports drift without writing files in check mode', async () => {
    const workspace = await createWorkspace();
    await workspace.writePack('alpha', createPackDocument('check-pack'));
    const packResult = await compileFirstPack(workspace);
    if (packResult.status !== 'compiled') throw new Error('Expected compilation success');

    const fsHandle: WorkspaceFS = { rootDirectory: workspace.rootDirectory };
    const writeResult = await writeWorkspaceArtifacts(fsHandle, [packResult], {
      check: true,
    });

    expect(
      writeResult.operations.every(
        (operation) => operation.action === 'would-write',
      ),
    ).toBe(true);

    const jsonOperation = findOperation(writeResult, 'check-pack', 'json');
    const moduleOperation = findOperation(writeResult, 'check-pack', 'module');
    await expect(
      fs.access(path.join(workspace.rootDirectory, jsonOperation!.path)),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(workspace.rootDirectory, moduleOperation!.path)),
    ).rejects.toThrow();
  });

  it('removes stale artifacts for packs that no longer exist', async () => {
    const workspace = await createWorkspace();
    const compiledDir = path.join(
      workspace.rootDirectory,
      'packages/orphan/content/compiled',
    );
    const generatedDir = path.join(
      workspace.rootDirectory,
      'packages/orphan/src/generated',
    );
    await fs.mkdir(compiledDir, { recursive: true });
    await fs.mkdir(generatedDir, { recursive: true });
    const jsonPath = path.join(compiledDir, 'orphan-pack.normalized.json');
    const modulePath = path.join(generatedDir, 'orphan-pack.generated.ts');
    await fs.writeFile(jsonPath, '{}', 'utf8');
    await fs.writeFile(modulePath, 'export {}', 'utf8');

    const fsHandle: WorkspaceFS = { rootDirectory: workspace.rootDirectory };
    const writeResult = await writeWorkspaceArtifacts(fsHandle, []);

    const jsonOperation = findOperation(writeResult, 'orphan-pack', 'json');
    const moduleOperation = findOperation(writeResult, 'orphan-pack', 'module');
    expect(jsonOperation?.action).toBe('deleted');
    expect(moduleOperation?.action).toBe('deleted');
    await expect(fs.access(jsonPath)).rejects.toThrow();
    await expect(fs.access(modulePath)).rejects.toThrow();
  });

  it('deletes existing artifacts when compilation fails', async () => {
    const workspace = await createWorkspace();
    await workspace.writePack('alpha', createPackDocument('unstable-pack'));
    const successResult = await compileFirstPack(workspace);
    if (successResult.status !== 'compiled') throw new Error('Expected compilation success');

    const fsHandle: WorkspaceFS = { rootDirectory: workspace.rootDirectory };
    await writeWorkspaceArtifacts(fsHandle, [successResult]);

    const failureResult: PackArtifactResult = {
      status: 'failed',
      packSlug: 'unstable-pack',
      document: successResult.document,
      error: new Error('schema failure'),
      warnings: [],
      durationMs: 0,
    };

    const removalResult = await writeWorkspaceArtifacts(fsHandle, [failureResult]);
    const jsonOperation = findOperation(removalResult, 'unstable-pack', 'json');
    const moduleOperation = findOperation(removalResult, 'unstable-pack', 'module');
    expect(jsonOperation?.action).toBe('deleted');
    expect(moduleOperation?.action).toBe('deleted');
  });
});
