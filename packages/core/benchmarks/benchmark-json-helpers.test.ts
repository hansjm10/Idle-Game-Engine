import * as childProcess from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertBenchmarkPayload,
  BENCHMARK_EVENT,
  BENCHMARK_SCHEMA_VERSION,
  computeStats,
  getEnvMetadata,
  ratio,
  resolveCommitSha,
  validateBenchmarkPayload,
} from './benchmark-json-helpers.mjs';

const ORIGINAL_ENV = { ...process.env };

const resetEnv = () => {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
};

afterEach(() => {
  resetEnv();
  vi.restoreAllMocks();
});

const createPayload = () => ({
  event: BENCHMARK_EVENT,
  schemaVersion: BENCHMARK_SCHEMA_VERSION,
  benchmark: {
    name: 'benchmark-json-helpers',
  },
  config: {},
  results: {},
  env: {
    nodeVersion: 'v20.0.0',
    platform: 'linux',
    arch: 'x64',
    commitSha: null,
  },
});

describe('computeStats', () => {
  it('returns null stats for empty samples', () => {
    expect(computeStats([])).toEqual({
      meanMs: null,
      medianMs: null,
      stdDevMs: null,
      minMs: null,
      maxMs: null,
      hz: null,
      samples: 0,
      unit: 'ms',
    });
  });

  it('computes single-sample medians', () => {
    const stats = computeStats([2]);

    expect(stats.meanMs).toBe(2);
    expect(stats.medianMs).toBe(2);
    expect(stats.stdDevMs).toBe(0);
    expect(stats.minMs).toBe(2);
    expect(stats.maxMs).toBe(2);
    expect(stats.hz).toBe(500);
    expect(stats.samples).toBe(1);
  });
});

describe('ratio', () => {
  it('returns null for non-finite inputs or zero denominators', () => {
    expect(ratio(Number.NaN, 1)).toBeNull();
    expect(ratio(Number.POSITIVE_INFINITY, 1)).toBeNull();
    expect(ratio(1, Number.POSITIVE_INFINITY)).toBeNull();
    expect(ratio(1, 0)).toBeNull();
  });
});

describe('resolveCommitSha', () => {
  it('prefers env vars in expected order', () => {
    const execSpy = vi
      .spyOn(childProcess, 'execSync')
      .mockImplementation(() => {
        throw new Error('execSync should not run');
      });

    process.env.GITHUB_SHA = 'github';
    process.env.CI_COMMIT_SHA = 'ci';
    process.env.COMMIT_SHA = 'commit';
    process.env.BUILD_VCS_NUMBER = 'build';

    expect(resolveCommitSha()).toBe('github');

    delete process.env.GITHUB_SHA;
    expect(resolveCommitSha()).toBe('ci');

    delete process.env.CI_COMMIT_SHA;
    expect(resolveCommitSha()).toBe('commit');

    delete process.env.COMMIT_SHA;
    expect(resolveCommitSha()).toBe('build');

    expect(execSpy).not.toHaveBeenCalled();
  });

  it('returns null when git rev-parse fails', () => {
    delete process.env.GITHUB_SHA;
    delete process.env.CI_COMMIT_SHA;
    delete process.env.COMMIT_SHA;
    delete process.env.BUILD_VCS_NUMBER;

    const execSpy = vi
      .spyOn(childProcess, 'execSync')
      .mockImplementation(() => {
        throw new Error('git missing');
      });

    expect(resolveCommitSha()).toBeNull();
    expect(execSpy).toHaveBeenCalledTimes(1);
  });
});

describe('getEnvMetadata', () => {
  it('includes commitSha from resolveCommitSha', () => {
    process.env.COMMIT_SHA = 'commit-sha';

    expect(getEnvMetadata().commitSha).toBe('commit-sha');
  });
});

describe('validateBenchmarkPayload', () => {
  it('reports missing event', () => {
    const payload = createPayload() as Record<string, unknown>;
    delete payload.event;

    expect(validateBenchmarkPayload(payload)).toEqual([
      `event must be "${BENCHMARK_EVENT}"`,
    ]);
  });

  it('reports wrong schemaVersion', () => {
    const payload = {
      ...createPayload(),
      schemaVersion: BENCHMARK_SCHEMA_VERSION + 1,
    };

    expect(validateBenchmarkPayload(payload)).toEqual([
      `schemaVersion must be ${BENCHMARK_SCHEMA_VERSION}`,
    ]);
  });

  it('reports invalid env containers', () => {
    const payload = { ...createPayload(), env: [] };

    expect(validateBenchmarkPayload(payload)).toEqual(['env must be an object']);
  });
});

describe('assertBenchmarkPayload', () => {
  it('throws with formatted errors', () => {
    const payload = {
      ...createPayload(),
      schemaVersion: BENCHMARK_SCHEMA_VERSION + 1,
    };

    expect(() => assertBenchmarkPayload(payload)).toThrow(
      `Invalid benchmark JSON payload:\n- schemaVersion must be ${BENCHMARK_SCHEMA_VERSION}`,
    );
  });
});
