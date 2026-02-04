# Design: First-Class Input Events for Desktop Shell Controls

**Issue**: #850
**Status**: Draft - Classification Complete
**Feature Types**: Primary: API, Secondary: Workflow, Data Model

---

## 1. Scope

### Problem
The desktop shell currently forwards unmatched control/pointer events as an ad-hoc `SHELL_CONTROL_EVENT` runtime command with untyped metadata. This makes input handling harder to reason about, serialize, and replay deterministically.

### Goals
- [ ] Remove the implicit passthrough behavior and `SHELL_CONTROL_EVENT` usage from the desktop shell input pipeline.
- [ ] Keep pointer-driven UI interactions working in the test-game desktop shell.
- [ ] Define a well-typed, serializable payload shape for forwarded input events (including pointer events).

### Non-Goals
- Add support for every possible input device/event type (gamepad, multi-touch gestures, etc.) beyond what is needed to preserve existing pointer UI behavior.
- Redesign the renderer/UI system or change unrelated runtime command queue semantics.

### Boundaries
- **In scope**: `packages/shell-desktop` input capture and IPC flow, `@idle-engine/controls` event→command mapping behavior as needed, and any core/controls contracts required to represent input events deterministically.
- **Out of scope**: Replay file/container format changes, renderer contract changes, or new UI widgets/interaction patterns beyond maintaining current behavior.

---

## 2. Workflow

This feature changes the **input event workflow** so that pointer/UI interactions are preserved via **explicit, typed input-event commands** (not implicit `metadata.passthrough` forwarding and not `SHELL_CONTROL_EVENT`).

**State gates (explicit)**:
- **Initial state**: `shell.booting` (entered when `packages/shell-desktop/src/main.ts` is evaluated).
- **Terminal states**: `shell.startup_failed` (process exits) and `sim.terminated` (controller is disposed and owns no worker).
- **Halted states**: `sim.stopped` and `sim.crashed` accept no input and require an explicit restart transition to re-enter `sim.initializing`.
- **Reversibility**: No transition is reversible in-place; recovery is via **explicit restart** (`sim.* -> sim.initializing`) which creates a new sim worker controller and resets nested input state to `sim.running.input.idle`.

### States
| State | Description | Entry Condition |
|-------|-------------|-----------------|
| shell.booting | Electron main process module is loading; window/IPC may not exist yet. | Node/Electron loads `main.ts`. |
| shell.startup_failed | App failed during startup and exits with a non-zero code; no further transitions. | `app.whenReady()` rejects (startup exception). |
| sim.initializing | Sim worker is spawned; init message sent; waiting for `ready`. Input events are ignored. | App is ready and sim worker controller is created (or restarted). |
| sim.running.input.idle | Sim tick loop is active; no pending input work. | Worker sends `ready`; tick loop starts; nested input state initialized. |
| sim.running.input.pointer_move_coalescing | Renderer is coalescing pointer-move events to one per animation frame. | Renderer receives pointer-move and schedules a RAF flush. |
| sim.running.input.processing | Main process is validating an input event and mapping it to runtime command(s). | Main receives a candidate input event from renderer IPC. |
| sim.running.input.enqueued | Command(s) were accepted for delivery to the sim worker. | Mapping produced ≥1 command and `worker.postMessage({ kind: 'enqueueCommands' ... })` succeeds. |
| sim.running.input.dropped | Input event was valid but produced no commands (and is not forwarded). | Mapping produced 0 commands for the event. |
| sim.running.input.rejected | Input event was invalid and is not processed. | Input event fails schema/shape validation at IPC boundary. |
| sim.disposing | Sim worker controller is shutting down; tick loop stopped; no further input accepted. | Window reload/close, or app shutdown triggers controller dispose. |
| sim.terminated | Sim worker controller is fully disposed; no worker thread is owned. | Worker is terminated/closed and controller resources are released. |
| sim.stopped | Sim worker exited cleanly (code 0); no further input accepted until restart. | Worker emits `exit` with code `0` while not disposing. |
| sim.crashed | Sim worker or IPC bridge failed; no further input accepted until restart. | Worker emits `error`/`messageerror`, sends `kind:'error'`, or exits non-zero while not disposing. |

