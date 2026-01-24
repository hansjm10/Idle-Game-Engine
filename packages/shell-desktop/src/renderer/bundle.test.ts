import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('shell-desktop renderer bundle', () => {
  it('does not rely on dist-relative workspace imports', async () => {
    const entryPoint = path.join(packageRoot, 'src', 'renderer', 'index.ts');
    const outFile = path.join(packageRoot, 'dist', 'renderer', 'index.js');

    const result = await build({
      entryPoints: [entryPoint],
      outfile: outFile,
      absWorkingDir: packageRoot,
      bundle: true,
      platform: 'browser',
      format: 'esm',
      target: 'es2020',
      sourcemap: false,
      write: false,
      logLevel: 'silent',
    });

    const outputFiles = result.outputFiles ?? [];
    const jsOutput = outputFiles.find((file) => file.path === outFile);
    expect(jsOutput).toBeDefined();

    const jsText = jsOutput?.text ?? '';
    expect(jsText).not.toContain('../../../renderer-');
    expect(jsText).not.toMatch(/\bfrom ['"]@idle-engine\//);
    expect(jsText).not.toMatch(/\bimport ['"]@idle-engine\//);
  });
});
