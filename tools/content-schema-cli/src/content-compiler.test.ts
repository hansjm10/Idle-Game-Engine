import { describe, expect, it, vi } from 'vitest';

import { loadContentCompiler } from './content-compiler.js';

describe('loadContentCompiler', () => {
  it('returns compiler exports when initial import succeeds', async () => {
    const compilerExports = { ok: true };
    const importCompiler = vi.fn().mockResolvedValue(compilerExports);
    const buildCompiler = vi.fn().mockResolvedValue(undefined);

    const result = await loadContentCompiler({
      buildCompiler,
      importCompiler,
      projectRoot: '/tmp/workspace',
    });

    expect(result).toBe(compilerExports);
    expect(importCompiler).toHaveBeenCalledTimes(1);
    expect(buildCompiler).not.toHaveBeenCalled();
  });

  it('builds the compiler once when import fails with module not found', async () => {
    const compilerExports = { ready: true };
    const missingError = new Error(
      'Cannot find package "@idle-engine/content-compiler"',
    );
    // @ts-expect-error - annotate code used in Node module errors.
    missingError.code = 'ERR_MODULE_NOT_FOUND';

    const importCompiler = vi
      .fn()
      .mockRejectedValueOnce(missingError)
      .mockResolvedValueOnce(compilerExports);
    const buildCompiler = vi.fn().mockResolvedValue(undefined);

    const result = await loadContentCompiler({
      buildCompiler,
      importCompiler,
      projectRoot: '/tmp/workspace',
    });

    expect(buildCompiler).toHaveBeenCalledTimes(1);
    expect(buildCompiler).toHaveBeenCalledWith({ projectRoot: '/tmp/workspace' });
    expect(importCompiler).toHaveBeenCalledTimes(2);
    expect(result).toBe(compilerExports);
  });

  it('rethrows errors unrelated to missing compiler module', async () => {
    const boom = new Error('boom');
    const importCompiler = vi.fn().mockRejectedValue(boom);
    const buildCompiler = vi.fn();

    await expect(
      loadContentCompiler({
        buildCompiler,
        importCompiler,
      }),
    ).rejects.toBe(boom);

    expect(buildCompiler).not.toHaveBeenCalled();
  });
});
