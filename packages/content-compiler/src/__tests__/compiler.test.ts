import { describe, expect, it } from 'vitest';

import {
  compileContentPack,
  compileWorkspacePacks,
} from '../compiler/pipeline.js';
import { createModuleIndices } from '../runtime.js';
import { createWorkspaceSummary } from '../artifacts/summary.js';

describe('content compiler scaffolding', () => {
  it('returns basic artifact metadata from compileContentPack', async () => {
    const result = await compileContentPack(
      {
        absolutePath: '/fake/path.json',
        relativePath: 'fake/path.json',
        packSlug: 'fake-pack',
        document: {},
      },
      {},
    );

    expect(result.packSlug).toBe('fake-pack');
    expect(result.artifacts).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('creates an empty workspace summary', async () => {
    const workspaceResult = await compileWorkspacePacks(
      { rootDirectory: process.cwd() },
      { summaryOutputPath: '/tmp/summary.json' },
    );

    const summary = createWorkspaceSummary(workspaceResult, '2024-01-01T00:00:00Z');

    expect(summary.packs).toEqual([]);
    expect(summary.generatedAt).toBe('2024-01-01T00:00:00Z');
  });

  it('builds module indices without throwing', () => {
    const indices = createModuleIndices({
      metadata: {
        id: 'test',
        name: 'Test Pack',
        version: '0.0.0',
      },
      modules: {},
    });

    expect(indices.resources.size).toBe(0);
  });
});
