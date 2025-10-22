import { parseContentPack } from '@idle-engine/content-schema';
import { describe, expect, it } from 'vitest';

import { serializeNormalizedContentPack } from '../artifacts/json.js';
import { createWorkspaceSummary } from '../artifacts/summary.js';
import { compileContentPack, compileWorkspacePacks } from '../compiler/pipeline.js';
import { computeArtifactHash, computeContentDigest } from '../hashing.js';
import { createModuleIndices, rehydrateNormalizedPack } from '../runtime.js';
import type {
  SerializedContentSchemaWarning,
  SerializedNormalizedContentPack,
  SerializedNormalizedModules,
} from '../types.js';

const createSchemaDocument = () =>
  ({
    metadata: {
      id: 'test-pack',
      title: { default: 'Test Pack', variants: {} },
      version: '0.0.1',
      engine: '^1.0.0',
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
  }) as const;

const { pack: baseSchemaPack } = parseContentPack(createSchemaDocument());
const BASE_METADATA = baseSchemaPack.metadata;

const EMPTY_MODULES: SerializedNormalizedModules = {
  resources: [] as SerializedNormalizedModules['resources'],
  generators: [] as SerializedNormalizedModules['generators'],
  upgrades: [] as SerializedNormalizedModules['upgrades'],
  metrics: [] as SerializedNormalizedModules['metrics'],
  achievements: [] as SerializedNormalizedModules['achievements'],
  automations: [] as SerializedNormalizedModules['automations'],
  transforms: [] as SerializedNormalizedModules['transforms'],
  prestigeLayers: [] as SerializedNormalizedModules['prestigeLayers'],
  guildPerks: [] as SerializedNormalizedModules['guildPerks'],
  runtimeEvents: [] as SerializedNormalizedModules['runtimeEvents'],
};

function createModules(
  overrides: Partial<SerializedNormalizedModules> = {},
): SerializedNormalizedModules {
  return {
    resources: overrides.resources ?? EMPTY_MODULES.resources,
    generators: overrides.generators ?? EMPTY_MODULES.generators,
    upgrades: overrides.upgrades ?? EMPTY_MODULES.upgrades,
    metrics: overrides.metrics ?? EMPTY_MODULES.metrics,
    achievements: overrides.achievements ?? EMPTY_MODULES.achievements,
    automations: overrides.automations ?? EMPTY_MODULES.automations,
    transforms: overrides.transforms ?? EMPTY_MODULES.transforms,
    prestigeLayers: overrides.prestigeLayers ?? EMPTY_MODULES.prestigeLayers,
    guildPerks: overrides.guildPerks ?? EMPTY_MODULES.guildPerks,
    runtimeEvents: overrides.runtimeEvents ?? EMPTY_MODULES.runtimeEvents,
  };
}

function createSerializedPack(
  overrides: Partial<SerializedNormalizedContentPack> = {},
): SerializedNormalizedContentPack {
  const modules = overrides.modules ?? createModules();

  return {
    formatVersion: 1,
    metadata: overrides.metadata ?? BASE_METADATA,
    modules,
    warnings: overrides.warnings ?? [],
    digest: overrides.digest,
    artifactHash: overrides.artifactHash,
  };
}

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

  it('builds module indices for serialized module arrays', () => {
    const resource = { id: 'resource-1' } as unknown as SerializedNormalizedModules['resources'][number];
    const serialized = createSerializedPack({
      modules: createModules({
        resources: [resource] as SerializedNormalizedModules['resources'],
      }),
    });

    const pack = rehydrateNormalizedPack(serialized);
    const indices = createModuleIndices(pack);

    expect(indices.resources.get(resource.id)).toBe(0);
    expect(indices.generators.size).toBe(0);
  });

  it('serializes normalized packs without dropping module data', () => {
    const warnings: readonly SerializedContentSchemaWarning[] = [
      {
        code: 'test',
        message: 'example warning',
        severity: 'warning',
        path: ['metadata'] as const,
        suggestion: 'double-check metadata fields',
      },
    ];
    const resource = { id: 'serialized-resource' } as unknown as SerializedNormalizedModules['resources'][number];
    const serialized = createSerializedPack({
      modules: createModules({
        resources: [resource] as SerializedNormalizedModules['resources'],
      }),
    });

    const pack = rehydrateNormalizedPack(serialized);
    const result = serializeNormalizedContentPack(pack, {
      warnings,
      digest: pack.digest.hash,
      artifactHash: 'hash-123',
    });

    expect(result.metadata).toEqual(pack.metadata);
    expect(result.modules).toEqual(pack.modules);
    expect(result.warnings).toEqual(warnings);
    expect(result.digest).toBe(pack.digest.hash);
    expect(result.artifactHash).toBe('hash-123');
  });

  it('serializes packs emitted by the content schema without a modules bag', () => {
    const document = {
      metadata: {
        id: 'test-pack',
        title: { default: 'Test Pack', variants: {} },
        version: '0.0.1',
        engine: '^1.0.0',
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
    } as const;

    const { pack, warnings } = parseContentPack(document);
    const serialized = serializeNormalizedContentPack(pack, { warnings });

    expect(serialized.metadata).toEqual(pack.metadata);
    expect(serialized.modules.resources).toBe(pack.resources);
    expect(serialized.modules.generators).toBe(pack.generators);
    expect(serialized.warnings).toEqual(warnings);
    expect(serialized.digest).toBe(pack.digest.hash);
  });

  it('rehydrates serialized packs with lookup metadata and digest verification', () => {
    const resource = { id: 'res-1' } as unknown as SerializedNormalizedModules['resources'][number];
    const modules = createModules({
      resources: [resource] as SerializedNormalizedModules['resources'],
    });
    const digest = computeContentDigest({
      metadata: BASE_METADATA,
      modules,
    });

    const serialized = createSerializedPack({
      modules,
      warnings: [],
      digest,
    });

    const pack = rehydrateNormalizedPack(serialized, { verifyDigest: true });

    expect(pack.metadata).toEqual(serialized.metadata);
    expect(Object.isFrozen(pack.modules)).toBe(true);
    expect(pack.resources).toHaveLength(1);
    expect(pack.lookup.resources.get(resource.id)).toBe(resource);
    expect(pack.digest.hash).toBe(digest);
  });

  it('throws when verifyDigest detects mismatched hashes', () => {
    const serialized = createSerializedPack({
      digest: 'fnv1a-deadbeef',
    });

    expect(() => rehydrateNormalizedPack(serialized, { verifyDigest: true })).toThrow(
      /Digest mismatch/,
    );
  });

  it('throws when verifyDigest is requested without a serialized digest', () => {
    const serialized = createSerializedPack();

    expect(() => rehydrateNormalizedPack(serialized, { verifyDigest: true })).toThrow(
      /does not include a digest/,
    );
  });

  it('computes deterministic hashes for content and artifacts', () => {
    const modulesA = createModules({
      resources: [
        { id: 'alpha' } as unknown as SerializedNormalizedModules['resources'][number],
        { id: 'beta' } as unknown as SerializedNormalizedModules['resources'][number],
      ],
    });
    const modulesB = createModules({
      resources: [
        { id: 'alpha' } as unknown as SerializedNormalizedModules['resources'][number],
        { id: 'beta' } as unknown as SerializedNormalizedModules['resources'][number],
      ],
    });

    const digestA = computeContentDigest({
      metadata: BASE_METADATA,
      modules: modulesA,
    });
    const digestB = computeContentDigest({
      metadata: BASE_METADATA,
      modules: modulesB,
    });

    expect(digestA).toEqual(digestB);
    expect(digestA).toMatch(/^fnv1a-[0-9a-f]{8}$/);

    const bytes = new TextEncoder().encode('hello world');
    const artifactHash = computeArtifactHash(bytes);

    expect(artifactHash).toBe(
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
    );
  });
});
