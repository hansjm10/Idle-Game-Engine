import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { compileWorkspacePacks } from '../compiler/pipeline.js';

function createPackDocument(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const baseDocument = {
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

async function writePackManifest(
  workspaceRoot: string,
  packageName: string,
  document: Record<string, unknown>,
): Promise<void> {
  const packageRoot = path.join(workspaceRoot, 'packages', packageName, 'content');
  await fs.mkdir(packageRoot, { recursive: true });
  const manifestPath = path.join(packageRoot, 'pack.json');
  await fs.writeFile(manifestPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
}

describe('compileWorkspacePacks schema options', () => {
  it('passes schema context options through to parseContentPack', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'content-compiler-schema-'));
    await writePackManifest(workspaceRoot, 'alpha', createPackDocument('alpha-pack'));
    const fsHandle = { rootDirectory: workspaceRoot };

    const schemaModule = await import('@idle-engine/content-schema');
    const parseSpy = vi.spyOn(schemaModule, 'parseContentPack');

    const schemaOptions = {
      knownPacks: [
        {
          id: 'beta-pack',
          version: '0.1.0',
          requires: [{ packId: 'gamma-pack', version: '^0.0.1' }],
        },
      ],
      activePackIds: ['beta-pack', 'gamma-pack'],
      runtimeEventCatalogue: ['event.alpha'],
    } as const;

    const calls: unknown[][] = [];

    try {
      await compileWorkspacePacks(fsHandle, { schema: schemaOptions });
      calls.push(...parseSpy.mock.calls);
    } finally {
      parseSpy.mockRestore();
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }

    expect(calls.length).toBeGreaterThan(0);
    for (const [, receivedOptions] of calls) {
      expect(receivedOptions).toEqual(schemaOptions);
    }
  });
});
