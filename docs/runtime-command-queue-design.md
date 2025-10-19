# Runtime Command Queue Design Document

**Issue:** #6
**Workstream:** Runtime Core
**Status:** Design
**Last Updated:** 2025-10-11

> **Execution Order:** Tackle the subissues derived from this document sequentially. Each one must be completed and reviewed before starting the next to keep the workstream focused and in sync.

## 1. Overview

The command queue is a core runtime component that enables deterministic, replayable game state mutations. It decouples user input, automation systems, and server-confirmed actions from immediate execution, allowing the runtime to process all state changes within the fixed-step tick loop described in the engine design.

## 2. Goals

- **Determinism**: All state mutations occur through commands executed within tick steps, ensuring reproducible simulation for offline catch-up and debugging
- **Priority Control**: Support multiple command sources (player, automation, system) with configurable priority tiers to resolve execution order conflicts
- **Serialization**: Enable command recording/replay for debugging, testing, and potential multiplayer synchronization
- **Performance**: Minimal overhead for command enqueueing and processing within the 100ms tick budget
- **Type Safety**: Strongly-typed command payloads that prevent invalid mutations at compile time

## 3. Non-Goals

- Network synchronization protocols (handled by separate social system layer)
- Complex undo/redo UI flows (out of scope for prototype milestone)
- Cross-tick command scheduling (time-based tasks use dedicated Task Scheduler system)

## 3.1 State Graph Structure Requirements

**Decision**: The runtime supports **cyclic state graphs** with **structured-cloneable types**.

### Supported State Structures

The runtime state graph can contain:

1. **Cyclic References**: Parent-child relationships and entity cross-references are fully supported
   ```typescript
   interface Entity {
     id: string;
     parent?: Entity; // Cycle: child → parent → child
     children: Entity[];
     dependencies: Set<Entity>; // Cross-references
   }

   const parent: Entity = { id: 'p', children: [] };
   const child: Entity = { id: 'c', parent, children: [] };
   parent.children.push(child); // Cycle created
   ```

2. **Collection Types**: Map, Set, and native collections are first-class citizens
   ```typescript
   interface GameState {
     entities: Map<string, Entity>; // Entity registry
     activeIds: Set<string>; // Active entity tracking
     resourceGraph: Map<string, Set<string>>; // Adjacency list
   }
   ```

3. **Complex Nested Structures**: Arbitrary nesting depth is supported
   ```typescript
   interface GameState {
     resources: {
       byType: Map<string, {
         instances: Map<string, Resource>;
         producers: Set<Entity>;
       }>;
     };
   }
   ```

### Cloning Behavior

The recorder uses `structuredClone()` which provides:

1. **Cycle Preservation**: Circular references are cloned correctly
   ```typescript
   const original = { self: null };
   original.self = original; // Cycle

   const clone = structuredClone(original);
   clone.self === clone; // true (cycle preserved)
   clone !== original; // true (different object)
   ```

2. **Collection Cloning**: Map and Set are deeply cloned
   ```typescript
   const state = {
     entities: new Map([['e1', { id: 'e1', value: 10 }]])
   };

   const clone = structuredClone(state);
   clone.entities.get('e1').value = 20;
   state.entities.get('e1').value; // Still 10 (deep clone)
   ```

3. **Type Preservation**: Objects maintain their identity
   ```typescript
   const state = {
     timestamp: new Date(),
     config: new Map([['key', 'value']]),
     buffer: new Uint8Array([1, 2, 3])
   };

   const clone = structuredClone(state);
   clone.timestamp instanceof Date; // true
   clone.config instanceof Map; // true
   clone.buffer instanceof Uint8Array; // true
   ```

### Unsupported Types

`structuredClone()` and `deepFreeze()` **cannot handle**:

1. **Functions**: Behavior is lost during cloning
   ```typescript
   // ✗ INVALID state structure
   interface BadState {
     calculate: () => number; // Function cannot be cloned
   }
   ```

2. **Class Instances with Methods**: Only data properties are preserved
   ```typescript
   class Generator {
     constructor(public id: string) {}
     produce() { return 10; } // Method lost during clone
   }

   // ✗ INVALID: Class instances with methods
   const state = { gen: new Generator('g1') };
   const clone = structuredClone(state);
   clone.gen.produce; // undefined (method lost)
   ```

3. **DOM Nodes and Browser APIs**:
   ```typescript
   // ✗ INVALID state structure
   interface BadState {
     element: HTMLElement; // Cannot be cloned
     worker: Worker; // Cannot be cloned
   }
   ```

4. **WeakMap/WeakSet**: Not cloneable
   ```typescript
   // ✗ INVALID state structure
   interface BadState {
     cache: WeakMap<object, any>; // Cannot be cloned
   }
   ```

5. **Symbols as Keys**: Symbol-keyed properties are not cloned
   ```typescript
   const sym = Symbol('key');
   const state = { [sym]: 'value' }; // Symbol key

   const clone = structuredClone(state);
   clone[sym]; // undefined (symbol properties not cloned)
   ```

### State Design Guidelines

**✓ Recommended Pattern**: Plain data with Maps/Sets/Arrays

```typescript
interface GameState {
  // Resources indexed by ID
  resources: Map<string, {
    id: string;
    amount: number;
    rate: number;
  }>;

  // Entity graph with cycles
  entities: Map<string, {
    id: string;
    parent?: string; // Reference by ID, not object (alternative)
    children: string[];
  }>;

  // Or direct object references (cycles preserved)
  entityGraph: Map<string, {
    id: string;
    parent?: EntityNode; // Cycle: child → parent → child (works!)
    children: EntityNode[];
  }>;

  // Temporal data
  timeline: {
    started: Date;
    events: Array<{ at: Date; type: string }>;
  };

  // Metadata
  version: string;
  seed: number; // RNG seed for determinism
}
```

**✗ Anti-Pattern**: Functions, classes, browser APIs

```typescript
// DON'T DO THIS
interface BadGameState {
  // Functions
  calculateProduction: () => number; // Lost during clone

  // Class instances with methods
  factory: new ProductionFactory(); // Methods lost

  // Browser APIs
  canvas: HTMLCanvasElement; // Cannot clone
  cache: WeakMap<Entity, ComputedStats>; // Cannot clone

  // Symbol keys
  [Symbol.for('internal')]: any; // Not cloned
}
```

### Freeze Behavior with Cycles

The `deepFreeze()` implementation handles cycles via `WeakSet` tracking:

```typescript
// Cyclic state is safe
const parent = { id: 'p', children: [] };
const child = { id: 'c', parent };
parent.children.push(child);

deepFreeze(parent);
// ✓ Successfully frozen (WeakSet prevents infinite recursion)

parent.id = 'new'; // Throws: Cannot assign to read only property
child.parent.id = 'new'; // Throws: Same object is frozen
```

### Callback Safety for Snapshots

Iteration helpers such as `Map.prototype.forEach`, `Set.prototype.forEach`, and typed-array traversal methods (`forEach`, `map`, `reduce`, etc.) are wrapped so that the container reference exposed to callbacks is always the immutable proxy. Attempted mutation through the callback-provided collection triggers the same runtime `TypeError` as direct mutation. This prevents accidental leaks where consumers capture the callback argument and call mutating APIs (`set`, `add`, `set()` on typed arrays) on the underlying mutable structure.

Helpers that synthesize new typed-array instances (`map`, `filter`, `subarray`, etc.) also route their return values back through the snapshot factory before handing them to the caller. The clone that is produced is immediately wrapped in the same mutation guards, so even if a consumer chains traversal helpers (`snapshot.typed.map(...).filter(...)`) the intermediate results continue to enforce immutability.

### Performance Implications

1. **Clone Cost**: `structuredClone()` has O(n) cost where n = object graph size
   - Typical game state (10k entities): ~5-10ms clone time
   - Large state (100k entities): ~50-100ms clone time
   - Mitigation: Only clone at recording start, not per command

2. **Freeze Cost**: `deepFreeze()` traverses entire graph once
   - Same complexity as clone: O(n)
   - Only called during `export()`, not on hot path

3. **Memory**: Snapshot holds complete state copy
   - Budget: ~5 MB for moderate game state (from design doc)
   - Monitor via telemetry if state grows beyond budget

## 4. Architecture

### 4.1 Command Interface

Commands follow the classic Command pattern with typed payloads:

```typescript
export interface Command<TPayload = unknown> {
  readonly type: string;
  readonly priority: CommandPriority;
  readonly payload: TPayload;
  readonly timestamp: number; // For ordering within same priority
  readonly step: number; // Simulation tick that will execute the command
}

type ImmutablePrimitive =
  | string
  | number
  | bigint
  | boolean
  | symbol
  | null
  | undefined;

type ImmutableFunction = (...args: unknown[]) => unknown;

type ImmutableArrayLike<T> = readonly ImmutablePayload<T>[];

export type ImmutablePayload<T> = T extends ImmutablePrimitive
  ? T
  : T extends ImmutableFunction
    ? T
    : T extends ArrayBuffer
      ? ImmutableArrayBufferSnapshot
      : T extends SharedArrayBuffer
        ? ImmutableSharedArrayBufferSnapshot
        : T extends Map<infer K, infer V>
          ? ReadonlyMap<ImmutablePayload<K>, ImmutablePayload<V>>
          : T extends Set<infer V>
            ? ReadonlySet<ImmutablePayload<V>>
            : T extends Array<infer U>
              ? ImmutableArrayLike<U>
              : T extends ReadonlyArray<infer U>
                ? ImmutableArrayLike<U>
                : T extends object
                  ? { readonly [K in keyof T]: ImmutablePayload<T[K]> }
                  : T;

export type CommandSnapshot<TPayload = unknown> = ImmutablePayload<
  Command<TPayload>
>;

export type CommandSnapshotPayload<TPayload> = ImmutablePayload<TPayload>;

export enum CommandPriority {
  SYSTEM = 0,    // Engine-generated (migrations, prestige resets)
  PLAYER = 1,    // Direct user input (purchase, toggle)
  AUTOMATION = 2 // Automated systems (auto-buy, auto-prestige)
}
```

### 4.2 Command Queue Structure

The queue maintains separate lanes per priority with FIFO ordering within each lane:

```typescript
interface CommandQueueEntry<TCommand extends Command = Command> {
  readonly command: TCommand;
  readonly sequence: number; // Tie-breaker when timestamps match
}

export class CommandQueue {
  private readonly queues: Map<
    CommandPriority,
    CommandQueueEntry<CommandSnapshot>[]
  > = new Map([
    [CommandPriority.SYSTEM, []],
    [CommandPriority.PLAYER, []],
    [CommandPriority.AUTOMATION, []]
  ]);
  private static readonly PRIORITY_ORDER: CommandPriority[] = [
    CommandPriority.SYSTEM,
    CommandPriority.PLAYER,
    CommandPriority.AUTOMATION
  ];

  private nextSequence = 0;
  private totalSize = 0;

  /**
   * Enqueue a command for execution in the next tick.
   * The step field must already contain the simulation tick that will execute it.
   */
  enqueue(command: Command): void {
    const queue = this.queues.get(command.priority);
    if (!queue) {
      throw new Error(`Invalid priority: ${command.priority}`);
    }

    // Snapshot the command so later mutations (object pooling, payload reuse)
    // cannot alter what eventually executes.
    const storedCommand = cloneCommand(command);

    const entry: CommandQueueEntry<CommandSnapshot> = {
      command: storedCommand,
      sequence: this.nextSequence++
    };

    // Deterministic insertion by timestamp, then sequence for ties.
    let lo = 0;
    let hi = queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const other = queue[mid];
      if (
        other.command.timestamp < entry.command.timestamp ||
        (other.command.timestamp === entry.command.timestamp &&
          other.sequence < entry.sequence)
      ) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    queue.splice(lo, 0, entry);
    this.totalSize++;
  }

  dequeueAll(): CommandSnapshot[] {
    const result: CommandSnapshot[] = [];
    for (const priority of CommandQueue.PRIORITY_ORDER) {
      const queue = this.queues.get(priority);
      if (queue && queue.length > 0) {
        const laneLength = queue.length;
        for (const entry of queue) {
          result.push(entry.command);
        }
        queue.length = 0; // Clear the lane after draining
        this.totalSize -= laneLength;
      }
    }
    return result;
  }

  clear(): void {
    for (const queue of this.queues.values()) {
      this.totalSize -= queue.length;
      queue.length = 0;
    }
    this.totalSize = 0;
  }

  get size(): number {
    return this.totalSize;
  }
}

function cloneCommand(command: Command): CommandSnapshot {
  const snapshot = structuredClone(command);
  return deepFreezeInPlace(snapshot);
}
```

