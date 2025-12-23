import {
  DEFAULT_EVENT_BUS_OPTIONS,
  EventBus,
  resetTelemetry,
  setTelemetry,
  TransportBufferPool,
  buildRuntimeEventFrame,
} from '../dist/index.js';
import {
  assertBenchmarkPayload,
  computeStats,
  getEnvMetadata,
  ratio,
} from './benchmark-json-helpers.mjs';

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

  assertBenchmarkPayload(payload);
  console.log(JSON.stringify(payload));
}

main();
