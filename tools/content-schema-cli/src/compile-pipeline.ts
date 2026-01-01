import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';

import type {
  CompileLogEvent,
  WorkspaceCompileResult,
} from '@idle-engine/content-compiler';

import {
  ContentPackValidationError,
  buildRuntimeEventManifest,
  validateContentPacks,
  writeRuntimeEventManifest,
} from './generate.js';

import type {
  CliOptions,
  FormattedArtifact,
  PackBalanceCounts,
  PipelineOutcome,
  RunSummary,
  SpawnProcessResult,
  ValidationFailureSummaryEntry,
} from './compile-utils.js';
import {
  createValidationFailureRunSummary,
  createValidationFailureSummary,
  extractRuntimeEventManifestHash,
  filterPrunedArtifacts,
  formatOperation,
  formatProcessOutput,
  groupOperationsBySlug,
  isChangeAction,
  isNodeError,
  resolveSummaryOutputPath,
  toPosixPath,
} from './compile-utils.js';

const CORE_PACKAGE_NAME = '@idle-engine/core';
const CORE_PACKAGE_JSON_RELATIVE_PATH = 'packages/core/package.json';
const CORE_DIST_MANIFEST_RELATIVE_PATH =
  'packages/core/dist/events/runtime-event-manifest.generated.js';

export type Logger = (event: CompileLogEvent) => void;

export type CompilePipelineOptions = Pick<
  CliOptions,
  'check' | 'clean' | 'pretty' | 'summary'
>;

export type CompileWorkspacePacksFn = (
  options: { rootDirectory: string },
  compileOptions: {
    check?: boolean;
    clean?: boolean;
    schema: unknown;
    summaryOutputPath?: string;
  },
) => Promise<WorkspaceCompileResult>;

export interface CompilePipelineCallbacks {
  onManifestResult?: (result: { action: string; path: string }) => void;
  onCoreDistManifestResult?: (result: CoreDistManifestResult) => void;
  onUnhandledError?: (error: unknown) => void;
}

export interface CompilePipelineDependencies {
  buildRuntimeEventManifest: typeof buildRuntimeEventManifest;
  validateContentPacks: typeof validateContentPacks;
  writeRuntimeEventManifest: typeof writeRuntimeEventManifest;
  ensureCoreDistRuntimeEventManifest: (
    options: EnsureCoreDistManifestOptions,
  ) => Promise<CoreDistManifestResult>;
  persistValidationFailureSummary: (
    options: PersistValidationFailureSummaryOptions,
  ) => Promise<{ action: string; path: string }>;
  now: () => Date;
}

export interface ExecuteCompilePipelineInput {
  options: CompilePipelineOptions;
  workspaceRoot: string;
  logger: Logger;
  compileWorkspacePacks: CompileWorkspacePacksFn;
  callbacks?: CompilePipelineCallbacks;
  dependencies?: Partial<CompilePipelineDependencies>;
}

