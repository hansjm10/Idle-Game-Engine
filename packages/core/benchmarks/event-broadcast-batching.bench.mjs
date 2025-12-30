import {
  DEFAULT_EVENT_BUS_OPTIONS,
  EventBroadcastBatcher,
  EventBus,
  TransportBufferPool,
  buildRuntimeEventFrame,
  createEventBroadcastFrame,
  resetTelemetry,
  setTelemetry,
} from '../dist/index.js';
import {
  assertBenchmarkPayload,
  BENCHMARK_EVENT,
  BENCHMARK_SCHEMA_VERSION,
  getEnvMetadata,
  ratio,
} from './benchmark-json-helpers.mjs';

const TICKS = 120;
const EVENTS_PER_TICK = 40;
const MESSAGE_OVERHEAD_BYTES = 64;

function expectedMessageCountForSteps(maxSteps) {
  return Math.ceil(TICKS / maxSteps);
}

const SCENARIOS = [
  {
    label: 'unbatched',
    options: { maxSteps: 1 },
    expectations: { messageCount: expectedMessageCountForSteps(1) },
  },
  {
    label: 'batch-5-steps',
    options: { maxSteps: 5 },
    expectations: {
      messageCount: expectedMessageCountForSteps(5),
      reducesMessageCount: true,
      reducesOverhead: true,
    },
  },
  {
    label: 'batch-10-steps',
    options: { maxSteps: 10 },
    expectations: {
      messageCount: expectedMessageCountForSteps(10),
      reducesMessageCount: true,
      reducesOverhead: true,
    },
  },
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

setTelemetry({
  recordError() {},
  recordWarning() {},
  recordProgress() {},
  recordCounters() {},
  recordTick() {},
});

function createBenchmarkBus() {
  return new EventBus({
    channels: DEFAULT_EVENT_BUS_OPTIONS.channels,
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

function buildFrames() {
  const bus = createBenchmarkBus();
  const pool = new TransportBufferPool();
  const frames = [];

  bus.beginTick(0);

  for (let tick = 1; tick <= TICKS; tick += 1) {
    bus.beginTick(tick);
    publishScenarioEvents(bus, EVENTS_PER_TICK);

    const frameResult = buildRuntimeEventFrame(bus, pool, {
      tick,
      manifestHash: bus.getManifestHash(),
      format: 'object-array',
    });

    frames.push(createEventBroadcastFrame(frameResult.frame, {
      serverStep: tick,
      includeChecksum: false,
      includeManifestHash: false,
      sortByDispatchOrder: false,
    }));

    frameResult.release();
  }

  return frames;
}

function measureScenario(frames, scenario) {
  const batcher = new EventBroadcastBatcher(scenario.options);
  let messageCount = 0;
  let payloadBytes = 0;

  for (const frame of frames) {
    const batches = batcher.ingestFrame(frame);
    for (const batch of batches) {
      payloadBytes += JSON.stringify(batch).length;
      messageCount += 1;
    }
  }

  const finalBatch = batcher.flush();
  if (finalBatch) {
    payloadBytes += JSON.stringify(finalBatch).length;
    messageCount += 1;
  }

  const overheadBytes = messageCount * MESSAGE_OVERHEAD_BYTES;
  const totalBytes = payloadBytes + overheadBytes;

  return {
    label: scenario.label,
    messageCount,
    payloadBytes,
    overheadBytes,
    totalBytes,
  };
}

function main() {
  const frames = buildFrames();
  const results = SCENARIOS.map((scenario) => measureScenario(frames, scenario));
  const baseline = results.find((entry) => entry.label === 'unbatched');
  assert(baseline, 'Expected a baseline scenario labeled "unbatched".');

  for (const scenario of SCENARIOS) {
    const entry = results.find((result) => result.label === scenario.label);
    assert(entry, `Missing results for scenario "${scenario.label}".`);

    const expectations = scenario.expectations;
    assert(expectations, `Scenario "${scenario.label}" is missing expectations.`);

    if (expectations.messageCount !== undefined) {
      assert(
        entry.messageCount === expectations.messageCount,
        `Expected ${scenario.label} to produce ${expectations.messageCount} messages (received ${entry.messageCount}).`,
      );
    }
    if (expectations.minMessageCount !== undefined) {
      assert(
        entry.messageCount >= expectations.minMessageCount,
        `Expected ${scenario.label} to produce at least ${expectations.minMessageCount} messages (received ${entry.messageCount}).`,
      );
    }
    if (expectations.maxMessageCount !== undefined) {
      assert(
        entry.messageCount <= expectations.maxMessageCount,
        `Expected ${scenario.label} to produce at most ${expectations.maxMessageCount} messages (received ${entry.messageCount}).`,
      );
    }
    if (expectations.reducesMessageCount) {
      assert(
        entry.messageCount < baseline.messageCount,
        `Expected ${scenario.label} to reduce message count versus unbatched.`,
      );
    }
    if (expectations.reducesOverhead) {
      assert(
        entry.overheadBytes < baseline.overheadBytes,
        `Expected ${scenario.label} to reduce overhead bytes versus unbatched.`,
      );
    }
  }

  const comparisons = results.map((entry) => ({
    label: entry.label,
    totalBytesOverBaseline: ratio(entry.totalBytes, baseline?.totalBytes ?? 0),
    messageCountOverBaseline: ratio(
      entry.messageCount,
      baseline?.messageCount ?? 0,
    ),
  }));

  resetTelemetry();

  const payload = {
    event: BENCHMARK_EVENT,
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    benchmark: {
      name: 'event-broadcast-batching',
    },
    config: {
      ticks: TICKS,
      eventsPerTick: EVENTS_PER_TICK,
      messageOverheadBytes: MESSAGE_OVERHEAD_BYTES,
      scenarios: SCENARIOS,
    },
    results: {
      scenarios: results,
      comparisons,
    },
    env: getEnvMetadata(),
  };

  assertBenchmarkPayload(payload);
  console.log(JSON.stringify(payload));
}

main();
