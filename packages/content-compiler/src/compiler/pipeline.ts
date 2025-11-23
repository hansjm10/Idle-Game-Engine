import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { BalanceValidationError, parseContentPack } from '@idle-engine/content-schema';
import type {
  ContentSchemaWarning,
  NormalizedContentPack as SchemaNormalizedContentPack,
} from '@idle-engine/content-schema';

import { createCompilerContext } from './context.js';
import { discoverContentDocuments } from '../fs/discovery.js';
import { serializeNormalizedContentPack } from '../artifacts/json.js';
import { createWorkspaceSummary } from '../artifacts/summary.js';
import { writeDeterministicFile, writeWorkspaceArtifacts } from '../fs/writer.js';
import type {
  CompileOptions,
  CompileWorkspaceOptions,
  ContentDocument,
  PackArtifactResult,
  NormalizedContentPack,
  SerializedNormalizedModules,
  ArtifactFileAction,
  WorkspaceSummary,
  WorkspaceArtifactWriteResult,
  WorkspaceCompileResult,
  WorkspaceFS,
} from '../types.js';

export async function compileContentPack(
  document: ContentDocument,
  options: CompileOptions,
): Promise<PackArtifactResult> {
  const start = performance.now();
  const context = createCompilerContext(
    { rootDirectory: options.cwd ?? process.cwd() },
    options,
  );

  try {
    const schemaOptions = context.schemaOptions as SchemaParseOptions;
    const { pack, warnings, balanceWarnings, balanceErrors } = parseContentPack(
      document.document,
      schemaOptions,
    );

    const normalizedPack = withSerializedModules(pack);
    const normalizedWarnings = Object.freeze([...warnings]);
    const artifact = serializeNormalizedContentPack(normalizedPack, {
      warnings: normalizedWarnings,
    });

    return {
      status: 'compiled',
      packSlug: document.packSlug,
      document,
      normalizedPack,
      warnings: normalizedWarnings,
      balanceWarnings: Object.freeze([...balanceWarnings]),
      balanceErrors: Object.freeze([...balanceErrors]),
      artifact,
      durationMs: performance.now() - start,
    };
  } catch (error) {
    const failureError =
      error instanceof Error ? error : new Error(String(error));
    const balanceWarnings: readonly ContentSchemaWarning[] = [];
    const balanceErrors: readonly ContentSchemaWarning[] =
      error instanceof BalanceValidationError ? error.issues : [];

    return {
      status: 'failed',
      packSlug: document.packSlug,
      document,
      error: failureError,
      warnings: Object.freeze([]),
      balanceWarnings: Object.freeze(balanceWarnings),
      balanceErrors: Object.freeze(balanceErrors),
      durationMs: performance.now() - start,
    };
  }
}

type SchemaParseOptions = Parameters<typeof parseContentPack>[1];

export async function compileWorkspacePacks(
  fs: WorkspaceFS,
  options: CompileWorkspaceOptions,
): Promise<WorkspaceCompileResult> {
  const documents = await discoverContentDocuments(fs);
  const documentsBySlug = new Map(documents.map((entry) => [entry.packSlug, entry]));
  const dependencyMap = buildDependencyMap(documentsBySlug);
  const topo = topologicallySortDocuments(documentsBySlug, dependencyMap);

  const results: PackArtifactResult[] = [];
  const failed = new Set<string>();

  for (const slug of topo.ordered) {
    const document = documentsBySlug.get(slug);
    if (!document) {
      continue;
    }

    const requiredDependencies = extractRequiredDependencies(document);
    const missingDependencies = dependencyMap.missing.get(slug);
    if (missingDependencies !== undefined && missingDependencies.size > 0) {
      results.push(
        createFailureResult(
          document,
          `Pack "${slug}" requires missing dependencies: ${Array.from(missingDependencies).join(', ')}`,
        ),
      );
      failed.add(slug);
      continue;
    }

    const failedDependencies = requiredDependencies.filter((dependency) => failed.has(dependency));
    if (failedDependencies.length > 0) {
      results.push(
        createFailureResult(
          document,
          `Pack "${slug}" requires dependencies that failed to compile: ${failedDependencies.join(', ')}`,
        ),
      );
      failed.add(slug);
      continue;
    }

    const compileResult = await compileContentPack(document, options);
    results.push(compileResult);
    if (compileResult.status === 'failed') {
      failed.add(slug);
    }
  }

  const remainingCycleSlugs = Array.from(topo.cycleSlugs).filter(
    (slug) => !failed.has(slug),
  );
  remainingCycleSlugs.sort();

  if (remainingCycleSlugs.length > 0) {
    const cycleMessage = createCycleErrorMessage(remainingCycleSlugs);
    for (const slug of remainingCycleSlugs) {
      const document = documentsBySlug.get(slug);
      if (!document) {
        continue;
      }
      results.push(createFailureResult(document, cycleMessage));
    }
  }

  const artifactWrites = await writeWorkspaceArtifacts(fs, results, {
    check: options.check,
    clean: options.clean,
  });

  const summary = createWorkspaceSummary({
    results,
    artifacts: artifactWrites,
  });

  const summaryPath = resolveSummaryPath(
    fs.rootDirectory,
    options.summaryOutputPath,
  );
  const summaryBuffer = createSummaryBuffer(summary);
  const summaryAction = await writeDeterministicFile(summaryPath, summaryBuffer, {
    check: options.check,
    clean: options.clean,
  });

  const hasDrift =
    options.check === true &&
    hasDriftActions(artifactWrites, summaryAction);

  return {
    packs: results,
    artifacts: artifactWrites,
    summary,
    summaryPath: toPosixPath(path.relative(fs.rootDirectory, summaryPath)),
    summaryAction,
    hasDrift,
  };
}

