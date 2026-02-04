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
[To be completed in design_api phase]

## 4. Data
[To be completed in design_data phase]

## 5. Tasks
[To be completed in design_plan phase]

## 6. Validation
[To be completed in design_plan phase]
