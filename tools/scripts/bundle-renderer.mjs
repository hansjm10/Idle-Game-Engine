#!/usr/bin/env node

import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { build } from 'esbuild';

function printUsageAndExit() {
  console.error(
    [
      'Usage: node tools/scripts/bundle-renderer.mjs [--package-root <path>] [--entry <path>] [--outfile <path>]',
      '',
      'Defaults:',
      '  --package-root  <cwd>',
      "  --entry         'src/renderer/index.ts'",
      "  --outfile       'dist/renderer/index.js'",
      '',
      'Bundles a renderer entrypoint into a browser-resolvable ES module.',
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

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printUsageAndExit();
  }

  const packageRoot = path.resolve(readArgValue(args, '--package-root') ?? process.cwd());
  const entryPoint = path.resolve(
    packageRoot,
    readArgValue(args, '--entry') ?? path.join('src', 'renderer', 'index.ts'),
  );
  const outFile = path.resolve(
    packageRoot,
    readArgValue(args, '--outfile') ?? path.join('dist', 'renderer', 'index.js'),
  );

  const entryStat = await stat(entryPoint).catch((error) => {
    throw new Error(
      `Failed to stat renderer entrypoint at ${entryPoint}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });

  if (!entryStat.isFile()) {
    throw new Error(`Renderer entrypoint is not a file: ${entryPoint}`);
  }

  await mkdir(path.dirname(outFile), { recursive: true });

  await build({
    entryPoints: [entryPoint],
    outfile: outFile,
    absWorkingDir: packageRoot,
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2020',
    sourcemap: true,
  });

  const bundledOutput = await readFile(outFile, 'utf8');
  if (bundledOutput.includes('../../../renderer-')) {
    throw new Error(
      'Renderer bundle includes dist-relative workspace imports. Use package imports and ensure bundling runs as part of the build.',
    );
  }

  const packageImportPatterns = [/\bfrom ['"]@idle-engine\//, /\bimport ['"]@idle-engine\//];
  if (packageImportPatterns.some((pattern) => pattern.test(bundledOutput))) {
    throw new Error(
      'Renderer bundle includes unresolved package imports. Ensure dependencies are bundled so the output can run in a packaged browser environment.',
    );
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
