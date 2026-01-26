import { describe, expect, it } from 'vitest';

import { readFile } from 'node:fs/promises';

describe('@idle-engine/core README', () => {
  it('documents the harness entrypoint and its stability expectations', async () => {
    const readmeUrl = new URL('../README.md', import.meta.url);
    const readme = await readFile(readmeUrl, 'utf8');

    const harnessEntryPointLine = readme
      .split('\n')
      .find((line) => line.includes('`@idle-engine/core/harness`'));

    expect(harnessEntryPointLine).toBeDefined();
    expect(harnessEntryPointLine).toMatch(/experimental/i);
    expect(harnessEntryPointLine).toMatch(/shell|host|test/i);

    expect(readme).toMatch(/stable surface.*intentionally stays small/i);
  });
});