### Transitions
| From | Event/Condition | To | Side Effects |
|------|-----------------|-----|--------------|
| shell.booting | `app.whenReady()` resolves. | sim.initializing | Register IPC handlers; create window; spawn sim worker; send worker `init`; (renderer may begin loading independently). |
| shell.booting | `app.whenReady()` rejects. | shell.startup_failed | `console.error(error)`; `app.exit(1)`. |
| sim.initializing | Worker sends `kind:'ready'`. | sim.running.input.idle | Persist `stepSizeMs` + `nextStep`; start tick interval; begin accepting input events. |
| sim.initializing | Worker sends `kind:'error'` OR emits `error`/`messageerror` OR exits non-zero. | sim.crashed | Stop tick interval; log failure; notify renderer via `simStatus` IPC; terminate worker. |
| sim.running.input.idle | Renderer sends a non-coalesced input event (e.g. pointer-down/up, wheel, key). | sim.running.input.processing | Snapshot current `nextStep`/`stepSizeMs`; begin validation + mapping. |
| sim.running.input.idle | Renderer sends pointer-move; renderer schedules RAF coalescing. | sim.running.input.pointer_move_coalescing | Store latest pointer-move; overwrite older move; ensure exactly one RAF is scheduled. |
| sim.running.input.pointer_move_coalescing | RAF flush runs with a pending pointer-move. | sim.running.input.processing | Emit exactly one pointer-move input event for the latest pending move; begin validation + mapping. |
| sim.running.input.pointer_move_coalescing | RAF flush runs with no pending pointer-move. | sim.running.input.idle | No-op (state returns to idle). |
| sim.running.input.processing | Input event fails IPC validation / schema checks. | sim.running.input.rejected | Drop event; optionally log (dev-only); do not enqueue commands. |
| sim.running.input.processing | Input event is valid; mapping produces 0 commands. | sim.running.input.dropped | Drop event; do not enqueue commands. |
| sim.running.input.processing | Input event is valid; mapping produces ≥1 command; `postMessage` succeeds. | sim.running.input.enqueued | Send `enqueueCommands` to worker; no acknowledgment is required. |
| sim.running.input.processing | Mapping throws OR `postMessage` throws. | sim.crashed | Treat as fatal bridge failure: stop tick interval; log error; notify renderer via `simStatus`; terminate worker. |
| sim.running.input.enqueued | After `postMessage` returns. | sim.running.input.idle | Clear per-event temporary state; await next input. |
| sim.running.input.dropped | Immediately after dropping. | sim.running.input.idle | Clear per-event temporary state; await next input. |
| sim.running.input.rejected | Immediately after rejecting. | sim.running.input.idle | Clear per-event temporary state; await next input. |
| sim.running.input.* | Tick interval fires. | sim.running.input.* | `postMessage({ kind:'tick', deltaMs })`; no state change for input pipeline. |
| sim.running.input.* | Worker sends `kind:'frame'`. | sim.running.input.* | Update `nextStep`; forward latest frame to renderer via `frame` IPC; ignore if `frame` is absent. |
| sim.running.input.* | Worker exits with code `0` while not disposing. | sim.stopped | Stop tick interval; log stop; notify renderer via `simStatus`; terminate worker. |
| sim.running.input.* | Worker emits `error`/`messageerror` OR sends `kind:'error'` OR exits non-zero while not disposing. | sim.crashed | Stop tick interval; log crash; notify renderer via `simStatus`; terminate worker. |
| sim.initializing | Dispose requested (window reload/close) before `ready`. | sim.disposing | Stop tick interval (if started); mark controller disposing; terminate worker. |
| sim.running.input.* | Dispose requested (window reload/close). | sim.disposing | Stop tick interval; terminate worker; ignore subsequent input/worker messages. |
| sim.disposing | Worker terminates/closes. | sim.terminated | Release controller references; future input is ignored until a new controller is created. |
| sim.stopped | Explicit restart requested (window reload / recreate controller). | sim.initializing | Create a new sim worker controller; nested input state resets to `sim.running.input.idle` after `ready`. |
| sim.crashed | Explicit restart requested (window reload / recreate controller). | sim.initializing | Create a new sim worker controller; nested input state resets to `sim.running.input.idle` after `ready`. |

### Error Handling

**Handlers**:
- **Global worker/bridge failure handler**: any worker error condition funnels into a single “fail closed” action (stop tick loop, log, send `simStatus`, terminate worker, ignore future input) and transitions to `sim.crashed`/`sim.stopped`.
- **Per-input-event handling**: IPC payload validation and mapping outcomes transition only within `sim.running.input.*` (reject/drop/enqueue), unless a fatal bridge error occurs.

