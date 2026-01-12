#!/usr/bin/env node

import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { FSWatcher } from 'chokidar';
import chokidar from 'chokidar';

import type {
  CliOptions,
  PipelineOutcome,
  WatchTrigger,
} from './compile-utils.js';
import {
  BOOLEAN_FLAGS,
  determineWatchStatus,
  normalizeError,
  normalizeWatchTargetPath,
  parseValueArg,
  resolveWorkspaceRoot,
  summarizeWatchTriggers,
} from './compile-utils.js';
import type {
  CompileWorkspacePacksFn,
  CoreDistManifestResult,
  Logger,
} from './compile-pipeline.js';
import { executeCompilePipeline } from './compile-pipeline.js';
import { loadContentCompiler } from './content-compiler.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

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

type CreateLoggerFn = (options: { pretty?: boolean }) => Logger;

export async function run(): Promise<void> {
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
    const outcome = await executeCompilePipeline({
      options,
      workspaceRoot,
      logger,
      compileWorkspacePacks,
      callbacks: {
        onManifestResult: (result) =>
          logManifestResult(result, {
            pretty: options.pretty,
            check: options.check,
          }),
        onCoreDistManifestResult: (result) =>
          logCoreDistRuntimeManifestResult(result, {
            pretty: options.pretty,
            check: options.check,
          }),
        onUnhandledError: (error) =>
          logUnhandledCliError(error, { pretty: options.pretty }),
      },
    });
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

interface LogManifestResultOptions {
  pretty: boolean;
  check: boolean;
}

export function logManifestResult(
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

export function logCoreDistRuntimeManifestResult(
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

export function logUnhandledCliError(
  error: unknown,
  { pretty }: { pretty: boolean },
): void {
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

export async function startWatch(
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

export function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    check: false,
    clean: false,
    pretty: false,
    watch: false,
    summary: undefined,
    cwd: undefined,
  };

  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    index += 1;

    if (BOOLEAN_FLAGS.has(arg)) {
      const flagKey = arg.slice(2) as keyof Pick<CliOptions, 'check' | 'clean' | 'pretty' | 'watch'>;
      options[flagKey] = true;
      continue;
    }

    if (arg === '--cwd' || arg === '-C' || arg.startsWith('--cwd=')) {
      const parsed = parseValueArg(arg, argv, index - 1, '--cwd');
      options.cwd = resolveWorkspaceRoot(parsed.value);
      index += parsed.skip;
      continue;
    }

    if (arg === '--summary' || arg.startsWith('--summary=')) {
      const parsed = parseValueArg(arg, argv, index - 1, '--summary');
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

export function printUsage(): void {
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

export function formatMonitorLog(
  message: string,
  pretty: boolean,
  rootDirectory?: string,
): string {
  const payload: Record<string, unknown> = {
    event: 'watch.status',
    message,
    timestamp: new Date().toISOString(),
    ...(rootDirectory !== undefined && { rootDirectory }),
  };
  return JSON.stringify(payload, undefined, pretty ? 2 : undefined);
}

export function formatWatchHintLog(pretty: boolean): string {
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

export function emitWatchRunEvent({
  outcome,
  durationMs,
  iteration,
  triggers,
  pretty,
}: EmitWatchRunEventInput): void {
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

export function formatWatchRunLog(payload: unknown, pretty: boolean): string {
  return JSON.stringify(payload, undefined, pretty ? 2 : undefined);
}

interface EmitRunSummaryEventInput {
  outcome: PipelineOutcome;
  pretty: boolean;
  durationMs: number;
  mode: 'single' | 'watch';
}

export function emitRunSummaryEvent({
  outcome,
  pretty,
  durationMs,
  mode,
}: EmitRunSummaryEventInput): void {
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

if (isExecutedDirectly(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  }
}

function isExecutedDirectly(moduleUrl: string): boolean {
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    return false;
  }
  return moduleUrl === pathToFileURL(scriptPath).href;
}
