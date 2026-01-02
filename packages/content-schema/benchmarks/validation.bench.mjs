/**
 * Validation benchmark suite for content-schema.
 * Measures validation performance across different pack sizes
 * and compares cached vs uncached validation.
 *
 * Run: node benchmarks/validation.bench.mjs
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, parse } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import {
  createContentPackValidator,
  createValidationCache,
} from '../dist/pack/index.js';

import { generateSyntheticPack, PACK_PRESETS as PRESETS } from './pack-generator.mjs';

const BENCHMARK_EVENT = 'benchmark_run_end';
const BENCHMARK_SCHEMA_VERSION = 1;

const WARMUP_ITERATIONS = 3;
const MEASURE_ITERATIONS = 10;
const RUNS = 3;

const __dirname = dirname(fileURLToPath(import.meta.url));

// Target times in milliseconds
// Note: Cache only skips refinements/normalization/balance, NOT Zod structural validation.
// Zod parsing dominates for larger packs, so cache speedup is modest (~5-15%).
// The real value is in avoiding expensive refinement/normalization on repeat validations.
const TARGETS = {
  tiny: 30, // ~40 entities
  medium: 100, // ~200 entities
  large: 500, // ~850 entities
  cachedSpeedup: 0.05, // 5% minimum speedup expected (Zod parsing still runs)
};

const ENFORCE_TARGETS = process.env.VALIDATION_BENCH_ENFORCE === '1';

function roundNumber(value, decimals = 6) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function computeStats(samples) {
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

function resolveGitDirFromFile(gitPath, currentDir) {
  const content = readFileSync(gitPath, 'utf-8').trim();
  const prefix = 'gitdir:';
  if (!content.toLowerCase().startsWith(prefix)) {
    return null;
  }

  const gitDirPath = content.slice(prefix.length).trim();
  if (!gitDirPath) {
    return null;
  }

  return isAbsolute(gitDirPath)
    ? gitDirPath
    : join(currentDir, gitDirPath);
}

function resolveGitDirEntry(gitPath, currentDir) {
  if (!existsSync(gitPath)) {
    return null;
  }

  const stats = statSync(gitPath);
  if (stats.isDirectory()) {
    return gitPath;
  }
  if (stats.isFile()) {
    return resolveGitDirFromFile(gitPath, currentDir);
  }

  return null;
}

function resolveGitDir(startDir) {
  let currentDir = startDir;
  const { root } = parse(startDir);

  while (true) {
    const gitPath = join(currentDir, '.git');
    try {
      const gitDir = resolveGitDirEntry(gitPath, currentDir);
      if (gitDir) {
        return gitDir;
      }
    } catch {
      return null;
    }

    if (currentDir === root) {
      return null;
    }

    currentDir = dirname(currentDir);
  }
}

function resolveCommitShaFromGitDir(gitDir) {
  if (!gitDir) {
    return null;
  }

  const headPath = join(gitDir, 'HEAD');
  if (!existsSync(headPath)) {
    return null;
  }

  const head = readFileSync(headPath, 'utf-8').trim();
  if (!head) {
    return null;
  }

  if (!head.startsWith('ref:')) {
    return /^[0-9a-f]{40}$/i.test(head) ? head : null;
  }

  const ref = head.slice('ref:'.length).trim();
  const refPath = join(gitDir, ref);
  if (existsSync(refPath)) {
    return readFileSync(refPath, 'utf-8').trim() || null;
  }

  const packedRefsPath = join(gitDir, 'packed-refs');
  if (!existsSync(packedRefsPath)) {
    return null;
  }

  const packedRefs = readFileSync(packedRefsPath, 'utf-8').split('\n');
  for (const line of packedRefs) {
    if (!line || line.startsWith('#') || line.startsWith('^')) {
      continue;
    }
    const [sha, refName] = line.split(' ');
    if (refName === ref) {
      return sha;
    }
  }

  return null;
}

function resolveCommitSha() {
  const envSha =
    process.env.GITHUB_SHA ??
    process.env.CI_COMMIT_SHA ??
    process.env.COMMIT_SHA ??
    process.env.BUILD_VCS_NUMBER;
  if (envSha) {
    return envSha;
  }

  try {
    const gitDir = resolveGitDir(__dirname);
    return resolveCommitShaFromGitDir(gitDir);
  } catch {
    return null;
  }
}

function getEnvMetadata() {
  return {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    commitSha: resolveCommitSha(),
  };
}

/**
 * Measure validation time for a pack (uncached).
 */
