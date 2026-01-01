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
  WorkspaceCompileResult,
} from '@idle-engine/content-compiler';

import type {
  CliOptions,
  FormattedArtifact,
  PackBalanceCounts,
  PipelineOutcome,
  RunSummary,
  SpawnProcessResult,
  ValidationFailureSummaryEntry,
  WatchTrigger,
} from './compile-utils.js';
import {
  BOOLEAN_FLAGS,
  createValidationFailureRunSummary,
  createValidationFailureSummary,
  determineWatchStatus,
  extractRuntimeEventManifestHash,
  filterPrunedArtifacts,
  formatOperation,
  formatProcessOutput,
  groupOperationsBySlug,
  isChangeAction,
  isNodeError,
  normalizeError,
  normalizeWatchTargetPath,
  parseValueArg,
  resolveSummaryOutputPath,
  resolveWorkspaceRoot,
  summarizeWatchTriggers,
  toPosixPath,
} from './compile-utils.js';
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

interface ExecuteContext {
  mode: 'watch';
  iteration: number;
  triggers?: WatchTrigger[];
}

type Logger = (event: CompileLogEvent) => void;

type CompileWorkspacePacksFn = (
  options: { rootDirectory: string },
  compileOptions: {
    check?: boolean;
    clean?: boolean;
    schema: unknown;
    summaryOutputPath?: string;
  },
) => Promise<WorkspaceCompileResult>;

type CreateLoggerFn = (options: { pretty?: boolean }) => Logger;

void run().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  let options: CliOptions;
  try {
    options = parseCliArgs(args);
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
    const shouldFail = (options.check && initialOutcome.drift) || !initialOutcome.success;
    if (shouldFail) {
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


function extractBalanceCounts(result: WorkspaceCompileResult['packs'][number]): PackBalanceCounts {
  if (result.status === 'compiled') {
    return {
      balanceWarnings: result.balanceWarnings.length,
      balanceErrors: result.balanceErrors.length,
    };
  }
  const maybeBalanceResult = result as { balanceWarnings?: unknown[]; balanceErrors?: unknown[] };
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
): void {
  const timestamp = new Date().toISOString();

  if (result.status === 'compiled') {
    const onlyUnchanged =
      check && artifacts.length > 0 && artifacts.every((artifact) => artifact.action === 'unchanged');
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

function emitPrunedEvent(slug: string, artifacts: FormattedArtifact[], check: boolean, logger: Logger): void {
  const prunedArtifacts = filterPrunedArtifacts(artifacts);
  if (prunedArtifacts.length === 0) {
    return;
  }
  logger({
    name: 'content_pack.pruned',
    slug,
    timestamp: new Date().toISOString(),
    artifacts: prunedArtifacts,
    check,
  } as CompileLogEvent);
}

function emitCompileEvents({ compileResult, logger, check }: EmitCompileEventsInput): void {
  const operationsBySlug = groupOperationsBySlug(compileResult.artifacts.operations);

  for (const result of compileResult.packs) {
    const operations = operationsBySlug.get(result.packSlug) ?? [];
    operationsBySlug.delete(result.packSlug);
    const artifacts = operations.map(formatOperation);
    const balanceCounts = extractBalanceCounts(result);

    emitPackResultEvent(result, artifacts, balanceCounts, check, logger);
    emitPrunedEvent(result.packSlug, artifacts, check, logger);
  }

  for (const [slug, operations] of operationsBySlug.entries()) {
    const artifacts = operations.map(formatOperation);
    emitPrunedEvent(slug, artifacts, check, logger);
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
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
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

function parseCliArgs(argv: string[]): CliOptions {
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

    if (BOOLEAN_FLAGS.has(arg)) {
      const flagKey = arg.slice(2) as keyof Pick<CliOptions, 'check' | 'clean' | 'pretty' | 'watch'>;
      options[flagKey] = true;
      continue;
    }

    if (arg === '--cwd' || arg === '-C' || arg.startsWith('--cwd=')) {
      const parsed = parseValueArg(arg, argv, index, '--cwd');
      options.cwd = resolveWorkspaceRoot(parsed.value);
      index += parsed.skip;
      continue;
    }

    if (arg === '--summary' || arg.startsWith('--summary=')) {
      const parsed = parseValueArg(arg, argv, index, '--summary');
      options.summary = parsed.value;
      index += parsed.skip;
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
    ...(rootDirectory !== undefined && { rootDirectory }),
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
