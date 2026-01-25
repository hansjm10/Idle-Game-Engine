import chokidar from 'chokidar';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeCompilePipeline = vi.fn();
vi.mock('./compile-pipeline.js', () => ({
  executeCompilePipeline,
}));

const loadContentCompiler = vi.fn();
vi.mock('./content-compiler.js', () => ({
  loadContentCompiler,
}));

describe('run', () => {
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    process.argv = [...originalArgv];
    process.exitCode = originalExitCode;

    executeCompilePipeline.mockReset();
    loadContentCompiler.mockReset();
  });

  it('prints usage and exits 1 when CLI args are invalid', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    process.argv = ['node', '/tmp/vitest', '--unknown'];

    const { run } = await import('./compile.js');
    await run();

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalled();

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('rejects --watch combined with --check without loading the compiler', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    process.argv = ['node', '/tmp/vitest', '--watch', '--check'];

    const { run } = await import('./compile.js');
    await run();

    expect(process.exitCode).toBe(1);
    expect(loadContentCompiler).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it('sets exitCode=0 on success in single mode', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    loadContentCompiler.mockResolvedValue({
      compileWorkspacePacks: vi.fn(),
      createLogger: vi.fn().mockReturnValue(vi.fn()),
    });
    executeCompilePipeline.mockResolvedValue({
      success: true,
      drift: false,
      runSummary: undefined,
    });

    process.argv = ['node', '/tmp/vitest'];

    const { run } = await import('./compile.js');
    await run();

    expect(process.exitCode).toBe(0);
    expect(executeCompilePipeline).toHaveBeenCalledTimes(1);
    expect(loadContentCompiler).toHaveBeenCalledTimes(1);

    logSpy.mockRestore();
  });

  it('sets exitCode=1 when check-mode drift is detected', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    loadContentCompiler.mockResolvedValue({
      compileWorkspacePacks: vi.fn(),
      createLogger: vi.fn().mockReturnValue(vi.fn()),
    });
    executeCompilePipeline.mockResolvedValue({
      success: true,
      drift: true,
      runSummary: undefined,
    });

    process.argv = ['node', '/tmp/vitest', '--check'];

    const { run } = await import('./compile.js');
    await run();

    expect(process.exitCode).toBe(1);
    expect(executeCompilePipeline).toHaveBeenCalledTimes(1);

    logSpy.mockRestore();
  });

  it('logs watch startup and registers signal handlers in watch mode', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const onSpy = vi
      .spyOn(process, 'on')
      .mockImplementation((() => process) as typeof process.on);

    loadContentCompiler.mockResolvedValue({
      compileWorkspacePacks: vi.fn(),
      createLogger: vi.fn().mockReturnValue(vi.fn()),
    });
    executeCompilePipeline.mockResolvedValue({
      success: true,
      drift: false,
      runSummary: undefined,
    });

    const watcher = {
      on: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const watchSpy = vi.spyOn(chokidar, 'watch').mockReturnValue(watcher as never);

    process.argv = ['node', '/tmp/vitest', '--watch'];

    const { run } = await import('./compile.js');
    await run();

    expect(logSpy).toHaveBeenCalled();
    expect(onSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));

    watchSpy.mockRestore();
    onSpy.mockRestore();
    logSpy.mockRestore();
  });
});
