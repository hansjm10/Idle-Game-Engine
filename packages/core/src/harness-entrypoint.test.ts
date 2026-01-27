import { describe, expect, it } from 'vitest';

import { readFile } from 'node:fs/promises';

import {
  buildProgressionSnapshot,
  loadGameStateSaveFormat,
} from '@idle-engine/core/harness';
import type {
  GameStateSaveFormat,
  ProgressionSnapshot,
} from '@idle-engine/core/harness';

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

  it('exports save and snapshot helpers', () => {
    const parsedSave = loadGameStateSaveFormat({
      version: 1,
      savedAt: 0,
      resources: {},
      progression: {},
      commandQueue: {},
      runtime: { step: 0 },
    });
    const typedSave: GameStateSaveFormat = parsedSave;
    expect(typedSave.version).toBe(1);
    expect(typedSave.savedAt).toBe(0);
    expect(typedSave.runtime.step).toBe(0);
    expect(typedSave.automation).toHaveLength(0);
    expect(typedSave.transforms).toHaveLength(0);
    expect(typedSave.entities).toEqual({
      entities: [],
      instances: [],
      entityInstances: [],
    });

    const snapshot = buildProgressionSnapshot(0, 0);
    const typedSnapshot: ProgressionSnapshot = snapshot;
    expect(typedSnapshot.step).toBe(0);
    expect(typedSnapshot.publishedAt).toBe(0);
    expect(typedSnapshot.resources).toHaveLength(0);
    expect(typedSnapshot.generators).toHaveLength(0);
    expect(typedSnapshot.upgrades).toHaveLength(0);
    expect(Object.isFrozen(typedSnapshot)).toBe(true);
  });
});
