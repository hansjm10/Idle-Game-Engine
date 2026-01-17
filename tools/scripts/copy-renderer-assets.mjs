#!/usr/bin/env node

import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function printUsageAndExit() {
  console.error(
    [
      'Usage: node tools/scripts/copy-renderer-assets.mjs [--package-root <path>] [--source-dir <path>] [--dest-dir <path>]',
      '',
      'Defaults:',
      '  --package-root  <cwd>',
      "  --source-dir    'src/renderer'",
      "  --dest-dir      'dist/renderer'",
      '',
      'Copies non-TypeScript static assets (e.g. .html, .css, images) from source to dest.',
    ].join('\n'),
  );
  process.exit(1);
}

function readArgValue(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (!value || value.startsWith('-')) {
    return undefined;
  }
  return value;
}

function isAssetFileName(name) {
  if (name.endsWith('.d.ts')) {
    return false;
  }
  if (name.endsWith('.ts') || name.endsWith('.tsx')) {
    return false;
  }
  return true;
}

async function ensureDirectoryExists(targetPath) {
  await mkdir(targetPath, { recursive: true });
}

async function copyAssetsRecursive(sourceDir, destDir) {
  await ensureDirectoryExists(destDir);

  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      await copyAssetsRecursive(sourcePath, destPath);
      continue;
    }

    if (!entry.isFile() || !isAssetFileName(entry.name)) {
      continue;
    }

    await ensureDirectoryExists(path.dirname(destPath));
    await copyFile(sourcePath, destPath);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printUsageAndExit();
  }

  const packageRoot = path.resolve(readArgValue(args, '--package-root') ?? process.cwd());
  const sourceDir = path.resolve(
    packageRoot,
    readArgValue(args, '--source-dir') ?? path.join('src', 'renderer'),
  );
  const destDir = path.resolve(
    packageRoot,
    readArgValue(args, '--dest-dir') ?? path.join('dist', 'renderer'),
  );

  const sourceStat = await stat(sourceDir).catch((error) => {
    throw new Error(
      `Failed to stat source directory at ${sourceDir}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });

  if (!sourceStat.isDirectory()) {
    throw new Error(`Source path is not a directory: ${sourceDir}`);
  }

  await copyAssetsRecursive(sourceDir, destDir);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
