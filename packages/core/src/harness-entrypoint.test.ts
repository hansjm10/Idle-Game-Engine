import { describe, expect, it } from 'vitest';

import { readFile } from 'node:fs/promises';

describe('harness entrypoint', () => {
  it('defines a harness subpath export', async () => {
    const packageJsonUrl = new URL('../package.json', import.meta.url);
    const raw = await readFile(packageJsonUrl, 'utf8');
    const pkg = JSON.parse(raw) as {
      exports?: Record<string, unknown>;
    };

    expect(pkg.exports).toHaveProperty('./harness');
    expect(pkg.exports?.['./harness']).toEqual({
      browser: {
        types: './dist/harness.browser.d.ts',
        default: './dist/harness.browser.js',
      },
      default: {
        types: './dist/harness.d.ts',
        default: './dist/harness.js',
      },
    });
  });

  it('exports save and snapshot helpers', async () => {
    const harness = await import('./harness.js');
    expect(harness.loadGameStateSaveFormat).toBeTypeOf('function');
    expect(harness.buildProgressionSnapshot).toBeTypeOf('function');
  });
});
