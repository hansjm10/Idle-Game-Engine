# @idle-engine/core

Skeleton implementation of the idle engine runtime. This placeholder exposes a deterministic tick accumulator that systems can register against. Future work will flesh out state graphs and persistence.

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
