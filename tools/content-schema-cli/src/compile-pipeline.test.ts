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

  it('emits pack result events and summarizes changed packs', async () => {
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
      action: 'unchanged',
      path: 'packages/core/dist/events/runtime-event-manifest.generated.js',
      expectedHash: 'deadbeef',
      actualHash: 'deadbeef',
    });

    const compileWorkspacePacks = vi.fn().mockResolvedValue({
      packs: [
        {
          status: 'compiled',
          packSlug: 'alpha',
          document: { relativePath: 'packages/alpha/content/pack.json' },
          durationMs: 10,
          warnings: [],
          balanceWarnings: [],
          balanceErrors: [],
        },
        {
          status: 'compiled',
          packSlug: 'beta',
          document: { relativePath: 'packages/beta/content/pack.json' },
          durationMs: 12,
          warnings: [{ code: 'warning' }],
          balanceWarnings: [],
          balanceErrors: [],
        },
        {
          status: 'failed',
          packSlug: 'gamma',
          document: { relativePath: 'packages/gamma/content/pack.json' },
          durationMs: 14,
          warnings: [],
          balanceWarnings: [],
          balanceErrors: [{ code: 'balance.error' }],
          error: new Error('compile failed'),
        },
      ],
      artifacts: {
        operations: [
          { slug: 'alpha', kind: 'json', path: 'content/compiled/alpha.json', action: 'unchanged' },
          { slug: 'beta', kind: 'json', path: 'content/compiled/beta.json', action: 'would-delete' },
          { slug: 'beta', kind: 'module', path: 'content/compiled/beta.mjs', action: 'written' },
          { slug: 'orphan', kind: 'json', path: 'content/compiled/orphan.json', action: 'deleted' },
        ],
      },
      summary: { packs: [] },
      summaryPath: 'content/compiled/index.json',
      summaryAction: 'would-write',
      hasDrift: false,
    } as unknown as WorkspaceCompileResult);

    const logger = vi.fn();

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
      dependencies: {
        buildRuntimeEventManifest,
        validateContentPacks,
        writeRuntimeEventManifest,
        ensureCoreDistRuntimeEventManifest,
        now: () => new Date('2024-01-01T00:00:00.000Z'),
      },
    });

    expect(outcome.drift).toBe(false);
    expect(outcome.runSummary?.changedPacks).toEqual(['beta', 'orphan']);
    expect(outcome.runSummary?.failedPacks).toEqual(['gamma']);
    expect(outcome.runSummary?.hasChanges).toBe(true);

    const names = logger.mock.calls.map((call) => (call[0] as { name?: string }).name);
    expect(names).toContain('content_pack.skipped');
    expect(names).toContain('content_pack.compiled');
    expect(names).toContain('content_pack.compilation_failed');
    expect(names.filter((name) => name === 'content_pack.pruned')).toHaveLength(2);
  });

  it('reports persist failures when validation summary persistence fails', async () => {
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
    const persistError = new Error('persist failed');
    const persistValidationFailureSummary = vi.fn().mockRejectedValue(persistError);
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

    expect(outcome).toEqual({
      success: false,
      drift: false,
      runSummary: undefined,
    });
    expect(onUnhandledError).toHaveBeenCalledWith(persistError);
  });

  it('reports unknown errors from the pipeline as unhandled', async () => {
    const buildRuntimeEventManifest = vi.fn().mockResolvedValue({
      manifestDefinitions: [],
      moduleSource: 'module source',
      manifestHash: 'deadbeef',
    });
    const validateContentPacks = vi.fn().mockRejectedValue(new Error('boom'));
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
        validateContentPacks,
      },
    });

    expect(outcome).toEqual({
      success: false,
      drift: false,
      runSummary: undefined,
    });
    expect(onUnhandledError).toHaveBeenCalledWith(expect.any(Error));
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

  it('rethrows unexpected access errors for core package.json', async () => {
    const accessError = new Error('nope') as NodeJS.ErrnoException;
    accessError.code = 'EACCES';

    await expect(
      ensureCoreDistRuntimeEventManifest({
        rootDirectory: '/workspace',
        expectedHash: 'deadbeef',
        check: true,
        io: {
          access: vi.fn().mockRejectedValue(accessError),
          readFile: vi.fn(),
          spawnProcess: vi.fn(),
          env: {},
        },
      }),
    ).rejects.toBe(accessError);
  });

  it('returns unchanged when hashes match (default IO)', async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'idle-engine-core-dist-manifest-'),
    );

    try {
      await fs.mkdir(path.join(workspaceRoot, 'packages/core/dist/events'), {
        recursive: true,
      });
      await fs.mkdir(path.join(workspaceRoot, 'packages/core'), { recursive: true });
      await fs.writeFile(
        path.join(workspaceRoot, 'packages/core/package.json'),
        JSON.stringify({ name: '@idle-engine/core' }),
        'utf8',
      );
      await fs.writeFile(
        path.join(
          workspaceRoot,
          'packages/core/dist/events/runtime-event-manifest.generated.js',
        ),
        "export const GENERATED_RUNTIME_EVENT_MANIFEST = { hash: 'deadbeef' };\n",
        'utf8',
      );

      const result = await ensureCoreDistRuntimeEventManifest({
        rootDirectory: workspaceRoot,
        expectedHash: 'deadbeef',
        check: true,
      });

      expect(result).toEqual({
        action: 'unchanged',
        path: 'packages/core/dist/events/runtime-event-manifest.generated.js',
        expectedHash: 'deadbeef',
        actualHash: 'deadbeef',
      });
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('reports drift when hashes differ in check mode', async () => {
    const readFile = vi
      .fn()
      .mockResolvedValueOnce("export const manifest = { hash: 'aaaa1111' }");

    const result = await ensureCoreDistRuntimeEventManifest({
      rootDirectory: '/workspace',
      expectedHash: 'deadbeef',
      check: true,
      io: {
        access: vi.fn().mockResolvedValue(undefined),
        readFile,
        spawnProcess: vi.fn(),
        env: {},
      },
    });

    expect(result).toEqual({
      action: 'would-build',
      path: 'packages/core/dist/events/runtime-event-manifest.generated.js',
      expectedHash: 'deadbeef',
      actualHash: 'aaaa1111',
    });
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

  it('throws when core build fails', async () => {
    const readFile = vi.fn().mockResolvedValueOnce(
      "export const manifest = { hash: 'aaaa1111' }",
    );
    const spawnProcess = vi.fn().mockResolvedValue({
      code: 1,
      stdout: 'stdout',
      stderr: 'stderr',
    });

    await expect(
      ensureCoreDistRuntimeEventManifest({
        rootDirectory: '/workspace',
        expectedHash: 'deadbeef',
        check: false,
        io: {
          access: vi.fn().mockResolvedValue(undefined),
          readFile,
          spawnProcess,
          env: {},
        },
      }),
    ).rejects.toThrow('Failed to rebuild @idle-engine/core');
  });

  it('throws when rebuild succeeds but manifest hash does not update', async () => {
    const readFile = vi
      .fn()
      .mockResolvedValueOnce("export const manifest = { hash: 'aaaa1111' }")
      .mockResolvedValueOnce("export const manifest = { hash: 'bbbb2222' }");
    const spawnProcess = vi.fn().mockResolvedValue({
      code: 0,
      stdout: '',
      stderr: '',
    });

    await expect(
      ensureCoreDistRuntimeEventManifest({
        rootDirectory: '/workspace',
        expectedHash: 'deadbeef',
        check: false,
        io: {
          access: vi.fn().mockResolvedValue(undefined),
          readFile,
          spawnProcess,
          env: {},
        },
      }),
    ).rejects.toThrow('did not update as expected');
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
