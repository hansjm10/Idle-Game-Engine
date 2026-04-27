#!/usr/bin/env node

/**
 * Verifies that committed dist/ files match their source builds.
 *
 * This script detects when TypeScript source has been modified but the
 * corresponding dist/ artifacts haven't been rebuilt and committed.
 *
 * IMPORTANT: Run this AFTER `pnpm build` to check for uncommitted changes.
 *
 * Usage:
 *   pnpm build && node tools/scripts/verify-dist-sync.mjs
 *
 * Exit codes:
 *   0: All dist/ files are in sync with source
 *   1: dist/ files are stale and need rebuilding/committing
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '../..');

const trustedGitCommandsByPlatform = new Map([
  ['darwin', ['/usr/bin/git']],
  ['linux', ['/usr/bin/git', '/bin/git']],
  ['win32', ['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\bin\\git.exe']],
]);

const trustedPathEntriesByPlatform = new Map([
  ['darwin', ['/usr/bin', '/bin']],
  ['linux', ['/usr/bin', '/bin']],
  ['win32', ['C:\\Program Files\\Git\\cmd', 'C:\\Program Files\\Git\\bin', 'C:\\Windows\\System32', 'C:\\Windows']],
]);

function compareStrings(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function getTrustedGitCommand() {
  const candidates = trustedGitCommandsByPlatform.get(process.platform) ?? ['/usr/bin/git'];
  const command = candidates.find((candidate) => existsSync(candidate));

  if (command === undefined) {
    throw new Error(`Unable to find git in trusted locations for ${process.platform}.`);
  }

  return command;
}

function copyEnvironmentValue(environment, name) {
  const value = process.env[name];
  if (value !== undefined) {
    environment[name] = value;
  }
}

function createGitEnvironment() {
  const pathEntries = trustedPathEntriesByPlatform.get(process.platform) ?? ['/usr/bin', '/bin'];
  const environment = {
    PATH: pathEntries.join(delimiter),
  };

  for (const name of ['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR']) {
    copyEnvironmentValue(environment, name);
  }

  return environment;
}

const gitCommand = getTrustedGitCommand();
const gitEnvironment = createGitEnvironment();

function runGit(args) {
  try {
    return execFileSync(gitCommand, args, {
      cwd: projectRoot,
      encoding: 'utf-8',
      env: gitEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return '';
  }
}

function listTrackedDistRoots() {
  const output = runGit(['ls-files', '-z', '--', 'packages/*/dist/**']);
  const roots = new Set();

  for (const filePath of output.split('\0')) {
    const match = /^(packages\/[^/]+\/dist)\//.exec(filePath);
    if (match) {
      roots.add(match[1]);
    }
  }

  return [...roots].sort(compareStrings);
}

function splitLines(output) {
  return output
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function listUnstagedStatusFiles(distPath) {
  return runGit(['status', '--short', '--untracked-files=no', '--', distPath])
    .split('\n')
    .filter(Boolean)
    .filter((line) => line.length >= 3 && line[1] !== ' ')
    .map((line) => line.slice(3));
}

function verifyDistSync() {
  console.log('🔍 Verifying dist/ files are in sync with source...\n');

  const stalePackages = [];

  for (const distPath of listTrackedDistRoots()) {
    if (!existsSync(join(projectRoot, distPath))) {
      console.warn(`⚠️  ${distPath} does not exist, skipping`);
      continue;
    }

    // Check for unstaged changes only (staged files are about to be committed)
    const diffChangedFiles = splitLines(runGit(['diff', '--name-only', '--', distPath]));
    const statusChangedFiles = listUnstagedStatusFiles(distPath);
    const changedFiles = [...new Set([...diffChangedFiles, ...statusChangedFiles])];
    const statusOnlyFiles = statusChangedFiles.filter((file) => !diffChangedFiles.includes(file));

    if (changedFiles.length > 0) {
      stalePackages.push({
        distPath,
        files: changedFiles,
        statusOnlyFiles,
      });
    }
  }

  if (stalePackages.length === 0) {
    console.log('✅ All dist/ files are in sync with source.\n');
    process.exit(0);
  }

  console.error('❌ dist/ files are out of sync!\n');
  console.error('The following packages have uncommitted dist/ changes:\n');

  for (const { distPath, files, statusOnlyFiles } of stalePackages) {
    console.error(`  📁 ${distPath}/`);
    for (const file of files) {
      console.error(`     - ${file}`);
    }
    if (statusOnlyFiles.length > 0) {
      console.error('     status-only changes detected; git status and git diff disagree');
    }
    console.error('');
  }

  console.error('To fix:\n');
  console.error('  1. Ensure you ran: pnpm build');
  console.error('  2. Commit the updated dist/ files');
  console.error('');
  console.error('This typically happens when you modify source files but forget');
  console.error('to rebuild and commit the dist/ artifacts.\n');

  process.exit(1);
}

verifyDistSync();
