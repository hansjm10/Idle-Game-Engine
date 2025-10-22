import { describe, expect, it } from 'vitest';

import { serializeNormalizedContentPack } from '../artifacts/json.js';
import { createWorkspaceSummary } from '../artifacts/summary.js';
import { compileContentPack, compileWorkspacePacks } from '../compiler/pipeline.js';
import { computeArtifactHash, computeContentDigest } from '../hashing.js';
import { createModuleIndices, rehydrateNormalizedPack } from '../runtime.js';

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

  it('serializes normalized packs without dropping module data', () => {
    const pack = {
      metadata: {
        id: 'serialized-pack',
        name: 'Serialized Pack',
        version: '1.0.0',
      },
      modules: {
        resources: [{ id: 'resource-1' }],
      },
    } as const;
    const warnings = [
      {
        code: 'test',
        message: 'example warning',
      },
    ] as const;

    const serialized = serializeNormalizedContentPack(pack, {
      warnings,
      digest: 'digest-abc',
      artifactHash: 'hash-123',
    });

    expect(serialized.metadata).toEqual(pack.metadata);
    expect(serialized.modules).toEqual(pack.modules);
    expect(serialized.warnings).toEqual(warnings);
    expect(serialized.digest).toBe('digest-abc');
    expect(serialized.artifactHash).toBe('hash-123');
  });

  it('rehydrates serialized packs with frozen modules', () => {
    const serialized = {
      formatVersion: 1,
      metadata: {
        id: 'rehydrate-pack',
        name: 'Rehydrate Pack',
        version: '1.2.3',
      },
      warnings: [],
      modules: {
        resources: Object.freeze([{ id: 'res-1' }]),
      },
      digest: 'digest-xyz',
      artifactHash: undefined,
    } as const;

    const pack = rehydrateNormalizedPack(serialized);

    expect(pack.metadata).toEqual(serialized.metadata);
    expect(pack.modules).toEqual(serialized.modules);
    expect(Object.isFrozen(pack.modules)).toBe(true);
  });

  it('computes deterministic hashes for content and artifacts', () => {
    const input = {
      nested: ['a', 'b'],
      value: 42,
    };

    const digestA = computeContentDigest(input);
    const digestB = computeContentDigest({ value: 42, nested: ['a', 'b'] });

    expect(digestA).toEqual(digestB);
    expect(digestA).toMatch(/^[0-9a-f]{8}$/);

    const bytes = new TextEncoder().encode('hello world');
    const artifactHash = computeArtifactHash(bytes);

    expect(artifactHash).toBe(
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
    );
  });
});
