# @idle-engine/core

Skeleton implementation of the idle engine runtime. This placeholder exposes a deterministic tick accumulator that systems can register against. Future work will flesh out state graphs, persistence, and social integrations.

## Scheduler capabilities

- Fixed timestep loop with configurable step size, foreground limits, and deterministic system ordering.
- Background throttling via `IdleEngineRuntime#setBackgroundThrottled` keeps CPU usage low without dropping accumulated time.
- Offline catch-up through `IdleEngineRuntime#runOfflineCatchUp` replays elapsed time with configurable caps and exposes overflow metadata for persistence.
- Diagnostics timeline now records pipeline phases (`commands.capture`, `systems.execute`, `diagnostics.emit`) alongside queue/event metrics for tooling.

The scheduler is also available as `FixedTimestepScheduler` for advanced embedding scenarios.