export async function executeCompilePipeline({
  options,
  workspaceRoot,
  logger,
  compileWorkspacePacks,
  callbacks,
  dependencies,
}: ExecuteCompilePipelineInput): Promise<PipelineOutcome> {
  const deps: CompilePipelineDependencies = {
    buildRuntimeEventManifest,
    validateContentPacks,
    writeRuntimeEventManifest,
    ensureCoreDistRuntimeEventManifest,
    persistValidationFailureSummary,
    now: () => new Date(),
    ...dependencies,
  };

  let manifest: Awaited<ReturnType<typeof buildRuntimeEventManifest>>;
  try {
    manifest = await deps.buildRuntimeEventManifest({
      rootDirectory: workspaceRoot,
    });
  } catch (error) {
    callbacks?.onUnhandledError?.(error);
    return {
      success: false,
      drift: false,
      runSummary: undefined,
    };
  }

  try {
    const validation = await deps.validateContentPacks(manifest.manifestDefinitions, {
      pretty: options.pretty,
      rootDirectory: workspaceRoot,
    });

    const manifestResult = await deps.writeRuntimeEventManifest(
      manifest.moduleSource,
      {
        check: options.check,
        clean: options.clean,
        rootDirectory: workspaceRoot,
      },
    );
    callbacks?.onManifestResult?.(manifestResult);

    const coreDistManifestResult = await deps.ensureCoreDistRuntimeEventManifest({
      rootDirectory: workspaceRoot,
      expectedHash: manifest.manifestHash,
      check: options.check === true,
    });
    callbacks?.onCoreDistManifestResult?.(coreDistManifestResult);

    const compileResult = await compileWorkspacePacks(
      { rootDirectory: workspaceRoot },
      {
        check: options.check,
        clean: options.clean,
        schema: validation.schemaOptions,
        summaryOutputPath: options.summary,
      },
    );

    emitCompileEvents({
      compileResult,
      logger,
      check: options.check === true,
      now: deps.now,
    });

    const hasFailures = compileResult.packs.some(
      (result) => result.status === 'failed',
    );
    const hasDrift =
      options.check === true &&
      (compileResult.hasDrift ||
        manifestResult.action === 'would-write' ||
        coreDistManifestResult.action === 'would-build');

    return {
      success: !hasFailures && !hasDrift,
      drift: hasDrift,
      runSummary: createRunSummary({
        compileResult,
        manifestAction: manifestResult.action,
      }),
    };
  } catch (error) {
    if (error instanceof ContentPackValidationError) {
      const checkMode = options.check === true;
      const cleanMode = options.clean === true;
      try {
        const summaryOutcome = await deps.persistValidationFailureSummary({
          failures: error.failures as ValidationFailureSummaryEntry[],
          rootDirectory: workspaceRoot,
          summaryOverride: options.summary,
          clean: cleanMode,
        });
        const summaryDrift =
          checkMode && summaryOutcome.action !== 'unchanged';

        return {
          success: false,
          drift: summaryDrift,
          runSummary: createValidationFailureRunSummary({
            failures: error.failures as ValidationFailureSummaryEntry[],
            summaryAction: summaryOutcome.action,
          }),
        };
      } catch (persistError) {
        callbacks?.onUnhandledError?.(persistError);
        return {
          success: false,
          drift: false,
          runSummary: undefined,
        };
      }
    }

    callbacks?.onUnhandledError?.(error);
    return {
      success: false,
      drift: false,
      runSummary: undefined,
    };
  }
}

interface EmitCompileEventsInput {
  compileResult: WorkspaceCompileResult;
  logger: Logger;
  check: boolean;
  now: () => Date;
}

function extractBalanceCounts(
  result: WorkspaceCompileResult['packs'][number],
): PackBalanceCounts {
  if (result.status === 'compiled') {
    return {
      balanceWarnings: result.balanceWarnings.length,
      balanceErrors: result.balanceErrors.length,
    };
  }
  const maybeBalanceResult = result as {
    balanceWarnings?: unknown[];
    balanceErrors?: unknown[];
  };
  return {
    balanceWarnings: maybeBalanceResult.balanceWarnings?.length ?? 0,
    balanceErrors: maybeBalanceResult.balanceErrors?.length ?? 0,
  };
}

function emitPackResultEvent(
  result: WorkspaceCompileResult['packs'][number],
  artifacts: FormattedArtifact[],
  balanceCounts: PackBalanceCounts,
  check: boolean,
  logger: Logger,
  now: () => Date,
): void {
  const timestamp = now().toISOString();

  if (result.status === 'compiled') {
    const onlyUnchanged =
      check &&
      artifacts.length > 0 &&
      artifacts.every((artifact) => artifact.action === 'unchanged');
    const eventName = onlyUnchanged ? 'content_pack.skipped' : 'content_pack.compiled';
    logger({
      name: eventName,
      slug: result.packSlug,
      path: result.document.relativePath,
      timestamp,
      durationMs: result.durationMs,
      warnings: result.warnings.length,
      balanceWarnings: balanceCounts.balanceWarnings,
      balanceErrors: balanceCounts.balanceErrors,
      artifacts,
      check,
    } as CompileLogEvent);
    return;
  }

  logger({
    name: 'content_pack.compilation_failed',
    slug: result.packSlug,
    path: result.document.relativePath,
    timestamp,
    durationMs: result.durationMs,
    warnings: result.warnings.length,
    balanceWarnings: balanceCounts.balanceWarnings,
    balanceErrors: balanceCounts.balanceErrors,
    message: result.error.message,
    stack: result.error.stack,
    artifacts,
    check,
  } as CompileLogEvent);
}

function emitPrunedEvent(
  slug: string,
  artifacts: FormattedArtifact[],
  check: boolean,
  logger: Logger,
  now: () => Date,
): void {
  const prunedArtifacts = filterPrunedArtifacts(artifacts);
  if (prunedArtifacts.length === 0) {
    return;
  }
  logger({
    name: 'content_pack.pruned',
    slug,
    timestamp: now().toISOString(),
    artifacts: prunedArtifacts,
    check,
  } as CompileLogEvent);
}