interface DependencyMap {
  readonly requires: Map<string, Set<string>>;
  readonly missing: Map<string, Set<string>>;
}

interface TopologyResult {
  readonly ordered: readonly string[];
  readonly cycleSlugs: ReadonlySet<string>;
}

function extractRequiredDependencies(document: ContentDocument): readonly string[] {
  const metadata = (document.document as { readonly metadata?: unknown })?.metadata;
  if (typeof metadata !== 'object' || metadata === null) {
    return [];
  }

  const dependencies = (metadata as { readonly dependencies?: unknown })?.dependencies;
  if (typeof dependencies !== 'object' || dependencies === null) {
    return [];
  }

  const requires = (dependencies as { readonly requires?: unknown })?.requires;
  if (!Array.isArray(requires)) {
    return [];
  }

  const requiredSlugs: string[] = [];

  for (const entry of requires) {
    const packId = (entry as { readonly packId?: unknown })?.packId;
    if (typeof packId === 'string' && packId.length > 0) {
      requiredSlugs.push(packId);
    }
  }

  return requiredSlugs;
}

function buildDependencyMap(
  documents: Map<string, ContentDocument>,
): DependencyMap {
  const requires = new Map<string, Set<string>>();
  const missing = new Map<string, Set<string>>();

  documents.forEach((document, slug) => {
    const required = extractRequiredDependencies(document);
    for (const dependency of required) {
      if (documents.has(dependency)) {
        if (!requires.has(dependency)) {
          requires.set(dependency, new Set());
        }
        requires.get(dependency)!.add(slug);
      } else {
        if (!missing.has(slug)) {
          missing.set(slug, new Set());
        }
        missing.get(slug)!.add(dependency);
      }
    }
  });

  return {
    requires,
    missing,
  };
}

function topologicallySortDocuments(
  documents: Map<string, ContentDocument>,
  dependencyMap: DependencyMap,
): TopologyResult {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, Set<string>>();

  documents.forEach((_document, slug) => {
    inDegree.set(slug, 0);
    adjacency.set(slug, new Set());
  });

  dependencyMap.requires.forEach((dependants, dependency) => {
    adjacency.set(dependency, new Set(dependants));
    dependants.forEach((slug) => {
      inDegree.set(slug, (inDegree.get(slug) ?? 0) + 1);
    });
  });

  const zeroInDegree: string[] = [];
  inDegree.forEach((degree, slug) => {
    if (degree === 0) {
      zeroInDegree.push(slug);
    }
  });
  zeroInDegree.sort();

  const ordered: string[] = [];
  const inDegreeMutable = new Map(inDegree);

  while (zeroInDegree.length > 0) {
    const slug = zeroInDegree.shift();
    if (slug === undefined) {
      continue;
    }
    ordered.push(slug);
    const neighbours = adjacency.get(slug);
    if (!neighbours) {
      continue;
    }
    const sortedNeighbours = Array.from(neighbours).sort();
    for (const neighbour of sortedNeighbours) {
      const current = inDegreeMutable.get(neighbour);
      if (current === undefined) {
        continue;
      }
      const next = current - 1;
      inDegreeMutable.set(neighbour, next);
      if (next === 0) {
        zeroInDegree.push(neighbour);
        zeroInDegree.sort();
      }
    }
  }

  const cycleSlugs = new Set<string>();
  inDegreeMutable.forEach((degree, slug) => {
    if (degree > 0) {
      cycleSlugs.add(slug);
    }
  });

  return {
    ordered,
    cycleSlugs,
  };
}

function resolveSummaryPath(
  rootDirectory: string,
  overridePath: string | undefined,
): string {
  if (overridePath) {
    return path.isAbsolute(overridePath)
      ? overridePath
      : path.join(rootDirectory, overridePath);
  }
  return path.join(rootDirectory, 'content', 'compiled', 'index.json');
}

function createSummaryBuffer(summary: WorkspaceSummary): Uint8Array {
  const json = JSON.stringify(summary, null, 2);
  return Buffer.from(`${json}\n`, 'utf8');
}

function hasDriftActions(
  artifacts: WorkspaceArtifactWriteResult,
  summaryAction: ArtifactFileAction,
): boolean {
  return (
    artifacts.operations.some(
      (operation) =>
        operation.action === 'would-write' ||
        operation.action === 'would-delete',
    ) || summaryAction === 'would-write'
  );
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

function createFailureResult(
  document: ContentDocument,
  message: string,
): PackArtifactResult {
  return {
    status: 'failed',
    packSlug: document.packSlug,
    document,
    error: new Error(message),
    warnings: Object.freeze([]),
    balanceWarnings: Object.freeze([]),
    balanceErrors: Object.freeze([]),
    durationMs: 0,
  };
}

function createCycleErrorMessage(slugs: readonly string[]): string {
  return `Dependency cycle detected involving: ${slugs.join(', ')}`;
}

function withSerializedModules(
  pack: SchemaNormalizedContentPack,
): NormalizedContentPack {
  const modules: SerializedNormalizedModules = {
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

  return {
    ...pack,
    modules,
  } as NormalizedContentPack;
}
