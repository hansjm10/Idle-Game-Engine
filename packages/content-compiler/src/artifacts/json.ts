import canonicalize from 'canonicalize';

import { computeArtifactHash } from '../hashing.js';
import {
  MODULE_NAMES,
  SERIALIZED_PACK_FORMAT_VERSION,
  type ModuleName,
  type SerializableNormalizedContentPackInput,
  type SerializedContentDigest,
  type SerializedContentSchemaWarning,
  type SerializedNormalizedContentPack,
  type SerializedNormalizedModules,
  type SerializedPackArtifact,
} from '../types.js';

const textEncoder = new TextEncoder();

const EMPTY_MODULES: SerializedNormalizedModules = {
  resources: Object.freeze([]) as SerializedNormalizedModules['resources'],
  entities: Object.freeze([]) as SerializedNormalizedModules['entities'],
  generators: Object.freeze([]) as SerializedNormalizedModules['generators'],
  upgrades: Object.freeze([]) as SerializedNormalizedModules['upgrades'],
  metrics: Object.freeze([]) as SerializedNormalizedModules['metrics'],
  achievements: Object.freeze([]) as SerializedNormalizedModules['achievements'],
  automations: Object.freeze([]) as SerializedNormalizedModules['automations'],
  transforms: Object.freeze([]) as SerializedNormalizedModules['transforms'],
  prestigeLayers: Object.freeze([]) as SerializedNormalizedModules['prestigeLayers'],
  runtimeEvents: Object.freeze([]) as SerializedNormalizedModules['runtimeEvents'],
};

export interface SerializeNormalizedContentPackOptions {
  readonly warnings?: readonly SerializedContentSchemaWarning[];
  readonly digest?: SerializedContentDigest;
}

type SerializedSchemaIssue =
  NonNullable<SerializedContentSchemaWarning['issues']>[number];

function cloneSchemaWarning(
  warning: SerializedContentSchemaWarning,
): SerializedContentSchemaWarning {
  const issues = warning.issues?.map(cloneSchemaWarningIssue);

  const cloned = {
    code: warning.code,
    message: warning.message,
    path: Object.freeze([...warning.path]) as SerializedContentSchemaWarning['path'],
    severity: warning.severity,
    ...(warning.suggestion !== undefined ? { suggestion: warning.suggestion } : {}),
    ...(issues !== undefined ? { issues: Object.freeze(issues) } : {}),
  } satisfies SerializedContentSchemaWarning;

  return Object.freeze(cloned) as SerializedContentSchemaWarning;
}

function cloneSchemaWarningIssue(
  issue: SerializedSchemaIssue,
): SerializedSchemaIssue {
  const cloned = {
    ...issue,
    path: Object.freeze([...issue.path]) as SerializedSchemaIssue['path'],
  } satisfies SerializedSchemaIssue;

  return Object.freeze(cloned) as SerializedSchemaIssue;
}

function cloneWarnings(
  warnings: readonly SerializedContentSchemaWarning[],
): readonly SerializedContentSchemaWarning[] {
  return Object.freeze(warnings.map(cloneSchemaWarning));
}

function cloneModules(
  source: Partial<SerializedNormalizedModules>,
): SerializedNormalizedModules {
  const modules = Object.create(null) as Record<
    ModuleName,
    SerializedNormalizedModules[ModuleName]
  >;

  for (const name of MODULE_NAMES) {
    modules[name] = cloneModuleEntries(source, name);
  }

  return Object.freeze(modules) as SerializedNormalizedModules;
}

function cloneModuleEntries<Name extends ModuleName>(
  source: Partial<SerializedNormalizedModules>,
  name: Name,
): SerializedNormalizedModules[Name] {
  return (source[name] ?? EMPTY_MODULES[name]) as SerializedNormalizedModules[Name];
}

function cloneDigest(
  digest: SerializedContentDigest,
): SerializedContentDigest {
  return Object.freeze({
    version: digest.version,
    hash: digest.hash,
  });
}

type SerializedPackBase = Omit<SerializedNormalizedContentPack, 'artifactHash'>;