| State | Error | Recovery State | Actions |
|-------|-------|----------------|---------|
| shell.booting | Startup promise rejects. | shell.startup_failed | Log error; exit process with code `1`. |
| shell.startup_failed | None (process is exiting). | shell.startup_failed | No-op. |
| sim.initializing | Worker thread fails to spawn or init message cannot be sent. | sim.crashed | Log error; send `simStatus` (crashed); terminate/abandon worker handle if present. |
| sim.initializing | Invalid/unsupported worker protocol message. | sim.initializing | Ignore message; keep waiting for `ready` (no retries are performed). |
| sim.initializing | Worker reports `kind:'error'` during init. | sim.crashed | Log error; send `simStatus` (crashed); terminate worker; stop accepting inputs. |
| sim.running.input.idle | Renderer sends malformed input payload. | sim.running.input.idle | Drop event at IPC boundary (no state change); do not enqueue commands. |
| sim.running.input.pointer_move_coalescing | RAF is cancelled (e.g., renderer navigation) before flush. | sim.running.input.idle | Drop pending pointer-move; do not enqueue commands. |
| sim.running.input.processing | IPC payload is not a valid input event shape. | sim.running.input.rejected | Drop event; optionally log in dev to aid diagnosis. |
| sim.running.input.processing | Mapping produces 0 commands (including “unbound” pointer events). | sim.running.input.dropped | Drop event silently (no implicit forwarding). |
| sim.running.input.processing | Mapping throws (e.g., payload resolver throws). | sim.crashed | Treat as fatal bridge failure; log error; stop tick; send `simStatus` (crashed); terminate worker. |
| sim.running.input.processing | `worker.postMessage` throws. | sim.crashed | Treat as fatal bridge failure; log error; stop tick; send `simStatus` (crashed); terminate worker. |
| sim.running.input.enqueued | None (postMessage has no acknowledgment). | sim.running.input.idle | No-op. |
| sim.running.input.dropped | None (event already dropped). | sim.running.input.idle | No-op. |
| sim.running.input.rejected | None (event already rejected). | sim.running.input.idle | No-op. |
| sim.running.input.* | `webContents.send(frame|simStatus)` throws (renderer not ready/crashed). | sim.running.input.* | Log error; continue sim tick loop; renderer recovery is via reload. |
| sim.running.input.* | Worker becomes unresponsive (no `frame`/`ready`/`error` messages arrive). | sim.running.input.* | No automatic transition; renderer appears stalled; operator recovery is explicit restart (reload). |
| sim.running.input.* | Worker exits with code `0`. | sim.stopped | Log stop; send `simStatus` (stopped); terminate worker; ignore further input until restart. |
| sim.running.input.* | Worker exits non-zero OR emits `error`/`messageerror` OR sends `kind:'error'`. | sim.crashed | Log crash; send `simStatus` (crashed); terminate worker; ignore further input until restart. |
| sim.disposing | Worker termination throws/rejects. | sim.terminated | Log error; proceed as terminated (controller must be dead from caller perspective). |
| sim.terminated | Any input/worker message arrives after dispose. | sim.terminated | Ignore. |
| sim.stopped | Any input event arrives before restart. | sim.stopped | Ignore. |
| sim.crashed | Any input event arrives before restart. | sim.crashed | Ignore. |

### Crash Recovery
- **Detection**: Recovery is needed if the current controller is in `sim.stopped` or `sim.crashed`, if the renderer is reloaded (which disposes and recreates the controller), or if the sim appears stalled (no frames are observed and no crash/stop signal is received).
- **Recovery state**: `sim.initializing` (a brand-new sim worker controller; nested input state resets).
- **Cleanup**: Stop tick interval; clear any pending pointer-move coalescing; terminate/close the previous worker; drop any in-flight input event (no buffering across restarts).

### Subprocesses (if applicable)
| Subprocess | Receives | Can Write | Failure Handling |
|------------|----------|-----------|------------------|
| Electron renderer process | `IdleEngineApi` bridge (send input events; receive frames and sim status). | IPC messages: input events → main; UI output to DOM/canvas. | If renderer reloads/crashes: main may fail `webContents.send` (logged); user reload restarts controller; no queued inputs are replayed. |
| Sim worker thread (Node `Worker`) | `init`, `tick`, `enqueueCommands`, `shutdown` messages; runtime config (`stepSizeMs`, `maxStepsPerFrame`). | Outbound messages: `ready`, `frame`, `error` back to main; no filesystem writes. | On `error`/`messageerror`/non-zero exit: transition to `sim.crashed` and terminate worker; on hang/unresponsiveness: no automatic transition, operator restarts via reload. |