Pre-seeding the per-priority lanes and iterating with `PRIORITY_ORDER` keeps dequeue operations deterministic, while the binary-search insertion guarantees FIFO behavior within a lane based on `timestamp` with a monotonic sequence fallback for ties. Cloning each command on enqueue ensures callers cannot mutate queued payloads after submission, preserving determinism for both live execution and recorded logs. This, combined with the sequence counter, prevents cross-thread enqueue races from reordering commands that share the same priority.

Snapshots surfaced by `dequeueAll()` expose payloads through `CommandSnapshotPayload<T>`; when a payload contains `ArrayBuffer` or `SharedArrayBuffer` instances the accessor yields immutable facades. Call sites must request writable copies with helpers like `toArrayBuffer()` or `toSharedArrayBuffer()` before mutating the data, ensuring replay logs never leak live runtime buffers.

### 4.3 Step Field Population

**Critical Design Pattern**: The `step` field stores the **simulation tick that will execute the command**. The queuing site is responsible for stamping the step as the command crosses into the queue so that handlers receive the correct execution context during live play and replay.

#### Step Stamping Locations

**1. UI Commands (from Main Thread)**

Commands sent from the presentation layer do **not** include the step field. The Worker runtime stamps it using the next execution step before adding the command to the queue:

```typescript
// Main thread - WorkerBridgeImpl.sendCommand()
sendCommand<T>(type: string, payload: T): void {
  this.worker.postMessage({
    type: 'COMMAND',
    command: {
      type,
      payload,
      timestamp: performance.now()
      // NO step field - will be stamped by Worker
    }
  });
}

let currentStep = 0;
let nextExecutableStep = 0; // updated inside the tick loop

// Worker runtime - onmessage handler
self.onmessage = (event) => {
  if (event.data.type === 'COMMAND') {
    commandQueue.enqueue({
      ...event.data.command,
      priority: CommandPriority.PLAYER,
      timestamp: performance.now(), // Overwrite caller-supplied timestamp
      step: nextExecutableStep // <-- Stamp with the tick that will execute the command
    });
  }
};
```

**Stamping Window**: `nextExecutableStep` is set to the current tick immediately
before the runtime captures the batch (`dequeueAll()`), then advanced to
`currentStep + 1` as soon as the batch is secured. Commands that arrive after
the batch capture—including those enqueued from within handlers—are therefore
stamped for the following tick, so `command.step` always matches the tick that
actually executes them.

**Why Worker Stamps It**: The main thread doesn't have access to `currentStep` (it lives in the Worker). Only the Worker runtime knows the current tick number, so stamping happens at enqueue time in the Worker's message handler.

The handler *also* replaces any caller-provided timestamp with the Worker's `performance.now()` reading so hostile callers cannot backdate commands to reorder the queue.

**2. System-Generated Commands (inside Worker)**

Systems running inside the Worker have access to `context.step` (the tick that is currently executing **now**). Because their commands run on the **next** tick, they must stamp `context.step + 1`:

```typescript
class ProductionSystem implements System {
  tick(state: ReadonlyGameState, context: TickContext): void {
    const production = calculateProduction(state, context.deltaMs);

    commandQueue.enqueue({
      type: 'APPLY_PRODUCTION',
      priority: CommandPriority.SYSTEM,
      payload: { resources: production },
      timestamp: performance.now(),
      step: context.step + 1 // <-- Executed next tick, so stamp with step+1
    });
  }
}
```

**Why Systems Stamp It**: `context.step` reflects the tick that is executing right now. Because queued commands run at the start of the *next* tick, the system stamps `context.step + 1` so handlers observe the correct execution tick regardless of whether they are running live or under replay.

**3. Engine Commands (inside Worker)**

Engine-level code (migrations, resets, etc.) must stamp commands with the tick they will execute on. When invoked during tick `currentStep`, the command will execute on `currentStep + 1`:

```typescript
// Option A: Accept currentStep parameter
function executePrestigeReset(currentStep: number, layer: number) {
  commandQueue.enqueue({
    type: 'PRESTIGE_RESET',
    priority: CommandPriority.SYSTEM,
    payload: { layer },
    timestamp: performance.now(),
    step: currentStep + 1 // <-- Executed next tick
  });
}

// Option B: Access global currentStep (inside Worker)
function executeMigration() {
  commandQueue.enqueue({
    type: 'APPLY_MIGRATION',
    priority: CommandPriority.SYSTEM,
    payload: { fromVersion: '1.0', toVersion: '1.1' },
    timestamp: performance.now(),
    step: currentStep + 1 // <-- Executed next tick
  });
}
```

#### Step Lifecycle Summary

```
┌─────────────────────────────────────────────────────────────┐
│ Tick N                                                      │
├─────────────────────────────────────────────────────────────┤
│ 1. currentStep = N                                          │
│ 2. Capture commands for step N (dequeueAll)                │
│    - Immediately set nextExecutableStep = N+1              │
│ 3. Execute queued commands (all have step = N)             │
│    - Handlers see ctx.step = cmd.step = N                  │
│    - Follow-on enqueues are stamped with step = N+1        │
│ 4. Systems tick() with context.step = N                    │
│    - Each system enqueues commands stamped with step = N+1 │
│ 5. currentStep++ (becomes N+1)                             │
│    - nextExecutableStep ← currentStep (now N+1)            │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Tick N+1                                                    │
├─────────────────────────────────────────────────────────────┤
│ 1. currentStep = N+1                                        │
│ 2. Capture commands for step N+1 (dequeueAll)              │
│    - Immediately set nextExecutableStep = N+2              │
│ 3. Execute queued commands (all have step = N+1)           │
│    - Includes UI commands posted after tick N              │
│ 4. Systems tick() with context.step = N+1                  │
│    - Enqueue commands stamped with step = N+2              │
│ 5. currentStep++ (becomes N+2)                             │
│    - nextExecutableStep ← currentStep (now N+2)            │
└─────────────────────────────────────────────────────────────┘
```

**Key Insight**: `command.step` always matches the simulation tick that will execute the command. Systems add `+1` because their work executes on the next tick, while the Worker stamps external commands with `nextExecutableStep` (which is ready to run on the upcoming tick). This keeps live execution and replay perfectly aligned.

#### Replay Behavior

During replay, `CommandRecorder.replay()` uses `cmd.step` directly to build execution context:

```typescript
for (const cmd of log.commands) {
  const handler = dispatcher.getHandler(cmd.type);
  if (handler) {
    handler(cmd.payload, {
      step: cmd.step, // Use STORED step, not incrementing counter
      timestamp: cmd.timestamp,
      priority: cmd.priority
    });
  }
}
```

This ensures every command sees the same `ctx.step` value during live execution and replay for the tick in which it actually mutates state.

### 4.4 Command Execution Flow

Commands are processed at the start of each tick step, before system execution:

```typescript
let currentStep = 0;        // Tick currently executing
let nextExecutableStep = 0; // Step used to stamp externally-enqueued commands

function runTick(deltaMs: number) {
  accumulator += deltaMs;
  const steps = clamp(floor(accumulator / FIXED_STEP_MS), 0, MAX_STEPS_PER_FRAME);
  accumulator -= steps * FIXED_STEP_MS;

  for (let i = 0; i < steps; i++) {
    // Accept commands for the current step until we capture the batch
    nextExecutableStep = currentStep;
    const commands = commandQueue.dequeueAll();

    // Once the batch is captured, advance stamping to the next step.
    // Any commands enqueued by handlers or telemetry during execution
    // will now target the step that actually runs them.
    nextExecutableStep = currentStep + 1;

    for (const cmd of commands) {
      if (cmd.step !== currentStep) {
        telemetry.recordError('CommandStepMismatch', {
          expectedStep: currentStep,
          commandStep: cmd.step,
          type: cmd.type
        });
        continue; // Skip mis-stamped command to preserve determinism
      }

      commandDispatcher.execute(cmd); // Apply state mutations using cmd.step
    }

    const systemContext: TickContext = {
      step: currentStep,
      deltaMs: FIXED_STEP_MS
    };

    const stateView =
      process.env.NODE_ENV === 'development'
        ? createReadOnlyProxy(gameState)
        : gameState;

    automationSystem.tick(stateView, systemContext);
    productionSystem.tick(stateView, systemContext);
    progressionSystem.tick(stateView, systemContext);
    eventSystem.tick(stateView, systemContext);
    telemetry.recordTick();

    currentStep++;                    // Move to the next simulation step
    nextExecutableStep = currentStep; // Commands arriving before the next dequeue target the new step
  }
}
```

The two-phase `nextExecutableStep` update is deliberate: we briefly set it to
`currentStep` so any commands that slipped in before the batch capture keep
their intended execution tick, then immediately advance it to `currentStep + 1`
before handlers run. Commands that enqueue additional work during execution are
therefore stamped for the following tick, guaranteeing their `cmd.step` matches
the tick that will actually execute them.

The runtime validates this invariant explicitly. A command whose `step` does not
match the tick that is currently executing is treated as a logic error: the
dispatcher skips it and emits a `CommandStepMismatch` telemetry record. This
protects replay determinism by preventing a mis-stamped command from mutating
state on the wrong tick during live execution or replay.

Before systems run, the runtime constructs a shared `TickContext` object and
passes it to every system. At minimum the context includes the `step` that just
executed and the fixed `deltaMs`, so systems have the information they need to
stamp follow-up commands with `context.step + 1` and to perform time-based
calculations deterministically.

```typescript
interface TickContext {
  readonly step: number;    // Tick that just executed
  readonly deltaMs: number; // Fixed step duration in milliseconds
}

type ReadonlyGameState = DeepReadonly<GameState>; // Utility type from shared runtime typings

interface System {
  tick(state: ReadonlyGameState, context: TickContext): void;
}
```

Each system receives a read-only view of `gameState` alongside the tick metadata. In development builds `state` is a proxy that throws on mutation; in production it is the live object reference. Systems must treat the argument as immutable in both cases.

**Critical Constraint**: Systems MUST NOT mutate state directly during `tick()`. Instead, they analyze current state and enqueue commands that will be executed in the **next** tick step. This ensures:
1. All mutations flow through the command queue and are captured by `CommandRecorder`
2. System logic remains pure and testable (reads state, outputs commands)
3. Replaying a command log reproduces identical state without re-running systems

Example of correct system implementation:

```typescript
class AutomationSystem implements System {
  tick(state: ReadonlyGameState, context: TickContext): void {
    // ✓ CORRECT: Read state, enqueue commands for next tick
    const affordable = findAffordableUpgrades(state);
    for (const upgrade of affordable) {
      commandQueue.enqueue({
        type: 'PURCHASE_UPGRADE',
        priority: CommandPriority.AUTOMATION,
        payload: { upgradeId: upgrade.id },
        timestamp: performance.now(),
        step: context.step + 1 // Stamp with the tick that will execute the command
      });
    }
  }
}

class ProductionSystem implements System {
  tick(state: ReadonlyGameState, context: TickContext): void {
    // ✗ WRONG: Direct state mutation bypasses command queue
    // resourceState.addAmount(
    //   resourceState.requireIndex('energy'),
    //   productionRate,
    // );

    // ✓ CORRECT: Enqueue production command
    commandQueue.enqueue({
      type: 'APPLY_PRODUCTION',
      priority: CommandPriority.SYSTEM,
      payload: {
        resources: calculateProduction(state, context.deltaMs)
      },
      timestamp: performance.now(),
      step: context.step + 1 // Stamp with the tick that will execute the command
    });
  }
}
```

**Enforcement**: The runtime provides read-only state proxies to systems. Direct mutation of the top-level state surface throws an error in development mode. Nested objects returned from `Map`/`Set` accessors are **not yet wrapped**; until that work lands, the example below should be interpreted as guarding only the first layer of state. A follow-up task will extend the proxy to decorate collection accessors so values are also read-only.

