import type {
  ContentSchemaWarning,
  NormalizedAchievement,
  NormalizedAutomation,
  NormalizedContentPack as SchemaNormalizedContentPack,
  NormalizedEntity,
  NormalizedFontAsset,
  NormalizedGenerator,
  NormalizedMetadata,
  NormalizedMetric,
  NormalizedPrestigeLayer,
  NormalizedResource,
  NormalizedRuntimeEventContribution,
  NormalizedTransform,
  NormalizedUpgrade,
  BalanceValidationOptions,
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
  readonly runtimeVersion?: string;
  readonly balance?: BalanceValidationOptions;
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
  readonly balanceWarnings: readonly SerializedContentSchemaWarning[];
  readonly balanceErrors: readonly SerializedContentSchemaWarning[];
  readonly artifact: SerializedPackArtifact;
}

interface PackCompileFailure extends PackResultBase {
  readonly status: 'failed';
  readonly packSlug: string;
  readonly document: ContentDocument;
  readonly error: Error;
  readonly warnings: readonly SerializedContentSchemaWarning[];
  readonly balanceWarnings?: readonly SerializedContentSchemaWarning[];
  readonly balanceErrors?: readonly SerializedContentSchemaWarning[];
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
  'fonts',
  'resources',
  'entities',
  'generators',
  'upgrades',
  'metrics',
  'achievements',
  'automations',
  'transforms',
  'prestigeLayers',
  'runtimeEvents',
] as const;

export type ModuleName = (typeof MODULE_NAMES)[number];

