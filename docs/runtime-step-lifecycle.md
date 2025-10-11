# Runtime Step Lifecycle Alignment

This note cross-references the implementation with
`docs/runtime-command-queue-design.md` §4.3 to confirm that runtime, systems,
and UI sources stamp commands consistently.

## IdleEngineRuntime (Worker)

- `packages/core/src/index.ts` manages `currentStep` / `nextExecutableStep`
  exactly as described in the design. The tick loop sets
  `nextExecutableStep = currentStep` before capturing the queue batch, advances
  it to `currentStep + 1` as soon as the batch is secured, and records a
  `CommandStepMismatch` telemetry event if a queued command is stamped for a
  different tick.
- `TickContext.step` surfaces the just-executed tick so internal systems stamp
  follow-up commands with `context.step + 1`, aligning system enqueues with the
  next tick boundary.

## Worker Bridge

- `packages/shell-web/src/runtime.worker.ts` acts as the security boundary for UI
  commands. Incoming messages are always treated as `PLAYER` priority and
  stamped with the Worker's monotonic clock plus the runtime's
  `getNextExecutableStep()` value before entering the queue (§7.2). Systems
  running inside the Worker can enqueue with elevated priorities because they
  already execute within the trusted boundary.
- The Worker runs the simulation loop on a fixed interval, forwarding the
  current step back to the UI so presentation code can confirm progression
  without accessing internal counters directly.

## Presentation Shell

- `packages/shell-web/src/modules/worker-bridge.ts` exposes `sendCommand` that
  mirrors the design’s `WorkerBridge` API (§7.1). The bridge wraps UI commands
  with `CommandSource.PLAYER` and a UI-side timestamp while delegating actual
  step stamping to the Worker.
- `packages/shell-web/src/modules/App.tsx` consumes the bridge and reacts to
  state updates, keeping UI logic aligned with the Worker-driven tick lifecycle
  rather than assuming direct access to runtime internals.

Together these pieces keep live execution, system automation, and UI command
entry synchronized with the fixed-step lifecycle detailed in the design doc.
