import { execSync } from 'node:child_process';

export const BENCHMARK_EVENT = 'benchmark_run_end';
export const BENCHMARK_SCHEMA_VERSION = 1;

export function roundNumber(value, decimals = 6) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function computeStats(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return {
      meanMs: null,
      medianMs: null,
      stdDevMs: null,
      minMs: null,
      maxMs: null,
      hz: null,
      samples: 0,
      unit: 'ms',
    };
  }

  const total = samples.reduce((sum, value) => sum + value, 0);
  const mean = total / samples.length;
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];
  const variance =
    samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    samples.length;
  const stdDev = Math.sqrt(Math.max(variance, 0));
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const hz = mean > 0 ? 1000 / mean : null;

  return {
    meanMs: roundNumber(mean),
    medianMs: roundNumber(median),
    stdDevMs: roundNumber(stdDev),
    minMs: roundNumber(min),
    maxMs: roundNumber(max),
    hz: roundNumber(hz, 3),
    samples: samples.length,
    unit: 'ms',
  };
}

export function resolveCommitSha() {
  const envSha =
    process.env.GITHUB_SHA ??
    process.env.CI_COMMIT_SHA ??
    process.env.COMMIT_SHA ??
    process.env.BUILD_VCS_NUMBER;
  if (envSha) {
    return envSha;
  }
  try {
    return execSync('git rev-parse HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

export function getEnvMetadata() {
  return {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    commitSha: resolveCommitSha(),
  };
}

export function ratio(numerator, denominator, decimals = 4) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) {
    return null;
  }
  if (denominator === 0) {
    return null;
  }
  return roundNumber(numerator / denominator, decimals);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateBenchmarkPayload(payload) {
  const errors = [];
  if (!isRecord(payload)) {
    errors.push('payload must be an object');
    return errors;
  }
  if (payload.event !== BENCHMARK_EVENT) {
    errors.push(`event must be "${BENCHMARK_EVENT}"`);
  }
  if (payload.schemaVersion !== BENCHMARK_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${BENCHMARK_SCHEMA_VERSION}`);
  }
  if (
    !isRecord(payload.benchmark) ||
    typeof payload.benchmark.name !== 'string' ||
    payload.benchmark.name.length === 0
  ) {
    errors.push('benchmark.name must be a non-empty string');
  }
  if (!isRecord(payload.config)) {
    errors.push('config must be an object');
  }
  if (!isRecord(payload.results)) {
    errors.push('results must be an object');
  }
  if (!isRecord(payload.env)) {
    errors.push('env must be an object');
    return errors;
  }
  if (
    typeof payload.env.nodeVersion !== 'string' ||
    payload.env.nodeVersion.length === 0
  ) {
    errors.push('env.nodeVersion must be a non-empty string');
  }
  if (
    typeof payload.env.platform !== 'string' ||
    payload.env.platform.length === 0
  ) {
    errors.push('env.platform must be a non-empty string');
  }
  if (typeof payload.env.arch !== 'string' || payload.env.arch.length === 0) {
    errors.push('env.arch must be a non-empty string');
  }
  if (
    payload.env.commitSha !== null &&
    typeof payload.env.commitSha !== 'string'
  ) {
    errors.push('env.commitSha must be a string or null');
  }
  return errors;
}

export function assertBenchmarkPayload(payload) {
  const errors = validateBenchmarkPayload(payload);
  if (errors.length > 0) {
    throw new Error(
      `Invalid benchmark JSON payload:\n- ${errors.join('\n- ')}`,
    );
  }
}
