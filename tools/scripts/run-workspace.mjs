#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const WORKSPACE_CONCURRENCY_DEFAULT = '4';

function getPnpmCommand() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

function splitArgs(args) {
  const pnpmArgs = ['-r'];
  const scriptArgs = [];
  let forwardToScript = false;

  for (const arg of args) {
    if (forwardToScript) {
      scriptArgs.push(arg);
      continue;
    }

    if (arg === '--') {
      forwardToScript = true;
      continue;
    }

    pnpmArgs.push(arg);
  }

  return { pnpmArgs, scriptArgs };
}

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  if (result.error) {
    console.error(result.error instanceof Error ? result.error.message : String(result.error));
    return 1;
  }
  return result.status ?? 1;
}

function showBenchmarkHelp() {
  console.log(`Usage: pnpm benchmark [pnpm args] -- [benchmark args]

Examples:
  pnpm benchmark
  pnpm benchmark --filter @idle-engine/core
  pnpm benchmark -- --help`);
}

function main() {
  const mode = process.argv[2];
  if (!mode) {
    console.error('Usage: node tools/scripts/run-workspace.mjs <build|lint|test|test:ci|coverage|benchmark> [...args]');
    return 1;
  }

  if (mode === 'benchmark') {
    const rawArgs = process.argv.slice(3);
    for (const arg of rawArgs) {
      if (arg === '--') {
        break;
      }
      if (arg === '-h' || arg === '--help') {
        showBenchmarkHelp();
        return 0;
      }
    }
  }

  const { pnpmArgs, scriptArgs } = splitArgs(process.argv.slice(3));
  const pnpm = getPnpmCommand();

  if (mode === 'build' || mode === 'lint' || mode === 'test' || mode === 'benchmark' || mode === 'coverage') {
    const args = [...pnpmArgs, 'run', '--if-present', mode];
    if (scriptArgs.length > 0) {
      args.push('--', ...scriptArgs);
    }

    const status = runCommand(pnpm, args);
    if (status !== 0) {
      return status;
    }

    if (mode === 'coverage') {
      return runCommand(process.execPath, ['tools/scripts/normalize-lcov-paths.mjs', '--quiet']);
    }

    return 0;
  }

  if (mode === 'test:ci') {
    const workspaceConcurrency =
      process.env.TEST_CI_WORKSPACE_CONCURRENCY ?? WORKSPACE_CONCURRENCY_DEFAULT;

    const args = [
      ...pnpmArgs,
      'run',
      '--no-sort',
      '--workspace-concurrency',
      workspaceConcurrency,
      'test:ci'
    ];
    if (scriptArgs.length > 0) {
      args.push('--', ...scriptArgs);
    }

    return runCommand(pnpm, args);
  }

  console.error(`Unknown mode "${mode}". Expected build|lint|test|test:ci|coverage|benchmark.`);
  return 1;
}

process.exit(main());

