# Runtime Command Queue Design Document

**Issue:** #6
**Workstream:** Runtime Core
**Status:** Design
**Last Updated:** 2025-10-09

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
  readonly step: number; // Originating tick step for deterministic replay
}

export enum CommandPriority {
  SYSTEM = 0,    // Engine-generated (migrations, prestige resets)
  PLAYER = 1,    // Direct user input (purchase, toggle)
  AUTOMATION = 2 // Automated systems (auto-buy, auto-prestige)
}
```

### 4.2 Command Queue Structure

The queue maintains separate lanes per priority with FIFO ordering within each lane:

```typescript
export class CommandQueue {
  private readonly queues: Map<CommandPriority, Command[]> = new Map([
    [CommandPriority.SYSTEM, []],
    [CommandPriority.PLAYER, []],
    [CommandPriority.AUTOMATION, []]
  ]);
  private static readonly PRIORITY_ORDER: CommandPriority[] = [
    CommandPriority.SYSTEM,
    CommandPriority.PLAYER,
    CommandPriority.AUTOMATION
  ];

  /**
   * Enqueue a command for execution in the next tick.
   * The step field must be populated by the caller with the current tick step.
   */
  enqueue(command: Command): void {
    const queue = this.queues.get(command.priority);
    if (!queue) {
      throw new Error(`Invalid priority: ${command.priority}`);
    }
    queue.push(command);
  }

  dequeueAll(): Command[] {
    const result: Command[] = [];
    for (const priority of CommandQueue.PRIORITY_ORDER) {
      const queue = this.queues.get(priority);
      if (queue && queue.length > 0) {
        result.push(...queue);
        queue.length = 0; // Clear the queue
      }
    }
    return result;
  }

  clear(): void {
    for (const queue of this.queues.values()) {
      queue.length = 0;
    }
  }

  get size(): number {
    let total = 0;
    for (const queue of this.queues.values()) {
      total += queue.length;
    }
    return total;
  }
}
```

Pre-seeding the per-priority lanes and iterating with `PRIORITY_ORDER` keeps dequeue operations deterministic regardless of which priority enqueues the first command, avoiding accidental lane reordering when using native `Map` iteration.

### 4.3 Step Field Population

**Critical Design Pattern**: The `step` field on each command MUST be populated with the current tick step at the time the command is **enqueued**, not when it's created or executed.

#### Step Stamping Locations

**1. UI Commands (from Main Thread)**

Commands sent from the presentation layer do **not** include the step field. The Worker runtime stamps it when enqueueing:

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

// Worker runtime - onmessage handler
self.onmessage = (event) => {
  if (event.data.type === 'COMMAND') {
    commandQueue.enqueue({
      ...event.data.command,
      priority: CommandPriority.PLAYER,
      timestamp: event.data.command.timestamp ?? performance.now(),
      step: currentStep // <-- STAMPED HERE with Worker's current tick step
    });
  }
};
```

**Why Worker Stamps It**: The main thread doesn't have access to `currentStep` (it lives in the Worker). Only the Worker runtime knows the current tick number, so stamping happens at enqueue time in the Worker's message handler.

**2. System-Generated Commands (inside Worker)**

Systems running inside the Worker have access to `context.step` during their `tick()` method and stamp it directly:

```typescript
class ProductionSystem implements System {
  tick(context: TickContext): void {
    const production = calculateProduction(gameState, context.deltaMs);

    commandQueue.enqueue({
      type: 'APPLY_PRODUCTION',
      priority: CommandPriority.SYSTEM,
      payload: { resources: production },
      timestamp: performance.now(),
      step: context.step // <-- STAMPED HERE from TickContext
    });
  }
}
```

**Why Systems Stamp It**: Systems receive `context.step` as a parameter, representing the current tick. Commands enqueued during tick N will execute in tick N+1, but they carry the step value from when they were created (tick N) for logging and debugging purposes.

**3. Engine Commands (inside Worker)**

