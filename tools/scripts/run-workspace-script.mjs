#!/usr/bin/env node

import { spawn } from 'node:child_process';
import process from 'node:process';

function printUsageAndExit() {
  console.error(
    'Usage: node tools/scripts/run-workspace-script.mjs <scriptName> [pnpm args] -- [script args]',
  );
  process.exit(1);
}

function showBenchmarkHelpAndExit() {
  console.log(
    [
      'Usage: pnpm benchmark [pnpm args] -- [benchmark args]',
      '',
      'Examples:',
      '  pnpm benchmark',
      '  pnpm benchmark --filter @idle-engine/core',
      '  pnpm benchmark -- --help',
    ].join('\n'),
  );
  process.exit(0);
}

function splitArgs(scriptName, rawArgs) {
  const pnpmArgs = [];
  const scriptArgs = [];
  let forwardToScript = false;

  for (const arg of rawArgs) {
    if (forwardToScript) {
      scriptArgs.push(arg);
      continue;
    }

    if (scriptName === 'benchmark' && (arg === '-h' || arg === '--help')) {
      showBenchmarkHelpAndExit();
    }

    if (arg === '--') {
      forwardToScript = true;
      continue;
    }

    pnpmArgs.push(arg);
  }

  return { pnpmArgs, scriptArgs };
}

function buildPnpmArgs(scriptName, pnpmArgs, scriptArgs) {
  const args = ['-r', ...pnpmArgs, 'run'];

  if (scriptName === 'test:ci') {
    const workspaceConcurrency = process.env.TEST_CI_WORKSPACE_CONCURRENCY ?? '4';
    args.push('--no-sort', '--workspace-concurrency', workspaceConcurrency, 'test:ci');
  } else {
    args.push('--if-present', scriptName);
  }

  if (scriptArgs.length > 0) {
    args.push('--', ...scriptArgs);
  }

  return args;
}

function printPnpmNotFoundError() {
  console.error('[workspace-runner] pnpm not found on PATH.');
  console.error('Install pnpm or enable corepack (Node 20+):');
  console.error('  corepack enable');
  console.error('  corepack prepare pnpm@10.18.1 --activate');
}

function runCommand(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit' });

    child.on('error', (error) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        if (command === 'pnpm') {
          printPnpmNotFoundError();
        } else {
          console.error(`[workspace-runner] Failed to spawn ${command}: command not found.`);
        }
      } else {
        console.error(`[workspace-runner] Failed to spawn ${command}.`);
        console.error(error instanceof Error ? error.message : String(error));
      }

      resolve(1);
    });

    child.on('close', (code, signal) => {
      if (signal) {
        resolve(1);
        return;
      }

      resolve(code ?? 0);
    });
  });
}

async function main() {
  const [scriptName, ...rawArgs] = process.argv.slice(2);
  if (!scriptName) {
    printUsageAndExit();
  }

  const { pnpmArgs, scriptArgs } = splitArgs(scriptName, rawArgs);
  const pnpmCommandArgs = buildPnpmArgs(scriptName, pnpmArgs, scriptArgs);

  const exitCode = await runCommand('pnpm', pnpmCommandArgs);
  if (exitCode !== 0) {
    process.exit(exitCode);
  }

  if (scriptName === 'coverage') {
    const normalizeExit = await runCommand(process.execPath, [
      'tools/scripts/normalize-lcov-paths.mjs',
      '--quiet',
    ]);
    process.exit(normalizeExit);
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