## 3. Interfaces

This section defines the **contract surface** for input events across:
- Electron renderer ↔ Electron main (IPC)
- Main ↔ sim worker (postMessage)
- Main input mapping → runtime command queue

### Endpoints
| Method | Path | Input | Success | Errors |
|--------|------|-------|---------|--------|
| IPC invoke | `idle-engine:ping` | `{ message: string }` | resolves `{ message: string }` | rejects if `message` is not a string |
| IPC invoke | `idle-engine:read-asset` | `{ url: string }` | resolves `ArrayBuffer` | rejects if url is invalid, non-`file:`, or escapes compiled asset root |
| IPC send | `idle-engine:input-event` | `ShellInputEventEnvelope` | none (fire-and-forget) | dropped if payload is invalid, sim is not running, or mapping produces 0 commands; **fatal** if mapping throws or worker delivery throws |
| IPC send | `idle-engine:control-event` (deprecated) | `ShellControlEvent` | none (fire-and-forget) | dropped if payload is invalid, sim is not running, or mapping produces 0 commands; **fatal** if mapping throws or worker delivery throws |
| IPC event | `idle-engine:frame` | `ShellFramePayload` | pushed to listeners | delivery may fail if renderer is not ready (main logs and continues) |
| IPC event | `idle-engine:sim-status` | `ShellSimStatusPayload` | pushed to listeners | delivery may fail if renderer is not ready (main logs and continues) |
| Worker postMessage | `SimWorkerInboundMessage.kind=enqueueCommands` | `{ kind:'enqueueCommands', commands: Command[] }` | enqueued for future ticks | **fatal** if `postMessage` throws → transition to `sim.crashed` and stop accepting input |
| Worker event | `SimWorkerOutboundMessage.kind=ready/frame/error` | see `SimWorkerOutboundMessage` | updates main state | invalid protocol messages are ignored during init; `error` is **fatal** (crash) |

### CLI Commands (if applicable)
N/A

### Events (if applicable)
| Event | Trigger | Payload | Consumers |
|-------|---------|---------|-----------|
| `idle-engine:frame` | Sim worker sends `kind:'frame'` and main forwards the frame. | `RenderCommandBuffer` | Electron renderer (`IdleEngineApi.onFrame`) |
| `idle-engine:sim-status` | Main enters `starting`, `running`, `stopped`, or `crashed`. | `ShellSimStatusPayload` | Electron renderer (`IdleEngineApi.onSimStatus`) |
| `sim-worker:ready` | Sim worker sends `kind:'ready'`. | `{ kind:'ready', stepSizeMs:number, nextStep:number }` | Electron main controller |
| `sim-worker:frame` | Sim worker sends `kind:'frame'`. | `{ kind:'frame', frame?:RenderCommandBuffer, droppedFrames:number, nextStep:number }` | Electron main controller |
| `sim-worker:error` | Sim worker sends `kind:'error'` or worker emits `error`/`messageerror`/non-zero exit. | `{ kind:'error', error:string }` plus worker error/exit metadata | Electron main controller (transitions to `sim.crashed`/`sim.stopped`) |

### Runtime Commands
| Command Type | Payload | Producer | Consumers | Errors |
|-------------|---------|----------|-----------|--------|
| `INPUT_EVENT` (new) | `InputEventCommandPayload` | Main input mapper via explicit bindings | UI/controls systems inside sim runtime | command is not produced unless mapping matches; mapping/worker errors are **fatal** (see workflow) |

### Validation Rules
All validation is **synchronous** at the IPC boundary (main process). When validation fails:
- IPC invoke endpoints reject with a thrown `TypeError` (Promise rejects in renderer).
- IPC send endpoints are dropped (no acknowledgment); main may log in dev builds.

