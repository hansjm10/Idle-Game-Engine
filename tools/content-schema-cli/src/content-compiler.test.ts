import { describe, expect, it, vi } from 'vitest';

import {
  buildContentCompiler,
  isModuleNotFoundError,
  loadContentCompiler,
} from './content-compiler.js';

// ============================================================================
// isModuleNotFoundError (pure function tests)
// ============================================================================

describe('isModuleNotFoundError', () => {
  const packageName = '@idle-engine/content-compiler';

  it('returns true for ERR_MODULE_NOT_FOUND with matching package', () => {
    const error = new Error(`Cannot find package "${packageName}"`);
    (error as Error & { code: string }).code = 'ERR_MODULE_NOT_FOUND';

    expect(isModuleNotFoundError(error, packageName)).toBe(true);
  });

  it('returns true for MODULE_NOT_FOUND with matching package (CommonJS)', () => {
    const error = new Error(`Cannot find module "${packageName}"`);
    (error as Error & { code: string }).code = 'MODULE_NOT_FOUND';

    expect(isModuleNotFoundError(error, packageName)).toBe(true);
  });

  it('returns false when error is null', () => {
    expect(isModuleNotFoundError(null, packageName)).toBe(false);
  });

  it('returns false when error is a primitive', () => {
    expect(isModuleNotFoundError('string error', packageName)).toBe(false);
    expect(isModuleNotFoundError(42, packageName)).toBe(false);
    expect(isModuleNotFoundError(undefined, packageName)).toBe(false);
  });

  it('returns false when error has wrong code', () => {
    const error = new Error(`Cannot find package "${packageName}"`);
    (error as Error & { code: string }).code = 'ENOENT';

    expect(isModuleNotFoundError(error, packageName)).toBe(false);
  });

  it('returns false when error has no code', () => {
    const error = new Error(`Cannot find package "${packageName}"`);

    expect(isModuleNotFoundError(error, packageName)).toBe(false);
  });

  it('returns false when package name does not match', () => {
    const error = new Error('Cannot find package "@some-other/package"');
    (error as Error & { code: string }).code = 'ERR_MODULE_NOT_FOUND';

    expect(isModuleNotFoundError(error, packageName)).toBe(false);
  });

  it('handles non-Error objects with code and message', () => {
    const error = {
      code: 'ERR_MODULE_NOT_FOUND',
      message: `Cannot find package "${packageName}"`,
    };

    expect(isModuleNotFoundError(error, packageName)).toBe(true);
  });

  it('converts non-Error objects to string for message check', () => {
    const error = {
      code: 'ERR_MODULE_NOT_FOUND',
      toString: () => `Error: Cannot find package "${packageName}"`,
    };

    expect(isModuleNotFoundError(error, packageName)).toBe(true);
  });

  it('falls back when custom toString throws', () => {
    const error = {
      code: 'ERR_MODULE_NOT_FOUND',
      toString: () => {
        throw new Error('boom');
      },
      value: packageName,
    };

    expect(isModuleNotFoundError(error, packageName)).toBe(true);
  });

  it('returns false when error cannot be stringified', () => {
    const error: Record<string, unknown> = {
      code: 'ERR_MODULE_NOT_FOUND',
    };
    error.self = error;

    expect(isModuleNotFoundError(error, packageName)).toBe(false);
  });
});

// ============================================================================
// buildContentCompiler
// ============================================================================

