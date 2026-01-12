import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceCompileResult } from '@idle-engine/content-compiler';

import { ContentPackValidationError } from './generate.js';
import {
  ensureCoreDistRuntimeEventManifest,
  executeCompilePipeline,
  spawnProcess,
} from './compile-pipeline.js';

const EMPTY_COMPILE_RESULT: WorkspaceCompileResult = {
  packs: [],
  artifacts: { operations: [] },
  summary: { packs: [] },
  summaryPath: 'content/compiled/index.json',
  summaryAction: 'unchanged',
  hasDrift: false,
};

describe('executeCompilePipeline', () => {
  it('marks drift when core dist would rebuild in check mode', async () => {
    const buildRuntimeEventManifest = vi.fn().mockResolvedValue({
      manifestDefinitions: [],
      moduleSource: 'module source',
      manifestHash: 'deadbeef',
    });
    const validateContentPacks = vi.fn().mockResolvedValue({
      schemaOptions: {},
    });
    const writeRuntimeEventManifest = vi
      .fn()
      .mockResolvedValue({ action: 'written', path: 'manifest.js' });
    const ensureCoreDistRuntimeEventManifest = vi.fn().mockResolvedValue({
      action: 'would-build',
      path: 'packages/core/dist/events/runtime-event-manifest.generated.js',
      expectedHash: 'deadbeef',
    });
    const compileWorkspacePacks = vi
      .fn()
      .mockResolvedValue(EMPTY_COMPILE_RESULT);
    const logger = vi.fn();
    const onManifestResult = vi.fn();
    const onCoreDistManifestResult = vi.fn();

    const outcome = await executeCompilePipeline({
      options: {
        check: true,
        clean: false,
        pretty: false,
        summary: undefined,
      },
      workspaceRoot: '/workspace',
      logger,
      compileWorkspacePacks,
      callbacks: {
        onManifestResult,
        onCoreDistManifestResult,
      },
      dependencies: {
        buildRuntimeEventManifest,
        validateContentPacks,
        writeRuntimeEventManifest,
        ensureCoreDistRuntimeEventManifest,
        now: () => new Date('2024-01-01T00:00:00.000Z'),
      },
    });

    expect(outcome.success).toBe(false);
    expect(outcome.drift).toBe(true);
    expect(outcome.runSummary?.manifestAction).toBe('written');
    expect(compileWorkspacePacks).toHaveBeenCalledWith(
      { rootDirectory: '/workspace' },
      {
        check: true,
        clean: false,
        schema: {},
        summaryOutputPath: undefined,
      },
    );
    expect(onManifestResult).toHaveBeenCalledWith({
      action: 'written',
      path: 'manifest.js',
    });
    expect(onCoreDistManifestResult).toHaveBeenCalledWith({
      action: 'would-build',
      path: 'packages/core/dist/events/runtime-event-manifest.generated.js',
      expectedHash: 'deadbeef',
    });
  });

  it('returns a validation failure summary without logging unhandled errors', async () => {
    const buildRuntimeEventManifest = vi.fn().mockResolvedValue({
      manifestDefinitions: [],
      moduleSource: 'module source',
      manifestHash: 'deadbeef',
    });
    const validateContentPacks = vi.fn().mockRejectedValue(
      new ContentPackValidationError('invalid', {
        failures: [
          {
            packSlug: 'alpha',
            path: 'packages/alpha-pack/content/alpha.json',
            message: 'Invalid content',
          },
        ],
      }),
    );
    const persistValidationFailureSummary = vi
      .fn()
      .mockResolvedValue({ action: 'would-write', path: 'summary.json' });
    const compileWorkspacePacks = vi.fn();
    const logger = vi.fn();
    const onUnhandledError = vi.fn();

    const outcome = await executeCompilePipeline({
      options: {
        check: true,
        clean: false,
        pretty: false,
        summary: undefined,
      },
      workspaceRoot: '/workspace',
      logger,
      compileWorkspacePacks,
      callbacks: {
        onUnhandledError,
      },
      dependencies: {
        buildRuntimeEventManifest,
        validateContentPacks,
        persistValidationFailureSummary,
      },
    });

    expect(outcome.success).toBe(false);
    expect(outcome.drift).toBe(true);
    expect(outcome.runSummary?.failedPacks).toEqual(['alpha']);
    expect(outcome.runSummary?.summaryAction).toBe('would-write');
    expect(compileWorkspacePacks).not.toHaveBeenCalled();
    expect(persistValidationFailureSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        rootDirectory: '/workspace',
        clean: false,
      }),
    );
    expect(onUnhandledError).not.toHaveBeenCalled();
  });

  it('persists validation failure summaries deterministically', async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'idle-engine-content-validation-cli-'),
    );

    try {
      const buildRuntimeEventManifest = vi.fn().mockResolvedValue({
        manifestDefinitions: [],
        moduleSource: 'module source',
        manifestHash: 'deadbeef',
      });
      const validateContentPacks = vi.fn().mockRejectedValue(
        new ContentPackValidationError('invalid', {
          failures: [
            {
              packSlug: 'alpha',
              path: 'packages/alpha-pack/content/alpha.json',
              message: 'Invalid content',
            },
          ],
        }),
      );
      const compileWorkspacePacks = vi.fn();
      const logger = vi.fn();
      const onUnhandledError = vi.fn();

      const runOnce = async ({ clean }: { clean: boolean }) =>
        executeCompilePipeline({
          options: {
            check: true,
            clean,
            pretty: false,
            summary: undefined,
          },
          workspaceRoot,
          logger,
          compileWorkspacePacks,
          callbacks: {
            onUnhandledError,
          },
          dependencies: {
            buildRuntimeEventManifest,
            validateContentPacks,
          },
        });

      const first = await runOnce({ clean: false });
      expect(first.success).toBe(false);
      expect(first.drift).toBe(true);
      expect(first.runSummary?.summaryAction).toBe('written');

      const summaryPath = path.join(
        workspaceRoot,
        'content',
        'compiled',
        'index.json',
      );
      const summaryRaw = await fs.readFile(summaryPath, 'utf8');
      const summary = JSON.parse(summaryRaw) as { packs?: Array<{ slug?: string; status?: string }> };
      expect(summary.packs?.[0]).toMatchObject({ slug: 'alpha', status: 'failed' });

      const second = await runOnce({ clean: false });
      expect(second.drift).toBe(false);
      expect(second.runSummary?.summaryAction).toBe('unchanged');

      const third = await runOnce({ clean: true });
      expect(third.drift).toBe(true);
      expect(third.runSummary?.summaryAction).toBe('written');

      expect(compileWorkspacePacks).not.toHaveBeenCalled();
      expect(onUnhandledError).not.toHaveBeenCalled();
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('reports unhandled errors before returning failure', async () => {
    const error = new Error('boom');
    const buildRuntimeEventManifest = vi.fn().mockRejectedValue(error);
    const compileWorkspacePacks = vi.fn();
    const logger = vi.fn();
    const onUnhandledError = vi.fn();

    const outcome = await executeCompilePipeline({
      options: {
        check: false,
        clean: false,
        pretty: false,
        summary: undefined,
      },
      workspaceRoot: '/workspace',
      logger,
      compileWorkspacePacks,
      callbacks: {
        onUnhandledError,
      },
      dependencies: {
        buildRuntimeEventManifest,
      },
    });

    expect(outcome).toEqual({
      success: false,
      drift: false,
      runSummary: undefined,
    });
    expect(onUnhandledError).toHaveBeenCalledWith(error);
  });
});