| Field | Type | Constraints | Error |
|------|------|-------------|-------|
| `PingRequest.message` | string | required | `TypeError("Invalid ping request: expected { message: string }")` |
| `ReadAssetRequest.url` | string | required, non-empty; must parse as URL; must be `file:`; must resolve inside compiled assets root | `TypeError("Invalid read asset request: expected { url: string }")`, `TypeError("Invalid asset url: expected a file:// URL.")`, `TypeError("Invalid asset url: path must be inside compiled assets.")`, or URL parse `TypeError` |
| `ShellInputEventEnvelope.schemaVersion` | number | required; must equal `1` | drop input event |
| `ShellInputEventEnvelope.event` | object | required | drop input event |
| `ShellInputEvent.kind` | string | required; one of `control`, `pointer`, `wheel` | drop input event |
| `ShellInputEvent.control.intent` | string | required; non-empty | drop input event |
| `ShellInputEvent.control.phase` | string | required; one of `start`, `repeat`, `end` | drop input event |
| `ShellInputEvent.control.value` | number | optional; if present must be finite | drop input event |
| `ShellInputEvent.pointer.intent` | string | required; one of `pointer.down`, `pointer.up`, `pointer.move` | drop input event |
| `ShellInputEvent.pointer.phase` | string | required; must match intent (`pointer.down → start`, `pointer.move → repeat`, `pointer.up → end`) | drop input event |
| `ShellInputEvent.pointer.x/y` | number | required; finite; canvas-relative CSS pixel coordinates | drop input event |
| `ShellInputEvent.pointer.button` | number | required; integer; range `-1..32` | drop input event |
| `ShellInputEvent.pointer.buttons` | number | required; integer; range `0..0xFFFF` | drop input event |
| `ShellInputEvent.pointer.pointerType` | string | required; one of `mouse`, `pen`, `touch` | drop input event |
| `ShellInputEvent.pointer.modifiers` | object | required; `{ alt, ctrl, meta, shift }` booleans | drop input event |
| `ShellInputEvent.wheel.intent` | string | required; must equal `pointer.wheel` | drop input event |
| `ShellInputEvent.wheel.phase` | string | required; must equal `repeat` | drop input event |
| `ShellInputEvent.wheel.x/y` | number | required; finite; canvas-relative CSS pixel coordinates | drop input event |
| `ShellInputEvent.wheel.modifiers` | object | required; `{ alt, ctrl, meta, shift }` booleans | drop input event |
| `ShellInputEvent.wheel.deltaX/Y/Z` | number | required; finite | drop input event |
| `ShellInputEvent.wheel.deltaMode` | number | required; one of `0`, `1`, `2` | drop input event |

### UI Interactions (if applicable)
| Action | Request | Loading State | Success | Error |
|--------|---------|---------------|---------|-------|
| Press Space (demo “collect”) | `IPC send idle-engine:control-event` (or `input-event` with `kind:'control'`) | none | Sim enqueues `COLLECT_RESOURCE` and UI updates on next frame | if sim is stopped/crashed: input is ignored; status text indicates “Reload to restart” |
| Pointer down/up/move on canvas | `IPC send idle-engine:input-event` (`kind:'pointer'`) | none | Explicit bindings may enqueue `INPUT_EVENT` commands; UI responds deterministically at tick boundaries | invalid payload is dropped; if mapping/bridge crashes, renderer receives `sim-status: crashed` |
| Mouse wheel on canvas | `IPC send idle-engine:input-event` (`kind:'wheel'`) | none | Explicit bindings may enqueue `INPUT_EVENT` commands | same as above |

#### Contract gates
- **Breaking change**: Yes, behaviorally. `metadata.passthrough` no longer causes implicit forwarding, and `SHELL_CONTROL_EVENT` commands are no longer emitted.
- **Migration**: Implement explicit bindings that map pointer/wheel inputs to `INPUT_EVENT` (or other typed) runtime commands. Any system that previously consumed `SHELL_CONTROL_EVENT.payload.event.metadata` must consume `InputEventCommandPayload.event` instead.
- **Versioning**: `ShellInputEventEnvelope.schemaVersion` starts at `1`. Main must reject unknown versions (drop) and may support `N-1` during migrations. `INPUT_EVENT` payload is versioned via `InputEventCommandPayload.schemaVersion` (also `1`).