describe('buildContentCompiler', () => {
  it('resolves when spawn process exits with code 0', async () => {
    const spawnProcess = vi.fn().mockResolvedValue({ code: 0 });

    await buildContentCompiler({
      projectRoot: '/tmp/workspace',
      dependencies: { spawnProcess },
    });

    expect(spawnProcess).toHaveBeenCalledWith(
      'pnpm',
      ['--filter', '@idle-engine/content-compiler', 'run', 'build'],
      expect.objectContaining({
        cwd: '/tmp/workspace',
        stdio: 'inherit',
      }),
    );
  });

  it('rejects when spawn process exits with non-zero code', async () => {
    const spawnProcess = vi.fn().mockResolvedValue({ code: 1 });

    await expect(
      buildContentCompiler({
        projectRoot: '/tmp/workspace',
        dependencies: { spawnProcess },
      }),
    ).rejects.toThrow(
      'Failed to build @idle-engine/content-compiler before running content compilation (exit code 1).',
    );
  });

  it('rejects when spawn process returns an error', async () => {
    const spawnError = new Error('ENOENT: pnpm not found');
    const spawnProcess = vi.fn().mockResolvedValue({ code: null, error: spawnError });

    await expect(
      buildContentCompiler({
        projectRoot: '/tmp/workspace',
        dependencies: { spawnProcess },
      }),
    ).rejects.toBe(spawnError);
  });

  it('uses custom package name when provided', async () => {
    const spawnProcess = vi.fn().mockResolvedValue({ code: 0 });

    await buildContentCompiler({
      projectRoot: '/tmp/workspace',
      packageName: '@custom/package',
      dependencies: { spawnProcess },
    });

    expect(spawnProcess).toHaveBeenCalledWith(
      'pnpm',
      ['--filter', '@custom/package', 'run', 'build'],
      expect.any(Object),
    );
  });

  it('uses custom stdio when provided', async () => {
    const spawnProcess = vi.fn().mockResolvedValue({ code: 0 });

    await buildContentCompiler({
      projectRoot: '/tmp/workspace',
      stdio: 'pipe',
      dependencies: { spawnProcess },
    });

    expect(spawnProcess).toHaveBeenCalledWith(
      'pnpm',
      expect.any(Array),
      expect.objectContaining({ stdio: 'pipe' }),
    );
  });

  it('uses custom env when provided', async () => {
    const spawnProcess = vi.fn().mockResolvedValue({ code: 0 });
    const customEnv = { PATH: '/custom/path', NODE_ENV: 'test' };

    await buildContentCompiler({
      projectRoot: '/tmp/workspace',
      env: customEnv,
      dependencies: { spawnProcess },
    });

    expect(spawnProcess).toHaveBeenCalledWith(
      'pnpm',
      expect.any(Array),
      expect.objectContaining({ env: customEnv }),
    );
  });

  it('includes exit code in error message', async () => {
    const spawnProcess = vi.fn().mockResolvedValue({ code: 127 });

    await expect(
      buildContentCompiler({
        projectRoot: '/tmp/workspace',
        dependencies: { spawnProcess },
      }),
    ).rejects.toThrow('exit code 127');
  });
});

// ============================================================================
// loadContentCompiler
// ============================================================================