```typescript
const proxyCache = new WeakMap<object, any>();

function createReadOnlyProxy<T extends object>(target: T, path = 'state'): T {
  if (!target || typeof target !== 'object') {
    return target;
  }

  const cached = proxyCache.get(target);
  if (cached) {
    return cached;
  }

  const proxy = new Proxy(target, {
    get(obj, prop) {
      const value = (obj as any)[prop];

      // Special handling for Map/Set methods - bind them to the target
      if (typeof value === 'function' && (obj instanceof Map || obj instanceof Set)) {
        return value.bind(obj);
      }

      // Wrap nested objects/collections in read-only proxies
      if (value && typeof value === 'object') {
        return createReadOnlyProxy(value, `${path}.${String(prop)}`);
      }

      return value;
    },

    set(obj, prop, value) {
      if (process.env.NODE_ENV === 'development') {
        throw new Error(
          `Systems must not mutate state directly. ` +
          `Attempted to set ${path}.${String(prop)} = ${value}. ` +
          `Use commandQueue.enqueue() instead.`
        );
      }
      return false;
    },

    deleteProperty(obj, prop) {
      if (process.env.NODE_ENV === 'development') {
        throw new Error(
          `Systems must not mutate state directly. ` +
          `Attempted to delete ${path}.${String(prop)}. ` +
          `Use commandQueue.enqueue() instead.`
        );
      }
      return false;
    }
  });

  proxyCache.set(target, proxy);
  return proxy as T;
}

// Usage in tick loop
const readOnlyState = createReadOnlyProxy(gameState);
automationSystem.tick(readOnlyState, context);
```

This proxy intercepts mutations at the **top level** and on **nested plain objects**:

The WeakMap cache ensures each underlying object maps to a single proxy instance, so identity checks (e.g., `child.parent === parent`) still succeed in development builds even with cyclic graphs.

```typescript
// Top-level property mutations throw in development mode:
readOnlyState.resources.energy = 100; // Throws: set state.resources.energy
delete readOnlyState.resources; // Throws: delete state.resources

// Nested plain object mutations also throw:
readOnlyState.config.setting = 'new'; // Throws: set state.config.setting (if config is a plain object)

// Reading works normally at all depths:
const energy = readOnlyState.resources.energy; // OK
const entity = readOnlyState.entities.get('e1'); // OK - Map methods are bound correctly
const hasUpgrade = readOnlyState.unlocks.has('upgrade1'); // OK - Set methods work

// LIMITATION: Values returned from Map/Set are NOT wrapped yet:
readOnlyState.entities.get('e1').health = 50; // Succeeds (entity object not wrapped)
readOnlyState.entities.set('e2', { health: 100 }); // Succeeds (Map.set allowed)
readOnlyState.unlocks.add('upgrade2'); // Succeeds (Set.add allowed)

// A follow-up task will extend the proxy to wrap collection accessor results
```

**Performance Note**: Proxy wrapping adds overhead (~10-20% for deep object access). This enforcement should be:
- **Enabled** in development/test environments to catch violations
- **Disabled** in production (pass raw `gameState` instead of proxy) for performance

### 4.3.1 System-Queue Interaction Model

**Decision**: Systems interact with the command queue **only by enqueueing commands**. They never need to be instrumented for replay.

This approach provides:

1. **Replay Independence**: When replaying a command log, systems are **not executed**. Only commands are re-executed via the dispatcher. This means:
   - `ProductionSystem.tick()` generates `APPLY_PRODUCTION` commands during live play
   - During replay, those same `APPLY_PRODUCTION` commands are executed from the log
   - The production system itself never runs during replay

2. **Deterministic Command Generation**: Systems must be deterministic in their command generation:
   ```typescript
   // ✓ CORRECT: Deterministic - same state always produces same commands
   class ProductionSystem implements System {
     tick(state: ReadonlyGameState, context: TickContext): void {
       const production = calculateProduction(state, context.deltaMs);
       if (production.energy > 0) {
          commandQueue.enqueue({
            type: 'APPLY_PRODUCTION',
            priority: CommandPriority.SYSTEM,
            payload: { energy: production.energy },
            timestamp: performance.now(),
            step: context.step + 1 // Executed on the next tick
          });
        }
      }
    }

   // ✗ WRONG: Non-deterministic - uses timestamp or random values
   class BadSystem implements System {
     tick(state: ReadonlyGameState, context: TickContext): void {
       if (Math.random() > 0.5) { // Non-deterministic!
         commandQueue.enqueue({ /* ... */ });
       }
     }
   }
   ```

3. **Recording During Live Play**: During normal play:
   ```
   Tick N:
     1. Execute queued commands (player inputs from previous tick)
     2. ProductionSystem.tick() → enqueues APPLY_PRODUCTION for tick N+1
     3. AutomationSystem.tick() → enqueues PURCHASE_UPGRADE for tick N+1
     4. Recorder captures all executed commands from step 1

   Tick N+1:
     1. Execute queued commands (APPLY_PRODUCTION, PURCHASE_UPGRADE)
        → Recorder captures these
     2. Systems generate new commands for tick N+2
   ```

4. **Replay Execution**: During replay:
   ```
   Tick N:
     1. Execute recorded commands from log
     2. Systems are NOT called (skip steps 2-4 from live play)
     3. State mutations come purely from commands

   Result: Same final state as live play
   ```

**Implication for System Design**: Systems become **decision engines** that observe state and emit commands. They do not execute game logic directly. Actual state changes happen exclusively in command handlers.

### 4.5 Command Dispatcher

The dispatcher routes commands to appropriate handlers based on command type:

```typescript
export interface ExecutionContext {
  readonly step: number;
  readonly timestamp: number;
  readonly priority: CommandPriority; // Authorization level
}

export type CommandHandler<T = unknown> = (
  payload: T,
  context: ExecutionContext
) => void | Promise<void>;

export class CommandDispatcher {
  private readonly handlers = new Map<string, CommandHandler>();

  register<T>(type: string, handler: CommandHandler<T>): void {
    this.handlers.set(type, handler);
  }

  getHandler(type: string): CommandHandler | undefined {
    return this.handlers.get(type);
  }

  forEachHandler(callback: (type: string, handler: CommandHandler) => void): void {
    for (const [type, handler] of this.handlers.entries()) {
      callback(type, handler);
    }
  }

  execute(command: Command): void {
    const handler = this.handlers.get(command.type);
    if (!handler) {
      telemetry.recordError('UnknownCommandType', { type: command.type });
      return;
    }

    // Build execution context using the command's stored step
    // This ensures replay sees the same ctx.step as live execution
    const context: ExecutionContext = {
      step: command.step, // Use command's step, not currentStep
      timestamp: command.timestamp,
      priority: command.priority
    };

    try {
      const result = handler(command.payload, context);
      if (isPromiseLike(result)) {
        result.catch((err) => {
          telemetry.recordError('CommandExecutionFailed', {
            type: command.type,
            error: err instanceof Error ? err.message : String(err)
          });
        });
      }
    } catch (err) {
      telemetry.recordError('CommandExecutionFailed', {
        type: command.type,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PromiseLike<T>).then === 'function'
  );
}
```

Handlers may return either `void` or a `Promise<void>`. The dispatcher treats promise rejections the same as synchronous exceptions so that telemetry captures failures consistently.

### 4.6 ResourceState Integration

