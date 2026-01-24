import { execFile } from 'node:child_process';
import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bundleScript = path.resolve(packageRoot, '..', '..', 'tools', 'scripts', 'bundle-renderer.mjs');

describe('shell-desktop renderer bundle', () => {
  it('does not rely on dist-relative workspace imports', async () => {
    const outFile = path.join(packageRoot, 'dist', 'renderer', 'index.bundle-test.js');

    try {
      await execFileAsync(process.execPath, [bundleScript, '--package-root', packageRoot, '--outfile', outFile], {
        cwd: packageRoot,
      });

      const outStat = await stat(outFile);
      expect(outStat.isFile()).toBe(true);
    } finally {
      await rm(outFile, { force: true });
      await rm(`${outFile}.map`, { force: true });
    }
  });
});
