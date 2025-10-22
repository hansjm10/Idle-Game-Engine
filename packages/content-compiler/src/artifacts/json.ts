import {
  MODULE_NAMES,
  type ModuleName,
  type SerializableNormalizedContentPackInput,
  type SerializedContentSchemaWarning,
  type SerializedNormalizedContentPack,
  type SerializedNormalizedModules,
} from '../types.js';

const EMPTY_MODULES: SerializedNormalizedModules = {
  resources: Object.freeze([]) as SerializedNormalizedModules['resources'],
  generators: Object.freeze([]) as SerializedNormalizedModules['generators'],
  upgrades: Object.freeze([]) as SerializedNormalizedModules['upgrades'],
  metrics: Object.freeze([]) as SerializedNormalizedModules['metrics'],
  achievements: Object.freeze([]) as SerializedNormalizedModules['achievements'],
  automations: Object.freeze([]) as SerializedNormalizedModules['automations'],
  transforms: Object.freeze([]) as SerializedNormalizedModules['transforms'],
  prestigeLayers: Object.freeze([]) as SerializedNormalizedModules['prestigeLayers'],
  guildPerks: Object.freeze([]) as SerializedNormalizedModules['guildPerks'],
  runtimeEvents: Object.freeze([]) as SerializedNormalizedModules['runtimeEvents'],
};

export interface SerializeNormalizedContentPackOptions {
  readonly warnings?: readonly SerializedContentSchemaWarning[];
  readonly digest?: string;
  readonly artifactHash?: string;
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

  return modules as SerializedNormalizedModules;
}

function cloneModuleEntries<Name extends ModuleName>(
  source: Partial<SerializedNormalizedModules>,
  name: Name,
): SerializedNormalizedModules[Name] {
  return (source[name] ?? EMPTY_MODULES[name]) as SerializedNormalizedModules[Name];
}

function cloneWarnings(
  warnings: readonly SerializedContentSchemaWarning[],
): readonly SerializedContentSchemaWarning[] {
  return Object.freeze(warnings.map(cloneSchemaWarning));
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

function buildSerializedObject(
  data: Omit<SerializedNormalizedContentPack, 'modules' | 'warnings'> & {
    readonly modules: SerializedNormalizedModules;
    readonly warnings: readonly SerializedContentSchemaWarning[];
  },
): SerializedNormalizedContentPack {
  const serialized: SerializedNormalizedContentPack = {
    formatVersion: data.formatVersion,
    metadata: data.metadata,
    modules: data.modules,
    warnings: data.warnings,
    ...(data.digest !== undefined ? { digest: data.digest } : {}),
    ...(data.artifactHash !== undefined ? { artifactHash: data.artifactHash } : {}),
  };

  return serialized;
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
    generators: pack.generators,
    upgrades: pack.upgrades,
    metrics: pack.metrics,
    achievements: pack.achievements,
    automations: pack.automations,
    transforms: pack.transforms,
    prestigeLayers: pack.prestigeLayers,
    guildPerks: pack.guildPerks,
    runtimeEvents: pack.runtimeEvents,
  };
}

export function serializeNormalizedContentPack(
  pack: SerializableNormalizedContentPackInput,
  options: SerializeNormalizedContentPackOptions = {},
): SerializedNormalizedContentPack {
  const warnings = cloneWarnings(options.warnings ?? []);
  const modules = cloneModules(resolveSerializedModules(pack));
  const digest = options.digest ?? pack.digest?.hash;

  return buildSerializedObject({
    formatVersion: 1,
    metadata: pack.metadata,
    modules,
    warnings,
    digest,
    artifactHash: options.artifactHash,
  });
}

export function canonicalizeSerializedNormalizedContentPack(
  serialized: SerializedNormalizedContentPack,
): string {
  const modules = cloneModules(serialized.modules);
  const warnings = cloneWarnings(serialized.warnings);
  const canonical = buildSerializedObject({
    ...serialized,
    modules,
    warnings,
  });

  return JSON.stringify(canonical);
}