Command handlers no longer mutate `gameState.resources` directly. They depend on the `ResourceState` façade exported from `@idle-engine/core` (`createResourceState`, `ResourceState`, `ResourceStateSnapshot`; see [Resource State Storage Design §5.2](resource-state-storage-design.md#52-runtime-api-surface) and §5.6). The façade centralises index lookups, dirty tracking, and telemetry so handlers follow a consistent pattern:

```typescript
import { type ResourceState } from '@idle-engine/core';

const resources: ResourceState = runtimeResources;

dispatcher.register<CollectResourcePayload>(
  'COLLECT_RESOURCE',
  (payload, ctx) => {
    const index = resources.requireIndex(payload.resourceId);
    const applied = resources.addAmount(index, payload.amount);
    if (applied !== payload.amount) {
      telemetry.recordWarning('ResourceCollectClamped', {
        command: 'COLLECT_RESOURCE',
        resourceId: payload.resourceId,
        requested: payload.amount,
        applied,
        step: ctx.step,
      });
    }
  },
);
```

Key invariants for handlers:

- **Index acquisition**: `requireIndex(id)` throws after recording a `ResourceUnknownId` telemetry event when handed an unknown id, preventing silent array misuse.
- **Mutation helpers**: `addAmount`, `spendAmount`, `setCapacity`, `grantVisibility`, `unlock`, `applyIncome`, and `applyExpense` clamp values, flip dirty bits, and emit telemetry (`ResourceSpendFailed`, `ResourceCapacityInvalidInput`, `ResourceAddAmountNegativeInput`, `ResourceDirtyToleranceSaturated`) when callers violate invariants. Failed spends return `false` and leave balances untouched; pass a `ResourceSpendAttemptContext` so telemetry ties failures back to the originating command or system.
- **Dirty propagation**: Successful mutations mark indices dirty. The façade maintains `dirtyIndexScratch`, `dirtyIndexPositions`, and per-resource tolerances so publish snaps only copy the union of previous/current dirty sets (§5.6).

After `CommandDispatcher.execute` drains the tick, the runtime coordinates the publish/reset sequence with the façade:

1. **Finalize**: Once systems finish queuing per-second rates, call `resourceState.finalizeTick(context.deltaMs)` so accumulated income/expense rolls into balances and `netPerSecond` updates deterministically (§5.2).
2. **Snapshot**: Capture `resourceState.snapshot({ mode: 'publish' })`; the result is immutable-by-contract and exposes the active publish buffers (ids, amounts, capacities, per-second rates, `tickDelta`, flags, tolerance, and `dirtyIndices`).
3. **Transport**: Feed the snapshot into `buildResourcePublishTransport(snapshot, pool, { mode: 'share'|'transfer', tick })` or use `createResourcePublishTransport(resourceState, pool, options)`. The helper allocates slabs from `TransportBufferPool`, copies only the dirty prefix, and returns `{ transport, transferables, release }`.
4. **Publish/Reset**: Post `transport` to the shell worker (optionally transferring buffers). After the shell consumes the frame, call `resourceState.resetPerTickAccumulators()` to zero per-second totals; tests may use `forceClearDirtyState()` when they need a full reset without publishing.

The cross-module flow looks like:

```
┌─────────────────────────────┐
│ CommandDispatcher.execute() │
└┬────────────────────────────┘
 │ ctx.step / ctx.priority
 ▼
┌─────────────────────────────┐
│ Command handler             │
│ - requireIndex(id)          │
│ - add/spend/set             │
│ - optional spend context    │
└┬────────────────────────────┘
 │ ResourceState facade
 ▼
┌─────────────────────────────┐
│ ResourceState               │
│ - clamps + telemetry        │
│ - marks dirty indices       │
└┬────────────────────────────┘
 │ snapshot({ mode: 'publish' })
 ▼
┌─────────────────────────────┐
│ buildResourcePublishTransport│
│ + TransportBufferPool       │
└┬────────────────────────────┘
 │ postMessage / transferables
 ▼
┌─────────────────────────────┐
│ Shell UI consumes deltas    │
└─────────────────────────────┘
```

Telemetry guards remain active in both live play and replay. When replay executes a command log, handlers still call into the same `ResourceState` instance; failed invariants produce identical telemetry, and the publish pipeline stays deterministic because dirty tracking is data-driven rather than frame-order dependent.

## 5. Command Types (Initial Set)

For the prototype milestone, we define commands for core interactions:

### 5.1 Resource Commands

```typescript
// Player purchases a generator
interface PurchaseGeneratorPayload {
  generatorId: string;
  count: number;
}

// Automation toggles a generator
interface ToggleGeneratorPayload {
  generatorId: string;
  enabled: boolean;
}

// Manual resource collection
interface CollectResourcePayload {
  resourceId: string;
  amount: number;
}
```

### 5.2 Prestige Commands

```typescript
// Player initiates prestige reset
interface PrestigeResetPayload {
  layer: number;
  confirmationToken?: string; // Prevents accidental resets
}
```

### 5.3 System Commands

```typescript
// Engine applies offline catch-up adjustments
interface OfflineCatchupPayload {
  elapsedMs: number;
  resourceDeltas: Record<string, number>;
}

// Migration applied during save load
interface ApplyMigrationPayload {
  fromVersion: string;
  toVersion: string;
  transformations: MigrationStep[];
}
```

## 6. Priority Resolution

When multiple commands are enqueued during a single frame:

1. **System commands** (priority 0) execute first, ensuring migrations and resets complete before other mutations
2. **Player commands** (priority 1) execute next, giving user input precedence over automation
3. **Automation commands** (priority 2) execute last, filling gaps not covered by player actions

Within the same priority tier, commands execute in timestamp order (FIFO).

### Example Scenario

Frame receives:
- Player clicks "Buy Generator" at `t=1000.5ms` (PLAYER priority)
- Automation system queues "Auto-buy upgrade" at `t=1000.8ms` (AUTOMATION priority)
- Engine detects save version mismatch, queues migration at `t=1001.0ms` (SYSTEM priority)

Execution order:
1. Migration (SYSTEM, t=1001.0)
2. Buy Generator (PLAYER, t=1000.5)
3. Auto-buy upgrade (AUTOMATION, t=1000.8)

## 7. Integration with Presentation Layer

### 7.1 Worker Bridge API

The Worker bridge provides a type-safe command interface for the presentation layer:

```typescript
export enum CommandSource {
  PLAYER = 'PLAYER',       // User-initiated actions (clicks, keyboard)
  AUTOMATION = 'AUTOMATION', // Automated systems within runtime
  SYSTEM = 'SYSTEM'         // Engine-level operations
}

export interface WorkerBridge {
  // Send command from presentation layer (always uses PLAYER source)
  sendCommand<T = unknown>(type: string, payload: T): void;

  // Subscribe to state updates from runtime
  onStateUpdate(callback: (state: GameState) => void): void;
}
```

The bridge implementation wraps commands with metadata and posts to the Worker:

```typescript
export class WorkerBridgeImpl implements WorkerBridge {
  private stateUpdateCallbacks: Array<(state: GameState) => void> = [];

  constructor(private readonly worker: Worker) {
    // Single message handler dispatches to all subscribers
    this.worker.onmessage = (event) => {
      if (event.data.type === 'STATE_UPDATE') {
        for (const callback of this.stateUpdateCallbacks) {
          callback(event.data.state);
        }
      }
      // Other message types can be added here without collision
    };
  }

  sendCommand<T>(type: string, payload: T): void {
    this.worker.postMessage({
      type: 'COMMAND',
      source: CommandSource.PLAYER, // Always PLAYER from UI
      command: {
        type,
        payload,
        timestamp: performance.now()
        // step will be stamped by Worker runtime when enqueuing
      }
    });
  }

  onStateUpdate(callback: (state: GameState) => void): void {
    this.stateUpdateCallbacks.push(callback);
  }

  offStateUpdate(callback: (state: GameState) => void): void {
    const index = this.stateUpdateCallbacks.indexOf(callback);
    if (index !== -1) {
      this.stateUpdateCallbacks.splice(index, 1);
    }
  }
}
```

### 7.2 Runtime Command Reception

The Worker runtime receives messages from the main thread and **must treat all external messages as PLAYER priority**:

```typescript
const runtimeClock = createMonotonicClock();

// Worker message handler - CRITICAL SECURITY BOUNDARY
self.onmessage = (event) => {
  if (event.data.type === 'COMMAND') {
    // SECURITY: All commands from main thread (postMessage) are PLAYER priority.
    // The Worker never trusts caller-provided metadata (source, timestamp, etc).
    commandQueue.enqueue({
      ...event.data.command,
      priority: CommandPriority.PLAYER, // Always PLAYER from external source
      timestamp: runtimeClock.now(), // Stamp inside the Worker to prevent tampering
      step: nextExecutableStep // Stamp with the tick that will execute the command
    });
  }
};

function createMonotonicClock() {
  let last = 0;
  return {
    now(): number {
      const raw = performance.now();
      last = raw > last ? raw : last + 0.0001;
      return last;
    }
  };
}
```

**Internal Command Enqueueing** (within Worker):

Systems and engine code running **inside the Worker** can enqueue with elevated priorities:

```typescript
// ProductionSystem (runs inside Worker)
class ProductionSystem implements System {
  tick(state: ReadonlyGameState, context: TickContext): void {
    const production = calculateProduction(state, context.deltaMs);

    // Direct enqueue with SYSTEM priority (safe - code runs in Worker)
    commandQueue.enqueue({
      type: 'APPLY_PRODUCTION',
      priority: CommandPriority.SYSTEM, // OK - internal code
      payload: { resources: production },
      timestamp: performance.now(),
      step: context.step + 1 // Executed next tick
    });
  }
}

// Prestige reset (engine code inside Worker)
function executePrestigeReset(currentStep: number, layer: number) {
  commandQueue.enqueue({
    type: 'PRESTIGE_RESET',
    priority: CommandPriority.SYSTEM, // OK - internal code
    payload: { layer },
    timestamp: performance.now(),
    step: currentStep + 1 // Executed next tick
  });
}
```

**Security Architecture**:

1. **Trust Boundary**: The Worker's `self.onmessage` handler is the security boundary
   - **Untrusted**: Any message from main thread (includes UI, dev tools, injected scripts)
   - **Trusted**: Code executing within the Worker context

2. **Priority & Timestamp Assignment**:
   - Messages from `postMessage()` → **Always PLAYER priority** and receive a Worker-stamped timestamp that advances monotonically
   - Internal `commandQueue.enqueue()` calls → Use specified priority (trusted code) and can supply their own timestamp/ordering metadata

3. **Attack Prevention**:
   ```typescript
   // ✗ Attack attempt (from compromised UI):
   worker.postMessage({
     type: 'COMMAND',
     source: 'SYSTEM', // Attacker tries to escalate
     command: { type: 'GRANT_RESOURCES', payload: { energy: 9999999 } }
   });

   // ✓ Runtime handles safely:
   // - Ignores event.data.source and event.data.command.timestamp
   // - Forces priority = PLAYER
   // - Replaces timestamp with Worker-owned monotonic clock
   // - Command executes with normal player permissions
   ```

4. **Authorization via Priority**: Command handlers use `context.priority` to enforce permissions:
   ```typescript
  const resources: ResourceState = runtimeResources; // Created via createResourceState(...)

  // System-only commands check priority
  const grantResourcesHandler = (
    payload: GrantResourcesPayload,
    ctx: ExecutionContext
  ) => {
    // Only SYSTEM priority can execute this command
    if (ctx.priority !== CommandPriority.SYSTEM) {
      telemetry.recordWarning('UnauthorizedSystemCommand', {
        payload,
        attemptedPriority: ctx.priority
      });
      return; // Reject - only system commands allowed
    }

    const index = resources.requireIndex(payload.resourceId);
    resources.addAmount(index, payload.amount); // Marks dirty + clamps internally
  };

  // Most commands accept any priority (SYSTEM, PLAYER, or AUTOMATION)
  const purchaseGeneratorHandler = (
    payload: PurchaseGeneratorPayload,
    ctx: ExecutionContext
  ) => {
    // All priorities can purchase - no authorization check needed
    // (Purchases are gated by resource cost, not priority)

    const generator = registry.getGenerator(payload.generatorId);
    const totalCost = generator.cost * payload.count;
    const energyIndex = resources.requireIndex('energy'); // Sample pack purchases spend energy

    const spendSucceeded = resources.spendAmount(energyIndex, totalCost, {
      commandId: 'PURCHASE_GENERATOR',
      systemId:
        ctx.priority === CommandPriority.AUTOMATION ? 'auto-buy' : undefined
    });

    if (!spendSucceeded) {
      telemetry.recordWarning('InsufficientResources', {
        generatorId: payload.generatorId,
        cost: totalCost,
        priority: ctx.priority
      });
      return; // Command rejected, no state mutation
    }

    generator.owned += payload.count;
  };

   // Some commands restrict based on priority
   const prestigeResetHandler = (
     payload: PrestigeResetPayload,
     ctx: ExecutionContext
   ) => {
     // Only PLAYER or SYSTEM can trigger prestige (prevents automation accidents)
     if (ctx.priority === CommandPriority.AUTOMATION) {
       telemetry.recordWarning('AutomationPrestigeBlocked', { payload });
       return; // Require explicit player confirmation
     }

     // Execute prestige reset with current step and layer
     executePrestigeReset(ctx.step, payload.layer);
   };
   ```

   **Priority Authorization Levels**:
   - `CommandPriority.SYSTEM` (0): Full authority - migrations, admin tools, engine operations
   - `CommandPriority.PLAYER` (1): User-initiated - purchases, prestige, manual actions
   - `CommandPriority.AUTOMATION` (2): Automated - purchases allowed, but some operations restricted (prestige)

   **Handler Authorization Patterns**:
   - **No restrictions** (purchases, resource collection): Accept any priority
   - **Player-or-System only** (prestige, destructive actions): Block AUTOMATION
   - **System-only** (migrations, debug commands): Require SYSTEM priority
   ```

**Security Note**: The `CommandSource` enum exists for documentation purposes, but the Worker **never trusts the source field from external messages**. All `postMessage()` commands are treated as PLAYER priority, regardless of what the sender claims. Only code running inside the Worker can enqueue SYSTEM or AUTOMATION commands.

### 7.3 Usage in React Components

```typescript
// In React component
import { useWorkerBridge } from '@idle-engine/shell-web';

function GeneratorButton({ id, cost }: GeneratorProps) {
  const bridge = useWorkerBridge();

  const handlePurchase = () => {
    bridge.sendCommand('PURCHASE_GENERATOR', {
      generatorId: id,
      count: 1
    });
  };

  return <button onClick={handlePurchase}>Buy Reactor ({cost} energy)</button>;
}
```

### 7.4 Automation System Integration

Automation systems run **inside the Worker** and can enqueue commands directly:

```typescript
// Inside Worker - Automation System
class AutoBuySystem implements System {
  tick(state: ReadonlyGameState, context: TickContext): void {
    const affordable = findAffordableUpgrades(state);

    for (const upgrade of affordable) {
      commandQueue.enqueue({
        type: 'PURCHASE_UPGRADE',
        priority: CommandPriority.AUTOMATION, // Direct priority assignment
        payload: { upgradeId: upgrade.id },
        timestamp: performance.now(),
        step: context.step + 1 // Executed next tick
      });
    }
  }
}
```

This architecture ensures:
- UI commands always get `PLAYER` priority via the bridge
- Automation systems can only enqueue from within the Worker runtime
- System commands are reserved for engine-level operations (migrations, resets)

## 8. Command Recording & Replay

For debugging and testing, the runtime can record all executed commands.

### 8.1 Recorder Snapshot Lifecycle

**Decision**: The recorder captures its state snapshot at **construction time**, before any commands are recorded.

This design ensures:

1. **Snapshot Timing**: The snapshot represents the **exact** state from which the first recorded command will execute
   ```typescript
   // Correct usage - snapshot taken before any mutations
   const initialState = createGameState();
   const recorder = new CommandRecorder(initialState); // Snapshot captured here

   // Now safe to mutate state via commands
   recorder.record(buyGeneratorCommand); // Record first
   dispatcher.execute(buyGeneratorCommand); // Then execute
   ```

2. **Lifecycle Guarantees**:
  - **Construction**: `new CommandRecorder(state)` performs `deepFreeze(cloneDeep(state))` immediately and snapshots the active RNG seed (via `getCurrentRNGSeed()` or an explicit override)
   - **Recording**: `record(cmd)` appends to internal array, does not touch snapshot
   - **Export**: `export()` returns frozen log containing the original snapshot + recorded commands
   - **Replay**: `replay(log)` restores `log.startState`, then executes `log.commands` in order

3. **Usage Patterns**:

   **Pattern A: Session Recording (typical use case)**
   ```typescript
   // At game load/start
   const gameState = await loadSaveOrCreateNew();
   const sessionRecorder = new CommandRecorder(gameState); // Snapshot at session start

   // During play - record commands then execute them
   function executeAndRecord(cmd: Command) {
     sessionRecorder.record(cmd); // Record first
     dispatcher.execute(cmd);     // Then execute
   }

   // On crash/bug report
   const log = sessionRecorder.export(); // Contains all commands from session start
   sendToServer(log);

   // Replaying a log (separate replay-only dispatcher to avoid recording)
   function replayBugReport(log: CommandLog) {
     const replayDispatcher = new CommandDispatcher();
     // Copy handlers from main dispatcher
     mainDispatcher.forEachHandler((type, handler) => {
       replayDispatcher.register(type, handler);
     });

     const replayRecorder = new CommandRecorder(log.startState);
     replayRecorder.replay(log, replayDispatcher);
   }
   ```

   **Pattern B: Deterministic Testing**
   ```typescript
   // Test setup
   const testState = { resources: { energy: 100 }, generators: {} };
   const recorder = new CommandRecorder(testState); // Known initial state

   // Execute test scenario
   const commands = [
     buyGeneratorCommand,
     waitCommand,
     collectResourceCommand
   ];

   for (const cmd of commands) {
     recorder.record(cmd);
     dispatcher.execute(cmd);
   }

   // Verify replay matches
   const log = recorder.export();
   const replayState = await replayLog(log);
   expect(replayState).toEqual(currentState);
   ```

   **Pattern C: Sub-session Recording**
   ```typescript
   // Record only a specific interaction, not full session
   function recordUserFlow(startState: GameState) {
     const recorder = new CommandRecorder(startState); // Snapshot before flow

     // User completes prestige flow
     executePrestigeCommands();

     return recorder.export(); // Just the prestige commands
   }
   ```

4. **Anti-patterns (will cause replay mismatch)**:
   ```typescript
   // ✗ WRONG: Mutating state before creating recorder
   const state = createGameState();
   state.resources.energy = 50; // Mutation
   const recorder = new CommandRecorder(state); // Snapshot includes mutation
   // Later commands assume energy=50, but original state was different

   // ✗ WRONG: Reusing recorder after state reset
   const recorder = new CommandRecorder(initialState);
   recorder.record(cmd1);
   gameState = resetToInitial(); // State reset
   recorder.record(cmd2); // cmd2 assumes reset state, but snapshot is pre-reset

// ✓ CORRECT: Reinitialize recorder after reset
const recorder = new CommandRecorder(initialState);
recorder.record(cmd1);

gameState = resetToInitial();
recorder.clear(gameState); // Refresh snapshot so new commands replay correctly
recorder.record(cmd2);
```

`clear(nextState)` always clones and freezes the new baseline before recording resumes, preventing stale snapshots from leaking across sessions.

> **Seed overrides**: Tests or tooling that drive a specific PRNG stream can provide `new CommandRecorder(state, { seed })` or `recorder.clear(nextState, { seed })`. When omitted, the recorder falls back to the runtime's `getCurrentRNGSeed()` helper.

5. **Tooling Implications**:
   - **Dev Tools**: Recorder starts when dev panel opens, captures state at that moment
   - **CI Tests**: Each test case creates fresh recorder with known fixture state
   - **Bug Reports**: Session recorder created at game initialization, runs for entire session
   - **A/B Testing**: Strategy simulator creates recorder per simulation run

### 8.2 Implementation

To avoid ambiguity when we wire this into the runtime, we will introduce a concrete alias alongside the queue implementation:

```typescript
export type StateSnapshot = DeepReadonly<GameState>;
```

`StateSnapshot` represents the exact shape produced by `structuredClone(gameState)`—all fields are recursively read-only and restricted to structured-clone-friendly types. The alias will live in the shared runtime typings so both the recorder and replay utilities consume the same definition. If additional serialization constraints emerge (e.g., stripping out non-cloneable dev-only fields), the alias should be updated to wrap an explicit `SerializableGameState` interface, but the contract remains: snapshots must be safe to clone, freeze, and ship across worker boundaries.

```typescript
export interface CommandLog {
  readonly version: string;
  readonly startState: StateSnapshot;
  readonly commands: readonly Command[];
  readonly metadata: {
    readonly recordedAt: number;
    readonly seed?: number; // Active RNG seed captured at record time
    readonly lastStep: number; // Highest step observed while recording (-1 when nothing executed)
  };
}

export interface RuntimeReplayContext {
  readonly commandQueue: CommandQueue;
  getCurrentStep?(): number;
  getNextExecutableStep?(): number;
  setCurrentStep?(step: number): void;
  setNextExecutableStep?(step: number): void;
}

// The runtime exposes the current deterministic PRNG seed via `getCurrentRNGSeed()`.
// Tests or tooling can override the captured value by supplying `{ seed }` to the
// recorder constructor or `clear()` helper.

// metadata.lastStep allows the runtime to realign its current/next step counters
// after replay so that subsequent ticks tick from the same position as the
// original session.

export class CommandRecorder {
  private readonly recorded: Command[] = [];
  private startState: StateSnapshot; // Stored as cloneable, plain data
  private rngSeed: number | undefined;
  private lastRecordedStep = -1;

  constructor(currentState: GameState, options?: { seed?: number }) {
    // Clone state immediately (cloneable, not frozen)
    this.startState = cloneDeep(currentState);
    // Freeze the clone to prevent accidental mutation
    deepFreezeInPlace(this.startState);
    // Capture the RNG seed so replay can restore identical randomness
    this.rngSeed = options?.seed ?? getCurrentRNGSeed?.();
  }

  record(command: Command): void {
    const snapshot = cloneDeep(command);   // Defensively copy the command
    deepFreezeInPlace(snapshot);           // Freeze to catch accidental mutation in dev
    this.recorded.push(snapshot);
    this.lastRecordedStep = Math.max(this.lastRecordedStep, command.step);
  }

  export(): CommandLog {
    const lastStep = this.lastRecordedStep;

    // Return defensive copy - clone the snapshot again for export
    const exportedLog = {
      version: '0.1.0',
      startState: cloneDeep(this.startState), // Fresh clone (unfrozen)
      commands: this.recorded.map(cloneDeep), // New clones so log remains isolated
      metadata: {
        recordedAt: Date.now(),
        seed: this.rngSeed,
        lastStep
      }
    };

    // Freeze the exported log to prevent mutation
    deepFreezeInPlace(exportedLog);
    return exportedLog as CommandLog;
  }

  // runtimeContext is optional; when omitted replay runs against ephemeral queue/state
  replay(log: CommandLog, dispatcher: CommandDispatcher, runtimeContext?: RuntimeReplayContext): void {
    // Clone the snapshot to get a mutable working copy
    const mutableState = cloneDeep(log.startState);

    // Restore to initial state
    restoreState(mutableState);

    // Restore RNG seed if present (for deterministic random handlers)
    if (log.metadata.seed !== undefined) {
      setRNGSeed(log.metadata.seed);
    }

    // Sandbox command enqueueing so replay cannot mutate the live queue, while
    // still verifying that every follow-up enqueue is present in the recorded log.
    const queue =
      runtimeContext?.commandQueue ??
      new CommandQueue(); // Isolated queue for replay when no runtime context is supplied

    if (queue.size > 0) {
      telemetry.recordError('ReplayQueueNotEmpty', { pending: queue.size });
      throw new Error('Command queue must be empty before replay begins.');
    }
    const sandboxedEnqueues: Command[] = [];
    const originalEnqueue = queue.enqueue.bind(queue);

    const recordedFinalStep = log.metadata.lastStep ?? -1;
    const derivedFinalStep =
      log.commands.length > 0
        ? log.commands.reduce((max, cmd) => Math.max(max, cmd.step), -1)
        : -1;
    const finalStep = recordedFinalStep >= 0 ? recordedFinalStep : derivedFinalStep;
    const previousStep = runtimeContext?.getCurrentStep?.();
    const previousNextStep = runtimeContext?.getNextExecutableStep?.();
    let replayFailed = true;

    // Track which future commands have already been matched to handler enqueues.
    const matchedFutureCommandIndices = new Set<number>();

    (queue as any).enqueue = (cmd: Command) => {
      const snapshot = cloneDeep(cmd);
      deepFreezeInPlace(snapshot);
      sandboxedEnqueues.push(snapshot);
    };

    try {
      for (let i = 0; i < log.commands.length; i++) {
        const cmd = log.commands[i];

        const context: ExecutionContext = {
          step: cmd.step, // Use stored step, NOT an incrementing counter
          timestamp: cmd.timestamp,
          priority: cmd.priority
        };

        const handler = dispatcher.getHandler(cmd.type);
        if (!handler) {
          telemetry.recordError('ReplayUnknownCommandType', {
            type: cmd.type,
            step: cmd.step
          });
        } else {
          try {
            handler(cmd.payload, context);
          } catch (err) {
            telemetry.recordError('ReplayExecutionFailed', {
              type: cmd.type,
              step: cmd.step,
              error: err instanceof Error ? err.message : String(err)
            });
          }
        }

        if (sandboxedEnqueues.length > 0) {
          for (const queued of sandboxedEnqueues) {
            const matchIndex = findMatchingFutureCommandIndex(
              log.commands,
              queued,
              i + 1,
              matchedFutureCommandIndices
            );

            if (matchIndex === -1) {
              telemetry.recordError('ReplayMissingFollowupCommand', {
                type: queued.type,
                step: queued.step
              });
              throw new Error(
                'Replay log is missing a command that was enqueued during handler execution.'
              );
            }

            matchedFutureCommandIndices.add(matchIndex);
          }

          sandboxedEnqueues.length = 0;
        }
      }

      replayFailed = false;
    } finally {
      (queue as any).enqueue = originalEnqueue;
      if (replayFailed) {
        if (previousStep !== undefined) {
          runtimeContext?.setCurrentStep?.(previousStep);
        }
        if (previousNextStep !== undefined) {
          runtimeContext?.setNextExecutableStep?.(previousNextStep);
        }
      } else if (finalStep >= 0 && runtimeContext) {
        runtimeContext.setCurrentStep?.(finalStep + 1);
        runtimeContext.setNextExecutableStep?.(finalStep + 1);
      }
    }
  }

  clear(nextState: GameState, options?: { seed?: number }): void {
    this.recorded.length = 0;
    this.startState = cloneDeep(nextState);
    deepFreezeInPlace(this.startState);
    this.rngSeed = options?.seed ?? getCurrentRNGSeed?.();
    this.lastRecordedStep = -1;
  }
}

When a replay runs without a `RuntimeReplayContext`, the recorder provisions a throwaway `CommandQueue` so that handler enqueues are still sandboxed and validated without touching the live runtime state. Tooling and tests can therefore replay logs in isolation, while embedding runtimes can opt into sharing their real queue by supplying the context.

// Recording always stores frozen clones so later mutations (payload pooling,
// handler-side adjustments, dev tools poking) cannot corrupt the captured
// history. Exporting clones the array again, keeping each log immutable and
// isolated from future recordings.

declare const getCurrentRNGSeed:
  | (() => number | undefined)
  | undefined; // Provided by RNG module; may be undefined in tests

// Utility functions
function cloneDeep<T>(obj: T): T {
  return structuredClone(obj); // Native deep clone (Node 17+, all modern browsers)
}

/**
 * Restore RNG seed for deterministic replay.
 * Handlers that use randomness must use this seeded RNG, not Math.random().
 */
function setRNGSeed(seed: number): void {
  // Implementation depends on RNG library (e.g., seedrandom, mulberry32)
  // Example with seedrandom:
  // Math.random = seedrandom(seed.toString());

  // Or with custom PRNG:
  rngState = seed;
}

function seededRandom(): number {
  // Deterministic PRNG (e.g., mulberry32)
  rngState = (rngState + 0x6D2B79F5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * Locate the first future command in the log that matches the queued command.
 * Replay asserts deterministic timestamps so handlers that stamp commands must be pure.
 */
function findMatchingFutureCommandIndex(
  commands: readonly Command[],
  candidate: Command,
  startIndex: number,
  claimedIndices: Set<number>
): number {
  for (let i = startIndex; i < commands.length; i++) {
    if (claimedIndices.has(i)) {
      continue;
    }
    if (commandsEqual(commands[i], candidate)) {
      return i;
    }
  }
  return -1;
}

function commandsEqual(a: Command, b: Command): boolean {
  return (
    a.type === b.type &&
    a.priority === b.priority &&
    a.step === b.step &&
    a.timestamp === b.timestamp &&
    payloadsMatch(a.payload, b.payload)
  );
}

function payloadsMatch(left: unknown, right: unknown, seen = new WeakMap<any, any>()): boolean {
  if (Object.is(left, right)) {
    return true;
  }

  if (typeof left !== typeof right) {
    return false;
  }

  if (!left || !right || typeof left !== 'object') {
    return left === right;
  }

  const existing = seen.get(left);
  if (existing) {
    return existing === right;
  }
  seen.set(left, right);

  if (left instanceof Map && right instanceof Map) {
    if (left.size !== right.size) {
      return false;
    }
    const rightEntries = Array.from(right.entries());
    return Array.from(left.entries()).every(([lk, lv], index) => {
      const [rk, rv] = rightEntries[index];
      return payloadsMatch(lk, rk, seen) && payloadsMatch(lv, rv, seen);
    });
  }

  if (left instanceof Set && right instanceof Set) {
    if (left.size !== right.size) {
      return false;
    }
    const rightValues = Array.from(right.values());
    return Array.from(left.values()).every((lv, index) =>
      payloadsMatch(lv, rightValues[index], seen)
    );
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return false;
    }
    for (let i = 0; i < left.length; i++) {
      if (!payloadsMatch(left[i], right[i], seen)) {
        return false;
      }
    }
    return true;
  }

  if (isArrayBufferViewLike(left) && isArrayBufferViewLike(right)) {
    if (left.byteLength !== right.byteLength) {
      return false;
    }
    const leftBytes = getArrayBufferViewBytes(left);   // unwraps immutable proxies
    const rightBytes = getArrayBufferViewBytes(right); // and compares raw bytes
    for (let i = 0; i < leftBytes.length; i++) {
      if (leftBytes[i] !== rightBytes[i]) {
        return false;
      }
    }
    return true;
  }

  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime();
  }

  const leftKeys = Object.keys(left as Record<string, unknown>);
  const rightKeys = Object.keys(right as Record<string, unknown>);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(right, key)) {
      return false;
    }
    if (!payloadsMatch(
      (left as Record<string, unknown>)[key],
      (right as Record<string, unknown>)[key],
      seen
    )) {
      return false;
    }
  }

  return true;
}

