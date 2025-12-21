---
title: Runtime Command Queue Design
sidebar_position: 4
---

# Runtime Command Queue Design

## Document Control
- **Title**: Introduce deterministic command queue for runtime state mutations
- **Authors**: Runtime Core Team
- **Reviewers**: N/A
- **Status**: Approved
- **Last Updated**: 2025-10-11
- **Related Issues**: #6
- **Execution Mode**: AI-led

## 1. Summary

The command queue is a core runtime component that enables deterministic, replayable game state mutations. It decouples user input, automation systems, and server-confirmed actions from immediate execution, allowing the runtime to process all state changes within the fixed-step tick loop. By routing all mutations through a priority-based queue, the system ensures reproducible simulation for offline catch-up, debugging, and potential multiplayer synchronization while maintaining strict performance budgets and type safety.

## 2. Context & Problem Statement

### Background
The Idle Engine runtime requires a mechanism to manage state mutations from multiple sources (player input, automation systems, engine operations) within its fixed-step tick loop. Without a structured approach, state changes would occur unpredictably, making deterministic replay impossible and complicating debugging.

### Problem
- Multiple systems need to mutate game state (UI layer, automation, engine migrations)
- Direct state mutation breaks determinism required for offline catch-up and debugging
- No mechanism exists to prioritize conflicting operations (e.g., player input vs automation)
- Command execution must occur within the 100ms tick budget while maintaining type safety

### Forces
- Performance target: Minimal overhead for command enqueueing and processing within 100ms tick budget
- Determinism requirement: Reproducible simulation for offline catch-up and debugging
- Type safety: Strongly-typed command payloads that prevent invalid mutations at compile time
- Priority handling: Support multiple command sources with configurable priority tiers

## 3. Goals & Non-Goals

### Goals
- **Determinism**: All state mutations occur through commands executed within tick steps, ensuring reproducible simulation for offline catch-up and debugging
- **Priority Control**: Support multiple command sources (player, automation, system) with configurable priority tiers to resolve execution order conflicts
- **Serialization**: Enable command recording/replay for debugging, testing, and potential multiplayer synchronization
- **Performance**: Minimal overhead for command enqueueing and processing within the 100ms tick budget
- **Type Safety**: Strongly-typed command payloads that prevent invalid mutations at compile time

### Non-Goals
- Network synchronization protocols (handled by separate social system layer)
- Complex undo/redo UI flows (out of scope for prototype milestone)
- Cross-tick command scheduling (time-based tasks use dedicated Task Scheduler system)

## 4. Stakeholders, Agents & Impacted Surfaces

### Primary Stakeholders
- Runtime Core Team: Responsible for implementation and maintenance
- Content Module Authors: Consumers of the command API

### Agent Roles
- Runtime Implementation Agent: Implements core command queue and dispatcher logic
- Integration Agent: Connects command queue to tick loop and worker bridge
- Testing Agent: Creates unit and integration tests for command flow

### Affected Packages/Services
- `packages/core`: Command queue, dispatcher, recorder implementations
- `packages/shell-web`: Worker bridge integration for command submission
- Runtime worker: Tick loop integration and command execution

### Compatibility Considerations
- Command payloads must be structured-cloneable for worker communication
- Backward compatibility for command log format versioning
- API stability for command handler registration

## 5. Current State

Prior to this design, the runtime lacked a formalized command system. State mutations occurred directly within systems or handlers, making deterministic replay impossible. There was no mechanism to prioritize operations from different sources or to record the sequence of state changes for debugging purposes.

## 6. Proposed Solution

### 6.1 Architecture Overview

The command queue system consists of three primary components:

1. **CommandQueue**: Priority-based queue structure that maintains separate FIFO lanes per priority tier
2. **CommandDispatcher**: Routes commands to type-specific handlers and manages execution context
3. **CommandRecorder**: Captures command history and initial state for replay and debugging

Commands flow through the system as follows:
1. External sources (UI, automation) enqueue commands with priority and payload
2. Tick loop dequeues all commands at the start of each step
3. Dispatcher executes commands in priority order
4. Handlers mutate state through well-defined interfaces
5. Recorder captures executed commands for replay

### 6.2 Detailed Design

#### Runtime Changes

##### State Graph Structure Requirements

**Decision**: The runtime supports **cyclic state graphs** with **structured-cloneable types**.

**Supported State Structures**

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

**Cloning Behavior**

The recorder uses `structuredClone()` which provides:

