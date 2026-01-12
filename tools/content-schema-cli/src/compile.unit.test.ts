import chokidar from 'chokidar';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { FSWatcher } from 'chokidar';

import type { CoreDistManifestResult } from './compile-pipeline.js';
import type { CliOptions, PipelineOutcome, RunSummary } from './compile-utils.js';
import {
  emitRunSummaryEvent,
  emitWatchRunEvent,
  formatMonitorLog,
  formatWatchHintLog,
  logCoreDistRuntimeManifestResult,
  logManifestResult,
  logUnhandledCliError,
  parseCliArgs,
  startWatch,
} from './compile.js';

describe('compile CLI helpers', () => {
  it('parses boolean flags, --cwd, and --summary', () => {
    const options = parseCliArgs([
      '--check',
      '--clean',
      '--pretty',
      '--watch',
      '--cwd',
      'workspace',
      '--summary=content/compiled/custom.json',
    ]);

    expect(options).toEqual({
      check: true,
      clean: true,
      pretty: true,
      watch: true,
      cwd: path.resolve(process.cwd(), 'workspace'),
      summary: 'content/compiled/custom.json',
    });
  });

  it('throws on unknown CLI options', () => {
    expect(() => parseCliArgs(['--unknown'])).toThrowError(
      'Unknown option: --unknown',
    );
  });

  it('throws when required value flags are missing values', () => {
    expect(() => parseCliArgs(['--cwd'])).toThrowError('Missing value for --cwd');
    expect(() => parseCliArgs(['--summary'])).toThrowError(
      'Missing value for --summary',
    );
  });

  it('formats watch log payloads with stable keys', () => {
    const statusLog = JSON.parse(
      formatMonitorLog('Watching', false, '/workspace'),
    ) as Record<string, unknown>;
    expect(statusLog).toMatchObject({
      event: 'watch.status',
      message: 'Watching',
      rootDirectory: '/workspace',
    });
    expect(statusLog.timestamp).toBeTypeOf('string');

    const hintLog = JSON.parse(formatWatchHintLog(false)) as Record<
      string,
      unknown
    >;
    expect(hintLog).toMatchObject({
      event: 'watch.hint',
      exit: 'CTRL+C',
    });
    expect(hintLog.timestamp).toBeTypeOf('string');
  });

  it('logs manifest events using consistent event suffixes', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    logManifestResult(
      { action: 'would-write', path: 'packages/core/src/events/runtime-event-manifest.generated.ts' },
      { pretty: false, check: true },
    );

    expect(logSpy).toHaveBeenCalledTimes(1);
    const driftPayload = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as Record<
      string,
      unknown
    >;
    expect(driftPayload).toMatchObject({
      event: 'runtime_manifest.drift',
      action: 'would-write',
      check: true,
    });

    logSpy.mockRestore();
  });

  it('logs core dist manifest results, including optional metadata', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result: CoreDistManifestResult = {
      action: 'would-build',
      path: 'packages/core/dist/events/runtime-event-manifest.generated.js',
      expectedHash: 'deadbeef',
      actualHash: 'aaaa1111',
      reason: 'stale manifest',
    };

    logCoreDistRuntimeManifestResult(result, { pretty: false, check: true });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({
      event: 'runtime_manifest.core_dist.drift',
      action: 'would-build',
      check: true,
      expectedHash: 'deadbeef',
      actualHash: 'aaaa1111',
      reason: 'stale manifest',
    });

    logSpy.mockRestore();
  });

  it('normalizes and logs unhandled errors without throwing', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    logUnhandledCliError('boom', { pretty: false });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(errorSpy.mock.calls[0]?.[0] as string) as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({
      event: 'cli.unhandled_error',
      fatal: true,
      message: 'boom',
    });

    errorSpy.mockRestore();
  });

  it('emits cli.run_summary and watch.run events with stable shapes', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const runSummary: RunSummary = {
      packTotals: { total: 2, compiled: 1, failed: 1, withWarnings: 0 },
      artifactActions: {
        total: 3,
        changed: 1,
        byAction: { written: 1, unchanged: 2 },
      },
      changedPacks: ['alpha'],
      failedPacks: ['beta'],
      hasChanges: true,
      summaryAction: 'written',
      manifestAction: 'written',
    };

    const outcome: PipelineOutcome = {
      success: true,
      drift: false,
      runSummary,
    };

    emitRunSummaryEvent({
      outcome,
      pretty: false,
      durationMs: 12.3456,
      mode: 'single',
    });

    emitWatchRunEvent({
      outcome,
      durationMs: 12.3456,
      pretty: false,
      iteration: 3,
      triggers: [
        { event: 'change', path: 'packages/alpha/content/pack.json' },
        { event: 'unlink', path: 'packages/beta/content/pack.json' },
      ],
    });

    expect(logSpy).toHaveBeenCalledTimes(2);

    const summaryPayload = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as Record<
      string,
      unknown
    >;
    expect(summaryPayload).toMatchObject({
      event: 'cli.run_summary',
      success: true,
      drift: false,
      durationMs: 12.35,
      mode: 'single',
    });

    const watchPayload = JSON.parse(logSpy.mock.calls[1]?.[0] as string) as Record<
      string,
      unknown
    >;
    expect(watchPayload).toMatchObject({
      event: 'watch.run',
      status: 'success',
      iteration: 3,
      durationMs: 12.35,
    });

    logSpy.mockRestore();
  });

  it('debounces watch triggers and invokes execute with aggregated triggers', async () => {
    vi.useFakeTimers();

    const onMock = vi.fn();
    const watcher = {
      on: onMock,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as FSWatcher;

    const watchSpy = vi.spyOn(chokidar, 'watch').mockReturnValue(watcher);
    const onSpy = vi
      .spyOn(process, 'on')
      .mockImplementation((() => process) as typeof process.on);

    const outcome: PipelineOutcome = {
      success: true,
      drift: false,
      runSummary: undefined,
    };
    const execute = vi.fn().mockResolvedValue(outcome);

    await startWatch(
      {
        check: false,
        clean: false,
        pretty: false,
        watch: true,
        summary: undefined,
        cwd: undefined,
      } satisfies CliOptions,
      execute,
      '/workspace',
    );

    const allHandler = onMock.mock.calls.find(
      (entry) => entry[0] === 'all',
    )?.[1] as ((eventName: string, targetPath: string) => void) | undefined;
    expect(allHandler).toBeTypeOf('function');

    allHandler?.('add', 'packages/alpha/content/pack.json');
    allHandler?.('change', 'packages/beta/content/pack.json');
    allHandler?.('unlinkDir', 'packages/ignored');

    await vi.advanceTimersByTimeAsync(200);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({
      mode: 'watch',
      iteration: 1,
      triggers: [
        { event: 'add', path: 'packages/alpha/content/pack.json' },
        { event: 'change', path: 'packages/beta/content/pack.json' },
      ],
    });

    onSpy.mockRestore();
    watchSpy.mockRestore();
    vi.useRealTimers();
  });

  it('queues watch runs while execute is still in-flight', async () => {
    vi.useFakeTimers();

    const onMock = vi.fn();
    const watcher = {
      on: onMock,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as FSWatcher;
    const watchSpy = vi.spyOn(chokidar, 'watch').mockReturnValue(watcher);
    const onSpy = vi
      .spyOn(process, 'on')
      .mockImplementation((() => process) as typeof process.on);

    const outcome: PipelineOutcome = {
      success: true,
      drift: false,
      runSummary: undefined,
    };

    let resolveFirst: ((value: PipelineOutcome) => void) | undefined;
    const firstRun = new Promise<PipelineOutcome>((resolve) => {
      resolveFirst = resolve;
    });

    const execute = vi
      .fn()
      .mockReturnValueOnce(firstRun)
      .mockResolvedValueOnce(outcome);

    await startWatch(
      {
        check: false,
        clean: false,
        pretty: false,
        watch: true,
        summary: undefined,
        cwd: undefined,
      } satisfies CliOptions,
      execute,
      '/workspace',
    );

    const allHandler = onMock.mock.calls.find(
      (entry) => entry[0] === 'all',
    )?.[1] as ((eventName: string, targetPath: string) => void) | undefined;
    expect(allHandler).toBeTypeOf('function');

    allHandler?.('change', 'packages/alpha/content/pack.json');
    await vi.advanceTimersByTimeAsync(200);

    expect(execute).toHaveBeenCalledTimes(1);

    allHandler?.('change', 'packages/alpha/content/pack.json');
    await vi.advanceTimersByTimeAsync(200);

    expect(execute).toHaveBeenCalledTimes(1);

    resolveFirst?.(outcome);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(200);

    expect(execute).toHaveBeenCalledTimes(2);

    onSpy.mockRestore();
    watchSpy.mockRestore();
    vi.useRealTimers();
  });
});
