#!/usr/bin/env node

import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';

import { build } from 'esbuild';

const USAGE = `
Usage: node tools/scripts/bundle-renderer.mjs [--package-root <path>] [--entry <path>] [--outfile <path>]

Defaults:
  --package-root  <cwd>
  --entry         src/renderer/index.ts
  --outfile       dist/renderer/index.js

Bundles a renderer entrypoint into a browser-resolvable ES module.
`.trim();

function printUsageAndExit(exitCode = 1) {
  console.error(USAGE);
  process.exit(exitCode);
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        help: { type: 'boolean', short: 'h' },
        'package-root': { type: 'string' },
        entry: { type: 'string' },
        outfile: { type: 'string' },
      },
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Invalid arguments: ${message}`);
    printUsageAndExit(1);
    return;
  }

  if (values.help) {
    printUsageAndExit(0);
  }

  const packageRoot = path.resolve(values['package-root'] ?? process.cwd());
  const entryPoint = path.resolve(packageRoot, values.entry ?? path.join('src', 'renderer', 'index.ts'));
  const outFile = path.resolve(packageRoot, values.outfile ?? path.join('dist', 'renderer', 'index.js'));

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

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
