import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { compileContentPack } from '../compiler/pipeline.js';
import { discoverContentDocuments } from '../fs/discovery.js';
import type { WorkspaceFS } from '../types.js';

const generateMsdfFontAssetFilesMock = vi.hoisted(() =>
  vi.fn(async () => ({
    atlasPng: new Uint8Array([1, 2, 3]),
    metadataJson: '{"schemaVersion":1,"id":"mock-font","technique":"msdf","baseFontSizePx":42,"lineHeightPx":50,"glyphs":[],"msdf":{"pxRange":3}}',
    contentHash: 'deadbeef',
  })),
);

vi.mock('../artifacts/fonts.js', () => ({
  generateMsdfFontAssetFiles: generateMsdfFontAssetFilesMock,
}));

const TMP_PREFIX = 'content-compiler-font-assets-';

async function createWorkspace(): Promise<{ rootDirectory: string; manifestPath: string }> {
  const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), TMP_PREFIX));
  const packageRoot = path.join(rootDirectory, 'packages/sample', 'content');
  await fs.mkdir(packageRoot, { recursive: true });
  const manifestPath = path.join(packageRoot, 'pack.json');
  await fs.writeFile(
    manifestPath,
    JSON.stringify(
      {
        metadata: {
          id: 'sample-pack',
          title: { default: 'Sample', variants: {} },
          version: '0.0.1',
          engine: '^0.1.0',
          defaultLocale: 'en-US',
          supportedLocales: ['en-US'],
        },
        fonts: [
          {
            id: 'ui-font',
            source: 'fonts/ui.ttf',
            baseSizePx: 42,
          },
        ],
        resources: [],
        generators: [],
        upgrades: [],
        metrics: [],
        achievements: [],
        automations: [],
        transforms: [],
        prestigeLayers: [],
        runtimeEvents: [],
      },
      null,
      2,
    ),
    'utf8',
  );

  return { rootDirectory, manifestPath };
}

describe('writeWorkspaceArtifacts font assets', () => {
  it('writes renderer font assets when fonts are declared', async () => {
    const { rootDirectory, manifestPath } = await createWorkspace();
    const fsHandle: WorkspaceFS = { rootDirectory };
    const [document] = await discoverContentDocuments(fsHandle);
    if (!document) throw new Error('No document discovered');

    const compiled = await compileContentPack(document, {});
    if (compiled.status !== 'compiled') throw new Error('Expected compilation success');

    const { writeWorkspaceArtifacts } = await import('../fs/writer.js');

    const writeResult = await writeWorkspaceArtifacts(fsHandle, [compiled]);
    const assetOps = writeResult.operations.filter(
      (op) => op.slug === 'sample-pack' && op.kind === 'asset',
    );

    expect(assetOps.length).toBeGreaterThanOrEqual(3);
    expect(generateMsdfFontAssetFilesMock).toHaveBeenCalledWith({
      font: expect.anything(),
      sourcePath: path.resolve(path.dirname(manifestPath), 'fonts/ui.ttf'),
    });

    const manifestOp = assetOps.find((op) =>
      op.path.endsWith('renderer-assets.manifest.json'),
    );
    expect(manifestOp?.action).toBe('written');

    const manifestOnDisk = await fs.readFile(
      path.join(rootDirectory, manifestOp!.path),
      'utf8',
    );
    const parsed = JSON.parse(manifestOnDisk) as unknown;
    expect(parsed).toMatchObject({
      schemaVersion: 4,
      assets: [
        {
          id: 'ui-font',
          kind: 'font',
          contentHash: 'deadbeef',
        },
      ],
    });
  });
});

