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

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '../..');

// Packages that commit dist/ and need verification
const PACKAGES_WITH_DIST = ['packages/controls'];

function run(cmd) {
  try {
    return execSync(cmd, {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
  } catch {
    return '';
  }
}

function verifyDistSync() {
  console.log('🔍 Verifying dist/ files are in sync with source...\n');

  const stalePackages = [];

  for (const packagePath of PACKAGES_WITH_DIST) {
    const distPath = join(packagePath, 'dist');
    if (!existsSync(join(projectRoot, distPath))) {
      console.warn(`⚠️  ${distPath} does not exist, skipping`);
      continue;
    }

    // Check for unstaged changes only (staged files are about to be committed)
    const diff = run(`git diff --name-only -- "${distPath}"`);
    const changedFiles = diff.split('\n').filter(Boolean);

    if (changedFiles.length > 0) {
      stalePackages.push({
        packagePath,
        files: changedFiles,
      });
    }
  }

  if (stalePackages.length === 0) {
    console.log('✅ All dist/ files are in sync with source.\n');
    process.exit(0);
  }

  console.error('❌ dist/ files are out of sync!\n');
  console.error('The following packages have uncommitted dist/ changes:\n');

  for (const { packagePath, files } of stalePackages) {
    console.error(`  📁 ${packagePath}/dist/`);
    for (const file of files) {
      console.error(`     - ${file}`);
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