Engine-level code (migrations, resets, etc.) must accept `currentStep` as a parameter or access it from a shared context:

```typescript
// Option A: Accept currentStep parameter
function executePrestigeReset(currentStep: number, layer: number) {
  commandQueue.enqueue({
    type: 'PRESTIGE_RESET',
    priority: CommandPriority.SYSTEM,
    payload: { layer },
    timestamp: performance.now(),
    step: currentStep // <-- STAMPED HERE from parameter
  });
}

// Option B: Access global currentStep (inside Worker)
function executeMigration() {
  commandQueue.enqueue({
    type: 'APPLY_MIGRATION',
    priority: CommandPriority.SYSTEM,
    payload: { fromVersion: '1.0', toVersion: '1.1' },
    timestamp: performance.now(),
    step: currentStep // <-- STAMPED HERE from Worker global
  });
}
```

#### Step Lifecycle Summary

```
┌─────────────────────────────────────────────────────────────┐
│ Tick N                                                      │
├─────────────────────────────────────────────────────────────┤
│ 1. currentStep = N                                          │
│ 2. Execute queued commands (all have step < N)             │
│ 3. Systems tick():                                          │
│    - ProductionSystem creates cmd with step=N              │
│    - AutomationSystem creates cmd with step=N              │
│ 4. Commands enqueued for execution in tick N+1             │
│ 5. currentStep++ (becomes N+1)                             │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Tick N+1                                                    │
├─────────────────────────────────────────────────────────────┤
│ 1. currentStep = N+1                                        │
│ 2. Execute queued commands (all have step=N)               │
│    - Handlers see ctx.step = cmd.step = N                  │
│    - Commands from tick N execute with context.step=N      │
│ 3. Systems tick() with context.step=N+1                    │
│    - New commands created with step=N+1                    │
│ 4. currentStep++ (becomes N+2)                             │
└─────────────────────────────────────────────────────────────┘
```

**Key Insight**: Commands created during tick N are stamped with `step=N` and execute in tick N+1. During execution, handlers see `ctx.step = N` (from the command), **NOT** N+1. This ensures replay matches live execution exactly.

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

This ensures all commands from tick N see `ctx.step = N` during replay, matching the behavior from live play.

### 4.4 Command Execution Flow

Commands are processed at the start of each tick step, before system execution:

```typescript
let currentStep = 0; // Global step counter for ExecutionContext

function runTick(deltaMs: number) {
  accumulator += deltaMs;
  const steps = clamp(floor(accumulator / FIXED_STEP_MS), 0, MAX_STEPS_PER_FRAME);
  accumulator -= steps * FIXED_STEP_MS;

  for (let i = 0; i < steps; i++) {
    const commands = commandQueue.dequeueAll();
    for (const cmd of commands) {
      commandDispatcher.execute(cmd); // Apply state mutations using cmd.step
    }

    automationSystem.tick();
    productionSystem.tick();
    progressionSystem.tick();
    eventSystem.tick();
    telemetry.recordTick();

    currentStep++; // Increment after each tick step
  }
}
```

**Critical Constraint**: Systems MUST NOT mutate state directly during `tick()`. Instead, they analyze current state and enqueue commands that will be executed in the **next** tick step. This ensures:
1. All mutations flow through the command queue and are captured by `CommandRecorder`
2. System logic remains pure and testable (reads state, outputs commands)
3. Replaying a command log reproduces identical state without re-running systems

Example of correct system implementation:

