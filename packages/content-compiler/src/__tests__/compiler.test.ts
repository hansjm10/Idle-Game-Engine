import { parseContentPack } from '@idle-engine/content-schema';
import { describe, expect, it } from 'vitest';

import {
  canonicalizeSerializedNormalizedContentPack,
  canonicalizeSerializedNormalizedContentPackForHash,
  serializeNormalizedContentPack,
} from '../artifacts/json.js';
import { computeArtifactHash, computeContentDigest } from '../hashing.js';
import { createModuleIndices, rehydrateNormalizedPack } from '../runtime.js';
import {
  SERIALIZED_PACK_FORMAT_VERSION,
  type SerializedContentDigest,
  type SerializedContentSchemaWarning,
  type SerializedNormalizedContentPack,
  type SerializedNormalizedModules,
} from '../types.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
    fonts: [],
    resources: [],
    entities: [],
    generators: [],
    upgrades: [],
    metrics: [],
    achievements: [],
    automations: [],
    transforms: [],
    prestigeLayers: [],
    runtimeEvents: [],
  }) as const;

const { pack: baseSchemaPack } = parseContentPack(createSchemaDocument());
const BASE_METADATA = baseSchemaPack.metadata;

const EMPTY_MODULES: SerializedNormalizedModules = {
  fonts: [] as SerializedNormalizedModules['fonts'],
  resources: [] as SerializedNormalizedModules['resources'],
  entities: [] as SerializedNormalizedModules['entities'],
  generators: [] as SerializedNormalizedModules['generators'],
  upgrades: [] as SerializedNormalizedModules['upgrades'],
  metrics: [] as SerializedNormalizedModules['metrics'],
  achievements: [] as SerializedNormalizedModules['achievements'],
  automations: [] as SerializedNormalizedModules['automations'],
  transforms: [] as SerializedNormalizedModules['transforms'],
  prestigeLayers: [] as SerializedNormalizedModules['prestigeLayers'],
  runtimeEvents: [] as SerializedNormalizedModules['runtimeEvents'],
};

function createModules(
  overrides: Partial<SerializedNormalizedModules> = {},
): SerializedNormalizedModules {
  return {
    fonts: overrides.fonts ?? EMPTY_MODULES.fonts,
    resources: overrides.resources ?? EMPTY_MODULES.resources,
    entities: overrides.entities ?? EMPTY_MODULES.entities,
    generators: overrides.generators ?? EMPTY_MODULES.generators,
    upgrades: overrides.upgrades ?? EMPTY_MODULES.upgrades,
    metrics: overrides.metrics ?? EMPTY_MODULES.metrics,
    achievements: overrides.achievements ?? EMPTY_MODULES.achievements,
    automations: overrides.automations ?? EMPTY_MODULES.automations,
    transforms: overrides.transforms ?? EMPTY_MODULES.transforms,
    prestigeLayers: overrides.prestigeLayers ?? EMPTY_MODULES.prestigeLayers,
    runtimeEvents: overrides.runtimeEvents ?? EMPTY_MODULES.runtimeEvents,
  };
}

function createSerializedPack(
  overrides: Partial<SerializedNormalizedContentPack> = {},
): SerializedNormalizedContentPack {
  const modules = overrides.modules ?? createModules();
  const metadata = overrides.metadata ?? BASE_METADATA;
  const warnings = overrides.warnings ?? [];
  const digest =
    overrides.digest ??
    computeContentDigest({
      metadata,
      modules,
    });

  const draft: SerializedNormalizedContentPack = {
    formatVersion: SERIALIZED_PACK_FORMAT_VERSION,
    metadata,
    modules,
    warnings,
    digest,
    artifactHash: overrides.artifactHash ?? '',
  };

  if (overrides.artifactHash !== undefined) {
    return Object.freeze(draft);
  }

  const canonicalForHash = canonicalizeSerializedNormalizedContentPackForHash(draft);
  const artifactHash = computeArtifactHash(encoder.encode(canonicalForHash));

  return Object.freeze({
    ...draft,
    artifactHash,
  });
}

