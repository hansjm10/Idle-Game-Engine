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

export interface SerializedContentSchemaWarning {
  readonly code: string;
  readonly message: string;
}

export interface NormalizedMetadata {
  readonly id: string;
  readonly name: string;
  readonly version: string;
}

export interface NormalizedContentPack {
  readonly metadata: NormalizedMetadata;
  readonly modules: Record<string, unknown>;
}

// TODO(#159): Expand module typings to match docs/content-compiler-design.md section 5.4.
export interface SerializedNormalizedContentPack {
  readonly formatVersion: 1;
  readonly metadata: NormalizedMetadata;
  readonly warnings: readonly SerializedContentSchemaWarning[];
  readonly modules: NormalizedContentPack['modules'];
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
