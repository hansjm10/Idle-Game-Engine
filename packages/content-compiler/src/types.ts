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
  readonly schema?: SchemaContextInput;
}

export interface SchemaContextInput {
  readonly runtimeEventCatalogue?: readonly string[] | ReadonlySet<string>;
  readonly knownPacks?: readonly {
    readonly id: string;
    readonly version: string;
    readonly requires?: readonly {
      readonly packId: string;
      readonly version?: string;
    }[];
  }[];
  readonly activePackIds?: readonly string[] | ReadonlySet<string>;
}

interface PackResultBase {
  readonly durationMs: number;
}

interface PackCompileSuccess extends PackResultBase {
  readonly status: 'compiled';
  readonly packSlug: string;
  readonly document: ContentDocument;
  readonly normalizedPack: NormalizedContentPack;
  readonly warnings: readonly SerializedContentSchemaWarning[];
  readonly artifact: SerializedPackArtifact;
}

interface PackCompileFailure extends PackResultBase {
  readonly status: 'failed';
  readonly packSlug: string;
  readonly document: ContentDocument;
  readonly error: Error;
  readonly warnings: readonly SerializedContentSchemaWarning[];
}

export type PackArtifactResult = PackCompileSuccess | PackCompileFailure;

export interface WorkspaceFS {
  readonly rootDirectory: string;
}

export interface CompileWorkspaceOptions
  extends CompileOptions,
    ArtifactWriterOptions {
  readonly summaryOutputPath?: string;
}

export interface WorkspaceCompileResult {
  readonly packs: readonly PackArtifactResult[];
  readonly artifacts: WorkspaceArtifactWriteResult;
  readonly summary: WorkspaceSummary;
  readonly summaryPath: string;
  readonly summaryAction: ArtifactFileAction;
  readonly hasDrift: boolean;
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

export const SERIALIZED_PACK_FORMAT_VERSION = 1;

export type SerializedContentDigest = NormalizedContentPack['digest'];

export interface SerializedNormalizedContentPack {
  readonly formatVersion: typeof SERIALIZED_PACK_FORMAT_VERSION;
  readonly metadata: NormalizedMetadata;
  readonly warnings: readonly SerializedContentSchemaWarning[];
  readonly modules: SerializedNormalizedModules;
  readonly digest: SerializedContentDigest;
  readonly artifactHash: string;
}

export interface SerializedPackArtifact {
  readonly serialized: SerializedNormalizedContentPack;
  readonly canonicalJson: string;
  readonly hashInput: Uint8Array;
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

export interface CompileLogArtifactOperation {
  readonly kind: ArtifactFileKind;
  readonly path: string;
  readonly action: ArtifactFileAction;
}

export type CompileLogEvent =
  | {
      readonly name: 'content_pack.compiled';
      readonly slug: string;
      readonly path: string;
      readonly timestamp: string;
      readonly durationMs: number;
      readonly warnings: number;
      readonly artifacts: readonly CompileLogArtifactOperation[];
      readonly check: boolean;
    }
  | {
      readonly name: 'content_pack.compilation_failed';
      readonly slug: string;
      readonly path: string;
      readonly timestamp: string;
      readonly durationMs: number;
      readonly message: string;
      readonly stack?: string;
      readonly artifacts: readonly CompileLogArtifactOperation[];
      readonly check: boolean;
    }
  | {
      readonly name: 'content_pack.skipped';
      readonly slug: string;
      readonly path: string;
      readonly timestamp: string;
      readonly durationMs: number;
      readonly warnings: number;
      readonly artifacts: readonly CompileLogArtifactOperation[];
      readonly check: boolean;
    }
  | {
      readonly name: 'content_pack.pruned';
      readonly slug: string;
      readonly timestamp: string;
      readonly artifacts: readonly CompileLogArtifactOperation[];
      readonly check: boolean;
    };

export interface ArtifactWriterOptions {
  readonly check?: boolean;
  readonly clean?: boolean;
}

export type ArtifactFileKind = 'json' | 'module';

export type ArtifactFileAction =
  | 'written'
  | 'unchanged'
  | 'deleted'
  | 'would-write'
  | 'would-delete';

export interface FileWriteOperation {
  readonly slug: string;
  readonly kind: ArtifactFileKind;
  readonly path: string;
  readonly action: ArtifactFileAction;
}

export interface WorkspaceArtifactWriteResult {
  readonly operations: readonly FileWriteOperation[];
}

export interface WorkspaceSummaryDependency {
  readonly packId: string;
  readonly version?: string;
  readonly digest?: string;
}

export interface WorkspaceSummaryDependencies {
  readonly requires: readonly WorkspaceSummaryDependency[];
  readonly optional: readonly WorkspaceSummaryDependency[];
  readonly conflicts: readonly WorkspaceSummaryDependency[];
}

export interface WorkspaceSummaryArtifacts {
  readonly json?: string;
  readonly module?: string;
}

export interface WorkspaceSummaryPack {
  readonly slug: string;
  readonly status: 'compiled' | 'failed';
  readonly version?: string;
  readonly digest?: SerializedContentDigest;
  readonly artifactHash?: string;
  readonly warnings: readonly SerializedContentSchemaWarning[];
  readonly dependencies: WorkspaceSummaryDependencies;
  readonly artifacts: WorkspaceSummaryArtifacts;
  readonly error?: string;
}

export interface WorkspaceSummary {
  readonly packs: readonly WorkspaceSummaryPack[];
}