interface ModuleTypeMap {
  readonly fonts: NormalizedFontAsset;
  readonly resources: NormalizedResource;
  readonly entities: NormalizedEntity;
  readonly generators: NormalizedGenerator;
  readonly upgrades: NormalizedUpgrade;
  readonly metrics: NormalizedMetric;
  readonly achievements: NormalizedAchievement;
  readonly automations: NormalizedAutomation;
  readonly transforms: NormalizedTransform;
  readonly prestigeLayers: NormalizedPrestigeLayer;
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
  readonly fonts: ReadonlyMap<string, number>;
  readonly resources: ReadonlyMap<string, number>;
  readonly entities: ReadonlyMap<string, number>;
  readonly generators: ReadonlyMap<string, number>;
  readonly upgrades: ReadonlyMap<string, number>;
  readonly metrics: ReadonlyMap<string, number>;
  readonly achievements: ReadonlyMap<string, number>;
  readonly automations: ReadonlyMap<string, number>;
  readonly transforms: ReadonlyMap<string, number>;
  readonly prestigeLayers: ReadonlyMap<string, number>;
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
      readonly balanceWarnings: number;
      readonly balanceErrors: number;
      readonly artifacts: readonly CompileLogArtifactOperation[];
      readonly check: boolean;
    }
  | {
      readonly name: 'content_pack.compilation_failed';
      readonly slug: string;
      readonly path: string;
      readonly timestamp: string;
      readonly durationMs: number;
      readonly warnings: number;
      readonly balanceWarnings: number;
      readonly balanceErrors: number;
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
      readonly balanceWarnings: number;
      readonly balanceErrors: number;
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

export type ArtifactFileKind = 'json' | 'module' | 'asset';

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

export interface WorkspaceSummaryBalance {
  readonly warnings: readonly SerializedContentSchemaWarning[];
  readonly errors: readonly SerializedContentSchemaWarning[];
  readonly warningCount: number;
  readonly errorCount: number;
}

export interface WorkspaceSummaryPack {
  readonly slug: string;
  readonly status: 'compiled' | 'failed';
  readonly version?: string;
  readonly digest?: SerializedContentDigest;
  readonly artifactHash?: string;
  readonly warnings: readonly SerializedContentSchemaWarning[];
  readonly balance?: WorkspaceSummaryBalance;
  readonly dependencies: WorkspaceSummaryDependencies;
  readonly artifacts: WorkspaceSummaryArtifacts;
  readonly error?: string;
}

export interface WorkspaceSummary {
  readonly packs: readonly WorkspaceSummaryPack[];
}

export type ContentValidationLogEvent =
  | ContentValidationValidatedEvent
  | ContentValidationFailedEvent
  | ContentBalanceWarningLogEvent
  | ContentBalanceFailedLogEvent;

export interface ContentValidationValidatedEvent {
  readonly event: 'content_pack.validated';
  readonly packSlug: string;
  readonly packVersion?: string;
  readonly path: string;
  readonly warningCount: number;
  readonly balanceWarningCount: number;
  readonly balanceErrorCount: number;
  readonly warnings: readonly SerializedContentSchemaWarning[];
  readonly balanceWarnings: readonly SerializedContentSchemaWarning[];
  readonly balanceErrors: readonly SerializedContentSchemaWarning[];
}

export interface ContentValidationFailedEvent {
  readonly event: 'content_pack.validation_failed';
  readonly packSlug?: string;
  readonly packVersion?: string;
  readonly path: string;
  readonly message: string;
  readonly issues?: readonly unknown[];
}

export interface ContentBalanceWarningLogEvent {
  readonly event: 'content_pack.balance_warning';
  readonly packSlug: string;
  readonly packVersion?: string;
  readonly path: string;
  readonly warningCount: number;
  readonly warnings: readonly SerializedContentSchemaWarning[];
}

export interface ContentBalanceFailedLogEvent {
  readonly event: 'content_pack.balance_failed';
  readonly packSlug: string;
  readonly packVersion?: string;
  readonly path: string;
  readonly errorCount: number;
  readonly errors: readonly SerializedContentSchemaWarning[];
}

export type RuntimeManifestLogEvent =
  | RuntimeManifestWrittenEvent
  | RuntimeManifestUnchangedEvent
  | RuntimeManifestDriftEvent;

interface RuntimeManifestBaseEvent {
  readonly path: string;
  readonly action: 'written' | 'unchanged' | 'would-write';
  readonly check: boolean;
  readonly timestamp: string;
}

export interface RuntimeManifestWrittenEvent extends RuntimeManifestBaseEvent {
  readonly event: 'runtime_manifest.written';
  readonly action: 'written';
}

export interface RuntimeManifestUnchangedEvent extends RuntimeManifestBaseEvent {
  readonly event: 'runtime_manifest.unchanged';
  readonly action: 'unchanged';
}

export interface RuntimeManifestDriftEvent extends RuntimeManifestBaseEvent {
  readonly event: 'runtime_manifest.drift';
  readonly action: 'would-write';
}

export interface WatchStatusLogEvent {
  readonly event: 'watch.status';
  readonly message: string;
  readonly timestamp: string;
  readonly rootDirectory?: string;
}

export interface WatchHintLogEvent {
  readonly event: 'watch.hint';
  readonly message: string;
  readonly timestamp: string;
  readonly exit: string;
}

export interface WatchRunLogEvent {
  readonly event: 'watch.run';
  readonly status: 'success' | 'failed' | 'skipped';
  readonly iteration: number;
  readonly timestamp: string;
  readonly durationMs: number;
  readonly triggers?: WatchTriggerSummary;
  readonly packs?: WatchRunPackSummary;
  readonly artifacts?: WatchRunArtifactSummary;
  readonly changedPacks?: readonly string[];
  readonly failedPacks?: readonly string[];
}

export interface WatchTriggerSummary {
  readonly count: number;
  readonly limit: number;
  readonly events?: Record<string, number>;
  readonly paths?: readonly string[];
  readonly morePaths?: number;
}

export interface WatchRunPackSummary {
  readonly total: number;
  readonly compiled: number;
  readonly failed: number;
  readonly withWarnings: number;
  readonly changed: number;
}

export interface WatchRunArtifactSummary {
  readonly total: number;
  readonly changed: number;
  readonly summaryAction: string;
  readonly manifestAction: string;
  readonly byAction: Record<string, number>;
}

export interface CliUnhandledErrorEvent {
  readonly event: 'cli.unhandled_error';
  readonly message: string;
  readonly timestamp: string;
  readonly fatal: boolean;
  readonly name?: string;
  readonly stack?: string;
}

export type ContentCliLogEvent =
  | ContentValidationLogEvent
  | RuntimeManifestLogEvent
  | WatchStatusLogEvent
  | WatchHintLogEvent
  | WatchRunLogEvent
  | CliUnhandledErrorEvent
  | CompileLogEvent;
