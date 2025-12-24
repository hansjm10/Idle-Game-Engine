# Benchmark JSON Output Schema

Core benchmarks under `packages/core/benchmarks` emit a trailing single-line JSON payload so CI and tooling can validate and diff results. The runtime workload harness under `tools/runtime-sim` uses the same envelope to feed the performance report. The JSON line must be the last non-empty line in the log output.

## Covered Benchmarks
- `packages/core/benchmarks/event-frame-format.bench.mjs`
- `packages/core/benchmarks/diagnostic-timeline-overhead.bench.mjs`
- `packages/core/benchmarks/state-sync-checksum.bench.mjs`
- `tools/runtime-sim` (runtime workload scenarios)

## Envelope (TypeScript-style)
```
type BenchmarkRunEnd = {
  event: 'benchmark_run_end';
  schemaVersion: 1;
  benchmark: {
    name: string;
  };
  config: Record<string, unknown>;
  results: Record<string, unknown>;
  env: {
    nodeVersion: string;
    platform: string;
    arch: string;
    commitSha: string | null;
  };
};

type BenchmarkStats = {
  meanMs: number | null;
  medianMs: number | null;
  stdDevMs: number | null;
  minMs: number | null;
  maxMs: number | null;
  hz: number | null;
  samples: number;
  unit: 'ms';
};
```

## Notes
- `config` captures benchmark configuration and scenario parameters.
- `results` stores per-scenario/task stats and optional ratio fields to reduce CI noise.
- `BenchmarkStats` uses 6 decimal places for ms fields and 3 for `hz`; ratio helpers default to 4 decimals.
- `env.commitSha` is `null` when no SHA is available in the environment or repository.
- The payload is validated with `tools/scripts/assert-json-tail.mjs`.

## Per-benchmark results

### event-frame-format
- `results.scenarios[]` includes `label`, `eventsPerTick`, `formats`, and `ratios`.
- `formats` includes `struct-of-arrays` and `object-array` `BenchmarkStats`.
- `ratios` includes `objectOverStructMean` and `objectOverStructMedian` (`number | null`).

### diagnostic-timeline-overhead
- `config.stepSizeMs` sets the runtime step size in milliseconds.
- `config.warmupTicks` and `config.measureTicks` define the warmup and measured tick counts.
- `config.commandsPerTick`, `config.eventsPerTick`, `config.commandIterations`, and `config.heavySystemIterations` define the workload.
- `config.bench` includes Tinybench settings: `time`, `iterations`, `warmupTime`, and `warmupIterations`.
- `results.tasks[]` includes `name`, `diagnosticsEnabled`, and `stats`.
- `stats` extends `BenchmarkStats` with `rmePercent` (`number | null`) and a tinybench-reported `hz` value.
- `results.ratios` includes `enabledOverDisabledMean` and `enabledOverDisabledMedian` (`number | null`).

### state-sync-checksum
- `results.scenarios[]` includes `label`, `shape`, `stats`, `meanOverTarget`, `status`, `targetUs`, and `enforceTarget`.
- `shape` includes `resources`, `generators`, `upgrades`, `achievements`, `automations`, `transforms`, and `commands`.
- `meanOverTarget` is the ratio of mean checksum time to `targetUs` (`number | null`); `status` is `OK`, `ABOVE_TARGET`, or `INFO`.

### runtime-workload-sim
- `config.stepSizeMs`, `config.warmupTicks`, `config.measureTicks`, and `config.seed` describe the workload run.
- `config.maxStepsPerFrame` is optional when the scenario overrides the runtime clamp.
- `config.scenarios` lists the scenario IDs executed; `config.includeMemory` toggles memory payloads.
- `results.scenarios[]` includes `label`, `stats`, `diagnostics`, `snapshot`, and optional `memory`.
- `stats` follows `BenchmarkStats` (mean/median/min/max/stddev/hz over per-tick durations).
- `diagnostics` includes `slowTickCount`, `maxQueueBacklog`, `maxTickDurationMs`, `avgTickDurationMs`, and `dropped`.
- `snapshot` includes `bytes` and `entries` for the diagnostics payload size.
- `memory` (when present) includes `rss`, `heapTotal`, `heapUsed`, `external`, and `arrayBuffers` in bytes.

## Example
```
{
  "event": "benchmark_run_end",
  "schemaVersion": 1,
  "benchmark": {
    "name": "event-frame-format"
  },
  "config": {
    "iterations": 200,
    "scenarios": [
      {"label": "dense", "eventsPerTick": 200},
      {"label": "sparse", "eventsPerTick": 8}
    ]
  },
  "results": {
    "scenarios": [
      {
        "label": "dense",
        "eventsPerTick": 200,
        "formats": {
          "struct-of-arrays": {
            "meanMs": 0.0421,
            "medianMs": 0.0419,
            "stdDevMs": 0.0025,
            "minMs": 0.0397,
            "maxMs": 0.0512,
            "hz": 23756.76,
            "samples": 200,
            "unit": "ms"
          },
          "object-array": {
            "meanMs": 0.0898,
            "medianMs": 0.0884,
            "stdDevMs": 0.0061,
            "minMs": 0.0812,
            "maxMs": 0.1043,
            "hz": 11135.92,
            "samples": 200,
            "unit": "ms"
          }
        },
        "ratios": {
          "objectOverStructMean": 2.1333,
          "objectOverStructMedian": 2.1098
        }
      }
    ]
  },
  "env": {
    "nodeVersion": "v20.11.1",
    "platform": "linux",
    "arch": "x64",
    "commitSha": "a79b8714c1e2c0b4f2f0f2a5c4c2c1a9b8d7e6f5"
  }
}
```
