import {
  type NormalizedContentPack,
  type FileWriteOperation,
  type PackArtifactResult,
  type SerializedContentDigest,
  type WorkspaceArtifactWriteResult,
  type WorkspaceSummary,
  type WorkspaceSummaryArtifacts,
  type WorkspaceSummaryDependencies,
  type WorkspaceSummaryDependency,
  type WorkspaceSummaryBalance,
  type WorkspaceSummaryPack,
  type SerializedContentSchemaWarning,
} from '../types.js';

export interface WorkspaceSummaryOptions {
  readonly results: readonly PackArtifactResult[];
  readonly artifacts: WorkspaceArtifactWriteResult;
}

export function createWorkspaceSummary(
  options: WorkspaceSummaryOptions,
): WorkspaceSummary {
  const digestBySlug = buildDigestMap(options.results);
  const operationsBySlug = groupOperations(options.artifacts.operations);

  const packs = options.results
    .map((result) =>
      createSummaryEntry(
        result,
        operationsBySlug.get(result.packSlug) ?? [],
        digestBySlug,
      ),
    )
    .sort((left, right) => {
      if (left.slug === right.slug) {
        return 0;
      }
      return left.slug < right.slug ? -1 : 1;
    });

  return {
    packs,
  };
}

function createSummaryEntry(
  result: PackArtifactResult,
  operations: readonly FileWriteOperation[],
  digestBySlug: ReadonlyMap<string, SerializedContentDigest>,
): WorkspaceSummaryPack {
  if (result.status === 'failed') {
    return {
      slug: result.packSlug,
      status: 'failed',
      warnings: result.warnings,
      balance: createBalanceSummary(result.balanceWarnings, result.balanceErrors),
      dependencies: emptyDependencies(),
      artifacts: emptyArtifacts(),
      error: result.error.message,
    };
  }

  const normalized = result.normalizedPack;
  const artifacts = resolveArtifacts(operations);
  const dependencies = createDependencies(normalized, digestBySlug);
  const digest = cloneDigest(normalized.digest);
  const artifactHash = result.artifact.serialized.artifactHash;

  return {
    slug: result.packSlug,
    status: 'compiled',
    version: normalized.metadata.version,
    digest,
    artifactHash,
    warnings: result.warnings,
    balance: createBalanceSummary(result.balanceWarnings, result.balanceErrors),
    dependencies,
    artifacts,
  };
}

function resolveArtifacts(
  operations: readonly FileWriteOperation[],
): WorkspaceSummaryArtifacts {
  const jsonPath = selectArtifactPath(operations, 'json');
  const modulePath = selectArtifactPath(operations, 'module');

  return {
    ...(jsonPath !== undefined ? { json: jsonPath } : {}),
    ...(modulePath !== undefined ? { module: modulePath } : {}),
  };
}

function selectArtifactPath(
  operations: readonly FileWriteOperation[],
  kind: 'json' | 'module',
): string | undefined {
  const operation = operations.find(
    (entry) =>
      entry.kind === kind &&
      entry.action !== 'deleted' &&
      entry.action !== 'would-delete',
  );
  return operation?.path;
}

function createDependencies(
  pack: NormalizedContentPack,
  digestBySlug: ReadonlyMap<string, SerializedContentDigest>,
): WorkspaceSummaryDependencies {
  const metadataDeps = pack.metadata.dependencies;

  if (!metadataDeps) {
    return emptyDependencies();
  }

  return {
    requires: formatDependencyList(metadataDeps.requires, digestBySlug),
    optional: formatDependencyList(metadataDeps.optional, digestBySlug),
    conflicts: formatDependencyList(metadataDeps.conflicts, digestBySlug),
  };
}

function formatDependencyList(
  entries:
    | readonly {
        readonly packId: string;
        readonly version?: string;
      }[]
    | undefined,
  digestBySlug: ReadonlyMap<string, SerializedContentDigest>,
): readonly WorkspaceSummaryDependency[] {
  if (!entries || entries.length === 0) {
    return [];
  }

  return entries.map((entry) => ({
    packId: entry.packId,
    ...(entry.version !== undefined ? { version: entry.version } : {}),
    ...(digestBySlug.has(entry.packId)
      ? { digest: digestBySlug.get(entry.packId)!.hash }
      : {}),
  }));
}

function buildDigestMap(
  results: readonly PackArtifactResult[],
): ReadonlyMap<string, SerializedContentDigest> {
  const digest = new Map<string, SerializedContentDigest>();

  results.forEach((result) => {
    if (result.status === 'compiled') {
      digest.set(result.packSlug, cloneDigest(result.normalizedPack.digest));
    }
  });

  return digest;
}

function groupOperations(
  operations: readonly FileWriteOperation[],
): Map<string, FileWriteOperation[]> {
  const grouped = new Map<string, FileWriteOperation[]>();

  operations.forEach((operation) => {
    if (!grouped.has(operation.slug)) {
      grouped.set(operation.slug, []);
    }
    grouped.get(operation.slug)!.push(operation);
  });

  return grouped;
}

function cloneDigest(
  digest: SerializedContentDigest,
): SerializedContentDigest {
  return {
    version: digest.version,
    hash: digest.hash,
  };
}

function emptyDependencies(): WorkspaceSummaryDependencies {
  return {
    requires: [],
    optional: [],
    conflicts: [],
  };
}

function emptyArtifacts(): WorkspaceSummaryArtifacts {
  return {};
}

function createBalanceSummary(
  warnings: readonly SerializedContentSchemaWarning[] | undefined,
  errors: readonly SerializedContentSchemaWarning[] | undefined,
): WorkspaceSummaryBalance {
  const warningList = warnings ?? [];
  const errorList = errors ?? [];

  return {
    warnings: warningList,
    errors: errorList,
    warningCount: warningList.length,
    errorCount: errorList.length,
  };
}
