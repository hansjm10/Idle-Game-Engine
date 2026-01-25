import { describe, expect, it, vi } from 'vitest';

const spawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn,
}));

describe('loadContentCompiler default spawnProcess', () => {
  it('uses the default spawnProcess when dependencies omit spawnProcess', async () => {
    spawn.mockImplementation(() => ({
      on: (event: string, handler: (arg: unknown) => void) => {
        if (event === 'exit') {
          handler(0);
        }
      },
    }));

    const compilerExports = { ready: true };
    const missingError = new Error(
      'Cannot find package "@idle-engine/content-compiler"',
    );
    (missingError as Error & { code: string }).code = 'ERR_MODULE_NOT_FOUND';

    const importCompiler = vi
      .fn()
      .mockRejectedValueOnce(missingError)
      .mockResolvedValueOnce(compilerExports);

    const { loadContentCompiler } = await import('./content-compiler.js');

    const result = await loadContentCompiler({
      projectRoot: '/tmp/workspace',
      dependencies: { importCompiler },
    });

    expect(result).toBe(compilerExports);
    expect(spawn).toHaveBeenCalledWith(
      'pnpm',
      ['--filter', '@idle-engine/content-compiler', 'run', 'build'],
      expect.objectContaining({ cwd: '/tmp/workspace', stdio: 'inherit' }),
    );
  });

  it('surfaces spawn errors from the default spawnProcess', async () => {
    const spawnError = new Error('ENOENT: pnpm not found');
    spawn.mockImplementation(() => ({
      on: (event: string, handler: (arg: unknown) => void) => {
        if (event === 'error') {
          handler(spawnError);
        }
      },
    }));

    const missingError = new Error(
      'Cannot find package "@idle-engine/content-compiler"',
    );
    (missingError as Error & { code: string }).code = 'ERR_MODULE_NOT_FOUND';

    const importCompiler = vi.fn().mockRejectedValue(missingError);

    const { loadContentCompiler } = await import('./content-compiler.js');

    await expect(
      loadContentCompiler({
        projectRoot: '/tmp/workspace',
        dependencies: { importCompiler },
      }),
    ).rejects.toBe(spawnError);
  });
});