describe('loadContentCompiler', () => {
  it('returns compiler exports when initial import succeeds', async () => {
    const compilerExports = { ok: true };
    const importCompiler = vi.fn().mockResolvedValue(compilerExports);
    const spawnProcess = vi.fn();

    const result = await loadContentCompiler({
      projectRoot: '/tmp/workspace',
      dependencies: { importCompiler, spawnProcess },
    });

    expect(result).toBe(compilerExports);
    expect(importCompiler).toHaveBeenCalledTimes(1);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('builds and retries when import fails with ERR_MODULE_NOT_FOUND', async () => {
    const compilerExports = { ready: true };
    const missingError = new Error(
      'Cannot find package "@idle-engine/content-compiler"',
    );
    (missingError as Error & { code: string }).code = 'ERR_MODULE_NOT_FOUND';

    const importCompiler = vi
      .fn()
      .mockRejectedValueOnce(missingError)
      .mockResolvedValueOnce(compilerExports);
    const spawnProcess = vi.fn().mockResolvedValue({ code: 0 });

    const result = await loadContentCompiler({
      projectRoot: '/tmp/workspace',
      dependencies: { importCompiler, spawnProcess },
    });

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(importCompiler).toHaveBeenCalledTimes(2);
    expect(result).toBe(compilerExports);
  });

  it('builds and retries when import fails with MODULE_NOT_FOUND', async () => {
    const compilerExports = { loaded: true };
    const missingError = new Error(
      'Cannot find module "@idle-engine/content-compiler"',
    );
    (missingError as Error & { code: string }).code = 'MODULE_NOT_FOUND';

    const importCompiler = vi
      .fn()
      .mockRejectedValueOnce(missingError)
      .mockResolvedValueOnce(compilerExports);
    const spawnProcess = vi.fn().mockResolvedValue({ code: 0 });

    const result = await loadContentCompiler({
      projectRoot: '/tmp/workspace',
      dependencies: { importCompiler, spawnProcess },
    });

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(result).toBe(compilerExports);
  });

  it('rethrows errors unrelated to missing compiler module', async () => {
    const boom = new Error('boom');
    const importCompiler = vi.fn().mockRejectedValue(boom);
    const spawnProcess = vi.fn();

    await expect(
      loadContentCompiler({
        dependencies: { importCompiler, spawnProcess },
      }),
    ).rejects.toBe(boom);

    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('attaches first error as cause when second import fails', async () => {
    const firstError = new Error(
      'Cannot find package "@idle-engine/content-compiler"',
    );
    (firstError as Error & { code: string }).code = 'ERR_MODULE_NOT_FOUND';

    const secondError = new Error('Still cannot load compiler');

    const importCompiler = vi
      .fn()
      .mockRejectedValueOnce(firstError)
      .mockRejectedValueOnce(secondError);
    const spawnProcess = vi.fn().mockResolvedValue({ code: 0 });

    await expect(
      loadContentCompiler({
        dependencies: { importCompiler, spawnProcess },
      }),
    ).rejects.toThrow('Still cannot load compiler');

    expect((secondError as Error & { cause?: unknown }).cause).toBe(firstError);
  });

  it('preserves existing cause when second import fails', async () => {
    const firstError = new Error(
      'Cannot find package "@idle-engine/content-compiler"',
    );
    (firstError as Error & { code: string }).code = 'ERR_MODULE_NOT_FOUND';

    const originalCause = new Error('original cause');
    const secondError = new Error('Still cannot load compiler', {
      cause: originalCause,
    });

    const importCompiler = vi
      .fn()
      .mockRejectedValueOnce(firstError)
      .mockRejectedValueOnce(secondError);
    const spawnProcess = vi.fn().mockResolvedValue({ code: 0 });

    await expect(
      loadContentCompiler({
        dependencies: { importCompiler, spawnProcess },
      }),
    ).rejects.toThrow('Still cannot load compiler');

    expect((secondError as Error & { cause?: unknown }).cause).toBe(originalCause);
  });

  it('does not attach cause when second error is not an Error instance', async () => {
    const firstError = new Error(
      'Cannot find package "@idle-engine/content-compiler"',
    );
    (firstError as Error & { code: string }).code = 'ERR_MODULE_NOT_FOUND';

    const stringError = 'string error';

    const importCompiler = vi
      .fn()
      .mockRejectedValueOnce(firstError)
      .mockRejectedValueOnce(stringError);
    const spawnProcess = vi.fn().mockResolvedValue({ code: 0 });

    await expect(
      loadContentCompiler({
        dependencies: { importCompiler, spawnProcess },
      }),
    ).rejects.toBe(stringError);
  });

  it('passes projectRoot to buildContentCompiler', async () => {
    const missingError = new Error(
      'Cannot find package "@idle-engine/content-compiler"',
    );
    (missingError as Error & { code: string }).code = 'ERR_MODULE_NOT_FOUND';

    const importCompiler = vi
      .fn()
      .mockRejectedValueOnce(missingError)
      .mockResolvedValueOnce({ built: true });
    const spawnProcess = vi.fn().mockResolvedValue({ code: 0 });

    await loadContentCompiler({
      projectRoot: '/custom/root',
      dependencies: { importCompiler, spawnProcess },
    });

    expect(spawnProcess).toHaveBeenCalledWith(
      'pnpm',
      expect.any(Array),
      expect.objectContaining({ cwd: '/custom/root' }),
    );
  });

  it('uses the default importer when no dependencies are provided', async () => {
    const result = await loadContentCompiler();

    expect(result).toHaveProperty('compileWorkspacePacks');
  }, 15000);
});
