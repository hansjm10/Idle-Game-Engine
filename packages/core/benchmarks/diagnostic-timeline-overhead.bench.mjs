import { execSync } from 'node:child_process';

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

  return {
    meanMs: roundNumber(mean),
    medianMs: roundNumber(median),
    stdDevMs: roundNumber(stdDev),
    minMs: roundNumber(min),
    maxMs: roundNumber(max),
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

async function runBenchmark() {
  const clock = getDefaultHighResolutionClock();
  const benchConfig = {
    time: 1_000,
    iterations: 30,
    warmupTime: 250,
    warmupIterations: 8,
  };
  const bench = new Bench({
    ...benchConfig,
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
      const stats = computeStats(task.result.samples);
      const summary = {
        stats: {
          ...stats,
          hz: roundNumber(task.result.hz, 2),
          rmePercent: roundNumber(task.result.rme * 100, 2),
        },
        diagnosticsEnabled: task.name === 'diagnostics-enabled',
      };
      summaries.set(task.name, {
        result: task.result,
        summary,
      });
    }
  }

  const rows = [...summaries.entries()].map(([name, entry]) => {
    const stats = entry.summary.stats;
    const hzLabel = stats.hz === null ? 'n/a' : stats.hz.toFixed(2);
    const avgLabel =
      stats.meanMs === null ? 'n/a' : stats.meanMs.toFixed(3);
    const medianLabel =
      stats.medianMs === null
        ? 'n/a'
        : stats.medianMs.toFixed(3);
    const stdLabel =
      stats.stdDevMs === null ? 'n/a' : stats.stdDevMs.toFixed(3);
    const minLabel =
      stats.minMs === null ? 'n/a' : stats.minMs.toFixed(3);
    const maxLabel =
      stats.maxMs === null ? 'n/a' : stats.maxMs.toFixed(3);
    const rmeLabel =
      stats.rmePercent === null
        ? 'n/a'
        : stats.rmePercent.toFixed(2);
    return `  task=${name} hz=${hzLabel} avg=${avgLabel}ms median=${medianLabel}ms std=${stdLabel}ms min=${minLabel}ms max=${maxLabel}ms samples=${stats.samples} rme=${rmeLabel}%`;
  });

  if (rows.length > 0) {
    console.log('Results:');
    for (const row of rows) {
      console.log(row);
    }
  }

  if (disabled && enabled) {
    const enabledStats =
      summaries.get('diagnostics-enabled')?.summary.stats;
    const disabledStats =
      summaries.get('diagnostics-disabled')?.summary.stats;
    const hasMean =
      Number.isFinite(enabledStats?.meanMs) &&
      Number.isFinite(disabledStats?.meanMs);
    const delta = hasMean
      ? enabledStats.meanMs - disabledStats.meanMs
      : null;
    const relative = hasMean
      ? (delta / disabledStats.meanMs) * 100
      : null;
    const hasMedian =
      Number.isFinite(enabledStats?.medianMs) &&
      Number.isFinite(disabledStats?.medianMs);
    const medianDelta = hasMedian
      ? enabledStats.medianMs - disabledStats.medianMs
      : null;
    if (delta !== null && relative !== null && medianDelta !== null) {
      console.log(
        `Overhead: +${delta.toFixed(
          3,
        )}ms per ${MEASURE_TICKS} ticks (${relative.toFixed(
          2,
        )}%) mean, +${medianDelta.toFixed(
          3,
        )}ms median`,
      );
    } else {
      console.log('Overhead: n/a');
    }
  }

  const tasks = [...summaries.entries()].map(([name, entry]) => ({
    name,
    diagnosticsEnabled: entry.summary.diagnosticsEnabled,
    stats: entry.summary.stats,
  }));
  const enabledStats =
    summaries.get('diagnostics-enabled')?.summary.stats ?? null;
  const disabledStats =
    summaries.get('diagnostics-disabled')?.summary.stats ?? null;
  const ratios = {
    enabledOverDisabledMean: ratio(
      enabledStats?.meanMs ?? null,
      disabledStats?.meanMs ?? null,
    ),
    enabledOverDisabledMedian: ratio(
      enabledStats?.medianMs ?? null,
      disabledStats?.medianMs ?? null,
    ),
  };

  return {
    event: 'benchmark_run_end',
    schemaVersion: 1,
    benchmark: {
      name: 'diagnostic-timeline-overhead',
    },
    config: {
      stepSizeMs: STEP_SIZE_MS,
      warmupTicks: WARMUP_TICKS,
      measureTicks: MEASURE_TICKS,
      commandsPerTick: COMMANDS_PER_TICK,
      eventsPerTick: EVENTS_PER_TICK,
      commandIterations: COMMAND_ITERATIONS,
      heavySystemIterations: HEAVY_SYSTEM_ITERATIONS,
      bench: benchConfig,
    },
    results: {
      tasks,
      ratios,
    },
    env: getEnvMetadata(),
  };
}

async function main() {
  setTelemetry(silentTelemetry);
  let payload;
  try {
    payload = await runBenchmark();
  } finally {
    resetTelemetry();
  }

  if (payload) {
    console.log(JSON.stringify(payload));
  }
}

main().catch((error) => {
  console.error('Benchmark failed:', error);
  process.exitCode = 1;
});