```typescript
class AutomationSystem implements System {
  tick(context: TickContext): void {
    // ✓ CORRECT: Read state, enqueue commands for next tick
    const affordable = findAffordableUpgrades(gameState);
    for (const upgrade of affordable) {
      commandQueue.enqueue({
        type: 'PURCHASE_UPGRADE',
        priority: CommandPriority.AUTOMATION,
        payload: { upgradeId: upgrade.id },
        timestamp: performance.now(),
        step: context.step // Stamp with current tick step
      });
    }
  }
}

class ProductionSystem implements System {
  tick(context: TickContext): void {
    // ✗ WRONG: Direct state mutation bypasses command queue
    // gameState.resources.energy += productionRate;

    // ✓ CORRECT: Enqueue production command
    commandQueue.enqueue({
      type: 'APPLY_PRODUCTION',
      priority: CommandPriority.SYSTEM,
      payload: {
        resources: calculateProduction(gameState, context.deltaMs)
      },
      timestamp: performance.now(),
      step: context.step // Stamp with current tick step
    });
  }
}
```

**Enforcement**: The runtime provides read-only state proxies to systems. Direct mutation of the top-level state surface throws an error in development mode. Nested objects returned from `Map`/`Set` accessors are **not yet wrapped**; until that work lands, the example below should be interpreted as guarding only the first layer of state. A follow-up task will extend the proxy to decorate collection accessors so values are also read-only.

```typescript
function createReadOnlyProxy<T extends object>(target: T, path = 'state'): T {
  return new Proxy(target, {
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
}

// Usage in tick loop
const readOnlyState = createReadOnlyProxy(gameState);
automationSystem.tick(readOnlyState, context);
```