function measureUncachedValidation(pack) {
  const validator = createContentPackValidator({
    balance: { enabled: false },
  });

  // Warmup
  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    validator.parse(pack);
  }

  // Measure multiple runs
  const samplesMs = [];
  for (let run = 0; run < RUNS; run++) {
    const start = performance.now();
    for (let i = 0; i < MEASURE_ITERATIONS; i++) {
      // Create fresh validator each time to avoid any internal caching
      const freshValidator = createContentPackValidator({
        balance: { enabled: false },
      });
      freshValidator.parse(pack);
    }
    const durationMs = performance.now() - start;
    samplesMs.push(durationMs / MEASURE_ITERATIONS);
  }

  return { samplesMs };
}

/**
 * Measure cached validation speedup.
 * Compares cache hit time vs cache miss time on the same validator.
 */
function measureCachedValidation(pack) {
  // Measure cache MISS times - validation without any cache
  const missSamplesMs = [];
  for (let run = 0; run < RUNS; run++) {
    // Fresh validator with fresh cache each run
    const freshCache = createValidationCache();
    const freshValidator = createContentPackValidator({
      cache: freshCache,
      balance: { enabled: false },
    });

    // Warmup
    for (let i = 0; i < WARMUP_ITERATIONS; i++) {
      freshCache.clear();
      freshValidator.parse(pack);
    }

    // Measure cache misses
    const start = performance.now();
    for (let i = 0; i < MEASURE_ITERATIONS; i++) {
      freshCache.clear(); // Force cache miss
      freshValidator.parse(pack);
    }
    const durationMs = performance.now() - start;
    missSamplesMs.push(durationMs / MEASURE_ITERATIONS);
  }

  // Measure cache HIT times - validation with warm cache
  const hitSamplesMs = [];
  for (let run = 0; run < RUNS; run++) {
    const warmCache = createValidationCache();
    const warmValidator = createContentPackValidator({
      cache: warmCache,
      balance: { enabled: false },
    });

    // Prime the cache
    warmValidator.parse(pack);

    // Warmup cache hits
    for (let i = 0; i < WARMUP_ITERATIONS * 3; i++) {
      warmValidator.parse(pack);
    }

    // Measure cache hits
    const hitIterations = MEASURE_ITERATIONS * 5;
    const start = performance.now();
    for (let i = 0; i < hitIterations; i++) {
      warmValidator.parse(pack);
    }
    const durationMs = performance.now() - start;
    hitSamplesMs.push(durationMs / hitIterations);
  }

  return { hitSamplesMs, missSamplesMs };
}

function formatPresetLabel(preset) {
  return [
    `resources=${preset.resources}`,
    `generators=${preset.generators}`,
    `upgrades=${preset.upgrades}`,
    `achievements=${preset.achievements}`,
    `automations=${preset.automations}`,
    `transforms=${preset.transforms}`,
  ].join(' ');
}