1. **Cycle Preservation**: Circular references are cloned correctly
2. **Collection Cloning**: Map and Set are deeply cloned
3. **Type Preservation**: Objects maintain their identity (Date, Map, Uint8Array, etc.)

**Unsupported Types**

`structuredClone()` and `deepFreeze()` cannot handle:
- Functions
- Class instances with methods
- DOM Nodes and Browser APIs
- WeakMap/WeakSet
- Symbol-keyed properties

**State Design Guidelines**

Recommended pattern: Plain data with Maps/Sets/Arrays
```typescript
interface GameState {
  resources: Map<string, {
    id: string;
    amount: number;
    rate: number;
  }>;
  entities: Map<string, {
    id: string;
    parent?: EntityNode; // Cycle preserved
    children: EntityNode[];
  }>;
  timeline: {
    started: Date;
    events: Array<{ at: Date; type: string }>;
  };
  version: string;
  seed: number; // RNG seed for determinism
}
```

**Performance Implications**

1. **Clone Cost**: `structuredClone()` has O(n) cost where n = object graph size
   - Typical game state (10k entities): ~5-10ms clone time
   - Large state (100k entities): ~50-100ms clone time
   - Mitigation: Only clone at recording start, not per command

2. **Freeze Cost**: `deepFreeze()` traverses entire graph once
   - Same complexity as clone: O(n)
   - Only called during `export()`, not on hot path

3. **Memory**: Snapshot holds complete state copy
   - Budget: ~5 MB for moderate game state
   - Monitor via telemetry if state grows beyond budget

##### Command Interface

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