// payloadsMatch walks the payload graph, respecting Map/Set order and
// accounting for shared references via the WeakMap. ArrayBuffer/DataView proxies
// produced by deepFreezeInPlace go through getArrayBufferViewBytes so byte
// mismatches are still detected. This avoids relying on generic deep-equality
// helpers that ignore structured-clone-only types.

/**
 * Freeze an object in-place, making plain objects/arrays immutable.
 *
 * IMPORTANT LIMITATIONS:
 * - Object.freeze() does NOT prevent Map.set/delete/clear or Set.add/delete/clear
 * - TypedArrays cannot be frozen (throws TypeError)
 * - This provides protection against accidental mutation, not malicious tampering
 *
 * The recorder relies on:
 * 1. Cloning to isolate snapshots (primary defense)
 * 2. Freezing plain objects to catch accidental mutations in dev
 * 3. Discipline to not mutate Map/Set/TypedArray in snapshots
 */
function deepFreezeInPlace<T>(obj: T): T {
  const seen = new WeakSet<object>();

  function freezeRecursive(value: any): void {
    if (!value || typeof value !== 'object') {
      return; // Primitives don't need freezing
    }

    if (seen.has(value)) {
      return; // Already processed (prevents cycles)
    }

    seen.add(value);

    // Skip TypedArrays - Object.freeze throws on them
    if (ArrayBuffer.isView(value)) {
      // TypedArrays (Uint8Array, etc.) cannot be frozen
      // Rely on cloning for isolation
      return;
    }

    // Freeze the object/array itself
    // NOTE: This does NOT prevent Map/Set mutations!
    Object.freeze(value);

    // Handle Map - freeze keys and values (but Map itself remains mutable)
    if (value instanceof Map) {
      for (const [k, v] of value.entries()) {
        freezeRecursive(k);
        freezeRecursive(v);
      }
    }
    // Handle Set - freeze items (but Set itself remains mutable)
    else if (value instanceof Set) {
      for (const item of value.values()) {
        freezeRecursive(item);
      }
    }
    // Handle Arrays and plain objects
    else {
      for (const prop of Object.getOwnPropertyNames(value)) {
        freezeRecursive(value[prop]);
      }
    }
  }

  freezeRecursive(obj);
  return obj;
}