#### Type contracts (wire-level)
```ts
export type ShellControlEvent = Readonly<{
  intent: string;
  phase: 'start' | 'repeat' | 'end';
  value?: number;
  /**
   * Deprecated. `passthrough` is ignored and must not be relied on.
   * Typed input events are sent via `ShellInputEventEnvelope`.
   */
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type ShellInputEventEnvelope = Readonly<{
  schemaVersion: 1;
  event: ShellInputEvent;
}>;

export type ShellInputEvent =
  | Readonly<{
      kind: 'control';
      intent: string;
      phase: 'start' | 'repeat' | 'end';
      value?: number;
    }>
  | Readonly<{
      kind: 'pointer';
      intent: 'pointer.down' | 'pointer.up' | 'pointer.move';
      phase: 'start' | 'repeat' | 'end';
      x: number;
      y: number;
      button: number;
      buttons: number;
      pointerType: 'mouse' | 'pen' | 'touch';
      modifiers: Readonly<{ alt: boolean; ctrl: boolean; meta: boolean; shift: boolean }>;
    }>
  | Readonly<{
      kind: 'wheel';
      intent: 'pointer.wheel';
      phase: 'repeat';
      x: number;
      y: number;
      deltaX: number;
      deltaY: number;
      deltaZ: number;
      deltaMode: 0 | 1 | 2;
      modifiers: Readonly<{ alt: boolean; ctrl: boolean; meta: boolean; shift: boolean }>;
    }>;

export type InputEventCommandPayload = Readonly<{
  schemaVersion: 1;
  event: ShellInputEvent;
}>;
```

## 4. Data

This feature introduces a **typed, versioned input-event schema** for desktop-shell forwarded inputs and a **typed runtime command payload** for replayable input events. No new on-disk files are created; the only persisted surface area is via existing save/snapshot/replay mechanisms that already serialize command-queue entries as JSON.

