#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import type { FSWatcher } from 'chokidar';
import chokidar from 'chokidar';

import type {
  CompileLogEvent,
  FileWriteOperation,
  WorkspaceCompileResult,
} from '@idle-engine/content-compiler';

import {
  buildRuntimeEventManifest,
  ContentPackValidationError,
  validateContentPacks,
  writeRuntimeEventManifest,
} from './generate.js';
import { loadContentCompiler } from './content-compiler.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

const CORE_PACKAGE_NAME = '@idle-engine/core';
const CORE_PACKAGE_JSON_RELATIVE_PATH = 'packages/core/package.json';
const CORE_DIST_MANIFEST_RELATIVE_PATH =
  'packages/core/dist/events/runtime-event-manifest.generated.js';

const WATCH_GLOBS = [
  'packages/**/content/**/*.{json,json5}',
  'packages/**/content/event-types.json',
  'packages/core/src/events/runtime-event-base-metadata.json',
];

const WATCH_IGNORED = [
  '**/content/compiled/**',
  '**/src/generated/*.generated.ts',
  '**/node_modules/**',
];
const DEBOUNCE_MS = 150;
const WATCH_EVENT_TYPES = new Set(['add', 'change', 'unlink']);
const MAX_TRIGGER_PATHS = 10;

interface CliOptions {
  check: boolean;
  clean: boolean;
  pretty: boolean;
  watch: boolean;
  summary: string | undefined;
  cwd: string | undefined;
}

interface ExecuteContext {
  mode: 'watch';
  iteration: number;
  triggers?: WatchTrigger[];
}

interface WatchTrigger {
  event: string;
  path?: string;
}

interface RunSummary {
  packTotals: {
    total: number;
    compiled: number;
    failed: number;
    withWarnings: number;
  };
  artifactActions: {
    total: number;
    changed: number;
    byAction: Record<string, number>;
  };
  changedPacks: string[];
  failedPacks: string[];
  hasChanges: boolean;
  summaryAction: string;
  manifestAction: string;
}

interface PipelineOutcome {
  success: boolean;
  drift: boolean;
  runSummary: RunSummary | undefined;
}

type Logger = (event: CompileLogEvent) => void;

interface CompileWorkspacePacksFn {
  (
    options: { rootDirectory: string },
    compileOptions: {
      check?: boolean;
      clean?: boolean;
      schema: unknown;
      summaryOutputPath?: string;
    },
  ): Promise<WorkspaceCompileResult>;
}

interface CreateLoggerFn {
  (options: { pretty?: boolean }): Logger;
}

void run().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  let options: CliOptions;
  try {
    options = parseArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (options.watch && options.check) {
    console.error('--watch cannot be combined with --check.');
    process.exitCode = 1;
    return;
  }

  const workspaceRoot = options.cwd ?? REPO_ROOT;
  const { compileWorkspacePacks, createLogger } = (await loadContentCompiler({
    projectRoot: REPO_ROOT,
  })) as {
    compileWorkspacePacks: CompileWorkspacePacksFn;
    createLogger: CreateLoggerFn;
  };
  const logger = createLogger({ pretty: options.pretty });

  const execute = async (context: ExecuteContext | undefined = undefined): Promise<PipelineOutcome> => {
    const startTime = performance.now();
    const outcome = await executePipeline(
      options,
      logger,
      workspaceRoot,
      compileWorkspacePacks,
    );
    const durationMs = performance.now() - startTime;

    emitRunSummaryEvent({
      outcome,
      pretty: options.pretty,
      durationMs,
      mode: options.watch ? 'watch' : 'single',
    });

    if (options.watch && context?.mode === 'watch') {
      emitWatchRunEvent({
        outcome,
        durationMs,
        pretty: options.pretty,
        iteration: context.iteration,
        triggers: context.triggers ?? [],
      });
    }

    if (!options.watch) {
      process.exitCode = outcome.success ? 0 : 1;
    } else if (!outcome.success) {
      process.exitCode = 1;
    }
    return outcome;
  };

  const initialOutcome = await execute();

  if (!options.watch) {
    if (options.check && initialOutcome.drift) {
      process.exitCode = 1;
    } else if (!initialOutcome.success) {
      process.exitCode = 1;
    }
    return;
  }

  console.log(
    formatMonitorLog(
      `Watching for changes under ${workspaceRoot}`,
      options.pretty,
      workspaceRoot,
    ),
  );
  console.log(formatWatchHintLog(options.pretty));
  await startWatch(options, execute, workspaceRoot);
}

