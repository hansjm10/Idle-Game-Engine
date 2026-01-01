import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceCompileResult } from '@idle-engine/content-compiler';

import { ContentPackValidationError } from './generate.js';
import {
  ensureCoreDistRuntimeEventManifest,
  executeCompilePipeline,
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