describe('ensureCoreDistRuntimeEventManifest', () => {
  it('skips when core package.json is missing', async () => {
    const missing = new Error('missing') as NodeJS.ErrnoException;
    missing.code = 'ENOENT';
    const access = vi.fn().mockRejectedValue(missing);

    const result = await ensureCoreDistRuntimeEventManifest({
      rootDirectory: '/workspace',
      expectedHash: 'deadbeef',
      check: true,
      io: {
        access,
        readFile: vi.fn(),
        spawnProcess: vi.fn(),
        env: {},
      },
    });

    expect(result).toEqual({
      action: 'skipped',
      path: 'packages/core/dist/events/runtime-event-manifest.generated.js',
      expectedHash: 'deadbeef',
      actualHash: undefined,
      reason: 'missing core package.json',
    });
  });

  it('skips when the core dist manifest is missing in check mode', async () => {
    const missing = new Error('missing') as NodeJS.ErrnoException;
    missing.code = 'ENOENT';

    const result = await ensureCoreDistRuntimeEventManifest({
      rootDirectory: '/workspace',
      expectedHash: 'deadbeef',
      check: true,
      io: {
        access: vi.fn().mockResolvedValue(undefined),
        readFile: vi.fn().mockRejectedValue(missing),
        spawnProcess: vi.fn(),
        env: {},
      },
    });

    expect(result).toEqual({
      action: 'skipped',
      path: 'packages/core/dist/events/runtime-event-manifest.generated.js',
      expectedHash: 'deadbeef',
      actualHash: undefined,
      reason: 'missing core dist runtime event manifest',
    });
  });

  it('rethrows unexpected read errors for the core dist manifest', async () => {
    const readError = new Error('nope') as NodeJS.ErrnoException;
    readError.code = 'EACCES';

    await expect(
      ensureCoreDistRuntimeEventManifest({
        rootDirectory: '/workspace',
        expectedHash: 'deadbeef',
        check: true,
        io: {
          access: vi.fn().mockResolvedValue(undefined),
          readFile: vi.fn().mockRejectedValue(readError),
          spawnProcess: vi.fn(),
          env: {},
        },
      }),
    ).rejects.toBe(readError);
  });

  it('builds when hashes differ in write mode', async () => {
    const readFile = vi
      .fn()
      .mockResolvedValueOnce("export const manifest = { hash: 'aaaa1111' }")
      .mockResolvedValueOnce("export const manifest = { hash: 'deadbeef' }");
    const spawnProcess = vi.fn().mockResolvedValue({
      code: 0,
      stdout: '',
      stderr: '',
    });

    const result = await ensureCoreDistRuntimeEventManifest({
      rootDirectory: '/workspace',
      expectedHash: 'deadbeef',
      check: false,
      io: {
        access: vi.fn().mockResolvedValue(undefined),
        readFile,
        spawnProcess,
        env: {},
      },
    });

    expect(result).toEqual({
      action: 'built',
      path: 'packages/core/dist/events/runtime-event-manifest.generated.js',
      expectedHash: 'deadbeef',
      actualHash: 'deadbeef',
    });
    expect(spawnProcess).toHaveBeenCalledTimes(1);
  });
});

describe('spawnProcess', () => {
  it('captures stdout/stderr and exit code', async () => {
    const result = await spawnProcess(
      'node',
      [
        '-e',
        "process.stdout.write('hello'); process.stderr.write('world');",
      ],
      { cwd: process.cwd(), env: process.env },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('hello');
    expect(result.stderr).toContain('world');
  });
});
