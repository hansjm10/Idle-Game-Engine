#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import chokidar from 'chokidar';

import {
  buildRuntimeEventManifest,
  validateContentPacks,
  writeRuntimeEventManifest,
} from './generate.js';
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

void run().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});

async function run() {
  const args = process.argv.slice(2);
  let options;
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
  const { compileWorkspacePacks, createLogger } = await loadContentCompiler({
    projectRoot: REPO_ROOT,
  });
  const logger = createLogger({ pretty: options.pretty });

  const execute = async () => {
    const outcome = await executePipeline(
      options,
      logger,
      workspaceRoot,
      compileWorkspacePacks,
    );
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
  await startWatch(options, execute, workspaceRoot);
}

async function executePipeline(
  options,
  logger,
  workspaceRoot,
  compileWorkspacePacks,
) {
  try {
    const manifest = await buildRuntimeEventManifest({
      rootDirectory: workspaceRoot,
    });
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
      (compileResult.hasDrift || manifestResult.action === 'would-write');

    return {
      success: !hasFailures && !hasDrift,
      drift: hasDrift,
    };
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    return {
      success: false,
      drift: false,
    };
  }
}

function emitCompileEvents({ compileResult, logger, check }) {
  const operationsBySlug = new Map();
  for (const operation of compileResult.artifacts.operations) {
    if (!operationsBySlug.has(operation.slug)) {
      operationsBySlug.set(operation.slug, []);
    }
    operationsBySlug.get(operation.slug).push(operation);
  }

  for (const result of compileResult.packs) {
    const operations = operationsBySlug.get(result.packSlug) ?? [];
    operationsBySlug.delete(result.packSlug);
    const artifacts = operations.map(formatOperation);
    const timestamp = new Date().toISOString();

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
          artifacts,
          check,
        });
      } else {
        logger({
          name: 'content_pack.compiled',
          slug: result.packSlug,
          path: result.document.relativePath,
          timestamp,
          durationMs: result.durationMs,
          warnings,
          artifacts,
          check,
        });
      }
    } else {
      logger({
        name: 'content_pack.compilation_failed',
        slug: result.packSlug,
        path: result.document.relativePath,
        timestamp,
        durationMs: result.durationMs,
        message: result.error.message,
        stack: result.error.stack,
        artifacts,
        check,
      });
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
      });
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
    });
  }
}

function formatOperation(operation) {
  return {
    kind: operation.kind,
    path: operation.path,
    action: operation.action,
  };
}

function logManifestResult(result, options) {
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

async function startWatch(options, execute, workspaceRoot) {
  const watcher = chokidar.watch(WATCH_GLOBS, {
    cwd: workspaceRoot,
    ignoreInitial: true,
    ignored: WATCH_IGNORED,
    awaitWriteFinish: {
      stabilityThreshold: 150,
      pollInterval: 20,
    },
  });

  let timeoutId;
  let running = false;
  let queued = false;

  const schedule = () => {
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
      try {
        await execute();
      } finally {
        running = false;
        if (queued) {
          schedule();
        }
      }
    }, DEBOUNCE_MS);
  };

  watcher.on('add', schedule);
  watcher.on('change', schedule);
  watcher.on('unlink', schedule);

  const closeWatcher = async () => {
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

function parseArgs(argv) {
  const options = {
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

function printUsage() {
  console.log(
    [
      'Usage: pnpm --filter @idle-engine/content-schema-cli run compile [options]',
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

function formatMonitorLog(message, pretty, rootDirectory) {
  const payload = {
    event: 'watch.status',
    message,
    timestamp: new Date().toISOString(),
    ...(rootDirectory !== undefined ? { rootDirectory } : {}),
  };
  return JSON.stringify(payload, undefined, pretty ? 2 : undefined);
}

function resolveWorkspaceRoot(inputPath) {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath);
}
