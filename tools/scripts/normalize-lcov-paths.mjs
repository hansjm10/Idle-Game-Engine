#!/usr/bin/env node

import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

const WORKSPACE_ROOTS = ['packages', 'tools', 'services'];

function toPosixPath(value) {
  return value.replaceAll('\\', '/');
}

function isWindowsAbsolutePath(value) {
  return /^[A-Za-z]:[\\/]/.test(value);
}

function normalizeSourceFilePath(sourceFile, { baseDir, projectRootAbs }) {
  if (!sourceFile) {
    return sourceFile;
  }

  const posixPath = toPosixPath(sourceFile);
  const baseDirPosix = toPosixPath(baseDir);

  if (posixPath.startsWith('packages/') || posixPath.startsWith('tools/') || posixPath.startsWith('services/')) {
    return posixPath;
  }

  if (baseDirPosix && posixPath.startsWith(`${baseDirPosix}/`)) {
    return posixPath;
  }

  const maybeAbsolute =
    posixPath.startsWith('/') || isWindowsAbsolutePath(posixPath) || sourceFile.startsWith('/');

  if (maybeAbsolute) {
    const resolved = path.resolve(sourceFile);
    const relative = path.relative(projectRootAbs, resolved);

    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      return toPosixPath(relative);
    }

    return toPosixPath(resolved);
  }

  if (!baseDirPosix) {
    return posixPath;
  }

  return `${baseDirPosix}/${posixPath}`;
}

function normalizeLcovContent(content, { baseDir, projectRootAbs }) {
  let changed = false;

  const normalized = content
    .split('\n')
    .map((line) => {
      if (!line.startsWith('SF:')) {
        return line;
      }

      const sourceFile = line.slice('SF:'.length);
      const normalizedSourceFile = normalizeSourceFilePath(sourceFile, { baseDir, projectRootAbs });

      if (normalizedSourceFile === sourceFile) {
        return line;
      }

      changed = true;
      return `SF:${normalizedSourceFile}`;
    })
    .join('\n');

  return { changed, normalized };
}

async function findLcovFiles() {
  const results = [];

  for (const rootDir of WORKSPACE_ROOTS) {
    const absoluteRoot = path.join(projectRoot, rootDir);
    const rootStats = await stat(absoluteRoot).catch(() => null);
    if (!rootStats?.isDirectory()) {
      continue;
    }

    const rootEntries = await readdir(absoluteRoot, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const lcovPath = path.join(absoluteRoot, entry.name, 'coverage', 'lcov.info');
      const lcovStats = await stat(lcovPath).catch(() => null);
      if (lcovStats?.isFile()) {
        results.push(path.relative(projectRoot, lcovPath));
      }
    }
  }

  return results.sort();
}

function parseArgs(argv) {
  const opts = { check: false, quiet: false, paths: [] };

  for (const arg of argv) {
    if (arg === '--check') {
      opts.check = true;
      continue;
    }
    if (arg === '--quiet') {
      opts.quiet = true;
      continue;
    }
    opts.paths.push(arg);
  }

  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const lcovFiles = opts.paths.length > 0 ? opts.paths : await findLcovFiles();

  if (lcovFiles.length === 0) {
    if (!opts.quiet) {
      console.log('[normalize-lcov-paths] No LCOV files found; skipping.');
    }
    return;
  }

  const projectRootAbs = projectRoot;
  const updated = [];

  for (const lcovFile of lcovFiles) {
    const lcovAbs = path.isAbsolute(lcovFile) ? lcovFile : path.join(projectRootAbs, lcovFile);
    const lcovRel = path.relative(projectRootAbs, lcovAbs);
    const baseDir = path.dirname(path.dirname(lcovRel));

    const original = await readFile(lcovAbs, 'utf8');
    const { changed, normalized } = normalizeLcovContent(original, { baseDir, projectRootAbs });

    if (!changed) {
      continue;
    }

    updated.push(lcovRel);
    if (!opts.check) {
      await writeFile(lcovAbs, normalized);
    }
  }

  if (opts.check && updated.length > 0) {
    console.error('[normalize-lcov-paths] LCOV file paths need normalization:');
    for (const file of updated) {
      console.error(`- ${file}`);
    }
    process.exit(1);
  }

  if (!opts.quiet && updated.length > 0) {
    console.log(`[normalize-lcov-paths] Normalized ${updated.length} LCOV file(s).`);
  }
}

try {
  await main();
} catch (error) {
  console.error('[normalize-lcov-paths] Failed to normalize LCOV file paths.');
  console.error(error);
  process.exit(1);
}

