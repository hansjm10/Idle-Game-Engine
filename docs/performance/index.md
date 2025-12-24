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
| Commit | 008ec48147158fd8256a6547d114fca2c02b5094 |
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
| diagnostics-disabled | false | 322.2929 | 309.1929 | 3.10 | 558.63 | 30 |
| diagnostics-enabled | true | 335.1000 | 329.2105 | 2.98 | 495.98 | 30 |

Overhead ratio (enabled/disabled): mean 1.040x, median 1.065x.

## event-frame-format
### @idle-engine/core
#### Run Details
| Detail | Value |
| --- | --- |
| Commit | 008ec48147158fd8256a6547d114fca2c02b5094 |
| Node | v22.21.1 |
| Platform | linux |
| Arch | x64 |
| Config: Iterations | 200 |
| Config: Scenarios | 2 |

#### Scenarios
| Scenario | Events/Tick | Struct Mean (ms) | Struct Median (ms) | Struct Hz | Object Mean (ms) | Object Median (ms) | Object Hz | Mean Ratio (object/struct) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dense | 200 | 0.0898 | 0.0702 | 11137.48 | 0.0588 | 0.0497 | 17005.12 | 0.655 |
| sparse | 8 | 0.0305 | 0.0154 | 32795.98 | 0.0066 | 0.0066 | 152338.36 | 0.215 |

## state-sync-checksum
### @idle-engine/core
#### Run Details
| Detail | Value |
| --- | --- |
| Commit | 008ec48147158fd8256a6547d114fca2c02b5094 |
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
| doc-typical | R100 G50 U0 Ach0 Auto0 Tr0 Cmd0 | 153.25 | 151.13 | 147.10 | 159.90 | 100 | 1.532 | ABOVE_TARGET |
| typical-expanded | R100 G50 U40 Ach20 Auto15 Tr10 Cmd8 | 269.44 | 266.29 | 249.04 | 292.17 | 100 | 2.694 | INFO |
| small | R20 G10 U8 Ach6 Auto5 Tr3 Cmd2 | 76.79 | 75.19 | 71.21 | 85.94 | 100 | 0.768 | INFO |
| large | R500 G250 U200 Ach100 Auto80 Tr60 Cmd40 | 1159.28 | 1160.56 | 1143.92 | 1174.06 | 100 | 11.593 | INFO |
