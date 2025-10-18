import { Bench } from 'tinybench';
import {
  IdleEngineRuntime,
  CommandPriority,
  getDefaultHighResolutionClock,
  resetTelemetry,
  setTelemetry,
} from '../dist/index.js';

const STEP_SIZE_MS = 16;
const WARMUP_TICKS = 50;
const MEASURE_TICKS = 320;
const COMMANDS_PER_TICK = 48;
const EVENTS_PER_TICK = 32;
const COMMAND_ITERATIONS = 96;
const HEAVY_SYSTEM_ITERATIONS = 1_536;
const BENCH_COMMAND_TYPE = 'bench:diagnostic';

const benchSink = { value: 0 };

const silentTelemetry = {
  recordError() {},
  recordWarning() {},
  recordProgress() {},
  recordCounters() {},
  recordTick() {},
};

function commitToSink(value) {
  benchSink.value = (benchSink.value ^ (value | 0)) >>> 0;
}

function createRuntimeScenario({ diagnosticsEnabled, clock }) {
  const timelineOptions =
    diagnosticsEnabled === true
      ? {
          enabled: true,
          clock,
          capacity: 1_024,
          slowTickBudgetMs: STEP_SIZE_MS * 2,
          slowSystemBudgetMs: STEP_SIZE_MS,
          systemHistorySize: 256,
        }
      : false;

  const runtime = new IdleEngineRuntime({
    stepSizeMs: STEP_SIZE_MS,
    maxStepsPerFrame: 10,
    diagnostics: { timeline: timelineOptions },
  });

  const queue = runtime.getCommandQueue();
  const dispatcher = runtime.getCommandDispatcher();
  let commandTimestamp = 0;

  dispatcher.register(BENCH_COMMAND_TYPE, (payload, context) => {
    let acc = payload.seed;
    for (let index = 0; index < payload.iterations; index += 1) {
      acc = (acc * 131 + context.step + index) % 1_000_003;
    }
    commitToSink(acc);
  });

  const enqueueCommands = (
    targetStep,
    count,
    iterations,
    priority,
  ) => {
    for (let index = 0; index < count; index += 1) {
      queue.enqueue({
        type: BENCH_COMMAND_TYPE,
        priority,
        payload: {
          iterations,
          seed: targetStep * 1_001 + index,
        },
        timestamp: commandTimestamp,
        step: targetStep,
      });
      commandTimestamp += 1;
    }
  };

  runtime.addSystem({
    id: 'event-publisher',
    tick: ({ step, events }) => {
      for (let index = 0; index < EVENTS_PER_TICK; index += 1) {
        events.publish('automation:toggled', {
          automationId: `bench:auto:${index % 8}`,
          enabled: (step + index) % 2 === 0,
        });
        events.publish('resource:threshold-reached', {
          resourceId: `bench:resource:${index % 8}`,
          threshold: step + index,
        });
      }
      enqueueCommands(
        step + 1,
        COMMANDS_PER_TICK / 2,
        COMMAND_ITERATIONS,
        CommandPriority.PLAYER,
      );
    },
  });

  runtime.addSystem({
    id: 'queue-churn',
    tick: ({ step }) => {
      enqueueCommands(
        step + 1,
        COMMANDS_PER_TICK / 2,
        COMMAND_ITERATIONS,
        CommandPriority.AUTOMATION,
      );
      enqueueCommands(
        step + 2,
        COMMANDS_PER_TICK / 4,
        COMMAND_ITERATIONS / 2,
        CommandPriority.SYSTEM,
      );
    },
  });

  runtime.addSystem({
    id: 'cpu-load',
    tick: ({ step }) => {
      let acc = step;
      for (
        let index = 0;
        index < HEAVY_SYSTEM_ITERATIONS;
        index += 1
      ) {
        acc = (acc ^ ((index + 11) * 13)) & 0xff_ff;
      }
      commitToSink(acc);
    },
  });

  enqueueCommands(
    0,
    COMMANDS_PER_TICK,
    COMMAND_ITERATIONS,
    CommandPriority.PLAYER,
  );
  enqueueCommands(
    1,
    COMMANDS_PER_TICK,
    COMMAND_ITERATIONS,
    CommandPriority.AUTOMATION,
  );

  return runtime;
}