async function executePipeline(
  options: CliOptions,
  logger: Logger,
  workspaceRoot: string,
  compileWorkspacePacks: CompileWorkspacePacksFn,
): Promise<PipelineOutcome> {
  let manifest: Awaited<ReturnType<typeof buildRuntimeEventManifest>>;
  try {
    manifest = await buildRuntimeEventManifest({
      rootDirectory: workspaceRoot,
    });
  } catch (error) {
    logUnhandledCliError(error, { pretty: options.pretty });
    return {
      success: false,
      drift: false,
      runSummary: undefined,
    };
  }

  try {
    const validation = await validateContentPacks(manifest.manifestDefinitions, {
      pretty: options.pretty,
      rootDirectory: workspaceRoot,
    });

    const manifestResult = await writeRuntimeEventManifest(manifest.moduleSource, {
      check: options.check,
      clean: options.clean,
      rootDirectory: workspaceRoot,
    });
    logManifestResult(manifestResult, {
      pretty: options.pretty,
      check: options.check,
    });

    const coreDistManifestResult = await ensureCoreDistRuntimeEventManifest({
      rootDirectory: workspaceRoot,
      expectedHash: manifest.manifestHash,
      check: options.check === true,
    });
    logCoreDistRuntimeManifestResult(coreDistManifestResult, {
      pretty: options.pretty,
      check: options.check,
    });

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
        const summaryOutcome = await persistValidationFailureSummary({
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
        logUnhandledCliError(persistError, { pretty: options.pretty });
        return {
          success: false,
          drift: false,
          runSummary: undefined,
        };
      }
    }

    logUnhandledCliError(error, { pretty: options.pretty });
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
}

function emitCompileEvents({ compileResult, logger, check }: EmitCompileEventsInput): void {
  const operationsBySlug = new Map<string, FileWriteOperation[]>();
  for (const operation of compileResult.artifacts.operations) {
    if (!operationsBySlug.has(operation.slug)) {
      operationsBySlug.set(operation.slug, []);
    }
    operationsBySlug.get(operation.slug)!.push(operation);
  }

  for (const result of compileResult.packs) {
    const operations = operationsBySlug.get(result.packSlug) ?? [];
    operationsBySlug.delete(result.packSlug);
    const artifacts = operations.map(formatOperation);
    const timestamp = new Date().toISOString();
    const balanceWarnings =
      result.status === 'compiled'
        ? result.balanceWarnings.length
        : (result as { balanceWarnings?: unknown[] }).balanceWarnings?.length ?? 0;
    const balanceErrors =
      result.status === 'compiled'
        ? result.balanceErrors.length
        : (result as { balanceErrors?: unknown[] }).balanceErrors?.length ?? 0;

    if (result.status === 'compiled') {
      const warnings = result.warnings.length;
      const onlyUnchanged =
        check &&
        artifacts.length > 0 &&
        artifacts.every((artifact) => artifact.action === 'unchanged');

      if (onlyUnchanged) {
        logger({
          name: 'content_pack.skipped',
          slug: result.packSlug,
          path: result.document.relativePath,
          timestamp,
          durationMs: result.durationMs,
          warnings,
          balanceWarnings,
          balanceErrors,
          artifacts,
          check,
        } as CompileLogEvent);
      } else {
        logger({
          name: 'content_pack.compiled',
          slug: result.packSlug,
          path: result.document.relativePath,
          timestamp,
          durationMs: result.durationMs,
          warnings,
          balanceWarnings,
          balanceErrors,
          artifacts,
          check,
        } as CompileLogEvent);
      }
    } else {
      logger({
        name: 'content_pack.compilation_failed',
        slug: result.packSlug,
        path: result.document.relativePath,
        timestamp,
        durationMs: result.durationMs,
        warnings: result.warnings.length,
        balanceWarnings,
        balanceErrors,
        message: result.error.message,
        stack: result.error.stack,
        artifacts,
        check,
      } as CompileLogEvent);
    }

    const prunedArtifacts = artifacts.filter(
      (artifact) =>
        artifact.action === 'deleted' || artifact.action === 'would-delete',
    );
    if (prunedArtifacts.length > 0) {
      logger({
        name: 'content_pack.pruned',
        slug: result.packSlug,
        timestamp: new Date().toISOString(),
        artifacts: prunedArtifacts,
        check,
      } as CompileLogEvent);
    }
  }

  for (const [slug, operations] of operationsBySlug.entries()) {
    const prunedArtifacts = operations
      .map(formatOperation)
      .filter(
        (artifact) =>
          artifact.action === 'deleted' || artifact.action === 'would-delete',
      );
    if (prunedArtifacts.length === 0) {
      continue;
    }
    logger({
      name: 'content_pack.pruned',
      slug,
      timestamp: new Date().toISOString(),
      artifacts: prunedArtifacts,
      check,
    } as CompileLogEvent);
  }
}

interface CreateRunSummaryInput {
  compileResult: WorkspaceCompileResult;
  manifestAction: string;
}

function createRunSummary({ compileResult, manifestAction }: CreateRunSummaryInput): RunSummary {
  const actionCounts: Record<string, number> = Object.create(null);
  const changedPacks = new Set<string>();

  for (const operation of compileResult.artifacts.operations) {
    actionCounts[operation.action] =
      (actionCounts[operation.action] ?? 0) + 1;

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

  failedPacks.sort();

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
    changedPacks: Array.from(changedPacks).sort(),
    failedPacks,
    hasChanges: changedActionCount > 0 || summaryChanged || manifestChanged,
    summaryAction,
    manifestAction,
  };
}

function isChangeAction(action: string): boolean {
  return (
    action === 'written' ||
    action === 'deleted' ||
    action === 'would-write' ||
    action === 'would-delete'
  );
}

interface FormattedOperation {
  kind: string;
  path: string;
  action: string;
}

function formatOperation(operation: FileWriteOperation): FormattedOperation {
  return {
    kind: operation.kind,
    path: operation.path,
    action: operation.action,
  };
}

interface LogManifestResultOptions {
  pretty: boolean;
  check: boolean;
}

function logManifestResult(
  result: { action: string; path: string },
  options: LogManifestResultOptions,
): void {
  const eventSuffix =
    result.action === 'would-write' ? 'drift' : result.action;
  const payload = {
    event: `runtime_manifest.${eventSuffix}`,
    path: result.path,
    action: result.action,
    check: options.check === true,
    timestamp: new Date().toISOString(),
  };
  const serialized = JSON.stringify(
    payload,
    undefined,
    options.pretty ? 2 : undefined,
  );
  console.log(serialized);
}

interface CoreDistManifestResult {
  action: 'unchanged' | 'built' | 'would-build' | 'skipped';
  path: string;
  expectedHash: string;
  actualHash?: string;
  reason?: string;
}

function logCoreDistRuntimeManifestResult(
  result: CoreDistManifestResult,
  options: LogManifestResultOptions,
): void {
  const eventSuffix =
    result.action === 'would-build' ? 'drift' : result.action;
  const payload: Record<string, unknown> = {
    event: `runtime_manifest.core_dist.${eventSuffix}`,
    path: result.path,
    action: result.action,
    check: options.check === true,
    timestamp: new Date().toISOString(),
    expectedHash: result.expectedHash,
    ...(result.actualHash ? { actualHash: result.actualHash } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
  };
  const serialized = JSON.stringify(
    payload,
    undefined,
    options.pretty ? 2 : undefined,
  );
  console.log(serialized);
}

interface EnsureCoreDistManifestOptions {
  rootDirectory: string;
  expectedHash: string;
  check: boolean;
}

async function ensureCoreDistRuntimeEventManifest({
  rootDirectory,
  expectedHash,
  check,
}: EnsureCoreDistManifestOptions): Promise<CoreDistManifestResult> {
  const corePackageJsonPath = path.join(
    rootDirectory,
    CORE_PACKAGE_JSON_RELATIVE_PATH,
  );
  try {
    await fs.access(corePackageJsonPath);
  } catch {
    return {
      action: 'skipped',
      path: CORE_DIST_MANIFEST_RELATIVE_PATH,
      expectedHash,
      actualHash: undefined,
      reason: 'missing core package.json',
    };
  }

  const distManifestPath = path.join(
    rootDirectory,
    CORE_DIST_MANIFEST_RELATIVE_PATH,
  );
  const relativePath = toPosixPath(
    path.relative(rootDirectory, distManifestPath),
  );

  const existingDistSource = await readFileIfExists(distManifestPath);
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

  const buildResult = await spawnProcess('pnpm', [
    '--filter',
    CORE_PACKAGE_NAME,
    'run',
    'build',
  ], {
    cwd: rootDirectory,
    env: process.env,
  });

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

  const updatedDistSource = await readFileIfExists(distManifestPath);
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

function extractRuntimeEventManifestHash(source: string): string | undefined {
  const match = source.match(/hash\s*:\s*['"]([0-9a-f]{8})['"]/i);
  return typeof match?.[1] === 'string' ? match[1].toLowerCase() : undefined;
}

interface SpawnProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
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
    });

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

function formatProcessOutput(result: SpawnProcessResult): string {
  const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (combined.length === 0) {
    return '';
  }

  const maxLength = 4000;
  const clipped =
    combined.length > maxLength
      ? combined.slice(combined.length - maxLength)
      : combined;

  return clipped.trim();
}

interface ValidationFailureSummaryEntry {
  packSlug: string;
  packVersion?: string;
  path: string;
  message: string;
  issues?: unknown[];
}

interface PersistValidationFailureSummaryOptions {
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
  const existing = await readFileIfExists(targetPath);

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

async function readFileIfExists(targetPath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(targetPath, 'utf8');
  } catch {
    return undefined;
  }
}

interface BalanceIssue {
  code?: string;
}

function createValidationFailureSummary(
  failures: readonly ValidationFailureSummaryEntry[],
): { packs: unknown[] } {
  const packs = failures
    .map((failure) => ({
      slug: failure.packSlug ?? failure.path,
      status: 'failed',
      ...(failure.packVersion ? { version: failure.packVersion } : {}),
      warnings: [],
      ...(deriveBalanceFromIssues(failure.issues as BalanceIssue[] | undefined) ?? {}),
      dependencies: emptySummaryDependencies(),
      artifacts: emptySummaryArtifacts(),
      error: failure.message,
    }))
    .sort((left, right) => {
      if (left.slug === right.slug) {
        return 0;
      }
      return left.slug < right.slug ? -1 : 1;
    });

  return { packs };
}

function emptySummaryDependencies(): {
  requires: never[];
  optional: never[];
  conflicts: never[];
} {
  return {
    requires: [],
    optional: [],
    conflicts: [],
  };
}

function emptySummaryArtifacts(): Record<string, never> {
  return {};
}

function createValidationFailureRunSummary({
  failures,
  summaryAction,
}: {
  failures: readonly ValidationFailureSummaryEntry[];
  summaryAction: string;
}): RunSummary {
  const failedSlugs = Array.from(
    new Set(
      failures
        .map((failure) => failure.packSlug)
        .filter((slug): slug is string => typeof slug === 'string' && slug.length > 0),
    ),
  ).sort();

  const actionChanges =
    summaryAction === 'written' || summaryAction === 'would-write';

  return {
    packTotals: {
      total: failedSlugs.length,
      compiled: 0,
      failed: failedSlugs.length,
      withWarnings: 0,
    },
    artifactActions: {
      total: 0,
      changed: 0,
      byAction: {},
    },
    changedPacks: [],
    failedPacks: failedSlugs,
    hasChanges: actionChanges,
    summaryAction,
    manifestAction: 'skipped',
  };
}

function resolveSummaryOutputPath(rootDirectory: string, overridePath?: string): string {
  if (overridePath) {
    return path.isAbsolute(overridePath)
      ? overridePath
      : path.join(rootDirectory, overridePath);
  }
  return path.join(rootDirectory, 'content', 'compiled', 'index.json');
}

function logUnhandledCliError(error: unknown, { pretty }: { pretty: boolean }): void {
  const normalized = normalizeError(error);
  const payload: Record<string, unknown> = {
    event: 'cli.unhandled_error',
    message: normalized.message,
    timestamp: new Date().toISOString(),
    fatal: true,
    ...(normalized.name ? { name: normalized.name } : {}),
    ...(normalized.stack ? { stack: normalized.stack } : {}),
  };

  const serialized = JSON.stringify(
    payload,
    undefined,
    pretty ? 2 : undefined,
  );
  console.error(serialized);
}

interface NormalizedError {
  name?: string;
  message: string;
  stack?: string;
}

function normalizeError(error: unknown): NormalizedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message ?? String(error),
      stack: error.stack,
    };
  }
  const message = String(error);
  return {
    name: undefined,
    message,
    stack: undefined,
  };
}

