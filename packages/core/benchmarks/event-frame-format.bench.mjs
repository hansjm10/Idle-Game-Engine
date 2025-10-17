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

  let totalMs = 0;

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
    totalMs += nowMs() - start;
    frameResult.release();
  }

  return {
    format,
    averageMs: totalMs / ITERATIONS,
  };
}

function runScenario(scenario) {
  const structResult = measureFormat(scenario, 'struct-of-arrays');
  const objectResult = measureFormat(scenario, 'object-array');
  const ratio =
    structResult.averageMs === 0
      ? Number.POSITIVE_INFINITY
      : objectResult.averageMs / structResult.averageMs;

  console.log(
    `scenario=${scenario.label} iterations=${ITERATIONS} eventsPerTick=${scenario.eventsPerTick}`,
  );
  console.log(
    `  format=struct-of-arrays average=${structResult.averageMs.toFixed(4)}ms`,
  );
  console.log(
    `  format=object-array    average=${objectResult.averageMs.toFixed(4)}ms`,
  );
  console.log(`  relative (object/struct)=${ratio.toFixed(3)}x`);
}

function main() {
  for (const scenario of SCENARIOS) {
    runScenario(scenario);
  }
  resetTelemetry();
}

main();