function emitCompileEvents({
  compileResult,
  logger,
  check,
  now,
}: EmitCompileEventsInput): void {
  const operationsBySlug = groupOperationsBySlug(compileResult.artifacts.operations);

  for (const result of compileResult.packs) {
    const operations = operationsBySlug.get(result.packSlug) ?? [];
    operationsBySlug.delete(result.packSlug);
    const artifacts = operations.map(formatOperation);
    const balanceCounts = extractBalanceCounts(result);

    emitPackResultEvent(result, artifacts, balanceCounts, check, logger, now);
    emitPrunedEvent(result.packSlug, artifacts, check, logger, now);
  }

  for (const [slug, operations] of operationsBySlug.entries()) {
    const artifacts = operations.map(formatOperation);
    emitPrunedEvent(slug, artifacts, check, logger, now);
  }
}

interface CreateRunSummaryInput {
  compileResult: WorkspaceCompileResult;
  manifestAction: string;
}

function createRunSummary({
  compileResult,
  manifestAction,
}: CreateRunSummaryInput): RunSummary {
  const actionCounts: Record<string, number> = Object.create(null);
  const changedPacks = new Set<string>();

  for (const operation of compileResult.artifacts.operations) {
    actionCounts[operation.action] = (actionCounts[operation.action] ?? 0) + 1;

    if (isChangeAction(operation.action)) {
      changedPacks.add(operation.slug);
    }
  }

  const sortedActionEntries = Object.entries(actionCounts).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const artifactActionsByType = Object.fromEntries(sortedActionEntries);
  const changedActionCount =
    (artifactActionsByType.written ?? 0) +
    (artifactActionsByType.deleted ?? 0) +
    (artifactActionsByType['would-write'] ?? 0) +
    (artifactActionsByType['would-delete'] ?? 0);

  let compiledCount = 0;
  let failedCount = 0;
  let packsWithWarnings = 0;
  const failedPacks: string[] = [];

  for (const packResult of compileResult.packs) {
    if (packResult.status === 'compiled') {
      compiledCount += 1;
      if (packResult.warnings.length > 0) {
        packsWithWarnings += 1;
      }
    } else {
      failedCount += 1;
      failedPacks.push(packResult.packSlug);
    }
  }

  failedPacks.sort((a, b) => a.localeCompare(b));

  const summaryAction =
    typeof compileResult.summaryAction === 'string'
      ? compileResult.summaryAction
      : 'unchanged';
  const summaryChanged =
    summaryAction === 'written' || summaryAction === 'would-write';
  const manifestChanged =
    manifestAction === 'written' || manifestAction === 'would-write';

  return {
    packTotals: {
      total: compileResult.packs.length,
      compiled: compiledCount,
      failed: failedCount,
      withWarnings: packsWithWarnings,
    },
    artifactActions: {
      total: compileResult.artifacts.operations.length,
      changed: changedActionCount,
      byAction: artifactActionsByType,
    },
    changedPacks: Array.from(changedPacks).sort((a, b) => a.localeCompare(b)),
    failedPacks,
    hasChanges: changedActionCount > 0 || summaryChanged || manifestChanged,
    summaryAction,
    manifestAction,
  };
}

export interface CoreDistManifestResult {
  action: 'unchanged' | 'built' | 'would-build' | 'skipped';
  path: string;
  expectedHash: string;
  actualHash?: string;
  reason?: string;
}

export interface EnsureCoreDistManifestOptions {
  rootDirectory: string;
  expectedHash: string;
  check: boolean;
  io?: EnsureCoreDistManifestIO;
}

export interface EnsureCoreDistManifestIO {
  access: (targetPath: string) => Promise<void>;
  readFile: (targetPath: string, encoding: BufferEncoding) => Promise<string>;
  spawnProcess: (
    command: string,
    args: string[],
    options: SpawnProcessOptions,
  ) => Promise<SpawnProcessResult>;
  env: NodeJS.ProcessEnv;
}

