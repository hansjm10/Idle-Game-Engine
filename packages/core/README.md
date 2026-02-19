# @idle-engine/core

Skeleton implementation of the idle engine runtime. This placeholder exposes a deterministic tick accumulator that systems can register against. Future work will flesh out state graphs and persistence.

## Entry points

- `@idle-engine/core` / `@idle-engine/core/public`: stable, documented public API (`/public` is a strict alias for readability).
- `@idle-engine/core/harness`: supported, experimental integration surface for host shells and test runners (save parsing + deterministic snapshot helpers) without depending on `@idle-engine/core/internals`.
- `@idle-engine/core/internals`: full surface for engine contributors and advanced tooling; no stability guarantees.
- `@idle-engine/core/prometheus`: Node-only Prometheus telemetry integration.

### Choosing an entry point

- Game code should stay on the stable surface (`@idle-engine/core`).
- Shells and test harnesses that need save parsing or deterministic snapshot building should use `@idle-engine/core/harness`.
- Engine contributors and advanced tooling can reach for `@idle-engine/core/internals`, but it may break at any time.

The harness surface is supported but `@stability experimental` and may change as the engine evolves. Prefer promoting broadly useful helpers into the stable `@idle-engine/core` entry point rather than growing the harness API by accident.

## Stable exports

The stable surface of `@idle-engine/core` intentionally stays small:

- Runtime wiring: `IdleEngineRuntime`, `createGameRuntime`, `wireGameRuntime` (plus types like `TickContext`, `System`, and `GameRuntimeWiring`)
- Commands: `RUNTIME_COMMAND_TYPES`, `CommandPriority` (plus types like `RuntimeCommand` and `RuntimeCommandPayloads`)
- Events: `EventBus`, `buildRuntimeEventFrame`, `EventBroadcastBatcher`, `EventBroadcastDeduper`, `applyEventBroadcastFrame`, `applyEventBroadcastBatch`, `createEventBroadcastFrame`, `createEventTypeFilter`, `GENERATED_RUNTIME_EVENT_DEFINITIONS`
- Versioning: `RUNTIME_VERSION`

## Avoiding accidental internals usage

For game code, prefer importing from `@idle-engine/core` and avoid depending on `@idle-engine/core/internals` unless you are intentionally integrating with engine internals.

For host shells and test runners, prefer `@idle-engine/core/harness` before opting into `@idle-engine/core/internals`.

If you use ESLint, you can enforce this in consumer packages via `@idle-engine/config-eslint`:

```js
import { createConfig } from '@idle-engine/config-eslint';

export default createConfig({
  restrictCoreInternals: 'error',
});
```

If you aren't using `@idle-engine/config-eslint`, you can also configure `no-restricted-imports` directly:

```js
export default [
  {
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['@idle-engine/core/internals'],
        },
      ],
    },
  },
];
```

## Event broadcast

Use event broadcast helpers to serialize runtime event frames on the server and hydrate them on clients. The `frame` below comes from `buildRuntimeEventFrame`.

```ts
import {
  EventBroadcastBatcher,
  EventBroadcastDeduper,
  applyEventBroadcastFrame,
  createEventBroadcastFrame,
  createEventTypeFilter,
} from '@idle-engine/core';

const filter = createEventTypeFilter(['automation:toggled']);
const broadcast = createEventBroadcastFrame(frame, {
  filter,
  includeChecksum: true,
});

const batcher = new EventBroadcastBatcher({ maxSteps: 5 });
const batches = batcher.ingestFrame(broadcast);

const deduper = new EventBroadcastDeduper();
applyEventBroadcastFrame(clientBus, broadcast, { deduper });
```