type ExecuteFn = (context?: ExecuteContext) => Promise<PipelineOutcome>;

async function startWatch(
  _options: CliOptions,
  execute: ExecuteFn,
  workspaceRoot: string,
): Promise<void> {
  const watcher: FSWatcher = chokidar.watch(WATCH_GLOBS, {
    cwd: workspaceRoot,
    ignoreInitial: true,
    ignored: WATCH_IGNORED,
    awaitWriteFinish: {
      stabilityThreshold: 150,
      pollInterval: 20,
    },
  });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let queued = false;
  let iteration = 0;
  const pendingTriggers: WatchTrigger[] = [];

  const schedule = (): void => {
    queued = true;
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(async () => {
      timeoutId = undefined;
      if (running) {
        return;
      }
      running = true;
      queued = false;
      const triggers = pendingTriggers.splice(0, pendingTriggers.length);
      iteration += 1;
      try {
        await execute({
          mode: 'watch',
          iteration,
          triggers,
        });
      } finally {
        running = false;
        if (queued || pendingTriggers.length > 0) {
          schedule();
        }
      }
    }, DEBOUNCE_MS);
  };

  watcher.on('all', (eventName: string, targetPath: string) => {
    if (!WATCH_EVENT_TYPES.has(eventName)) {
      return;
    }
    const normalizedPath = normalizeWatchTargetPath(workspaceRoot, targetPath);
    pendingTriggers.push({
      event: eventName,
      ...(normalizedPath.length > 0 ? { path: normalizedPath } : {}),
    });
    schedule();
  });

  const closeWatcher = async (): Promise<void> => {
    await watcher.close();
  };

  process.on('SIGINT', async () => {
    await closeWatcher();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await closeWatcher();
    process.exit(0);
  });
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    check: false,
    clean: false,
    pretty: false,
    watch: false,
    summary: undefined,
    cwd: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') {
      options.check = true;
      continue;
    }
    if (arg === '--clean') {
      options.clean = true;
      continue;
    }
    if (arg === '--pretty') {
      options.pretty = true;
      continue;
    }
    if (arg === '--watch') {
      options.watch = true;
      continue;
    }
    if (arg === '--cwd' || arg === '-C') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('Missing value for --cwd');
      }
      options.cwd = resolveWorkspaceRoot(value);
      index += 1;
      continue;
    }
    if (arg.startsWith('--cwd=')) {
      options.cwd = resolveWorkspaceRoot(arg.slice('--cwd='.length));
      continue;
    }
    if (arg === '--summary') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('Missing value for --summary');
      }
      options.summary = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--summary=')) {
      options.summary = arg.slice('--summary='.length);
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function printUsage(): void {
  console.log(
    [
      'Usage: pnpm --filter @idle-engine/content-validation-cli run compile [options]',
      '',
      'Options:',
      '  --check             Run without writing files; exits 1 when drift detected.',
      '  --clean             Force rewrites even when artifacts are unchanged.',
      '  --pretty            Pretty-print JSON log events.',
      '  --cwd <path>        Override the workspace root directory.',
      '  --summary <path>    Override the workspace summary output path.',
      '  --watch             Re-run on file changes.',
      '  -h, --help          Show this help text.',
    ].join('\n'),
  );
}

