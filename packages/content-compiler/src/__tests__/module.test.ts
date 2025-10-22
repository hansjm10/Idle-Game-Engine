import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { compileContentPack } from '../compiler/pipeline.js';
import { createGeneratedModuleSource } from '../artifacts/module.js';
import { discoverContentDocuments } from '../fs/discovery.js';
import type { WorkspaceFS } from '../types.js';

const TMP_PREFIX = 'content-compiler-module-';

async function createWorkspace(): Promise<string> {
  const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), TMP_PREFIX));
  const packageRoot = path.join(rootDirectory, 'packages/sample', 'content');
  await fs.mkdir(packageRoot, { recursive: true });
  const manifestPath = path.join(packageRoot, 'pack.json');
  await fs.writeFile(
    manifestPath,
    JSON.stringify(
      {
        metadata: {
          id: 'module-pack',
          title: { default: 'Module Test', variants: {} },
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
      },
      null,
      2,
    ),
    'utf8',
  );
  return rootDirectory;
}

describe('createGeneratedModuleSource', () => {
  it('emits a module with digest, hash, and summary exports', async () => {
    const workspaceRoot = await createWorkspace();
    const fsHandle: WorkspaceFS = { rootDirectory: workspaceRoot };
    const [document] = await discoverContentDocuments(fsHandle);
    if (!document) throw new Error('No document discovered');
    const result = await compileContentPack(document, {});
    if (result.status !== 'compiled') throw new Error('Expected compiled result');

    const moduleSource = createGeneratedModuleSource({
      packSlug: result.packSlug,
      artifact: result.artifact,
    });

    expect(moduleSource).toContain('export const MODULE_PACK = rehydrateNormalizedPack');
    expect(moduleSource).toContain('export const MODULE_PACK_DIGEST = serialized.digest;');
    expect(moduleSource).toContain('export const MODULE_PACK_ARTIFACT_HASH = serialized.artifactHash;');
    expect(moduleSource).toContain('export const MODULE_PACK_INDICES = createModuleIndices(MODULE_PACK);');
    expect(moduleSource).toContain('export const MODULE_PACK_SUMMARY = Object.freeze({');
    expect(moduleSource).toContain(
      `"artifactHash": "${result.artifact.serialized.artifactHash}"`,
    );
    expect(moduleSource).toContain(
      `"hash": "${result.artifact.serialized.digest.hash}"`,
    );
  });
});