function canonicalizeValue(value: unknown): string {
  const result = canonicalize(value);
  if (typeof result !== 'string') {
    throw new Error('Failed to canonicalize serialized content pack.');
  }
  return result;
}

function buildSerializedPackBase(
  data: Omit<SerializedPackBase, 'modules' | 'warnings'> & {
    readonly modules: SerializedNormalizedModules;
    readonly warnings: readonly SerializedContentSchemaWarning[];
  },
): SerializedPackBase {
  const serialized: SerializedPackBase = {
    formatVersion: data.formatVersion,
    metadata: data.metadata,
    modules: data.modules,
    warnings: data.warnings,
    digest: data.digest,
  };

  return Object.freeze(serialized);
}

function buildSerializedPackWithHash(
  base: SerializedPackBase,
  artifactHash: string,
): SerializedNormalizedContentPack {
  const serialized: SerializedNormalizedContentPack = {
    ...base,
    artifactHash,
  };

  return Object.freeze(serialized);
}

function resolveSerializedModules(
  pack: SerializableNormalizedContentPackInput,
): SerializedNormalizedModules {
  const modules = (pack as { readonly modules?: SerializedNormalizedModules }).modules;
  if (modules !== undefined) {
    return modules;
  }

  return {
    resources: pack.resources,
    entities: pack.entities,
    generators: pack.generators,
    upgrades: pack.upgrades,
    metrics: pack.metrics,
    achievements: pack.achievements,
    automations: pack.automations,
    transforms: pack.transforms,
    prestigeLayers: pack.prestigeLayers,
    runtimeEvents: pack.runtimeEvents,
  };
}

export function serializeNormalizedContentPack(
  pack: SerializableNormalizedContentPackInput,
  options: SerializeNormalizedContentPackOptions = {},
): SerializedPackArtifact {
  const warnings = cloneWarnings(options.warnings ?? []);
  const modules = cloneModules(resolveSerializedModules(pack));
  const digestSource = options.digest ?? pack.digest;
  if (digestSource === undefined) {
    throw new Error(
      `Serialized content pack ${pack.metadata?.id ?? '<unknown>'} is missing a digest.`,
    );
  }
  const digest = cloneDigest(digestSource);

  const base = buildSerializedPackBase({
    formatVersion: SERIALIZED_PACK_FORMAT_VERSION,
    metadata: pack.metadata,
    modules,
    warnings,
    digest,
  });

  const serializedForHash = buildSerializedPackWithHash(base, '');
  const canonicalWithPlaceholder = canonicalizeValue(serializedForHash);
  const hashInput = textEncoder.encode(canonicalWithPlaceholder);
  const artifactHash = computeArtifactHash(hashInput);
  const serialized = buildSerializedPackWithHash(base, artifactHash);
  const canonicalJson = canonicalizeValue(serialized);

  return {
    serialized,
    canonicalJson,
    hashInput,
  };
}

export function canonicalizeSerializedNormalizedContentPack(
  serialized: SerializedNormalizedContentPack,
): string {
  const modules = cloneModules(serialized.modules);
  const warnings = cloneWarnings(serialized.warnings);
  const digest = cloneDigest(serialized.digest);
  const base = buildSerializedPackBase({
    formatVersion: serialized.formatVersion,
    metadata: serialized.metadata,
    modules,
    warnings,
    digest,
  });
  const canonical = buildSerializedPackWithHash(base, serialized.artifactHash);
  return canonicalizeValue(canonical);
}

export function canonicalizeSerializedNormalizedContentPackForHash(
  serialized: SerializedNormalizedContentPack,
): string {
  const modules = cloneModules(serialized.modules);
  const warnings = cloneWarnings(serialized.warnings);
  const digest = cloneDigest(serialized.digest);
  const base = buildSerializedPackBase({
    formatVersion: serialized.formatVersion,
    metadata: serialized.metadata,
    modules,
    warnings,
    digest,
  });

  const canonical = buildSerializedPackWithHash(base, '');
  return canonicalizeValue(canonical);
}
