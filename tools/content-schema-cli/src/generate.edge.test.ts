import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  buildRuntimeEventManifest,
  ContentPackValidationError,
  validateContentPacks,
  writeRuntimeEventManifest,
} from './generate.js';

async function writeJson(targetPath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeText(targetPath: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, value, 'utf8');
}

async function createWorkspace(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'idle-engine-generate-'));
  await fs.mkdir(path.join(root, 'packages'), { recursive: true });
  return {
    root,
    cleanup: async () => {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

describe('generate.ts edge cases', () => {
  it('writeRuntimeEventManifest reports drift in check mode and skips unchanged writes', async () => {
    const workspace = await createWorkspace();
    try {
      const result = await writeRuntimeEventManifest('module source', {
        rootDirectory: workspace.root,
        check: true,
      });
      expect(result).toEqual({
        action: 'would-write',
        path: 'packages/core/src/events/runtime-event-manifest.generated.ts',
      });

      const written = await writeRuntimeEventManifest('module source', {
        rootDirectory: workspace.root,
      });
      expect(written.action).toBe('written');

      const unchanged = await writeRuntimeEventManifest('module source', {
        rootDirectory: workspace.root,
      });
      expect(unchanged).toEqual({
        action: 'unchanged',
        path: 'packages/core/src/events/runtime-event-manifest.generated.ts',
      });
    } finally {
      await workspace.cleanup();
    }
  });

  it.each([
    {
      name: 'requires base metadata arrays',
      metadata: { nope: true },
      error: 'Base event metadata must be an array.',
    },
    {
      name: 'rejects non-object metadata entries',
      metadata: [null],
      error: 'Base event metadata entry at index 0 must be an object.',
    },
    {
      name: 'rejects missing event types',
      metadata: [{ type: '', version: 1 }],
      error: 'missing a string type',
    },
    {
      name: 'rejects non-positive versions',
      metadata: [{ type: 'core:event', version: 0 }],
      error: 'positive integer version',
    },
    {
      name: 'rejects invalid packSlug types',
      metadata: [{ type: 'core:event', version: 1, packSlug: 123 }],
      error: 'invalid packSlug',
    },
    {
      name: 'rejects invalid schema references',
      metadata: [{ type: 'core:event', version: 1, schema: 123 }],
      error: 'invalid schema reference',
    },
  ])('$name', async ({ metadata, error }) => {
    const workspace = await createWorkspace();
    try {
      await writeJson(
        path.join(
          workspace.root,
          'packages/core/src/events/runtime-event-base-metadata.json',
        ),
        metadata,
      );

      await expect(
        buildRuntimeEventManifest({ rootDirectory: workspace.root }),
      ).rejects.toThrow(error);
    } finally {
      await workspace.cleanup();
    }
  });

  it('includes default packSlug values in base metadata entries', async () => {
    const workspace = await createWorkspace();
    try {
      await writeJson(
        path.join(
          workspace.root,
          'packages/core/src/events/runtime-event-base-metadata.json',
        ),
        [
          { type: 'core:event', version: 1 },
          { type: 'core:event.with_pack', version: 2, packSlug: 'core-pack' },
        ],
      );

      const manifest = await buildRuntimeEventManifest({ rootDirectory: workspace.root });

      expect(manifest.manifestDefinitions).toEqual([
        expect.objectContaining({
          channel: 0,
          type: 'core:event',
          version: 1,
          packSlug: '@idle-engine/core',
        }),
        expect.objectContaining({
          channel: 1,
          type: 'core:event.with_pack',
          version: 2,
          packSlug: 'core-pack',
        }),
      ]);
    } finally {
      await workspace.cleanup();
    }
  });

  it('throws with actionable context when an event-types manifest is invalid JSON', async () => {
    const workspace = await createWorkspace();
    try {
      await writeJson(
        path.join(
          workspace.root,
          'packages/core/src/events/runtime-event-base-metadata.json',
        ),
        [{ type: 'core:event', version: 1 }],
      );

      await fs.mkdir(path.join(workspace.root, 'packages/alpha'), { recursive: true });

      await writeText(
        path.join(workspace.root, 'packages/beta/content/event-types.json'),
        '{',
      );

      await expect(
        buildRuntimeEventManifest({ rootDirectory: workspace.root }),
      ).rejects.toThrow('Failed to parse packages/beta/content/event-types.json');
    } finally {
      await workspace.cleanup();
    }
  });

  it('rejects duplicate event types declared across manifests', async () => {
    const workspace = await createWorkspace();
    try {
      await writeJson(
        path.join(
          workspace.root,
          'packages/core/src/events/runtime-event-base-metadata.json',
        ),
        [],
      );

      await writeJson(
        path.join(workspace.root, 'packages/alpha/content/event-types.json'),
        {
          packSlug: 'alpha',
          eventTypes: [
            { namespace: 'alpha', name: 'event', version: 1, schema: './schema.json' },
          ],
        },
      );
      await writeText(
        path.join(workspace.root, 'packages/alpha/content/schema.json'),
        '{}',
      );

      await writeJson(
        path.join(workspace.root, 'packages/beta/content/event-types.json'),
        {
          packSlug: 'beta',
          eventTypes: [
            { namespace: 'alpha', name: 'event', version: 1, schema: './schema.json' },
          ],
        },
      );
      await writeText(
        path.join(workspace.root, 'packages/beta/content/schema.json'),
        '{}',
      );

      await expect(
        buildRuntimeEventManifest({ rootDirectory: workspace.root }),
      ).rejects.toThrow('duplicates are not allowed');
    } finally {
      await workspace.cleanup();
    }
  });

  it('rejects manifests that reference missing schema files', async () => {
    const workspace = await createWorkspace();
    try {
      await writeJson(
        path.join(
          workspace.root,
          'packages/core/src/events/runtime-event-base-metadata.json',
        ),
        [],
      );

      await writeJson(
        path.join(workspace.root, 'packages/alpha/content/event-types.json'),
        {
          packSlug: 'alpha',
          eventTypes: [
            { namespace: 'alpha', name: 'missing-schema', version: 1, schema: './missing.json' },
          ],
        },
      );

      await expect(
        buildRuntimeEventManifest({ rootDirectory: workspace.root }),
      ).rejects.toThrow('does not exist');
    } finally {
      await workspace.cleanup();
    }
  });

  it('renders empty manifests deterministically when no definitions exist', async () => {
    const workspace = await createWorkspace();
    try {
      await writeJson(
        path.join(
          workspace.root,
          'packages/core/src/events/runtime-event-base-metadata.json',
        ),
        [],
      );

      const manifest = await buildRuntimeEventManifest({ rootDirectory: workspace.root });

      expect(manifest.manifestDefinitions).toEqual([]);
      expect(manifest.manifestEntries).toEqual([]);
      expect(manifest.moduleSource).toContain(
        'export const CONTENT_EVENT_DEFINITIONS = []',
      );
      expect(manifest.moduleSource).toContain(
        'export const GENERATED_RUNTIME_EVENT_DEFINITIONS = []',
      );
      expect(manifest.moduleSource).toContain(
        "export type ContentRuntimeEventType =\n  never;",
      );
    } finally {
      await workspace.cleanup();
    }
  });

  it('includes achievement-derived events and ignores non-string IDs', async () => {
    const workspace = await createWorkspace();
    try {
      await writeJson(
        path.join(
          workspace.root,
          'packages/core/src/events/runtime-event-base-metadata.json',
        ),
        [],
      );

      await writeJson(
        path.join(workspace.root, 'packages/alpha/content/pack.json'),
        {
          metadata: { id: 'alpha-pack', version: '1.0.0' },
          achievements: [
            { reward: { kind: 'emitEvent', eventId: 'alpha:event' } },
            { reward: { kind: 'emitEvent', eventId: '' } },
            { reward: { kind: 'emitEvent', eventId: 123 } },
            { onUnlockEvents: ['alpha:unlock', '', null, 'alpha:event'] },
          ],
        },
      );

      const manifest = await buildRuntimeEventManifest({ rootDirectory: workspace.root });
      const types = manifest.manifestDefinitions.map((entry) => entry.type);

      expect(types).toContain('alpha:event');
      expect(types).toContain('alpha:unlock');
      expect(types.filter((entry) => entry === 'alpha:event')).toHaveLength(1);
    } finally {
      await workspace.cleanup();
    }
  });

  it('returns schema options even when no content packs are present', async () => {
    const workspace = await createWorkspace();
    try {
      await fs.rm(path.join(workspace.root, 'packages'), { recursive: true, force: true });

      const result = await validateContentPacks([], {
        rootDirectory: workspace.root,
      });

      expect(result.schemaOptions.knownPacks).toEqual([]);
      expect(result.schemaOptions.activePackIds).toEqual([]);
      expect(result.schemaOptions.runtimeEventCatalogue).toEqual([]);
    } finally {
      await workspace.cleanup();
    }
  });

  it('reports unreadable content packs as validation failures', async () => {
    const workspace = await createWorkspace();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await writeText(
        path.join(workspace.root, 'packages/broken-pack/content/pack.json'),
        '{',
      );

      await expect(
        validateContentPacks([], { rootDirectory: workspace.root }),
      ).rejects.toBeInstanceOf(ContentPackValidationError);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      await workspace.cleanup();
    }
  });

  it('extracts known pack dependencies and parses JSON5 documents before validation fails', async () => {
    const workspace = await createWorkspace();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await writeJson(
        path.join(workspace.root, 'packages/no-metadata/content/pack.json'),
        {},
      );

      await writeJson(
        path.join(workspace.root, 'packages/invalid-id/content/pack.json'),
        { metadata: { id: 123, version: '1.0.0' } },
      );

      await writeText(
        path.join(workspace.root, 'packages/known-pack/content/pack.json5'),
        `{\n  // JSON5 file to exercise JSON5 parsing\n  metadata: {\n    id: 'known-pack',\n    version: '1.0.0',\n    dependencies: {\n      requires: [\n        { packId: 'dep-a', version: '2.0.0' },\n        null,\n        { packId: 'dep-b' },\n        { packId: 123 },\n      ],\n    },\n  },\n}\n`,
      );

      await writeJson(
        path.join(workspace.root, 'packages/empty-requires/content/pack.json'),
        {
          metadata: {
            id: 'empty-requires',
            version: '1.0.0',
            dependencies: { requires: [{ packId: 123 }] },
          },
        },
      );

      await expect(
        validateContentPacks([], { rootDirectory: workspace.root }),
      ).rejects.toBeInstanceOf(ContentPackValidationError);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      await workspace.cleanup();
    }
  });
});