export async function ensureCoreDistRuntimeEventManifest({
  rootDirectory,
  expectedHash,
  check,
  io,
}: EnsureCoreDistManifestOptions): Promise<CoreDistManifestResult> {
  const fsIO: EnsureCoreDistManifestIO = io ?? {
    access: (targetPath: string) => fs.access(targetPath),
    readFile: (targetPath: string, encoding: BufferEncoding) =>
      fs.readFile(targetPath, encoding),
    spawnProcess,
    env: process.env,
  };

  const corePackageJsonPath = path.join(
    rootDirectory,
    CORE_PACKAGE_JSON_RELATIVE_PATH,
  );
  try {
    await fsIO.access(corePackageJsonPath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return {
        action: 'skipped',
        path: CORE_DIST_MANIFEST_RELATIVE_PATH,
        expectedHash,
        actualHash: undefined,
        reason: 'missing core package.json',
      };
    }
    throw error;
  }

  const distManifestPath = path.join(
    rootDirectory,
    CORE_DIST_MANIFEST_RELATIVE_PATH,
  );
  const relativePath = toPosixPath(
    path.relative(rootDirectory, distManifestPath),
  );

  const existingDistSource = await readFileIfExists(
    distManifestPath,
    fsIO.readFile,
  );
  const existingHash =
    typeof existingDistSource === 'string'
      ? extractRuntimeEventManifestHash(existingDistSource)
      : undefined;

  if (existingHash === expectedHash) {
    return {
      action: 'unchanged',
      path: relativePath,
      expectedHash,
      actualHash: existingHash,
    };
  }

  if (check) {
    if (existingDistSource === undefined) {
      return {
        action: 'skipped',
        path: relativePath,
        expectedHash,
        actualHash: undefined,
        reason: 'missing core dist runtime event manifest',
      };
    }

    return {
      action: 'would-build',
      path: relativePath,
      expectedHash,
      actualHash: existingHash,
    };
  }

  const buildResult = await fsIO.spawnProcess(
    'pnpm',
    ['--filter', CORE_PACKAGE_NAME, 'run', 'build'],
    {
      cwd: rootDirectory,
      env: fsIO.env,
    },
  );

  if (buildResult.code !== 0) {
    const output = formatProcessOutput(buildResult);
    throw new Error(
      [
        `Failed to rebuild ${CORE_PACKAGE_NAME} after regenerating the runtime event manifest (exit code ${buildResult.code}).`,
        'Re-run `pnpm generate` or build core manually to update `packages/core/dist/`.',
        output ? `\n\n${output}` : undefined,
      ]
        .filter((line): line is string => line !== undefined)
        .join('\n'),
    );
  }

  const updatedDistSource = await readFileIfExists(
    distManifestPath,
    fsIO.readFile,
  );
  const updatedHash =
    typeof updatedDistSource === 'string'
      ? extractRuntimeEventManifestHash(updatedDistSource)
      : undefined;

  if (updatedHash !== expectedHash) {
    throw new Error(
      [
        `Rebuilt ${CORE_PACKAGE_NAME} but its dist runtime event manifest hash did not update as expected.`,
        `Expected: ${expectedHash}`,
        `Actual: ${updatedHash ?? 'missing'}`,
      ].join('\n'),
    );
  }

  return {
    action: 'built',
    path: relativePath,
    expectedHash,
    actualHash: updatedHash,
  };
}

interface SpawnProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

async function spawnProcess(
  command: string,
  args: string[],
  options: SpawnProcessOptions,
): Promise<SpawnProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    } as SpawnOptions);

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk;
    });

    child.on('error', reject);
    child.on('exit', (code: number | null) => {
      resolve({ code, stdout, stderr });
    });
  });
}

export interface PersistValidationFailureSummaryOptions {
  failures: readonly ValidationFailureSummaryEntry[];
  rootDirectory: string;
  summaryOverride?: string;
  clean: boolean;
}

async function persistValidationFailureSummary({
  failures,
  rootDirectory,
  summaryOverride,
  clean,
}: PersistValidationFailureSummaryOptions): Promise<{ action: string; path: string }> {
  const summary = createValidationFailureSummary(failures);
  const absoluteSummaryPath = resolveSummaryOutputPath(
    rootDirectory,
    summaryOverride,
  );
  const writeResult = await writeDeterministicJsonFile(
    absoluteSummaryPath,
    summary,
    {
      check: false,
      clean,
    },
  );
  return {
    action: writeResult.action,
    path: toPosixPath(path.relative(rootDirectory, absoluteSummaryPath)),
  };
}

interface WriteDeterministicJsonFileOptions {
  check: boolean;
  clean: boolean;
}

async function writeDeterministicJsonFile(
  targetPath: string,
  data: unknown,
  options: WriteDeterministicJsonFileOptions,
): Promise<{ action: string }> {
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  const existing = await readFileIfExists(
    targetPath,
    (pathToRead, encoding) => fs.readFile(pathToRead, encoding),
  );

  if (options.check) {
    return {
      action: existing === serialized ? 'unchanged' : 'would-write',
    };
  }

  if (!options.clean && existing === serialized) {
    return { action: 'unchanged' };
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, serialized, 'utf8');
  return { action: 'written' };
}

type ReadFileFn = (
  targetPath: string,
  encoding: BufferEncoding,
) => Promise<string>;

async function readFileIfExists(
  targetPath: string,
  readFile: ReadFileFn,
): Promise<string | undefined> {
  try {
    return await readFile(targetPath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}