function formatMonitorLog(message: string, pretty: boolean, rootDirectory?: string): string {
  const payload: Record<string, unknown> = {
    event: 'watch.status',
    message,
    timestamp: new Date().toISOString(),
    ...(rootDirectory !== undefined ? { rootDirectory } : {}),
  };
  return JSON.stringify(payload, undefined, pretty ? 2 : undefined);
}

function formatWatchHintLog(pretty: boolean): string {
  const payload = {
    event: 'watch.hint',
    message: 'Press Ctrl+C to stop watching; structured logs continue until exit.',
    timestamp: new Date().toISOString(),
    exit: 'CTRL+C',
  };
  return JSON.stringify(payload, undefined, pretty ? 2 : undefined);
}

interface EmitWatchRunEventInput {
  outcome: PipelineOutcome;
  durationMs: number;
  pretty: boolean;
  iteration: number;
  triggers: WatchTrigger[];
}

function emitWatchRunEvent({ outcome, durationMs, iteration, triggers, pretty }: EmitWatchRunEventInput): void {
  const status = determineWatchStatus(outcome);
  const payload: Record<string, unknown> = {
    event: 'watch.run',
    status,
    iteration,
    timestamp: new Date().toISOString(),
    durationMs: Number(durationMs.toFixed(2)),
  };

  if (Array.isArray(triggers) && triggers.length > 0) {
    payload.triggers = summarizeWatchTriggers(triggers);
  }

  const summary = outcome.runSummary;
  if (summary) {
    payload.packs = {
      total: summary.packTotals.total,
      compiled: summary.packTotals.compiled,
      failed: summary.packTotals.failed,
      withWarnings: summary.packTotals.withWarnings,
      changed: summary.changedPacks.length,
    };
    payload.artifacts = {
      total: summary.artifactActions.total,
      changed: summary.artifactActions.changed,
      summaryAction: summary.summaryAction,
      manifestAction: summary.manifestAction,
      byAction: summary.artifactActions.byAction,
    };
    if (summary.changedPacks.length > 0) {
      payload.changedPacks = summary.changedPacks;
    }
    if (summary.failedPacks.length > 0) {
      payload.failedPacks = summary.failedPacks;
    }
  }

  console.log(formatWatchRunLog(payload, pretty));
}