##### Command Queue Structure

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

  enqueue(command: Command): void {
    const queue = this.queues.get(command.priority);
    if (!queue) {
      throw new Error(`Invalid priority: ${command.priority}`);
    }

    const storedCommand = cloneCommand(command);
    const entry: CommandQueueEntry<CommandSnapshot> = {
      command: storedCommand,
      sequence: this.nextSequence++
    };

    // Binary search insertion for deterministic ordering
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
        queue.length = 0;
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

##### Step Field Population

**Critical Design Pattern**: The `step` field stores the **simulation tick that will execute the command**. The queuing site is responsible for stamping the step as the command crosses into the queue.

**Step Stamping Locations**

1. **UI Commands (from Main Thread)**: Worker runtime stamps with `nextExecutableStep`
2. **System-Generated Commands (inside Worker)**: Systems stamp with `context.step + 1`
3. **Engine Commands (inside Worker)**: Engine code stamps with `currentStep + 1`

**Step Lifecycle**

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
```

##### Command Execution Flow

```typescript
let currentStep = 0;
let nextExecutableStep = 0;

function runTick(deltaMs: number) {
  accumulator += deltaMs;
  const steps = clamp(floor(accumulator / FIXED_STEP_MS), 0, MAX_STEPS_PER_FRAME);
  accumulator -= steps * FIXED_STEP_MS;

  for (let i = 0; i < steps; i++) {
    nextExecutableStep = currentStep;
    const commands = commandQueue.dequeueAll();
    nextExecutableStep = currentStep + 1;

    for (const cmd of commands) {
      if (cmd.step !== currentStep) {
        telemetry.recordError('CommandStepMismatch', {
          expectedStep: currentStep,
          commandStep: cmd.step,
          type: cmd.type
        });
        continue;
      }
      commandDispatcher.execute(cmd);
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

    currentStep++;
    nextExecutableStep = currentStep;
  }
}
```

**System Constraints**

Systems MUST NOT mutate state directly during `tick()`. Instead, they analyze current state and enqueue commands that will be executed in the **next** tick step. This ensures:
1. All mutations flow through the command queue and are captured by `CommandRecorder`
2. System logic remains pure and testable (reads state, outputs commands)
3. Replaying a command log reproduces identical state without re-running systems

**System-Queue Interaction Model**

Systems interact with the command queue **only by enqueueing commands**. They never need to be instrumented for replay. During replay, systems are NOT executed—only commands are re-executed via the dispatcher.

##### Command Dispatcher

```typescript
export interface ExecutionContext {
  readonly step: number;
  readonly timestamp: number;
  readonly priority: CommandPriority;
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

    const context: ExecutionContext = {
      step: command.step,
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
```

##### ResourceState Integration

Command handlers depend on the `ResourceState` façade exported from `@idle-engine/core`. The façade centralizes index lookups, dirty tracking, and telemetry:

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
- **Index acquisition**: `requireIndex(id)` throws after recording telemetry when handed an unknown id
- **Mutation helpers**: `addAmount`, `spendAmount`, `setCapacity`, etc. clamp values and emit telemetry
- **Dirty propagation**: Successful mutations mark indices dirty for publish snapshots

#### Data & Schemas

##### Command Types (Initial Set)

For the prototype milestone, we define commands for core interactions:

**Resource Commands**
```typescript
interface PurchaseGeneratorPayload {
  generatorId: string;
  count: number;
}

interface ToggleGeneratorPayload {
  generatorId: string;
  enabled: boolean;
}

interface CollectResourcePayload {
  resourceId: string;
  amount: number;
}
```

**Prestige Commands**
```typescript
interface PrestigeResetPayload {
  layer: number;
  confirmationToken?: string;
}
```

**System Commands**
```typescript
interface OfflineCatchupPayload {
  elapsedMs: number;
  resourceDeltas: Record<string, number>;
}

interface ApplyMigrationPayload {
  fromVersion: string;
  toVersion: string;
  transformations: MigrationStep[];
}
```

##### Priority Resolution

When multiple commands are enqueued during a single frame:
1. **System commands** (priority 0) execute first
2. **Player commands** (priority 1) execute next
3. **Automation commands** (priority 2) execute last

Within the same priority tier, commands execute in timestamp order (FIFO).

#### APIs & Contracts

##### Worker Bridge API

The Worker bridge provides a type-safe command interface for the presentation layer:

```typescript
export enum CommandSource {
  PLAYER = 'PLAYER',
  AUTOMATION = 'AUTOMATION',
  SYSTEM = 'SYSTEM'
}

export interface WorkerBridge {
  sendCommand<T = unknown>(type: string, payload: T): void;
  onStateUpdate(callback: (state: GameState) => void): void;
}
```

The bridge implementation wraps commands with metadata and posts to the Worker. The Worker runtime stamps external commands with `nextExecutableStep` before enqueueing.

##### Command Recording & Replay

**Recorder Snapshot Lifecycle**

The recorder captures its state snapshot at **construction time**, before any commands are recorded.

```typescript
export interface CommandLog {
  readonly version: string;
  readonly startState: StateSnapshot;
  readonly commands: readonly Command[];
  readonly metadata: {
    readonly recordedAt: number;
    readonly seed?: number;
    readonly lastStep: number;
  };
}

export class CommandRecorder {
  private readonly recorded: Command[] = [];
  private startState: StateSnapshot;
  private rngSeed: number | undefined;
  private lastRecordedStep = -1;

  constructor(currentState: GameState, options?: { seed?: number }) {
    this.startState = cloneDeep(currentState);
    deepFreezeInPlace(this.startState);
    this.rngSeed = options?.seed ?? getCurrentRNGSeed?.();
  }

  record(command: Command): void {
    const snapshot = cloneDeep(command);
    deepFreezeInPlace(snapshot);
    this.recorded.push(snapshot);
    this.lastRecordedStep = Math.max(this.lastRecordedStep, command.step);
  }

  export(): CommandLog {
    const exportedLog = {
      version: '0.1.0',
      startState: cloneDeep(this.startState),
      commands: this.recorded.map(cloneDeep),
      metadata: {
        recordedAt: Date.now(),
        seed: this.rngSeed,
        lastStep: this.lastRecordedStep
      }
    };
    return deepFreezeInPlace(exportedLog);
  }

  replay(log: CommandLog, dispatcher: CommandDispatcher): void {
    for (const cmd of log.commands) {
      const handler = dispatcher.getHandler(cmd.type);
      if (handler) {
        handler(cmd.payload, {
          step: cmd.step,
          timestamp: cmd.timestamp,
          priority: cmd.priority
        });
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
```

**Usage Patterns**

Session Recording (typical use case):
```typescript
const gameState = await loadSaveOrCreateNew();
const sessionRecorder = new CommandRecorder(gameState);

function executeAndRecord(cmd: Command) {
  sessionRecorder.record(cmd);
  dispatcher.execute(cmd);
}

const log = sessionRecorder.export();
sendToServer(log);
```

Deterministic Testing:
```typescript
const testState = { resources: { energy: 100 }, generators: {} };
const recorder = new CommandRecorder(testState);

for (const cmd of commands) {
  recorder.record(cmd);
  dispatcher.execute(cmd);
}

const log = recorder.export();
const replayState = await replayLog(log);
expect(replayState).toEqual(currentState);
```

### 6.3 Operational Considerations

#### Deployment
The command queue is integrated into the runtime core package and deployed as part of the Worker bundle. No separate deployment or rollout is required.

#### Telemetry & Observability
Key metrics exposed:
- `CommandQueueDepth`: Current size of each priority lane
- `CommandExecutionTime`: Time spent processing commands per tick
- `CommandStepMismatch`: Commands with incorrect step stamps
- `CommandDropped`: Commands evicted due to queue overflow
- `UnknownCommandType`: Unregistered command types
- `CommandExecutionFailed`: Handler exceptions

#### Security & Compliance
- Command payloads from external sources are validated before execution
- Queue size limits prevent memory exhaustion attacks
- Command logs may contain sensitive game state—encryption required for transmission

## 7. Work Breakdown & Delivery Plan

### 7.1 Issue Map

| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| feat(core): implement CommandQueue data structure | Priority-based queue with FIFO lanes | Runtime Implementation Agent | Design approval | Unit tests pass; deterministic ordering verified |
| feat(core): implement CommandDispatcher | Handler registration and execution | Runtime Implementation Agent | CommandQueue complete | Handler registration works; execution context correct |
| feat(core): add command types for resource operations | Payload interfaces for core commands | Runtime Implementation Agent | None | TypeScript compilation; payload validation |
| feat(core): integrate command queue into tick loop | Connect queue to runtime execution | Integration Agent | CommandQueue, CommandDispatcher | Commands execute in correct order within tick |
| feat(core): implement command handlers | Resource operation handlers | Integration Agent | Tick loop integration | Handlers mutate state correctly; telemetry emitted |
| feat(shell-web): add Worker bridge command handler | Message handling for external commands | Integration Agent | Tick loop integration | Commands from UI reach runtime; step stamping correct |
| feat(core): implement CommandRecorder | Recording and replay functionality | Runtime Implementation Agent | CommandDispatcher | Replay produces identical state; logs are immutable |
| feat(core): add queue capacity limits | Overflow handling and eviction | Runtime Implementation Agent | CommandQueue | Queue respects limits; telemetry on overflow |
| docs(core): document command API contracts | API documentation for content modules | Documentation Agent | All implementation complete | Clear usage examples; common patterns documented |

### 7.2 Milestones

**Phase 1: Core Implementation (Week 1)**
- CommandQueue and CommandDispatcher implementation
- Basic command types and payload interfaces
- Unit tests for queue ordering and priority resolution

**Phase 2: Integration (Week 2)**
- Tick loop integration
- Command handlers for core operations
- Worker bridge message handling
- Integration tests for end-to-end flow

**Phase 3: Recording & Polish (Week 3)**
- CommandRecorder implementation
- Queue capacity limits and error handling
- API documentation
- Performance profiling

### 7.3 Coordination Notes

**Hand-off Package**:
- Source files: `packages/core/src/command-queue.ts`, `packages/core/src/command-dispatcher.ts`, `packages/core/src/command-recorder.ts`
- Test files: `packages/core/src/command-queue.test.ts`, `packages/core/src/index.test.ts`
- Integration points: `packages/core/src/index.ts` (tick loop), `packages/shell-web/src/runtime.worker.ts` (worker bridge)

**Communication Cadence**: Daily status updates during active implementation; review checkpoints at end of each phase

## 8. Agent Guidance & Guardrails

### Context Packets
- Review Idle Engine Design Document (Section 9.1 - Tick Pseudocode)
- Review Resource State Storage Design (Section 5.2 - Runtime API Surface)
- Review Implementation Plan (Section 4 - Runtime Core Tasks)

### Prompting & Constraints
- All command interfaces must be readonly to enforce immutability
- Use `structuredClone()` for defensive copying
- Apply `deepFreezeInPlace()` to command snapshots in development builds
- Follow naming convention: `Command` suffix for interfaces, `Payload` suffix for data types
- Commit messages must follow conventional commits format: `feat(core): <description>`

### Safety Rails
- Do not mutate state directly in systems—always enqueue commands
- Do not skip command validation—handlers must verify preconditions
- Do not ignore telemetry—emit events for all error conditions
- Do not use `Math.random()`—use seeded PRNG for determinism

### Validation Hooks
Before marking implementation complete:
- Run `npm test` and verify all tests pass
- Run `npm run build` and verify no TypeScript errors
- Run `npm run lint` and verify no linting errors
- Verify command replay produces identical state in integration tests

## 9. Alternatives Considered

### Alternative 1: Direct State Mutation
**Description**: Allow systems to mutate state directly without a command queue

**Pros**: Simpler implementation, lower overhead

**Cons**: Non-deterministic replay, difficult debugging, no priority control

**Decision**: Rejected. Determinism is a core requirement for offline catch-up.

### Alternative 2: Event Bus Pattern
**Description**: Publish/subscribe event system for state changes

**Pros**: Decoupled components, extensible

**Cons**: Execution order non-deterministic, harder to replay, performance overhead from event dispatching

**Decision**: Rejected. Command pattern provides better determinism guarantees.

### Alternative 3: Transaction Log
**Description**: Record state diffs instead of commands

**Pros**: Smaller log size, faster replay

**Cons**: Complex diff calculation, harder to debug (diffs less readable than commands), replay requires perfect state reconstruction

**Decision**: Rejected. Commands are more debuggable and easier to reason about.

## 10. Testing & Validation Plan

### Unit / Integration

**Unit Tests** (`packages/core/src/command-queue.test.ts`):
- Commands execute in priority order
- FIFO ordering maintained within same priority
- Timestamp-based ordering with sequence fallback
- Queue size tracking accurate
- Clear operation resets state

**Integration Tests** (`packages/core/src/index.test.ts`):
- Commands execute correctly within tick loop
- Step stamping accurate for all sources
- System-generated commands enqueue for next tick
- State mutations apply through ResourceState facade
- Telemetry emitted on errors

**Replay Tests**:
- Replaying command log reproduces identical state
- Exported logs are immutable
- Seed restoration works correctly
- Clear operation resets recorder state

### Performance

**Benchmarks**:
- 10,000 queued commands process in <5ms
- Command overhead <5% of 100ms tick budget
- Memory footprint <3MB for typical queue depth

**Profiling Methodology**:
- Use Chrome DevTools performance profiling in Worker context
- Measure enqueue, dequeue, and execute separately
- Test with realistic command mix (70% automation, 20% player, 10% system)

**Success Thresholds**:
- Enqueue: <1µs per command
- Dequeue: <5ms for full queue drain
- Execute: <10µs per command (handler-dependent)

### Tooling / A11y
N/A - This is a runtime-only feature with no UI components.

## 11. Risks & Mitigations

**Risk**: Queue overflow from runaway automation
**Mitigation**: Implement `MAX_QUEUE_SIZE` limit with priority-based eviction. Emit telemetry on overflow for monitoring.

**Risk**: Non-deterministic command generation in systems
**Mitigation**: Enforce read-only state proxies in development builds. Document determinism requirements clearly.

**Risk**: Handler exceptions breaking tick loop
**Mitigation**: Wrap handler execution in try-catch. Log errors via telemetry but continue processing remaining commands.

**Risk**: Replay divergence due to missing RNG seed
**Mitigation**: Capture RNG seed in CommandLog metadata. Restore seed before replay.

**Risk**: Performance degradation with large command logs
**Mitigation**: Batch replay in chunks of 1000 commands. Profile and optimize hot paths.

## 12. Rollout Plan

### Milestones
- **Week 1**: Core implementation complete, unit tests passing
- **Week 2**: Integration complete, end-to-end tests passing
- **Week 3**: Recording/replay complete, documentation published

### Migration Strategy
No migration required—this is a new feature. Existing systems will be refactored to use command queue as they are implemented.

### Communication
- Publish API documentation in `/docs` directory
- Add usage examples in implementation plan
- Notify content module authors of command API availability

## 13. Open Questions

All design questions have been resolved through the development process. See Section 15 (Resolved Decisions) for documentation of key decisions.

## 14. Follow-Up Work

**Post-Prototype Enhancements**:
- Conditional Commands: Commands that execute only when predicates are met
- Macro Commands: Composite commands for complex multi-step actions
- Network Sync: Serialize command stream for multiplayer synchronization
- Rollback: Store command checkpoints for efficient undo/redo
- Compression: Delta-encode command logs for reduced storage/bandwidth

**Technical Debt**:
- Extend read-only proxy to wrap Map/Set accessor results
- Implement multiple RNG stream registration API
- Add command log encryption for secure transmission

## 15. References

- [Game Programming Patterns: Command](https://gameprogrammingpatterns.com/command.html)
- [Game Programming Patterns: Event Queue](https://gameprogrammingpatterns.com/event-queue.html)
- [Idle Engine Design Document](./idle-engine-design.md) (Section 9.1 - Tick Pseudocode)
- [Resource State Storage Design](./resource-state-storage-design.md) (Section 5.2 - Runtime API Surface)
- [Implementation Plan](./implementation-plan.md) (Section 4 - Runtime Core Tasks)
- [Tick Accumulator Coverage Design](./tick-accumulator-coverage-design.md) (Sections 5.1-5.3)

**Relevant Code Paths**:
- `packages/core/src/command-queue.ts`: CommandQueue implementation
- `packages/core/src/command-dispatcher.ts`: CommandDispatcher implementation
- `packages/core/src/command-recorder.ts`: CommandRecorder implementation
- `packages/core/src/index.ts:120`: Tick loop integration
- `packages/core/src/command-queue.test.ts:553`: Priority resolution tests
- `packages/core/src/index.test.ts:193`: Integration tests
- `packages/shell-web/src/runtime.worker.test.ts:136`: Worker bridge tests

## Appendix A — Glossary

- **Command**: An object representing a state mutation with type, priority, payload, timestamp, and step
- **Command Queue**: Priority-based queue structure maintaining separate FIFO lanes per priority tier
- **Command Dispatcher**: Routes commands to type-specific handlers and manages execution context
- **Command Recorder**: Captures command history and initial state for replay and debugging
- **Command Priority**: Enumeration defining execution order (SYSTEM < PLAYER < AUTOMATION)
- **Command Snapshot**: Immutable, frozen copy of a command for replay and logging
- **Execution Context**: Metadata passed to handlers (step, timestamp, priority)
- **Step**: Simulation tick number when a command will execute
- **Structured Clone**: Deep copy operation supporting cycles, Maps, Sets, and typed arrays
- **Deep Freeze**: Recursive immutability enforcement via `Object.freeze()`
- **FIFO**: First-In-First-Out ordering within priority lanes
- **Determinism**: Property ensuring identical inputs produce identical outputs

## Appendix B — Change Log

| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2025-10-11 | Runtime Core Team | Migrated to design document template format |
| 2025-10-11 | Runtime Core Team | Added accumulator diagnostics coverage; documented system execution order, error handling, and deferred enqueue behavior; strengthened priority guarantees; validated monotonic clock behavior |

## Appendix C — Resolved Decisions

**Automation throttling**: No per-tick throttle in the initial release. We rely on `MAX_QUEUE_SIZE`, per-priority depth telemetry, and `CommandQueueOverflow`/`CommandDropped` signals to surface runaway automation. If telemetry shows chronic starvation, we will introduce targeted throttles as a follow-up enhancement.

**Command conflicts**: Handlers must revalidate state at execution time and gracefully no-op when their preconditions are invalidated (emitting `telemetry.recordWarning('CommandConflict', …)`). Destructive operations such as prestige reset must flush or invalidate dependent state via their handlers; the queue itself remains FIFO and does not perform speculative reordering.

**Multiple RNG streams**: Yes. Each subsystem that owns an independent PRNG must register with the runtime RNG module so the recorder can capture and restore every active seed. The RNG helper will expose `registerRNGStream(id, getSeed, setSeed)` to supplement the existing global seed capture.

## Appendix D — Implementation Status

### Completed Tasks (Week 1)
- [x] Implement `CommandQueue` data structure with priority lanes
- [x] Implement `CommandDispatcher` with handler registration
- [x] Add command types and payload interfaces for resource operations
- [x] Write unit tests for queue ordering and priority resolution (`packages/core/src/command-queue.test.ts:553`)

### In Progress (Week 2)
- [ ] Integrate command queue into tick loop (update `IdleEngineRuntime`)
- [ ] Implement command handlers for purchase/toggle operations
- [ ] Add Worker bridge message handler for incoming commands
- [x] Write integration tests for end-to-end command flow (`packages/core/src/index.test.ts:193`, `packages/shell-web/src/runtime.worker.test.ts:136`)

### Pending (Week 3)
- [ ] Implement `CommandRecorder` for debugging/replay
- [ ] Add validation layer with error handling
- [ ] Implement queue capacity limits and overflow handling
- [ ] Document command API contracts for content modules

### Success Criteria Status

The command queue is complete when:

1. **Determinism**: Replaying a command log produces identical final state (verified by property tests) - IN PROGRESS
2. **Priority**: Commands execute in correct priority order across 1000+ enqueued commands (benchmark) - COMPLETE
3. **Performance**: Command processing overhead stays under 5% of the tick budget at 60 ticks/sec (profiled) - PENDING
4. **Integration**: React shell can enqueue commands, runtime executes them, state updates reflected in UI (E2E test) - IN PROGRESS
5. **Observability**: Command queue depth and execution metrics exposed via diagnostics interface - PENDING