function runUncachedScenario(presetName, preset) {
  console.log(`\n[uncached] ${presetName}: ${formatPresetLabel(preset)}`);

  const pack = generateSyntheticPack(preset);
  const { samplesMs } = measureUncachedValidation(pack);
  const stats = computeStats(samplesMs);
  const targetMs = TARGETS[presetName];
  const passesTarget = targetMs ? stats.meanMs <= targetMs : true;
  let status = 'INFO';
  if (targetMs) {
    status = passesTarget ? 'OK' : 'ABOVE_TARGET';
  }

  console.log(
    `  mean=${stats.meanMs.toFixed(2)}ms median=${stats.medianMs.toFixed(2)}ms stddev=${stats.stdDevMs.toFixed(2)}ms`,
  );
  console.log(
    `  target=${targetMs ?? 'none'}ms status=${status}${ENFORCE_TARGETS ? '' : ' (not enforced)'}`,
  );

  if (ENFORCE_TARGETS && !passesTarget) {
    process.exitCode = 1;
  }

  return {
    label: `uncached-${presetName}`,
    preset: presetName,
    shape: {
      resources: preset.resources,
      generators: preset.generators,
      upgrades: preset.upgrades,
      achievements: preset.achievements,
      automations: preset.automations,
      transforms: preset.transforms,
    },
    stats,
    targetMs,
    meanOverTarget: targetMs ? roundNumber(stats.meanMs / targetMs, 4) : null,
    status,
    enforceTarget: ENFORCE_TARGETS,
  };
}

function runCachedScenario(presetName, preset) {
  console.log(`\n[cached] ${presetName}: ${formatPresetLabel(preset)}`);

  const pack = generateSyntheticPack(preset);
  const { hitSamplesMs, missSamplesMs } = measureCachedValidation(pack);

  const hitStats = computeStats(hitSamplesMs);
  const missStats = computeStats(missSamplesMs);

  const speedup =
    missStats.meanMs > 0
      ? 1 - hitStats.meanMs / missStats.meanMs
      : 0;
  const passesSpeedup = speedup >= TARGETS.cachedSpeedup;
  const status = passesSpeedup ? 'OK' : 'BELOW_SPEEDUP';

  console.log(
    `  cache hit: mean=${hitStats.meanMs.toFixed(3)}ms median=${hitStats.medianMs.toFixed(3)}ms`,
  );
  console.log(
    `  cache miss: mean=${missStats.meanMs.toFixed(2)}ms median=${missStats.medianMs.toFixed(2)}ms`,
  );
  console.log(
    `  speedup=${(speedup * 100).toFixed(1)}% target=${(TARGETS.cachedSpeedup * 100).toFixed(0)}% status=${status}${ENFORCE_TARGETS ? '' : ' (not enforced)'}`,
  );

  if (ENFORCE_TARGETS && !passesSpeedup) {
    process.exitCode = 1;
  }

  return {
    label: `cached-${presetName}`,
    preset: presetName,
    shape: {
      resources: preset.resources,
      generators: preset.generators,
      upgrades: preset.upgrades,
      achievements: preset.achievements,
      automations: preset.automations,
      transforms: preset.transforms,
    },
    hitStats,
    missStats,
    speedup: roundNumber(speedup, 4),
    speedupTarget: TARGETS.cachedSpeedup,
    status,
    enforceTarget: ENFORCE_TARGETS,
  };
}

// Main benchmark execution
console.log('Content Pack Validation Benchmark');
console.log('=================================');
console.log(`Warmup iterations: ${WARMUP_ITERATIONS}`);
console.log(`Measure iterations: ${MEASURE_ITERATIONS}`);
console.log(`Runs per scenario: ${RUNS}`);
console.log(`Enforce targets: ${ENFORCE_TARGETS}`);

const uncachedResults = [];
const cachedResults = [];

// Run uncached benchmarks for each preset
for (const [presetName, preset] of Object.entries(PRESETS)) {
  uncachedResults.push(runUncachedScenario(presetName, preset));
}

// Run cached benchmarks for medium preset (representative)
cachedResults.push(runCachedScenario('medium', PRESETS.medium));

const payload = {
  event: BENCHMARK_EVENT,
  schemaVersion: BENCHMARK_SCHEMA_VERSION,
  benchmark: {
    name: 'content-pack-validation',
  },
  config: {
    warmupIterations: WARMUP_ITERATIONS,
    measureIterations: MEASURE_ITERATIONS,
    runs: RUNS,
    targets: TARGETS,
    enforceTargets: ENFORCE_TARGETS,
  },
  results: {
    uncached: uncachedResults,
    cached: cachedResults,
  },
  env: getEnvMetadata(),
};

console.log('\n--- JSON Output ---');
console.log(JSON.stringify(payload));