function determineWatchStatus(outcome: PipelineOutcome): 'success' | 'failed' | 'skipped' {
  if (!outcome.success) {
    return 'failed';
  }

  if (outcome.runSummary && outcome.runSummary.hasChanges === false) {
    return 'skipped';
  }

  return 'success';
}

interface WatchTriggerSummary {
  count: number;
  limit: number;
  events?: Record<string, number>;
  paths?: string[];
  morePaths?: number;
}

function summarizeWatchTriggers(triggers: WatchTrigger[]): WatchTriggerSummary {
  const eventsByType: Record<string, number> = Object.create(null);
  const uniquePaths: string[] = [];
  const seenPaths = new Set<string>();

  for (const trigger of triggers) {
    const { event, path: triggerPath } = trigger ?? {};
    if (typeof event === 'string') {
      eventsByType[event] = (eventsByType[event] ?? 0) + 1;
    }
    if (typeof triggerPath === 'string' && !seenPaths.has(triggerPath)) {
      seenPaths.add(triggerPath);
      uniquePaths.push(triggerPath);
    }
  }

  const sortedEventEntries = Object.entries(eventsByType).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const limitedPaths = uniquePaths.slice(0, MAX_TRIGGER_PATHS);
  const overflow = uniquePaths.length - limitedPaths.length;

  const summary: WatchTriggerSummary = {
    count: triggers.length,
    limit: MAX_TRIGGER_PATHS,
    ...(sortedEventEntries.length > 0
      ? { events: Object.fromEntries(sortedEventEntries) }
      : {}),
    ...(limitedPaths.length > 0 ? { paths: limitedPaths } : {}),
  };

  if (overflow > 0) {
    summary.morePaths = overflow;
  }

  return summary;
}