### Schema Changes
| Location | Field | Type | Required | Default | Constraints |
|----------|-------|------|----------|---------|-------------|
| `packages/shell-desktop/src/ipc.ts` | `IPC_CHANNELS.inputEvent` | `string` | yes | n/a | must equal `idle-engine:input-event` |
| `packages/shell-desktop/src/ipc.ts` | `ShellInputEventEnvelope.schemaVersion` | `1` | yes | `1` (when encoding) | reject/drop if not exactly `1` |
| `packages/shell-desktop/src/ipc.ts` | `ShellInputEventEnvelope.event` | `ShellInputEvent` | yes | n/a | reject/drop if missing or not an object |
| `packages/shell-desktop/src/ipc.ts` | `ShellInputEvent.kind` | `'control' \| 'pointer' \| 'wheel'` | yes | n/a | must be one of the listed literals |
| `packages/shell-desktop/src/ipc.ts` | `ShellInputEvent.control.intent` | `string` | yes | n/a | non-empty after trim |
| `packages/shell-desktop/src/ipc.ts` | `ShellInputEvent.control.phase` | `'start' \| 'repeat' \| 'end'` | yes | n/a | must be one of the listed literals |
| `packages/shell-desktop/src/ipc.ts` | `ShellInputEvent.control.value` | `number` | no | `undefined` | if present: finite (`Number.isFinite`) |
| `packages/shell-desktop/src/ipc.ts` | `ShellInputEvent.pointer.intent` | `'pointer.down' \| 'pointer.up' \| 'pointer.move'` | yes | n/a | must be one of the listed literals |
| `packages/shell-desktop/src/ipc.ts` | `ShellInputEvent.pointer.phase` | `'start' \| 'repeat' \| 'end'` | yes | n/a | must match intent (`down→start`, `move→repeat`, `up→end`) |
| `packages/shell-desktop/src/ipc.ts` | `ShellInputEvent.pointer.x` | `number` | yes | n/a | finite; canvas-relative CSS pixel coordinate |
| `packages/shell-desktop/src/ipc.ts` | `ShellInputEvent.pointer.y` | `number` | yes | n/a | finite; canvas-relative CSS pixel coordinate |
| `packages/shell-desktop/src/ipc.ts` | `ShellInputEvent.pointer.button` | `number` | yes | n/a | integer; range `-1..32` |
| `packages/shell-desktop/src/ipc.ts` | `ShellInputEvent.pointer.buttons` | `number` | yes | n/a | integer; range `0..0xFFFF` |
| `packages/shell-desktop/src/ipc.ts` | `ShellInputEvent.pointer.pointerType` | `'mouse' \| 'pen' \| 'touch'` | yes | n/a | must be one of the listed literals |
| `packages/shell-desktop/src/ipc.ts` | `ShellInputEvent.pointer.modifiers` | `{ alt, ctrl, meta, shift }` | yes | n/a | object with all four boolean keys present |
| `packages/shell-desktop/src/ipc.ts` | `ShellInputEvent.pointer.modifiers.alt` | `boolean` | yes | n/a | - |
| `packages/shell-desktop/src/ipc.ts` | `ShellInputEvent.pointer.modifiers.ctrl` | `boolean` | yes | n/a | - |
| `packages/shell-desktop/src/ipc.ts` | `ShellInputEvent.pointer.modifiers.meta` | `boolean` | yes | n/a | - |
| `packages/shell-desktop/src/ipc.ts` | `ShellInputEvent.pointer.modifiers.shift` | `boolean` | yes | n/a | - |
| `packages/shell-desktop/src/ipc.ts` | `ShellInputEvent.wheel.intent` | `'pointer.wheel'` | yes | n/a | must equal `pointer.wheel` |
| `packages/shell-desktop/src/ipc.ts` | `ShellInputEvent.wheel.phase` | `'repeat'` | yes | n/a | must equal `repeat` |
| `packages/shell-desktop/src/ipc.ts` | `ShellInputEvent.wheel.x` | `number` | yes | n/a | finite; canvas-relative CSS pixel coordinate |
| `packages/shell-desktop/src/ipc.ts` | `ShellInputEvent.wheel.y` | `number` | yes | n/a | finite; canvas-relative CSS pixel coordinate |
| `packages/shell-desktop/src/ipc.ts` | `ShellInputEvent.wheel.deltaX` | `number` | yes | n/a | finite |
| `packages/shell-desktop/src/ipc.ts` | `ShellInputEvent.wheel.deltaY` | `number` | yes | n/a | finite |
| `packages/shell-desktop/src/ipc.ts` | `ShellInputEvent.wheel.deltaZ` | `number` | yes | n/a | finite |
| `packages/shell-desktop/src/ipc.ts` | `ShellInputEvent.wheel.deltaMode` | `0 \| 1 \| 2` | yes | n/a | must be one of the listed literals |
| `packages/shell-desktop/src/ipc.ts` | `ShellInputEvent.wheel.modifiers` | `{ alt, ctrl, meta, shift }` | yes | n/a | object with all four boolean keys present |
| `packages/shell-desktop/src/ipc.ts` | `ShellInputEvent.wheel.modifiers.alt` | `boolean` | yes | n/a | - |
| `packages/shell-desktop/src/ipc.ts` | `ShellInputEvent.wheel.modifiers.ctrl` | `boolean` | yes | n/a | - |
| `packages/shell-desktop/src/ipc.ts` | `ShellInputEvent.wheel.modifiers.meta` | `boolean` | yes | n/a | - |
| `packages/shell-desktop/src/ipc.ts` | `ShellInputEvent.wheel.modifiers.shift` | `boolean` | yes | n/a | - |
| `packages/core/src/command.ts` | `RUNTIME_COMMAND_TYPES.INPUT_EVENT` | `string` | yes | n/a | must equal `INPUT_EVENT` |
| `packages/core/src/command.ts` | `RuntimeCommandPayloads.INPUT_EVENT` | `InputEventCommandPayload` | yes | n/a | payload must be JSON-serializable |
| `packages/core/src/command.ts` | `InputEventCommandPayload.schemaVersion` | `1` | yes | `1` (when encoding) | reject if not exactly `1` (handler must validate) |
| `packages/core/src/command.ts` | `InputEventCommandPayload.event` | `ShellInputEvent` | yes | n/a | must satisfy the same variant constraints as IPC `ShellInputEvent` |
| `packages/shell-desktop/src/ipc.ts` | `ShellControlEvent.metadata` (deprecated semantics) | `Record<string, unknown>` | no | `undefined` | `metadata.passthrough` is ignored; pointer/wheel metadata must not be relied on |

### Field Definitions
**`IPC_CHANNELS.inputEvent`**
- Purpose: Stable channel name for sending typed input events across the Electron IPC boundary (renderer → main).
- Set by: `packages/shell-desktop` IPC contract definition.
- Read by: Renderer sender and main-process receiver.

**`ShellInputEventEnvelope.schemaVersion`**
- Purpose: Wire-level version gate for input-event payloads.
- Set by: Desktop renderer when emitting an input event.
- Read by: Desktop main process when validating inbound input events.
- Derived: Constant `1` for this feature’s initial rollout.

**`ShellInputEventEnvelope.event`**
- Purpose: Carries the typed input event (control/pointer/wheel) across IPC.
- Set by: Desktop renderer input capture layer.
- Read by: Desktop main input mapper (mapping to runtime commands).
- References: No foreign keys; `intent` strings are matched against control/binding intent strings but are not strong references.

