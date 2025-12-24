---
title: Performance Report
sidebar_label: Performance Report
---

# Performance Report

Run `pnpm perf:md` from the repository root to regenerate this page after modifying benchmarks.
Benchmark artifacts are generated in `artifacts/benchmarks/` and are ignored by git.

## diagnostic-timeline-overhead
### @idle-engine/core
#### Run Details
| Detail | Value |
| --- | --- |
| Commit | b346573e098d06a7eef4d01440b0d13ee09cf0c7 |
| Node | v22.21.1 |
| Platform | linux |
| Arch | x64 |
| Config: Step Size (ms) | 16 |
| Config: Warmup Ticks | 50 |
| Config: Measure Ticks | 320 |
| Config: Commands/Tick | 48 |
| Config: Events/Tick | 32 |
| Config: Command Iterations | 96 |
| Config: Heavy System Iterations | 1536 |
| Config: Bench Time (ms) | 1000 |
| Config: Bench Iterations | 30 |
| Config: Bench Warmup Time (ms) | 250 |
| Config: Bench Warmup Iterations | 8 |

#### Tasks
| Task | Diagnostics Enabled | Mean (ms) | Median (ms) | Hz | RME (%) | Samples |
| --- | --- | --- | --- | --- | --- | --- |
| diagnostics-disabled | false | 273.5056 | 268.3064 | 3.66 | 338.17 | 30 |
| diagnostics-enabled | true | 264.3028 | 261.3773 | 3.78 | 323.45 | 30 |

Overhead ratio (enabled/disabled): mean 0.966x, median 0.974x.

## event-frame-format
### @idle-engine/core
#### Run Details
| Detail | Value |
| --- | --- |
| Commit | b346573e098d06a7eef4d01440b0d13ee09cf0c7 |
| Node | v22.21.1 |
| Platform | linux |
| Arch | x64 |
| Config: Iterations | 200 |
| Config: Scenarios | 2 |

#### Scenarios
| Scenario | Events/Tick | Struct Mean (ms) | Struct Median (ms) | Struct Hz | Object Mean (ms) | Object Median (ms) | Object Hz | Mean Ratio (object/struct) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dense | 200 | 0.0722 | 0.0460 | 13856.38 | 0.0457 | 0.0301 | 21904.29 | 0.633 |
| sparse | 8 | 0.0224 | 0.0072 | 44725.76 | 0.0045 | 0.0037 | 219821.29 | 0.203 |

## runtime-workload-sim
### @idle-engine/runtime-sim-cli
#### Run Details
| Detail | Value |
| --- | --- |
| Commit | b346573e098d06a7eef4d01440b0d13ee09cf0c7 |
| Node | v22.21.1 |
| Platform | linux |
| Arch | x64 |
| Config: Step Size (ms) | 100 |
| Config: Warmup Ticks | 50 |
| Config: Measure Ticks | 300 |
| Config: Seed | 4242 |
| Config: Scenarios | 2 |
| Config: Include Memory | false |

#### Scenarios
| Scenario | Mean (ms) | Median (ms) | Max (ms) | Slow Ticks | Max Queue Backlog | Dropped | Snapshot (KB) | RSS (MB) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sample-pack-baseline | 0.2299 | 0.1960 | 3.3909 | 0 | 1 | 0 | 565.63 | n/a |
| sample-pack-progression | 0.2306 | 0.2319 | 1.1199 | 0 | 1 | 0 | 565.58 | n/a |

## state-sync-checksum
### @idle-engine/core
#### Run Details
| Detail | Value |
| --- | --- |
| Commit | b346573e098d06a7eef4d01440b0d13ee09cf0c7 |
| Node | v22.21.1 |
| Platform | linux |
| Arch | x64 |
| Config: Warmup Iterations | 2000 |
| Config: Measure Iterations | 20000 |
| Config: Runs | 5 |
| Config: Target (us) | 100 |
| Config: Enforce Target | false |

#### Scenarios
| Scenario | Shape | Mean (us) | Median (us) | Min (us) | Max (us) | Target (us) | Mean/Target | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| doc-typical | R100 G50 U0 Ach0 Auto0 Tr0 Cmd0 | 127.06 | 125.85 | 121.79 | 135.45 | 100 | 1.271 | ABOVE_TARGET |
| typical-expanded | R100 G50 U40 Ach20 Auto15 Tr10 Cmd8 | 212.50 | 211.73 | 204.11 | 222.53 | 100 | 2.125 | INFO |
| small | R20 G10 U8 Ach6 Auto5 Tr3 Cmd2 | 59.01 | 58.56 | 57.77 | 61.36 | 100 | 0.590 | INFO |
| large | R500 G250 U200 Ach100 Auto80 Tr60 Cmd40 | 1049.83 | 1057.04 | 1000.92 | 1082.63 | 100 | 10.498 | INFO |