This proxy intercepts mutations at the **top level** and on **nested plain objects**:

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
     tick(context: TickContext): void {
       const production = calculateProduction(gameState, context.deltaMs);
       if (production.energy > 0) {
         commandQueue.enqueue({
           type: 'APPLY_PRODUCTION',
           priority: CommandPriority.SYSTEM,
           payload: { energy: production.energy },
           timestamp: performance.now(),
           step: context.step // Stamp with current tick step
         });
       }
     }
   }

   // ✗ WRONG: Non-deterministic - uses timestamp or random values
   class BadSystem implements System {
     tick(context: TickContext): void {
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
) => void;

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
      handler(command.payload, context);
    } catch (err) {
      telemetry.recordError('CommandExecutionFailed', {
        type: command.type,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
}
```

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
// Worker message handler - CRITICAL SECURITY BOUNDARY
self.onmessage = (event) => {
  if (event.data.type === 'COMMAND') {
    // SECURITY: All commands from main thread (postMessage) are PLAYER priority
    // Never trust event.data.source - compromised UI could send 'SYSTEM'
    commandQueue.enqueue({
      ...event.data.command,
      priority: CommandPriority.PLAYER, // Always PLAYER from external source
      timestamp: event.data.command.timestamp ?? performance.now(),
      step: currentStep // Stamp with current tick step when enqueueing
    });
  }
};
```

**Internal Command Enqueueing** (within Worker):

Systems and engine code running **inside the Worker** can enqueue with elevated priorities:

```typescript
// ProductionSystem (runs inside Worker)
class ProductionSystem implements System {
  tick(context: TickContext): void {
    const production = calculateProduction(gameState, context.deltaMs);

    // Direct enqueue with SYSTEM priority (safe - code runs in Worker)
    commandQueue.enqueue({
      type: 'APPLY_PRODUCTION',
      priority: CommandPriority.SYSTEM, // OK - internal code
      payload: { resources: production },
      timestamp: performance.now(),
      step: context.step // Stamp with current tick step
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
    step: currentStep // Stamp with current tick step
  });
}
```

**Security Architecture**:

1. **Trust Boundary**: The Worker's `self.onmessage` handler is the security boundary
   - **Untrusted**: Any message from main thread (includes UI, dev tools, injected scripts)
   - **Trusted**: Code executing within the Worker context

2. **Priority Assignment**:
   - Messages from `postMessage()` → **Always PLAYER priority** (ignores `event.data.source`)
   - Internal `commandQueue.enqueue()` calls → Use specified priority (trusted code)

3. **Attack Prevention**:
   ```typescript
   // ✗ Attack attempt (from compromised UI):
   worker.postMessage({
     type: 'COMMAND',
     source: 'SYSTEM', // Attacker tries to escalate
     command: { type: 'GRANT_RESOURCES', payload: { energy: 9999999 } }
   });

   // ✓ Runtime handles safely:
   // - Ignores event.data.source
   // - Forces priority = PLAYER
   // - Command executes with normal player permissions
   ```

4. **Authorization via Priority**: Command handlers use `context.priority` to enforce permissions:
   ```typescript
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

     gameState.resources[payload.resourceId] += payload.amount;
   };

   // Most commands accept any priority (SYSTEM, PLAYER, or AUTOMATION)
   const purchaseGeneratorHandler = (
     payload: PurchaseGeneratorPayload,
     ctx: ExecutionContext
   ) => {
     // All priorities can purchase - no authorization check needed
     // (Purchases are gated by resource cost, not priority)

     const generator = registry.getGenerator(payload.generatorId);
     const cost = generator.cost;

     if (gameState.resources.energy < cost) {
       return; // Insufficient resources
     }

     gameState.resources.energy -= cost;
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
  tick(context: TickContext): void {
    const affordable = findAffordableUpgrades(gameState);

    for (const upgrade of affordable) {
      commandQueue.enqueue({
        type: 'PURCHASE_UPGRADE',
        priority: CommandPriority.AUTOMATION, // Direct priority assignment
        payload: { upgradeId: upgrade.id },
        timestamp: performance.now(),
        step: context.step // Stamp with current tick step
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
   - **Construction**: `new CommandRecorder(state)` performs `deepFreeze(cloneDeep(state))` immediately
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

   // ✓ CORRECT: Create new recorder after reset
   const recorder1 = new CommandRecorder(initialState);
   recorder1.record(cmd1);

   gameState = resetToInitial();
   const recorder2 = new CommandRecorder(gameState); // New snapshot for new session
   recorder2.record(cmd2);
   ```

5. **Tooling Implications**:
   - **Dev Tools**: Recorder starts when dev panel opens, captures state at that moment
   - **CI Tests**: Each test case creates fresh recorder with known fixture state
   - **Bug Reports**: Session recorder created at game initialization, runs for entire session
   - **A/B Testing**: Strategy simulator creates recorder per simulation run

### 8.2 Implementation

```typescript
export interface CommandLog {
  readonly version: string;
  readonly startState: StateSnapshot;
  readonly commands: readonly Command[];
  readonly metadata: {
    readonly recordedAt: number;
    readonly seed?: number; // RNG seed for deterministic replay
  };
}

export class CommandRecorder {
  private readonly recorded: Command[] = [];
  private readonly startState: StateSnapshot; // Stored as cloneable, plain data

  constructor(currentState: GameState) {
    // Clone state immediately (cloneable, not frozen)
    this.startState = cloneDeep(currentState);
    // Freeze the clone to prevent accidental mutation
    deepFreezeInPlace(this.startState);
  }

  record(command: Command): void {
    this.recorded.push(command);
  }

  export(): CommandLog {
    // Return defensive copy - clone the snapshot again for export
    const exportedLog = {
      version: '0.1.0',
      startState: cloneDeep(this.startState), // Fresh clone (unfrozen)
      commands: [...this.recorded],
      metadata: { recordedAt: Date.now() }
    };

    // Freeze the exported log to prevent mutation
    deepFreezeInPlace(exportedLog);
    return exportedLog as CommandLog;
  }

  replay(log: CommandLog, dispatcher: CommandDispatcher, runtimeContext?: RuntimeReplayContext): void {
    // Clone the snapshot to get a mutable working copy
    const mutableState = cloneDeep(log.startState);

    // Restore to initial state
    restoreState(mutableState);

    // Restore RNG seed if present (for deterministic random handlers)
    if (log.metadata.seed !== undefined) {
      setRNGSeed(log.metadata.seed);
    }

    // Re-execute all commands using their ORIGINAL step values
    for (const cmd of log.commands) {
      // Build execution context with the ORIGINAL step from the command
      // This ensures all commands from the same tick see the same ctx.step
      const context: ExecutionContext = {
        step: cmd.step, // Use stored step, NOT an incrementing counter
        timestamp: cmd.timestamp,
        priority: cmd.priority
      };

      // Execute via dispatcher's handler directly to avoid re-recording
      const handler = dispatcher.getHandler(cmd.type);
      if (handler) {
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
    }
  }

  clear(): void {
    this.recorded.length = 0;
  }
}

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
 * IMPORTANT: This function replaces gameState properties completely to avoid
 * leaving obsolete keys from pre-reset/migration state. Object.assign would
 * merge properties, causing replayed runs to diverge from original state.
 */
function restoreState(snapshot: StateSnapshot): void {
  // The snapshot is already cloned by the caller (replay method)

  // Clear all existing properties first
  for (const key of Object.keys(gameState)) {
    delete (gameState as any)[key];
  }

  // Copy all snapshot properties to gameState
  for (const key of Object.keys(snapshot)) {
    (gameState as any)[key] = (snapshot as any)[key];
  }

  // Alternative approach for typed state structures:
  // If gameState has a known structure with Maps/Sets, explicitly reconstruct:
  /*
  gameState.resources = new Map(snapshot.resources);
  gameState.entities = new Map(snapshot.entities);
  gameState.unlocks = new Set(snapshot.unlocks);
  gameState.progression = { ...snapshot.progression };
  // etc. - exhaustively assign all root properties
  */
}

```

### 8.3 Deterministic Replay Guarantees

**Critical Design Decisions**: The replay implementation addresses three determinism requirements:

#### 1. Step Counter Preservation

**Problem**: Commands must preserve their originating tick step. Multiple commands executed within the same tick must all see the same `ctx.step` value, both during live play and replay.

**Example Failure** (incorrect approach with auto-increment):
```typescript
// Handler that gates behavior per step
const applyProductionHandler = (payload, ctx: ExecutionContext) => {
  // Only apply once per step (prevent double-application)
  if (lastProductionStep === ctx.step) return;
  lastProductionStep = ctx.step;

  gameState.resources.energy += payload.amount;
};

// Live play tick 100: cmd1.step=100, cmd2.step=100, cmd3.step=100
// All three commands see ctx.step=100 (same tick)

// Replay with auto-increment: cmd1→ctx.step=0, cmd2→ctx.step=1, cmd3→ctx.step=2
// Each command sees different step! Handler logic diverges
```

**Solution**:
- Each `Command` includes a `step` field storing its originating tick number
- During live play: commands are stamped with `currentStep` when enqueued (tick N)
- During live execution: `CommandDispatcher.execute()` uses `cmd.step` for `ctx.step` (still N, not N+1)
- During replay: `CommandRecorder.replay()` uses `cmd.step` directly for `ctx.step` (N)
- This ensures all commands from tick N see `ctx.step = N` in both live play and replay

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
- Alternatively: use separate replay-only dispatcher with no recording subscriptions
- Documentation updated to show both patterns

#### 3. RNG Seed Restoration

**Problem**: `CommandLog.metadata.seed` is exported but never restored during replay. Handlers using randomness diverge.

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
- `CommandRecorder.replay()` checks `log.metadata.seed` and calls `setRNGSeed(seed)` before executing commands
- Handlers **must** use `seededRandom()` instead of `Math.random()` for determinism
- Alternative: restrict handlers to pure deterministic logic only (no randomness)

### 8.4 Freeze/Clone/Restore Lifecycle

**Key Insight**: We separate "freezing for safety" from "cloning for replay". Frozen snapshots remain cloneable because they're plain data, not proxies.

#### Lifecycle Stages

**1. Recording Start (Constructor)**
```typescript
constructor(currentState: GameState) {
  this.startState = cloneDeep(currentState); // Clone to isolate from live state
  deepFreezeInPlace(this.startState);        // Freeze to prevent accidental mutation
}
```

- **Clone first**: `structuredClone()` creates independent copy
- **Freeze second**: `Object.freeze()` makes the clone immutable
- **Result**: `this.startState` is frozen but still cloneable (no proxies)

**2. Export (Creating Command Log)**
```typescript
export(): CommandLog {
  const exportedLog = {
    startState: cloneDeep(this.startState), // Clone the frozen snapshot
    commands: [...this.recorded],
    // ...
  };

  deepFreezeInPlace(exportedLog); // Freeze the exported log
  return exportedLog;
}
```

- **Clone**: `structuredClone()` can clone frozen objects (they're plain data)
- **Freeze**: Exported log is frozen to prevent external mutation
- **Result**: Multiple exports are independent, immutable snapshots

**3. Replay (Restoring State)**
```typescript
replay(log: CommandLog, dispatcher: CommandDispatcher): void {
  const mutableState = cloneDeep(log.startState); // Clone frozen snapshot
  restoreState(mutableState);                     // Apply to game state

  // Re-execute commands using their original step values
  for (const cmd of log.commands) {
    const handler = dispatcher.getHandler(cmd.type);
    if (handler) {
      handler(cmd.payload, {
        step: cmd.step, // Use stored step from command
        timestamp: cmd.timestamp,
        priority: cmd.priority
      });
    }
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
- `Object.freeze()` prevents mutation of plain objects/arrays
- Helps catch accidental bugs in development
- Does NOT work on Map/Set/TypedArray

**Map/Set Limitations**:
```typescript
const map = new Map([['a', { value: 1 }]]);
deepFreezeInPlace(map);

// ✗ Map methods still work (Object.freeze doesn't prevent this!)
map.set('b', 2);      // Succeeds (Map itself is not frozen)
map.delete('a');      // Succeeds

// ✓ But nested objects ARE frozen
map.get('a').value = 2; // Throws: Cannot assign to read-only property

// ✓ Cloning provides real isolation
const clone = structuredClone(map);
clone.set('b', 2);    // Succeeds on clone
map.has('b');         // false (original unaffected)
```

**TypedArray Limitations**:
```typescript
const state = { buffer: new Uint8Array([1, 2, 3]) };
deepFreezeInPlace(state); // Skips TypedArrays (Object.freeze would throw)

// ✗ TypedArray can still be mutated
state.buffer[0] = 99;    // Succeeds (cannot freeze TypedArrays)
state.buffer[0];         // 99 (mutation succeeded)

// ✓ But cloning provides isolation
const clone = structuredClone(state);
clone.buffer[0] = 88;    // Mutate clone

// Original and clone are independent
clone.buffer[0];         // 88 (clone mutated)
state.buffer[0];         // 99 (original unchanged by clone mutation)
```

**Defense Strategy**:
1. **Isolation via cloning**: Snapshots are independent (always works)
2. **Freezing plain objects**: Catches accidental mutations (partial coverage)
3. **Code discipline**: Don't mutate Map/Set/TypedArray in snapshots (enforced by review)

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
- **Partial immutability**: Plain objects/arrays frozen; Map/Set/TypedArray cannot be frozen
- **Cloneability**: No proxies, plain data only (compatible with `structuredClone()`)

**State Serialization Constraints**:

For deterministic replay to work, game state must be **cloneable via `structuredClone()`**. Freezing provides additional safety for plain objects/arrays only.

1. **Supported Types**:
   - **Plain objects and arrays** (cloneable + freezable)
   - **Primitives** (string, number, boolean, null, undefined)
   - **Date objects** (cloneable + freezable)
   - **Map and Set collections** (cloneable, but NOT freezable - remain mutable)
   - **Typed arrays** (Uint8Array, etc.) (cloneable, but NOT freezable - would throw)
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
   // Cycles are safe for freezing (WeakSet prevents infinite recursion)
   const parent = { children: [] };
   const child = { parent };
   parent.children.push(child);

   deepFreezeInPlace(parent); // Works correctly with cycle tracking
   ```

5. **Map/Set/TypedArray Handling**:
   ```typescript
   const state = {
     items: new Map([['a', { value: 1 }]]),
     ids: new Set(['x', 'y']),
     buffer: new Uint8Array([1, 2, 3])
   };

   deepFreezeInPlace(state);

   // ✗ Map/Set are NOT frozen (Object.freeze limitation)
   state.items.set('b', 2);  // Succeeds (Map methods work)
   state.ids.add('z');       // Succeeds (Set methods work)

   // ✗ TypedArrays are NOT frozen (would throw if we tried)
   state.buffer[0] = 99;     // Succeeds (cannot freeze TypedArrays)

   // ✓ But nested objects ARE frozen
   state.items.get('a').value = 2; // Throws: read-only property

   // ✓ Cloning provides true isolation (primary defense)
   const clone = structuredClone(state);
   clone.items.set('c', 3);
   clone.ids.add('w');
   clone.buffer[0] = 88;

   // Original is unaffected by clone mutations
   state.items.has('c');  // false
   state.ids.has('w');    // false
   state.buffer[0];       // Still 99 (or 1 if never mutated)
   ```

   **Important**: The recorder relies primarily on **cloning for isolation**, not freezing. Map/Set/TypedArray in snapshots should not be mutated (enforced by code review), but the architecture remains safe because:
   - Each `export()` clones the snapshot
   - Each `replay()` clones the snapshot
   - Mutations affect only the clone, never the original

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
    telemetry.recordWarning('CommandQueueOverflow', { size: this.size });
    // Drop oldest automation commands first
    this.dropLowestPriority();
  }
  // ... proceed with enqueue
}
```

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

The presentation layer performs optimistic validation before sending commands:

```typescript
// In React hook
const canAffordGenerator = (id: string, cost: number) => {
  return gameState.resources['energy'] >= cost;
};

const buyGenerator = (id: string, cost: number) => {
  if (!canAffordGenerator(id, cost)) {
    showError('Insufficient resources');
    return; // Don't enqueue invalid command
  }

  workerBridge.sendCommand({ ... });
};
```

The runtime performs authoritative validation during execution:

```typescript
// In command handler
const purchaseGeneratorHandler = (payload: PurchaseGeneratorPayload) => {
  const generator = registry.getGenerator(payload.generatorId);
  const resource = registry.getResource(generator.costResource);

  if (resource.amount < generator.cost) {
    telemetry.recordWarning('InsufficientResources', payload);
    return; // Command rejected, no state mutation
  }

  resource.amount -= generator.cost;
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
- [ ] Implement `CommandQueue` data structure with priority lanes
- [ ] Implement `CommandDispatcher` with handler registration
- [ ] Add command types and payload interfaces for resource operations
- [ ] Write unit tests for queue ordering and priority resolution

### 12.2 Week 2 Tasks
- [ ] Integrate command queue into tick loop (update `IdleEngineRuntime`)
- [ ] Implement command handlers for purchase/toggle operations
- [ ] Add Worker bridge message handler for incoming commands
- [ ] Write integration tests for end-to-end command flow

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

## 15. Open Questions

1. Should automation commands be throttled per-tick to prevent starvation of player commands?
2. How do we handle command conflicts (e.g., prestige reset invalidating pending purchases)?
3. Should command logs include RNG seed for full deterministic replay of stochastic events?

## 16. References

- [Game Programming Patterns: Command](https://gameprogrammingpatterns.com/command.html)
- [Game Programming Patterns: Event Queue](https://gameprogrammingpatterns.com/event-queue.html)
- Idle Engine Design Document (Section 9.1 - Tick Pseudocode)
- Implementation Plan (Section 4 - Runtime Core Tasks)