**`ShellInputEvent.*` (variants)**
- Purpose: Lossless-but-minimal representation of the input needed for deterministic UI/control handling.
- Set by: Desktop renderer (source-of-truth is the browser/DOM event data).
- Read by: Desktop main mapper; optionally embedded into `INPUT_EVENT` runtime commands for sim-side consumption.
- Derived fields:
  - `pointer.phase` is derived from `pointer.intent` (`down→start`, `move→repeat`, `up→end`) and must remain consistent; mismatches are rejected.
  - `wheel.phase` is always `repeat`.
- Ordering dependencies: None stored in the payload; ordering is defined by IPC delivery order and the main-process enqueue policy (commands are scheduled at the runtime’s next executable step).

**`InputEventCommandPayload.schemaVersion`**
- Purpose: Version gate for runtime command payload evolution independent of IPC evolution.
- Set by: Desktop main process when producing an `INPUT_EVENT` command.
- Read by: Sim-side command handler(s) that consume `INPUT_EVENT`.
- Derived: Constant `1` for this feature’s initial rollout.

**`InputEventCommandPayload.event`**
- Purpose: The replayable input event attached to an `INPUT_EVENT` runtime command.
- Set by: Desktop main process (copied from a validated `ShellInputEventEnvelope.event`).
- Read by: Sim-side controls/UI input system(s).
- References: No foreign keys; `intent` is a semantic identifier only.

**`ShellControlEvent.metadata` (deprecated semantics)**
- Purpose: Legacy extensibility hook for `idle-engine:control-event`; retained for backwards compatibility with existing control scheme resolvers that read arbitrary metadata.
- Set by: Legacy control-event senders (renderer or other callers).
- Read by: Control scheme payload resolvers; desktop shell no longer uses `metadata.passthrough` to forward raw events.

### Migrations
| Change | Existing Data | Migration | Rollback |
|--------|---------------|-----------|----------|
| Add IPC input-event envelope (`ShellInputEventEnvelope`, `IPC_CHANNELS.inputEvent`) | No records exist; channel absent | Add new IPC channel and validate on receive; absence means no typed input events are sent | Remove channel; renderer falls back to legacy control events only |
| Add runtime command type `INPUT_EVENT` with `InputEventCommandPayload` | Existing command queues/snapshots contain no `INPUT_EVENT` entries | Add command handler(s) for `INPUT_EVENT`; producers emit only when a mapping explicitly targets it | Remove handler and stop emitting `INPUT_EVENT` |
| Deprecate passthrough forwarding and `SHELL_CONTROL_EVENT` production | Older saves/snapshots *may* contain `SHELL_CONTROL_EVENT` entries | Do not emit `SHELL_CONTROL_EVENT` going forward. For compatibility, either (a) keep a no-op handler registered for `SHELL_CONTROL_EVENT`, or (b) drop unsupported command types during restore via `CommandQueue.restoreFromSave({ isCommandTypeSupported })` | Restore legacy behavior only by reintroducing passthrough forwarding and emitting `SHELL_CONTROL_EVENT` (not recommended) |

### Artifacts
| Artifact | Location | Created | Updated | Deleted |
|----------|----------|---------|---------|---------|
| IPC input-event message | Electron IPC message on `idle-engine:input-event` | When renderer captures input | Never (immutable) | After message delivery/GC (ephemeral) |
| `INPUT_EVENT` command | In-memory command queue entry | When main maps a validated `ShellInputEvent` to `INPUT_EVENT` | Never (immutable) | When dequeued/executed or queue is cleared on restart |
| Serialized `INPUT_EVENT` payload | `SerializedCommandQueueV1.entries[].payload` (inside `GameStateSnapshot.commandQueue`) | When a snapshot/save captures the command queue | Never (immutable) | When the snapshot/save is discarded by the caller |

### Artifact Lifecycle
| Scenario | Artifact Behavior |
|----------|-------------------|
| Success | IPC message is validated; 0..N runtime commands are created and enqueued (including optional `INPUT_EVENT`); queued commands execute at tick boundaries and are then removed. |
| Failure | Invalid IPC payloads are dropped (no commands created). Valid payloads that map to 0 commands produce no artifacts beyond transient validation work. |
| Crash recovery | Renderer→main IPC messages in flight are lost. Any `INPUT_EVENT` commands not yet dequeued are lost if the runtime/controller is restarted without persisting the queue; if a snapshot/save captured them, they persist only within that snapshot/save. |

## 5. Tasks
[To be completed in design_plan phase]

## 6. Validation
[To be completed in design_plan phase]