/**
 * Restore game state from a snapshot.
 * The snapshot is cloned to ensure the original remains immutable.
 *
 * IMPORTANT: This function mutates existing gameState containers in place so any
 * references held by systems (e.g., const entities = gameState.entities) remain
 * valid after replay. Keys that no longer exist in the snapshot are removed,
 * and Maps/Sets/Arrays/objects are reconciled in place instead of being replaced.
*/
function restoreState(snapshot: StateSnapshot): void {
  const mutableSnapshot = cloneDeep(snapshot); // Preserves graph aliasing
  reconcileValue(gameState, mutableSnapshot, new WeakMap());
}

function reconcileValue(current: any, next: any, seen: WeakMap<object, any>): any {
  if (!next || typeof next !== 'object') {
    return next;
  }

  if (seen.has(next)) {
    return seen.get(next);
  }

  if (next instanceof Map) {
    const map = current instanceof Map ? current : new Map();
    seen.set(next, map);

    const existingEntries =
      current instanceof Map ? Array.from(current.entries()) : [];
    const matchedEntryIndices = new Set<number>();

    map.clear();
    for (const [key, value] of next.entries()) {
      const existingEntry = findMatchingMapEntry(
        existingEntries,
        key,
        matchedEntryIndices
      );
      const resolvedKey =
        existingEntry !== undefined
          ? existingEntry[0]
          : reconcileValue(undefined, key, seen);
      const resolvedValue = reconcileValue(
        existingEntry?.[1],
        value,
        seen
      );
      map.set(resolvedKey, resolvedValue);
    }
    return map;
  }

  if (next instanceof Set) {
    const set = current instanceof Set ? current : new Set();
    seen.set(next, set);

    const existingItems = current instanceof Set ? Array.from(current.values()) : [];
    const matchedItemIndices = new Set<number>();

    set.clear();
    for (const item of next.values()) {
      const existingItem = findMatchingSetItem(existingItems, item, matchedItemIndices);
      const resolvedItem = reconcileValue(existingItem ?? undefined, item, seen);
      set.add(resolvedItem);
    }
    return set;
  }

  if (Array.isArray(next)) {
    const array = Array.isArray(current) ? current : [];
    seen.set(next, array);
    array.length = next.length;
    for (let i = 0; i < next.length; i++) {
      array[i] = reconcileValue(array[i], next[i], seen);
    }
    return array;
  }

  if (ArrayBuffer.isView(next)) {
    const ctor = next.constructor as {
      new(buffer: ArrayBufferLike): typeof next;
    };
    return new ctor(next);
  }

  // Note: The production implementation also treats immutable proxy snapshots
  // generated by `deepFreezeInPlace` as ArrayBuffer views. It keeps a cache in
  // the `seen` WeakMap so duplicate typed-array/DataView references in the
  // snapshot resolve back to the exact same view instance, even when the proxy
  // wrappers do not expose `.buffer`, `.length`, or other brand-checked accessors.
  // When those accessors throw, the runtime falls back to copying byte data but
  // still reuses the resolved view for every subsequent reference.

  if (next instanceof Date) {
    return new Date(next.getTime());
  }

  if (isPlainObject(next)) {
    const target = isPlainObject(current) ? current : {};
    seen.set(next, target);

    for (const key of Object.keys(target)) {
      if (!(key in next)) {
        delete target[key];
      }
    }

    for (const [key, value] of Object.entries(next)) {
      target[key] = reconcileValue(target[key], value, seen);
    }

    return target;
  }

  // Fall back to structuredClone for rare structured types (RegExp, URL, etc.)
  const clone = structuredClone(next);
  if (typeof clone === 'object' && clone !== null) {
    seen.set(next, clone);
  }
  return clone;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function findMatchingMapEntry(
  entries: Array<[any, any]>,
  candidateKey: any,
  matchedIndices: Set<number>
): [any, any] | undefined {
  for (let i = 0; i < entries.length; i++) {
    if (matchedIndices.has(i)) {
      continue;
    }
    const [existingKey] = entries[i];
    if (
      Object.is(existingKey, candidateKey) ||
      payloadsMatch(existingKey, candidateKey)
    ) {
      matchedIndices.add(i);
      return entries[i];
    }
  }
  return undefined;
}

function findMatchingSetItem(
  items: any[],
  candidate: any,
  matchedIndices: Set<number>
): any | undefined {
  for (let i = 0; i < items.length; i++) {
    if (matchedIndices.has(i)) {
      continue;
    }
    const existing = items[i];
    if (Object.is(existing, candidate) || payloadsMatch(existing, candidate)) {
      matchedIndices.add(i);
      return existing;
    }
  }
  return undefined;
}

```

#### Supporting Utilities

Several helper modules are assumed in the pseudocode above. They must exist (or be stubbed) before the queue work ships:

- **`telemetry` facade**: Provides `recordError(event, data)`, `recordWarning(event, data)`, `recordProgress(event, data)`, and `recordTick()`; all methods must be fire-and-forget and safe in worker, browser, and Node test environments. If a provided facade throws, the default wrapper logs the failure via `console.error` to avoid cascading crashes.
- **Monotonic clock**: `createMonotonicClock()` wraps `performance.now()` but guarantees strictly increasing values even if the host clock stalls. In Node, import `performance` from `perf_hooks` so replay/tests run without polyfills.
- **Deterministic RNG hooks**: `getCurrentRNGSeed(): number | undefined`, `setRNGSeed(seed: number): void`, and `seededRandom(): number` live in the runtime RNG module. Command handlers that rely on randomness must consume `seededRandom()`; direct `Math.random()` usage is prohibited once the queue lands.
- **`structuredClone` availability**: Browser runtimes already expose it; Node tests must run on a version that includes the API or ship a ponyfill with equivalent semantics.

The reconciliation logic deliberately keeps previously shared references alive. For example, if a system cached `const entities = gameState.entities`, that Map instance survives replay; each entry is reconciled in place so cached entity objects continue to reference the same containers after restoration. The `WeakMap` registry ensures every object from the snapshot maps back to exactly one runtime object, so cycles and cross-links are recreated faithfully. This protects long-lived references inside the runtime while still guaranteeing the restored state matches the recorded snapshot exactly.

The replay sandbox guarantees that log-driven execution never leaks additional
commands into the live runtime. Any handler that attempts to enqueue during
replay indicates the log is missing an entry; the method emits telemetry and
throws immediately so the bad capture cannot advance unnoticed.

When a `RuntimeReplayContext` is supplied, the recorder snapshots the current
`currentStep`/`nextExecutableStep` values, runs the replay, and then sets both
counters to `log.metadata.lastStep + 1` so the live runtime resumes from the
correct tick. If the replay aborts early, the original counter values are
restored to avoid leaving the runtime in a mismatched state.

### 8.3 Deterministic Replay Guarantees

**Critical Design Decisions**: The replay implementation addresses three determinism requirements:

#### 1. Step Counter Preservation

**Problem**: Commands must preserve the execution tick they target. Multiple commands executed within the same tick must all see the same `ctx.step` value, both during live play and replay.

**Example Failure** (incorrect approach with auto-increment):
```typescript
// Handler that gates behavior per step
// resources: ResourceState captured from runtime setup
const applyProductionHandler = (payload, ctx: ExecutionContext) => {
  // Only apply once per step (prevent double-application)
  if (lastProductionStep === ctx.step) return;
  lastProductionStep = ctx.step;

  const energyIndex = resources.requireIndex('energy');
  resources.addAmount(energyIndex, payload.amount);
};

// Live play tick 100: cmd1.step=100, cmd2.step=100, cmd3.step=100
// All three commands see ctx.step=100 (same tick)

// Replay with auto-increment: cmd1→ctx.step=0, cmd2→ctx.step=1, cmd3→ctx.step=2
// Each command sees different step! Handler logic diverges
```

**Solution**:
- Each `Command` includes a `step` field storing the simulation step that will execute it
- During live play: systems stamp `context.step + 1` and the Worker stamps `nextExecutableStep`
- During live execution: `CommandDispatcher.execute()` feeds `cmd.step` into the handler context
- During replay: `CommandRecorder.replay()` uses `cmd.step` directly for `ctx.step`
- This ensures all commands executed on tick N see `ctx.step = N` in both live play and replay

#### 2. Recording Loop Prevention

**Problem**: Recommended pattern `dispatcher.on('commandExecuted', (cmd) => recorder.record(cmd))` causes every replayed command to be recorded again because the subscription remains active during replay.

**Example Failure**:
```typescript
// Setup (live play)
dispatcher.on('commandExecuted', (cmd) => sessionRecorder.record(cmd));

// Export log with 100 commands
const log = sessionRecorder.export(); // commands: [cmd1, cmd2, ..., cmd100]

// Replay with same dispatcher
sessionRecorder.replay(log, dispatcher);
// Replays cmd1 → dispatcher fires 'commandExecuted' → recorder.record(cmd1) AGAIN
// Result: sessionRecorder.recorded now has 200 commands (100 original + 100 duplicates)
```

**Solution**:
  - `CommandRecorder.replay()` calls handlers **directly** via `dispatcher.getHandler()`, bypassing event system
  - Replay temporarily swaps `commandQueue.enqueue` with a sandbox that records attempted follow-up commands; each queued command is matched against the remaining log entries so the tool can surface telemetry and fail fast when the capture is incomplete or divergent
  - When no runtime context is provided, replay still captures follow-up enqueues by routing them through a fresh, isolated `CommandQueue`, so tests and tooling remain decoupled from the live runtime
- Missing handlers are surfaced via `telemetry.recordError('ReplayUnknownCommandType', …)` so replay drift cannot go unnoticed
- Alternatively: use separate replay-only dispatcher with no recording subscriptions
- Documentation updated to show both patterns

#### 3. RNG Seed Restoration

**Problem**: Without capturing and restoring the active RNG seed, handlers that rely on randomness diverge between live play and replay.

**Example Failure**:
```typescript
// Handler with random drop chance
const enemyDropHandler = (payload, ctx) => {
  if (Math.random() < 0.1) { // 10% drop chance
    gameState.inventory.push({ item: 'rare_gem' });
  }
};

// Live play (seed=42): Math.random() = 0.05 → drop succeeds
// Replay (seed not restored): Math.random() = 0.87 → drop fails
// Result: Different final state
```

**Solution**:
- `CommandRecorder` snapshots the current RNG seed at construction/export time (or accepts an explicit override) so `log.metadata.seed` is always populated
- `CommandRecorder.replay()` checks `log.metadata.seed` and calls `setRNGSeed(seed)` before executing commands
- Handlers **must** use `seededRandom()` instead of `Math.random()` for determinism
- Alternative: restrict handlers to pure deterministic logic only (no randomness)

### 8.4 Freeze/Clone/Restore Lifecycle

**Key Insight**: We separate "freezing for safety" from "cloning for replay". `deepFreezeInPlace()` wraps Maps/Sets/TypedArrays in guard proxies that throw on mutation while still presenting structured-clone-compatible views, so snapshots stay immutable yet cloneable.

#### Lifecycle Stages

**1. Recording Start (Constructor)**
```typescript
constructor(currentState: GameState, options?: { seed?: number }) {
  this.startState = cloneDeep(currentState); // Clone to isolate from live state
  deepFreezeInPlace(this.startState);        // Wrap in immutable guard proxies
  this.rngSeed = options?.seed ?? getCurrentRNGSeed?.();
}
```

- **Clone first**: `structuredClone()` creates independent copy
- **Freeze second**: `deepFreezeInPlace()` guards all nested collections/arrays
- **Result**: `this.startState` is frozen but still cloneable through the guard proxies

**2. Export (Creating Command Log)**
```typescript
export(): CommandLog {
  const exportedLog = {
    startState: cloneDeep(this.startState), // Clone the frozen snapshot
    commands: [...this.recorded],
    metadata: {
      recordedAt: Date.now(),
      seed: this.rngSeed
    }
  };

  deepFreezeInPlace(exportedLog); // Freeze the exported log via guard proxies
  return exportedLog;
}
```

- **Clone**: `structuredClone()` clones the wrapped snapshots without mutating the live state
- **Freeze**: Guard proxies reject external mutation attempts
- **Result**: Multiple exports are independent, immutable snapshots

**3. Replay (Restoring State)**
```typescript
replay(log: CommandLog, dispatcher: CommandDispatcher): void {
  const mutableState = cloneDeep(log.startState); // Clone frozen snapshot
  restoreState(mutableState);                     // Apply to game state

  // Re-execute commands using their original step values
  for (const cmd of log.commands) {
    const handler = dispatcher.getHandler(cmd.type);
    if (!handler) {
      telemetry.recordError('ReplayUnknownCommandType', {
        type: cmd.type,
        step: cmd.step
      });
      continue;
    }

    handler(cmd.payload, {
      step: cmd.step, // Use stored step from command
      timestamp: cmd.timestamp,
      priority: cmd.priority
    });
  }
}
```

- **Clone**: Create mutable working copy from frozen snapshot
- **Restore**: Copy into live `gameState`
- **Execute**: Commands mutate the restored state using their original step values
- **Result**: Replay produces identical final state as original session

#### Why This Works

**Cloning is the Primary Defense**:
- `structuredClone()` creates completely independent copies
- Mutating a clone never affects the original
- Each snapshot lives in its own memory space

**Freezing is Secondary Protection**:
- `deepFreezeInPlace()` walks the snapshot and returns a read-only graph
- Plain objects/arrays are cloned and `Object.freeze()` is applied
- Map/Set/Date/TypedArray instances are wrapped in proxies whose mutators (`set`, `add`, `setFullYear`, `copyWithin`, `subarray`, etc.) throw `TypeError`
- Typed array `buffer` accessors surface immutable buffer snapshots that only hand out cloned copies, and standalone `ArrayBuffer`/`SharedArrayBuffer` payloads are wrapped in the same facades so the live runtime memory is never directly exposed. The `ImmutableTypedArraySnapshot` TypeScript surface removes mutating helpers and narrows `.buffer` to those immutable facades so call sites must explicitly request writable copies before mutating.
- `RegExp` payloads are rehydrated via `new RegExp(source, flags)` so `.exec()`/`.test()` continue to behave like native instances without sharing mutable references

**Immutable Collections Example**:
```typescript
const payload = deepFreezeInPlace({
  map: new Map([['a', { value: 1 }]]),
  set: new Set([1, 2]),
  date: new Date('2025-01-01T00:00:00.000Z'),
  typed: new Uint8Array([5, 6]),
});

// Mutations throw in development/test builds
expect(() => payload.map.set('b', 2)).toThrow(TypeError);
expect(() => (payload.map.get('a') as { value: number }).value = 2).toThrow(TypeError);
expect(() => payload.set.add(3)).toThrow(TypeError);
expect(() => payload.date.setFullYear(2030)).toThrow(TypeError);
expect(() => {
  payload.typed[0] = 9;
}).toThrow(TypeError);
expect(() => payload.typed.set([7], 1)).toThrow(TypeError);

// Derived views remain immutable
const subView = payload.typed.subarray(0, 1);
expect(() => {
  subView[0] = 42;
}).toThrow(TypeError);
```

**Buffer Snapshot Facade**:
```typescript
const command = deepFreezeInPlace({
  buffer: new ArrayBuffer(4),
});

const immutable = command.buffer; // → ImmutableArrayBufferSnapshot

// Read accessors always return fresh copies
const copy = immutable.toUint8Array();
copy[0] = 99; // Safe - mutating the copy leaves the snapshot intact

// Attempting to obtain a writable view requires opting into a copy first
const runtimeBuffer = immutable.toArrayBuffer(); // New ArrayBuffer instance
```

Shared memory snapshots use the same pattern via `ImmutableSharedArrayBufferSnapshot`, ensuring readers must copy before mutating while preserving the original contents for deterministic replay.

**Defense Strategy**:
1. **Isolation via cloning**: Snapshots are independent (always works)
2. **Immutable snapshots**: `deepFreezeInPlace()` always returns read-only graphs whose mutation attempts surface as `TypeError`
3. **Deterministic APIs**: ArrayBuffer snapshots require explicit copy helpers, producing identical behavior in development and production

**Clone-Freeze-Clone Pattern**:
```
Live State → Clone → Freeze → Store (recorder.startState)
                                  ↓
                               Clone → Freeze → Export (log)
                                  ↓
                               Clone → Restore → Replay (mutable state)
```

Each step maintains:
- **Isolation**: Clones are independent (via `structuredClone()`)
- **Development immutability**: `deepFreezeInPlace()` injects read-only guards for Map/Set/Date/TypedArray during dev/test to surface accidental mutations early
- **Production cloneability**: Release builds omit the proxy layer, keeping snapshots plain-data and `structuredClone()` compatible for recording/replay

**State Serialization Constraints**:

For deterministic replay to work, game state must be **cloneable via `structuredClone()`**. Freezing provides additional safety for plain objects/arrays only.

1. **Supported Types**:
   - **Plain objects and arrays** (cloneable + freezable)
   - **Primitives** (string, number, boolean, null, undefined)
   - **Date objects** (cloneable + mutation-guarded proxies in development)
   - **Map and Set collections** (cloneable + mutation-guarded proxies in development)
   - **Typed arrays** (Uint8Array, etc.) (cloneable + mutation-guarded proxies for values and subviews in development)
   - **ArrayBuffer / SharedArrayBuffer** (snapshots expose immutable facades that provide explicit copy helpers without leaking the live runtime buffers)
   - **RegExp** (cloned with `source`/`flags` and `lastIndex` preserved so replay stays deterministic)
   - **Cyclic references** (handled by `structuredClone()` and `deepFreezeInPlace()`)

2. **Unsupported Types** (will cause cloning failures):
   - Functions (behavior lost during clone)
   - DOM nodes (not cloneable)
   - WeakMap/WeakSet (not cloneable)
   - Symbols as property keys (not cloned)
   - Class instances with private fields (lost during clone)
   - Proxies (throws DataCloneError)

3. **Best Practices**:
   ```typescript
   // ✓ GOOD: Plain data structures
   interface GameState {
     resources: Record<string, number>;
     generators: Map<string, GeneratorState>;
     unlocks: Set<string>;
     timestamp: Date;
   }

   // ✗ AVOID: Functions and class instances
   interface BadGameState {
     calculateProduction: () => number; // Lost during clone
     ui: HTMLElement; // Not serializable
     cache: WeakMap<object, any>; // Not cloneable
   }
   ```

4. **Cyclic State Handling**:
   ```typescript
   // Cycles are safe for freezing (WeakMap caches preserve referential identity)
   const parent = { children: [] };
   const child = { parent };
   parent.children.push(child);

   deepFreezeInPlace(parent); // Works correctly with cycle tracking
   ```

5. **Map/Set/TypedArray Handling**:
   ```typescript
   const state = deepFreezeInPlace({
     items: new Map([['a', { value: 1 }]]),
     ids: new Set(['x', 'y']),
     buffer: new Uint8Array([1, 2, 3]),
   });

   expect(() => state.items.set('b', 2)).toThrow(TypeError);
   expect(() => state.ids.add('z')).toThrow(TypeError);
   expect(() => {
     state.buffer[0] = 99;
   }).toThrow(TypeError);
   expect(() => state.buffer.set([7], 1)).toThrow(TypeError);

   const sub = state.buffer.subarray(0, 1);
   expect(() => {
     sub[0] = 42;
   }).toThrow(TypeError);

   // Nested data remains deeply frozen
   expect(() => (state.items.get('a') as { value: number }).value = 2).toThrow(TypeError);
   ```

   **Important**: Development and test builds surface incorrect mutations immediately via the proxy layer. Production builds still rely on cloning for isolation (the snapshot handed to the queue is a unique copy), but skip proxy creation to stay within the tick budget.
   - Each `export()` clones the frozen snapshot before serialisation
   - Each `replay()` clones the stored snapshot before mutating anything
   - Proxy guards block escape hatches such as `valueOf()` so callers cannot peel back the immutable wrappers and reach the mutable backing instances
   - Mutations always target a clone, never the source snapshot

This enables:
- **Deterministic testing**: Record player session, replay in CI to verify no regressions
- **Bug reproduction**: Export command log from user session, replay locally to debug
- **Balance tuning**: Simulate strategies by crafting command sequences

## 9. Performance Considerations

### 9.1 Queue Capacity Limits

To prevent memory leaks from runaway automation or attack scenarios:

```typescript
const MAX_QUEUE_SIZE = 10000; // Configurable per deployment

enqueue(command: Command): void {
  if (this.size >= MAX_QUEUE_SIZE) {
    telemetry.recordWarning('CommandQueueOverflow', {
      size: this.size,
      maxSize: MAX_QUEUE_SIZE,
      priority: command.priority
    });
    // Only evict commands at priorities <= the incoming request
    const dropped = this.dropLowestPriorityUpTo(command.priority);
    if (!dropped) {
      telemetry.recordWarning('CommandRejected', {
        type: command.type,
        priority: command.priority,
        timestamp: command.timestamp
      });
      return;
    }
  }
  // ... proceed with enqueue
}

private dropLowestPriorityUpTo(maxPriority: CommandPriority): boolean {
  for (const priority of [...CommandQueue.PRIORITY_ORDER].reverse()) {
    if (priority < maxPriority) {
      continue;
    }
    const queue = this.queues.get(priority);
    if (!queue || queue.length === 0) {
      continue;
    }

    const dropped = queue.shift(); // Remove oldest command in lowest-priority lane
    if (dropped) {
      this.totalSize--;
    }
    telemetry.recordWarning('CommandDropped', {
      type: dropped!.command.type,
      priority,
      timestamp: dropped!.command.timestamp
    });
    return true;
  }
  return false;
}
```

This strategy removes the oldest command from the lowest-priority lane at or
below the incoming priority, preserving deterministic behavior while keeping
higher-priority queues intact. If no eligible command can be evicted the
incoming enqueue is rejected and surfaced via `CommandRejected` telemetry, which
lets orchestration layers detect starvation scenarios. Each eviction still emits
`CommandDropped` with enough metadata to trace automation or attack patterns
that saturate the queue. Because the queue maintains a running `totalSize`
counter (see Section 4.2), the overflow check stays O(1) regardless of how many
commands are currently buffered.

### 9.2 Batch Processing Optimization

When replaying large command logs (e.g., 12-hour offline catch-up):

```typescript
// Process commands in batches to allow instrumentation
const BATCH_SIZE = 1000;

for (let i = 0; i < log.commands.length; i += BATCH_SIZE) {
  const batch = log.commands.slice(i, i + BATCH_SIZE);
  for (const cmd of batch) {
    dispatcher.execute(cmd); // Use dispatcher to ensure consistent execution
  }
  telemetry.recordProgress('CommandReplay', { processed: i });
}
```

### 9.3 Memory Footprint

Typical command memory profile:
- Command object: ~80 bytes (type string, priority enum, timestamp number, payload reference)
- Average payload: ~200 bytes (resource IDs, counts, flags)
- 10,000 queued commands ≈ 2.8 MB (within 5 MB runtime budget)

## 10. Error Handling

### 10.1 Invalid Command Rejection

```typescript
execute(command: Command): void {
  const handler = this.handlers.get(command.type);

  if (!handler) {
    telemetry.recordError('UnknownCommandType', { type: command.type });
    return; // Fail silently to avoid breaking tick loop
  }

  const executionContext = {
    step: command.step, // Use command's step for deterministic replay
    timestamp: command.timestamp,
    priority: command.priority
  };

  try {
    handler(command.payload, executionContext);
  } catch (err) {
    telemetry.recordError('CommandExecutionFailed', {
      type: command.type,
      error: err instanceof Error ? err.message : String(err)
    });
    // Continue processing remaining commands
  }
}
```

### 10.2 Validation Before Enqueue

The presentation layer performs optimistic validation before sending commands. UI code works against the latest `ResourceStateSnapshot` rebuilt from the worker's `ResourcePublishTransport` payload:

```typescript
// In React hook
const resourceIndexById = useMemo(() => {
  return new Map(resources.ids.map((id, index) => [id, index]));
}, [resources.ids]);

const canAffordGenerator = (cost: number) => {
  const energyIndex = resourceIndexById.get('energy');
  return energyIndex !== undefined && resources.amounts[energyIndex] >= cost;
};

const buyGenerator = (payload: PurchaseGeneratorPayload) => {
  const generator = registry.getGenerator(payload.generatorId);
  const totalCost = generator.cost * payload.count;

  if (!canAffordGenerator(totalCost)) {
    showError('Insufficient resources');
    return; // Don't enqueue invalid command
  }

  workerBridge.sendCommand('PURCHASE_GENERATOR', payload);
};
```

The runtime performs authoritative validation during execution:

```typescript
// In command handler
const purchaseGeneratorHandler: CommandHandler<PurchaseGeneratorPayload> = (
  payload,
  ctx,
) => {
  const generator = registry.getGenerator(payload.generatorId);
  const totalCost = generator.cost * payload.count;
  const energyIndex = resources.requireIndex('energy');

  const spendSucceeded = resources.spendAmount(energyIndex, totalCost, {
    commandId: 'PURCHASE_GENERATOR',
    systemId:
      ctx.priority === CommandPriority.AUTOMATION ? 'auto-buy' : undefined,
  });

  if (!spendSucceeded) {
    telemetry.recordWarning('InsufficientResources', {
      generatorId: payload.generatorId,
      cost: totalCost,
      priority: ctx.priority,
      step: ctx.step,
    });
    return; // Command rejected, no state mutation
  }

  generator.owned += payload.count;
};
```

## 11. Testing Strategy

### 11.1 Unit Tests

```typescript
describe('CommandQueue', () => {
  it('executes commands in priority order', () => {
    queue.enqueue({
      type: 'AUTO',
      priority: CommandPriority.AUTOMATION,
      payload: {},
      timestamp: 100,
      step: 0
    });
    queue.enqueue({
      type: 'PLAYER',
      priority: CommandPriority.PLAYER,
      payload: {},
      timestamp: 100,
      step: 0
    });
    queue.enqueue({
      type: 'SYSTEM',
      priority: CommandPriority.SYSTEM,
      payload: {},
      timestamp: 100,
      step: 0
    });

    const commands = queue.dequeueAll();
    expect(commands[0].type).toBe('SYSTEM');
    expect(commands[1].type).toBe('PLAYER');
    expect(commands[2].type).toBe('AUTO');
  });

  it('maintains FIFO order within same priority', () => {
    queue.enqueue({
      type: 'CMD1',
      priority: CommandPriority.PLAYER,
      payload: {},
      timestamp: 100,
      step: 0
    });
    queue.enqueue({
      type: 'CMD2',
      priority: CommandPriority.PLAYER,
      payload: {},
      timestamp: 200,
      step: 0
    });

    const commands = queue.dequeueAll();
    expect(commands[0].timestamp).toBe(100);
    expect(commands[1].timestamp).toBe(200);
  });
});
```

### 11.2 Integration Tests

```typescript
describe('Command Execution', () => {
  it('applies resource mutations correctly', () => {
    const state = createTestState({ energy: 100 });
    const dispatcher = createDispatcher(state);

    dispatcher.execute({
      type: 'PURCHASE_GENERATOR',
      payload: { generatorId: 'reactor', count: 1 },
      priority: CommandPriority.PLAYER,
      timestamp: 0,
      step: 0
    });

    expect(state.resources.energy).toBe(90); // Cost 10
    expect(state.generators.reactor.owned).toBe(1);
  });

  it('rejects invalid commands gracefully', () => {
    const state = createTestState({ energy: 5 });
    const dispatcher = createDispatcher(state);

    dispatcher.execute({
      type: 'PURCHASE_GENERATOR',
      payload: { generatorId: 'reactor', count: 1 }, // Cost 10, insufficient
      priority: CommandPriority.PLAYER,
      timestamp: 0,
      step: 0
    });

    expect(state.resources.energy).toBe(5); // No mutation
    expect(state.generators.reactor.owned).toBe(0);
  });
});
```

### 11.3 Replay Tests

```typescript
describe('Command Replay', () => {
  it('reproduces identical state from command log', () => {
    const initialState = createInitialState();
    const recorder = new CommandRecorder(initialState); // Snapshot at start

    // Simulate player session (mutates initialState)
    const dispatcher = createDispatcher(initialState);
    runSimulation(initialState, recorder, dispatcher);
    const finalStateOriginal = cloneDeep(initialState);

    // Export and replay
    const log = recorder.export();
    const replayDispatcher = createDispatcher();
    recorder.replay(log, replayDispatcher);
    const replayedState = replayDispatcher.getState();

    expect(replayedState).toEqual(finalStateOriginal);
  });

  it('exported logs are immutable', () => {
    const initialState = createInitialState();
    const recorder = new CommandRecorder(initialState);

    recorder.record({
      type: 'TEST_CMD',
      priority: CommandPriority.PLAYER,
      payload: { value: 1 },
      timestamp: 0,
      step: 0
    });

    const log1 = recorder.export();

    // Record more commands after export
    recorder.record({
      type: 'TEST_CMD_2',
      priority: CommandPriority.PLAYER,
      payload: { value: 2 },
      timestamp: 1,
      step: 1
    });

    const log2 = recorder.export();

    // First export should be unaffected
    expect(log1.commands.length).toBe(1);
    expect(log2.commands.length).toBe(2);

    // Logs should be frozen
    expect(() => {
      (log1 as any).commands.push({ /* ... */ });
    }).toThrow();
  });
});
```

## 12. Implementation Plan

The command queue implementation follows this sequence (aligned with Phase 1 - Runtime Skeleton):

### 12.1 Week 1 Tasks
- [x] Implement `CommandQueue` data structure with priority lanes
- [x] Implement `CommandDispatcher` with handler registration
- [x] Add command types and payload interfaces for resource operations
- [x] Write unit tests for queue ordering and priority resolution (`packages/core/src/command-queue.test.ts:553`)

### 12.2 Week 2 Tasks
- [ ] Integrate command queue into tick loop (update `IdleEngineRuntime`)
- [ ] Implement command handlers for purchase/toggle operations
- [ ] Add Worker bridge message handler for incoming commands
- [x] Write integration tests for end-to-end command flow (`packages/core/src/index.test.ts:193`, `packages/shell-web/src/runtime.worker.test.ts:136`)

### 12.3 Week 3 Tasks
- [ ] Implement `CommandRecorder` for debugging/replay
- [ ] Add validation layer with error handling
- [ ] Implement queue capacity limits and overflow handling
- [ ] Document command API contracts for content modules

## 13. Success Criteria

The command queue is complete when:

1. **Determinism**: Replaying a command log produces identical final state (verified by property tests)
2. **Priority**: Commands execute in correct priority order across 1000+ enqueued commands (benchmark)
3. **Performance**: Command processing overhead < 5% of tick budget at 60 ticks/sec (profiled)
4. **Integration**: React shell can enqueue commands, runtime executes them, state updates reflected in UI (E2E test)
5. **Observability**: Command queue depth and execution metrics exposed via diagnostics interface

## 14. Future Enhancements (Post-Prototype)

- **Conditional Commands**: Commands that execute only when predicates are met (e.g., "buy when resource >= threshold")
- **Macro Commands**: Composite commands for complex multi-step actions
- **Network Sync**: Serialize command stream for multiplayer synchronization
- **Rollback**: Store command checkpoints for efficient undo/redo
- **Compression**: Delta-encode command logs for reduced storage/bandwidth

## 15. Resolved Decisions

- **Automation throttling**: No per-tick throttle in the initial release. We rely on `MAX_QUEUE_SIZE`, per-priority depth telemetry, and `CommandQueueOverflow`/`CommandDropped` signals to surface runaway automation. If telemetry shows chronic starvation, we will introduce targeted throttles as a follow-up enhancement.
- **Command conflicts**: Handlers must revalidate state at execution time and gracefully no-op when their preconditions are invalidated (emitting `telemetry.recordWarning('CommandConflict', …)`). Destructive operations such as prestige reset must flush or invalidate dependent state via their handlers; the queue itself remains FIFO and does not perform speculative reordering.
- **Multiple RNG streams**: Yes. Each subsystem that owns an independent PRNG must register with the runtime RNG module so the recorder can capture and restore every active seed. The RNG helper will expose `registerRNGStream(id, getSeed, setSeed)` to supplement the existing global seed capture.

## 16. References

- [Game Programming Patterns: Command](https://gameprogrammingpatterns.com/command.html)
- [Game Programming Patterns: Event Queue](https://gameprogrammingpatterns.com/event-queue.html)
- Idle Engine Design Document (Section 9.1 - Tick Pseudocode)
- Implementation Plan (Section 4 - Runtime Core Tasks)

## Appendix A – 2025-10-11 Update Summary

- Added accumulator diagnostics coverage for clamp debt, deterministic drain, and fractional cadence precision (`packages/core/src/index.test.ts:336`, `packages/core/src/index.test.ts:370`, `packages/core/src/index.test.ts:480`). See `docs/tick-accumulator-coverage-design.md` §§5.1–5.3 for the scenarios and backlog expectations—the diagnostics metadata must surface the remaining accumulator debt while queue counters stay at zero so devtools timelines remain reliable.
- Documented system execution order, error handling, and deferred enqueue behaviour via new runtime tests; exceptions now log `SystemExecutionFailed` telemetry instead of stopping the tick (`packages/core/src/index.ts:120`, `packages/core/src/index.test.ts:210`, `packages/core/src/index.test.ts:252`, `packages/core/src/index.test.ts:293`).
- Strengthened priority guarantees by mixing command priorities inside runtime ticks and capturing queue boundary scenarios (`packages/core/src/index.test.ts:327`, `packages/core/src/command-queue.test.ts:553`).
- Validated monotonic clock behaviour within the worker bridge when the host clock stalls (`packages/shell-web/src/runtime.worker.test.ts:136`).