describe('content compiler scaffolding', () => {
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
    expect(indices.entities.size).toBe(0);
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
    const result = serializeNormalizedContentPack(pack, { warnings });

    expect(result.serialized.metadata).toEqual(pack.metadata);
    expect(result.serialized.modules).toEqual(pack.modules);
    expect(result.serialized.warnings).toEqual(warnings);
    expect(result.serialized.digest).toEqual(pack.digest);
    const canonicalForHash =
      canonicalizeSerializedNormalizedContentPackForHash(result.serialized);
    expect(result.serialized.artifactHash).toBe(
      computeArtifactHash(encoder.encode(canonicalForHash)),
    );
    const hashInputJson = decoder.decode(result.hashInput);
    expect(hashInputJson).toContain('"artifactHash":""');
    expect(result.canonicalJson).toBe(
      canonicalizeSerializedNormalizedContentPack(result.serialized),
    );
    expect(hashInputJson).toBe(canonicalForHash);
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
    entities: [],
    generators: [],
    upgrades: [],
    metrics: [],
    achievements: [],
    automations: [],
      transforms: [],
      prestigeLayers: [],
      runtimeEvents: [],
    } as const;

    const { pack, warnings } = parseContentPack(document);
    const result = serializeNormalizedContentPack(pack, { warnings });

    expect(result.serialized.metadata).toEqual(pack.metadata);
    expect(result.serialized.modules.resources).toBe(pack.resources);
    expect(result.serialized.modules.entities).toBe(pack.entities);
    expect(result.serialized.modules.generators).toBe(pack.generators);
    expect(result.serialized.warnings).toEqual(warnings);
    expect(result.serialized.digest).toEqual(pack.digest);
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
    expect(pack.digest).toEqual(digest);
  });

  it('throws when verifyDigest detects mismatched hashes', () => {
    const mismatchedDigest: SerializedContentDigest = {
      ...computeContentDigest({
        metadata: BASE_METADATA,
        modules: createModules(),
      }),
      hash: 'fnv1a-deadbeef',
    };

    const serialized = createSerializedPack({
      digest: mismatchedDigest,
    });

    expect(() => rehydrateNormalizedPack(serialized, { verifyDigest: true })).toThrow(
      /Digest mismatch/,
    );
  });

  it('rehydrates without digest verification when disabled', () => {
    const serialized = createSerializedPack();
    const tamperedDigest: SerializedContentDigest = {
      ...serialized.digest,
      hash: 'fnv1a-deadbeef',
    };

    const tampered = Object.freeze({
      ...serialized,
      digest: tamperedDigest,
    }) as SerializedNormalizedContentPack;

    const pack = rehydrateNormalizedPack(tampered);

    expect(pack.digest).toEqual(tamperedDigest);
  });

  it('throws when verifyDigest is requested without a serialized digest', () => {
    const serialized = createSerializedPack();
    const { digest: _digest, ...rest } = serialized;
    const withoutDigest = rest as unknown as SerializedNormalizedContentPack;

    expect(() => rehydrateNormalizedPack(withoutDigest, { verifyDigest: true })).toThrow(
      /does not include a digest/,
    );
  });

  it('throws when serialized pack format version is unsupported', () => {
    const serialized = createSerializedPack();
    const unsupported = Object.freeze({
      ...serialized,
      formatVersion: SERIALIZED_PACK_FORMAT_VERSION + 1,
    }) as unknown as SerializedNormalizedContentPack;

    expect(() => rehydrateNormalizedPack(unsupported)).toThrow(
      /Unsupported serialized content pack format/,
    );
  });

  it('rejects module entries missing identifiers during rehydration', () => {
    const modules = createModules({
      resources: [
        {} as unknown as SerializedNormalizedModules['resources'][number],
      ] as SerializedNormalizedModules['resources'],
    });

    const serialized = createSerializedPack({ modules });

    expect(() => rehydrateNormalizedPack(serialized)).toThrow(/missing a valid id/);
  });

  it('rejects duplicate module identifiers during rehydration', () => {
    const resourceA = { id: 'duplicate' } as unknown as SerializedNormalizedModules['resources'][number];
    const resourceB = { id: 'duplicate' } as unknown as SerializedNormalizedModules['resources'][number];

    const serialized = createSerializedPack({
      modules: createModules({
        resources: [resourceA, resourceB] as SerializedNormalizedModules['resources'],
      }),
    });

    expect(() => rehydrateNormalizedPack(serialized)).toThrow(/Duplicate resources id/);
  });

  it('creates zero-based module indices aligned with module order', () => {
    const modules = createModules({
      resources: [
        { id: 'first-resource' } as unknown as SerializedNormalizedModules['resources'][number],
        { id: 'second-resource' } as unknown as SerializedNormalizedModules['resources'][number],
      ],
      generators: [
        { id: 'generator-a' } as unknown as SerializedNormalizedModules['generators'][number],
      ],
    });

    const serialized = createSerializedPack({ modules });
    const pack = rehydrateNormalizedPack(serialized);
    const indices = createModuleIndices(pack);

    expect(indices.resources.get('first-resource')).toBe(0);
    expect(indices.resources.get('second-resource')).toBe(1);
    expect(indices.generators.get('generator-a')).toBe(0);
    expect(Object.isFrozen(indices)).toBe(true);
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
    expect(digestA.hash).toMatch(/^fnv1a-[0-9a-f]{8}$/);

    const bytes = encoder.encode('hello world');
    const artifactHash = computeArtifactHash(bytes);

    expect(artifactHash).toBe(
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
    );

    const serializedA = createSerializedPack({ modules: modulesA });
    const serializedB = createSerializedPack({ modules: modulesB });

    expect(serializedA.artifactHash).toEqual(serializedB.artifactHash);
    expect(
      canonicalizeSerializedNormalizedContentPack(serializedA),
    ).toEqual(canonicalizeSerializedNormalizedContentPack(serializedB));
  });
});