function formatWatchRunLog(payload: unknown, pretty: boolean): string {
  return JSON.stringify(payload, undefined, pretty ? 2 : undefined);
}

interface EmitRunSummaryEventInput {
  outcome: PipelineOutcome;
  pretty: boolean;
  durationMs: number;
  mode: 'single' | 'watch';
}

function emitRunSummaryEvent({ outcome, pretty, durationMs, mode }: EmitRunSummaryEventInput): void {
  const payload: Record<string, unknown> = {
    event: 'cli.run_summary',
    timestamp: new Date().toISOString(),
    success: outcome.success === true,
    drift: outcome.drift === true,
    summary: outcome.runSummary ?? null,
  };

  if (typeof durationMs === 'number' && Number.isFinite(durationMs)) {
    payload.durationMs = Number(durationMs.toFixed(2));
  }

  if (typeof mode === 'string' && mode.length > 0) {
    payload.mode = mode;
  }

  console.log(JSON.stringify(payload, undefined, pretty ? 2 : undefined));
}

function resolveWorkspaceRoot(inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath);
}

function normalizeWatchTargetPath(workspaceRoot: string, targetPath: string): string {
  if (typeof targetPath !== 'string' || targetPath.length === 0) {
    return '';
  }
  const absolutePath = path.isAbsolute(targetPath)
    ? targetPath
    : path.resolve(workspaceRoot, targetPath);
  const relativePath = path.relative(workspaceRoot, absolutePath);
  return toPosixPath(relativePath);
}

function toPosixPath(inputPath: string): string {
  if (inputPath === '') {
    return '';
  }
  return inputPath.split(path.sep).join('/');
}

function deriveBalanceFromIssues(issues: BalanceIssue[] | undefined): { balance: unknown } | undefined {
  if (!Array.isArray(issues)) {
    return undefined;
  }

  const balanceErrors = issues.filter(
    (issue) => typeof issue?.code === 'string' && issue.code.startsWith('balance.'),
  );

  if (balanceErrors.length === 0) {
    return undefined;
  }

  return {
    balance: {
      warnings: [],
      errors: balanceErrors,
      warningCount: 0,
      errorCount: balanceErrors.length,
    },
  };
}
