import type {
  ContentSchemaWarning,
  NormalizedAchievement,
  NormalizedAutomation,
  NormalizedContentPack as SchemaNormalizedContentPack,
  NormalizedGenerator,
  NormalizedGuildPerk,
  NormalizedMetadata,
  NormalizedMetric,
  NormalizedPrestigeLayer,
  NormalizedResource,
  NormalizedRuntimeEventContribution,
  NormalizedTransform,
  NormalizedUpgrade,
} from '@idle-engine/content-schema';

export interface ContentDocument {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly packSlug: string;
  readonly document: unknown;
}

export interface CompileOptions {
  readonly cwd?: string;
  readonly watch?: boolean;
}

export interface PackArtifactResult {
  readonly packSlug: string;
  readonly artifacts: readonly string[];
  readonly warnings: readonly string[];
}

export interface WorkspaceFS {
  readonly rootDirectory: string;
}

export interface CompileWorkspaceOptions extends CompileOptions {
  readonly summaryOutputPath?: string;
}

export interface WorkspaceCompileResult {
  readonly packs: readonly PackArtifactResult[];
  readonly summaryPath?: string;
}

export interface RehydrateOptions {
  readonly verifyDigest?: boolean;
}

export type SerializedContentSchemaWarning = ContentSchemaWarning;

export const MODULE_NAMES = [
  'resources',
  'generators',
  'upgrades',
  'metrics',
  'achievements',
  'automations',
  'transforms',
  'prestigeLayers',
  'guildPerks',
  'runtimeEvents',
] as const;

export type ModuleName = (typeof MODULE_NAMES)[number];

interface ModuleTypeMap {
  readonly resources: NormalizedResource;
  readonly generators: NormalizedGenerator;
  readonly upgrades: NormalizedUpgrade;
  readonly metrics: NormalizedMetric;
  readonly achievements: NormalizedAchievement;
  readonly automations: NormalizedAutomation;
  readonly transforms: NormalizedTransform;
  readonly prestigeLayers: NormalizedPrestigeLayer;
  readonly guildPerks: NormalizedGuildPerk;
  readonly runtimeEvents: NormalizedRuntimeEventContribution;
}

export type SerializedNormalizedModules = {
  readonly [Key in keyof ModuleTypeMap]: readonly ModuleTypeMap[Key][];
};

export type NormalizedContentPack = SchemaNormalizedContentPack & {
  readonly modules: SerializedNormalizedModules;
};

export type SerializableNormalizedContentPackInput = SchemaNormalizedContentPack & {
  readonly modules?: SerializedNormalizedModules;
};

export interface SerializedNormalizedContentPack {
  readonly formatVersion: 1;
  readonly metadata: NormalizedMetadata;
  readonly warnings: readonly SerializedContentSchemaWarning[];
  readonly modules: SerializedNormalizedModules;
  readonly digest?: string;
  readonly artifactHash?: string;
}

export interface ModuleIndexTables {
  readonly resources: ReadonlyMap<string, number>;
  readonly generators: ReadonlyMap<string, number>;
  readonly upgrades: ReadonlyMap<string, number>;
  readonly metrics: ReadonlyMap<string, number>;
  readonly achievements: ReadonlyMap<string, number>;
  readonly automations: ReadonlyMap<string, number>;
  readonly transforms: ReadonlyMap<string, number>;
  readonly prestigeLayers: ReadonlyMap<string, number>;
  readonly guildPerks: ReadonlyMap<string, number>;
  readonly runtimeEvents: ReadonlyMap<string, number>;
}

export interface CompileLogEvent {
  readonly name: string;
  readonly slug: string;
  readonly message?: string;
  readonly timestamp: string;
}

export interface WorkspaceSummary {
  readonly packs: readonly PackArtifactResult[];
  readonly generatedAt: string;
}