function warmupRuntime(runtime) {
  for (let index = 0; index < WARMUP_TICKS; index += 1) {
    runtime.tick(STEP_SIZE_MS);
  }
}

function runMeasurement(runtime) {
  for (let index = 0; index < MEASURE_TICKS; index += 1) {
    runtime.tick(STEP_SIZE_MS);
  }
}

function registerTask(bench, label, diagnosticsEnabled, clock) {
  let runtime;
  bench.add(
    label,
    () => {
      runMeasurement(runtime);
    },
    {
      beforeEach() {
        runtime = createRuntimeScenario({ diagnosticsEnabled, clock });
        warmupRuntime(runtime);
      },
      afterEach() {
        runtime = undefined;
      },
    },
  );
}

function formatResult(result) {
  const { samples, mean } = result;
  const sortedSamples = [...samples].sort((one, two) => one - two);
  const middle = Math.floor(sortedSamples.length / 2);
  const median =
    sortedSamples.length % 2 === 0
      ? (sortedSamples[middle - 1] + sortedSamples[middle]) / 2
      : sortedSamples[middle];
  const variance =
    samples.reduce((acc, value) => acc + (value - mean) ** 2, 0) /
    samples.length;
  const stdDev = Math.sqrt(Math.max(variance, 0));
  return {
    hz: result.hz.toFixed(2),
    averageMs: result.mean.toFixed(3),
    medianMs: median.toFixed(3),
    stdDevMs: stdDev.toFixed(3),
    minMs: Math.min(...samples).toFixed(3),
    maxMs: Math.max(...samples).toFixed(3),
    rmePercent: (result.rme * 100).toFixed(2),
    samples: result.samples.length,
  };
}

async function runBenchmark() {
  const clock = getDefaultHighResolutionClock();
  const bench = new Bench({
    time: 1_000,
    iterations: 30,
    warmupTime: 250,
    warmupIterations: 8,
    now: () => clock.now(),
  });

  registerTask(bench, 'diagnostics-disabled', false, clock);
  registerTask(bench, 'diagnostics-enabled', true, clock);

  console.log('Running DiagnosticTimeline overhead benchmark...');
  await bench.warmup();
  await bench.run();

  const disabled = bench.getTask('diagnostics-disabled')?.result;
  const enabled = bench.getTask('diagnostics-enabled')?.result;

  const summaries = new Map();
  for (const task of bench.tasks) {
    if (task.result) {
      summaries.set(task.name, {
        result: task.result,
        formatted: formatResult(task.result),
        sortedSamples: [...task.result.samples].sort(
          (a, b) => a - b,
        ),
      });
    }
  }

  const rows = [...summaries.entries()].map(([name, entry]) => {
    const formatted = entry.formatted;
    return `  task=${name} hz=${formatted.hz} avg=${formatted.averageMs}ms median=${formatted.medianMs}ms std=${formatted.stdDevMs}ms min=${formatted.minMs}ms max=${formatted.maxMs}ms samples=${formatted.samples} rme=${formatted.rmePercent}%`;
  });

  if (rows.length > 0) {
    console.log('Results:');
    for (const row of rows) {
      console.log(row);
    }
  }

  if (disabled && enabled) {
    const delta = enabled.mean - disabled.mean;
    const relative = (delta / disabled.mean) * 100;
    const enabledSummary = summaries.get('diagnostics-enabled');
    const disabledSummary = summaries.get('diagnostics-disabled');
    const enabledMedian =
      enabledSummary?.sortedSamples.at(
        Math.floor(enabledSummary.sortedSamples.length / 2),
      ) ?? 0;
    const disabledMedian =
      disabledSummary?.sortedSamples.at(
        Math.floor(disabledSummary.sortedSamples.length / 2),
      ) ?? 0;
    const medianDelta = enabledMedian - disabledMedian;
    console.log(
      `Overhead: +${delta.toFixed(
        3,
      )}ms per ${MEASURE_TICKS} ticks (${relative.toFixed(
        2,
      )}%) mean, +${medianDelta.toFixed(
        3,
      )}ms median`,
    );
  }
}

async function main() {
  setTelemetry(silentTelemetry);
  try {
    await runBenchmark();
  } finally {
    resetTelemetry();
  }
}

main().catch((error) => {
  console.error('Benchmark failed:', error);
  process.exitCode = 1;
});
