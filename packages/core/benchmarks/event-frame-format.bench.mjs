import { execSync } from 'node:child_process';

import {
  DEFAULT_EVENT_BUS_OPTIONS,
  EventBus,
  resetTelemetry,
  setTelemetry,
  TransportBufferPool,
  buildRuntimeEventFrame,
} from '../dist/index.js';

const ITERATIONS = 200;
const SCENARIOS = [
  { label: 'dense', eventsPerTick: 200 },
  { label: 'sparse', eventsPerTick: 8 },
];

setTelemetry({
  recordError() {},
  recordWarning() {},
  recordProgress() {},
  recordCounters() {},
  recordTick() {},
});

function nowMs() {
  const perf = globalThis.performance;
  if (perf && typeof perf.now === 'function') {
    return perf.now();
  }

  const nodeProcess = globalThis.process;
  if (nodeProcess && typeof nodeProcess.hrtime === 'function') {
    const [seconds, nanoseconds] = nodeProcess.hrtime();
    return seconds * 1000 + nanoseconds / 1e6;
  }

  return Date.now();
}

function roundNumber(value, decimals = 6) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function computeStats(samples) {
  if (samples.length === 0) {
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
    return execSync('git rev-parse HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
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

function ratio(numerator, denominator, decimals = 4) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) {
    return null;
  }
  if (denominator === 0) {
    return null;
  }
  return roundNumber(numerator / denominator, decimals);
}

function createBenchmarkBus() {
  return new EventBus({
    clock: {
      now: () => nowMs(),
    },
    channels: DEFAULT_EVENT_BUS_OPTIONS.channels.slice(0, 2),
    frameExport: {
      defaultFormat: 'struct-of-arrays',
      autoFallback: {
        enabled: false,
      },
    },
  });
}

function publishScenarioEvents(bus, totalEvents) {
  const half = Math.floor(totalEvents / 2);
  for (let index = 0; index < totalEvents; index += 1) {
    if (index < half) {
      bus.publish('resource:threshold-reached', {
        resourceId: `bench:resource:${index}`,
        threshold: index,
      });
    } else {
      bus.publish('automation:toggled', {
        automationId: `bench:automation:${index}`,
        enabled: index % 2 === 0,
      });
    }
  }
}

function measureFormat(scenario, format) {
  const bus = createBenchmarkBus();
  const pool = new TransportBufferPool();

  bus.beginTick(0);

  const samples = [];

  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    const tick = iteration + 1;
    bus.beginTick(tick);
    publishScenarioEvents(bus, scenario.eventsPerTick);

    const start = nowMs();
    const frameResult = buildRuntimeEventFrame(bus, pool, {
      tick,
      manifestHash: bus.getManifestHash(),
      owner: `benchmark:${scenario.label}`,
      format,
    });
    samples.push(nowMs() - start);
    frameResult.release();
  }

  return {
    format,
    stats: computeStats(samples),
  };
}

function runScenario(scenario) {
  const structResult = measureFormat(scenario, 'struct-of-arrays');
  const objectResult = measureFormat(scenario, 'object-array');
  const meanRatio = ratio(
    objectResult.stats.meanMs,
    structResult.stats.meanMs,
  );
  const medianRatio = ratio(
    objectResult.stats.medianMs,
    structResult.stats.medianMs,
  );
  const structAverage =
    structResult.stats.meanMs === null
      ? 'n/a'
      : structResult.stats.meanMs.toFixed(4);
  const objectAverage =
    objectResult.stats.meanMs === null
      ? 'n/a'
      : objectResult.stats.meanMs.toFixed(4);
  const meanRatioLabel =
    meanRatio === null ? 'n/a' : meanRatio.toFixed(3);

  console.log(
    `scenario=${scenario.label} iterations=${ITERATIONS} eventsPerTick=${scenario.eventsPerTick}`,
  );
  console.log(
    `  format=struct-of-arrays average=${structAverage}ms`,
  );
  console.log(
    `  format=object-array    average=${objectAverage}ms`,
  );
  console.log(`  relative (object/struct)=${meanRatioLabel}x`);

  return {
    label: scenario.label,
    eventsPerTick: scenario.eventsPerTick,
    formats: {
      'struct-of-arrays': structResult.stats,
      'object-array': objectResult.stats,
    },
    ratios: {
      objectOverStructMean: meanRatio,
      objectOverStructMedian: medianRatio,
    },
  };
}

function main() {
  const scenarioResults = [];
  for (const scenario of SCENARIOS) {
    scenarioResults.push(runScenario(scenario));
  }
  resetTelemetry();

  const payload = {
    event: 'benchmark_run_end',
    schemaVersion: 1,
    benchmark: {
      name: 'event-frame-format',
    },
    config: {
      iterations: ITERATIONS,
      scenarios: SCENARIOS,
    },
    results: {
      scenarios: scenarioResults,
    },
    env: getEnvMetadata(),
  };

  console.log(JSON.stringify(payload));
}

main();
