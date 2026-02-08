# Design: Generic Save/Load and Offline Catch-Up Tooling

**Issue**: #854
**Status**: Draft - Classification Complete
**Feature Types**: Primary: Workflow, Secondary: API, UI

---

## 0. Research Context

### Problem Restatement

The desktop shell (`packages/shell-desktop`) needs Save/Load and offline catch-up dev tooling that is **capability-driven** rather than mode-driven. Currently, `sim-runtime.ts` is a bare demo runtime that does not use `wireGameRuntime()` from core and has no serialize/hydrate support. The `main.ts` application menu has no Save/Load or Offline Catch-Up menu items, and the worker protocol has no messages for capability signaling or save/load operations. Save files must be written atomically (temp + rename) to prevent corruption on crash. The core infrastructure for serialization, hydration, and offline catch-up is fully implemented and ready to be wired into the shell.

### Repository Findings

#### Shell Desktop — Main Process & Worker
- `packages/shell-desktop/src/main.ts`: Main Electron process (655 lines). Contains `SimWorkerController` (L259–493), `installAppMenu()` (L546–577), `createMainWindow()` (L579–618), app lifecycle (L620–654). **No save/load logic, no dev-tooling menu items, no capability detection.** Menu has only View + Window submenus.
- `packages/shell-desktop/src/sim/worker-protocol.ts`: Typed worker message protocol (60 lines). Defines inbound (init, tick, enqueueCommands, shutdown) and outbound (ready, frame, error) messages. **No save/load/serialize/hydrate/capability messages exist.**
- `packages/shell-desktop/src/sim-worker.ts`: Worker thread entry (93 lines). Delegates to `SimRuntime`. Handles init→ready handshake, tick, enqueueCommands, shutdown. **No save/load message handling.**
- `packages/shell-desktop/src/sim/sim-runtime.ts`: Demo sim runtime (298 lines). Creates `IdleEngineRuntime`, registers `COLLECT_RESOURCE`, `SHELL_CONTROL_EVENT`, `INPUT_EVENT` handlers. Exposes `SimRuntime` interface with `hasCommandHandler(type)` — **this existing method can be used for capability detection**. Does NOT use `wireGameRuntime()`.
- `packages/shell-desktop/src/ipc.ts`: Electron IPC contract (95 lines). Channels: ping, readAsset, controlEvent, inputEvent, frame, simStatus. **No save/load IPC channels.**
- `packages/shell-desktop/src/runtime-harness.ts`: Re-exports `buildProgressionSnapshot` and `loadGameStateSaveFormat` from `@idle-engine/core/harness`. Existing bridge for save format parsing.

#### Shell Desktop — Tests
- `packages/shell-desktop/src/main.test.ts` (1725 lines): Comprehensive main process tests — tests for worker controller lifecycle, IPC handlers, menu structure, error paths.
- `packages/shell-desktop/src/sim-worker.test.ts` (684 lines): Worker message protocol tests.
- `packages/shell-desktop/src/sim/sim-runtime.test.ts` (401 lines): Demo runtime tests including `hasCommandHandler` checks.

#### Core Runtime — Save/Load Infrastructure
- `packages/core/src/game-state-save.ts` (601 lines): Complete save/load infra. `GameStateSaveFormatV1` format, `serializeGameStateSaveFormat()`, `hydrateGameStateSaveFormat()`, `loadGameStateSaveFormat()` (with v0→v1 migration), `encodeGameStateSave()` (Uint8Array with optional gzip), `decodeGameStateSave()`. **Fully production-ready.**
- `packages/core/src/game-runtime-wiring.ts` (469 lines): `wireGameRuntime()` returns `GameRuntimeWiring` with `.serialize()` and `.hydrate()` methods. `registerOfflineCatchup` defaults to `true`. This is the canonical way to wire up a content pack with full save/load and offline catch-up.
- `packages/core/src/command.ts`: Defines `RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP` (L115), `OfflineCatchupPayload` (L183-188) with `{ elapsedMs, resourceDeltas, maxElapsedMs?, maxSteps? }`, command authorization (L370-371) allowing SYSTEM and AUTOMATION priorities.
- `packages/core/src/offline-catchup-command-handlers.ts` (89 lines): Handler validates payload, applies resource deltas, resolves offline progress limits, credits remaining time.

#### Atomic Write Reference Pattern
- `packages/content-compiler/src/fs/writer.ts` (L126–157): The **only existing atomic write pattern** in the repo. Uses `temp file in same directory` + `rename` + `finally { safeUnlink }`. Pattern: `.tmp-<basename>-<randomUUID()>` → `writeFile(tempPath)` → `rename(tempPath, targetPath)` → `safeUnlink(tempPath)` in finally.

#### Package Config
- `packages/shell-desktop/package.json`: ESM, Electron ^32.3.1, depends on `@idle-engine/core`, `@idle-engine/controls`, `@idle-engine/renderer-contract`, `@idle-engine/renderer-webgpu`.
- No other shell packages exist (`shell-desktop` is the only one).

### External Findings

- **Node.js Atomic File Writes**: The standard pattern is write-to-temp + rename (`fs.rename` is atomic on Unix-like systems). The repo already follows this pattern in `content-compiler/src/fs/writer.ts`. For Electron desktop, the same `fs.promises.writeFile` + `fs.promises.rename` approach applies. The `write-file-atomic` npm package exists but adding an external dep is unnecessary given the existing in-repo pattern.
- **Electron `app.getPath('userData')`**: Returns the per-user app data directory (e.g., `~/.config/<app-name>` on Linux, `~/Library/Application Support/<app-name>` on macOS, `%APPDATA%/<app-name>` on Windows). This is the canonical location for save files. Currently not used in `shell-desktop`.
- **Electron Menu Accelerators**: Menu items support `accelerator` property for keyboard shortcuts (e.g., `CmdOrCtrl+S` for Save). `enabled` property can dynamically gate items based on runtime state.

### Recommended Direction

**Capability-based approach via worker protocol extension:**

1. **Extend `SimRuntime` interface** to optionally expose `serialize()` and `hydrate()` methods, making them available when a content pack is wired via `wireGameRuntime()`.

2. **Add worker protocol messages** for capability signaling and save/load:
   - **Outbound (worker→main)**: Extend the `ready` message (or add a `capabilities` message) to report which capabilities the sim supports: `{ canSerialize: boolean, canOfflineCatchup: boolean }`.
   - **Inbound (main→worker)**: Add `{ kind: 'serialize' }` request and outbound `{ kind: 'saveData', data: Uint8Array }` response. Add `{ kind: 'hydrate', data: Uint8Array }` inbound message.

3. **Add menu items to `installAppMenu()`**: A "Dev" menu with Save (Ctrl+S), Load (Ctrl+O), and Offline Catch-Up items. Items are `enabled` based on reported capabilities from the worker.

4. **Atomic save writes in main process**: When save data arrives from the worker, write to `app.getPath('userData')/<save-filename>.save` using the temp+rename pattern from `content-compiler/src/fs/writer.ts`.

5. **Use `hasCommandHandler(RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP)`** in the worker to detect offline catch-up support (already exposed on `SimRuntime`).

6. **Use the existing `encodeGameStateSave`/`decodeGameStateSave`** functions from core for binary save encoding (with optional gzip compression).

### Alternatives Considered

- **Feature flags / environment variables (e.g., `IDLE_ENGINE_GAME`)**: Rejected — this was the original problem. Mode-driven gating doesn't scale across packs and creates tight coupling between shell tooling and specific content.
- **IPC-based save/load (renderer↔main)**: Rejected — save/load is a main-process + worker concern. The renderer should not be involved in persistence; it's a display layer. Menu triggers from main process are sufficient.
- **Shared atomic-write utility package**: Considered but premature — the pattern is small (~15 lines). If a third shell or tool needs it, extract then. For now, inline in `shell-desktop` following the content-compiler reference.
- **Adding save metadata (engine/content hash/version) now**: The issue mentions "consider save metadata for future migrations." The core `GameStateSaveFormatV1` already includes `version` and `savedAt`. Additional metadata (content hash, engine version) is deferred per the non-goals ("Add a new save schema or migration framework").
- **Requesting capabilities via a separate round-trip**: Instead of reporting capabilities in the `ready` message, we could add a `{ kind: 'queryCapabilities' }` request. However, piggybacking on `ready` is simpler since capabilities are known at init time and avoids extra async handshake complexity.

### Risks and Unknowns

- **Demo runtime lacks serialize/hydrate**: The current `sim-runtime.ts` is a bare demo that doesn't use `wireGameRuntime()`. Save/Load menu items will be correctly disabled for the demo, but **end-to-end testing requires either a test fixture with a wired runtime or the demo itself being upgraded**. Mitigation: Unit tests can mock the capability signaling; integration testing can use a minimal content pack.
- **Worker message serialization for `Uint8Array`**: Electron `Worker.postMessage` supports transferable objects including `ArrayBuffer`. The `encodeGameStateSave` returns `Uint8Array` which backs an `ArrayBuffer`. Need to ensure proper transferable handling to avoid unnecessary copies. Mitigation: Use `worker.postMessage(msg, [msg.data.buffer])` transfer list.
- **Save file location naming**: Without a game-mode identifier, save files need a naming convention. Options: use content pack ID, use a fixed name, or allow configuration. Mitigation: Start with a configurable save filename pattern (default to content pack ID if available, fallback to `idle-engine-save.bin`).
- **Offline catch-up `resourceDeltas` parameter**: The issue asks whether `resourceDeltas` should be optional or populated. The core handler validates it must be an object but accepts `{}`. Mitigation: Shell tooling should default to `resourceDeltas: {}` which triggers time-credit-only offline catch-up.
- **Race conditions during save**: If the user triggers Save while a tick is in progress, the serialized state should be consistent. Mitigation: The worker processes messages sequentially on its event loop, so a `serialize` message will be handled between ticks, guaranteeing a consistent snapshot.

### Sources

- `packages/shell-desktop/src/main.ts` — main process, menu, worker controller
- `packages/shell-desktop/src/sim/worker-protocol.ts` — worker message types
- `packages/shell-desktop/src/sim-worker.ts` — worker entry point
- `packages/shell-desktop/src/sim/sim-runtime.ts` — demo runtime with `hasCommandHandler`
- `packages/shell-desktop/src/ipc.ts` — IPC channel definitions
- `packages/shell-desktop/src/runtime-harness.ts` — core harness bridge
- `packages/core/src/game-state-save.ts` — save format, encode/decode, migrations
- `packages/core/src/game-runtime-wiring.ts` — `wireGameRuntime()`, serialize/hydrate
- `packages/core/src/command.ts` — `OFFLINE_CATCHUP` command type and payload
- `packages/core/src/offline-catchup-command-handlers.ts` — offline catch-up handler
- `packages/content-compiler/src/fs/writer.ts` — atomic write reference pattern
- [Electron `app.getPath` API](https://www.electronjs.org/docs/latest/api/app)
- [Node.js atomic file write patterns](https://github.com/mcollina/fast-write-atomic)
- [write-file-atomic npm](https://www.npmjs.com/package/write-file-atomic)

---

## 1. Scope

### Problem
Desktop shell dev tooling for Save/Load and offline catch-up is tied to a specific game mode instead of runtime capabilities, so it cannot be reliably reused across packs. Save writes are also non-atomic, which risks corrupted or truncated save files on crash.

### Goals
- [ ] Enable Save/Load based on runtime support for serialize/hydrate capabilities, not hard-coded game mode checks.
- [ ] Write save files atomically to prevent partial/corrupt save artifacts on interruption.
- [ ] Enable offline catch-up tooling based on command support (for `OFFLINE_CATCHUP`) instead of game mode.

### Non-Goals
- Add a new save schema or migration framework in this issue (including mandatory metadata/version migration behavior).
- Redesign renderer UX or gameplay systems unrelated to shell dev-tooling enablement and persistence safety.

### Boundaries
- **In scope**: `packages/shell-desktop` menu/tooling gating, worker/main capability signaling or feature detection needed for gating, and atomic save-file write behavior for desktop shell tooling.
- **Out of scope**: core gameplay balance/content behavior changes, broad infrastructure/build pipeline changes, and non-desktop shell implementations.

---

## 2. Workflow

### States
| State | Description | Entry Condition |
|-------|-------------|-----------------|
| `main_bootstrap` | Main process initializes window, IPC, and menu scaffolding with capability-gated actions disabled. | Electron app enters ready flow and `createMainWindow()` begins. |
| `worker_starting` | Main creates sim worker controller, sends `init`, and waits for `ready` (protocol v2 or legacy fallback payload). | `main_bootstrap` completes controller construction. |
| `running_idle` | Worker is ready, tick loop runs, and Save/Load/Offline Catch-Up actions are accepted only when capability flags allow them. | `worker_starting` receives a valid `ready` payload and applies ready normalization rules. |
| `save_request_pending` | Save operation is in-flight while waiting for worker serialization payload. | User triggers Save from `running_idle` and `canSerialize === true`. |
| `save_atomic_write` | Main process writes save bytes atomically via temp-file + rename in userData directory. | `save_request_pending` receives serialized bytes. |
| `load_reading_file` | Main process prompts for save file path and reads bytes from disk. | User triggers Load from `running_idle` and `canSerialize === true`. |
| `load_decoding` | Main process decodes/parses save bytes and validates/migrates schema. | `load_reading_file` successfully reads bytes. |
| `load_hydrating` | Hydrate request is in-flight while waiting for worker hydrate result. | `load_decoding` produces valid hydrated payload. |
| `offline_catchup_dispatch` | Main builds and enqueues `OFFLINE_CATCHUP` command. | User triggers Offline Catch-Up from `running_idle` and `canOfflineCatchup === true`. |
| `recoverable_error` | Operation-level failure surfaced to user while worker may still be alive; retry is allowed. | Any operation state reports non-fatal failure (I/O, decode, timeout, validation). |
| `worker_failed` | Worker crashed/stopped or messaging is invalid; runtime session is no longer operational. | Any active state receives worker `error`, `exit`, or `messageerror`, or init timeout. |
| `app_terminating` | Main is disposing worker/timers and exiting process. | Quit/close requested from any non-terminal state. |
| `app_terminated` | Process is exited; no further transitions. | `app_terminating` completes disposal and exits. |

### State Gates
- **Initial state**: `main_bootstrap`, entered when Electron app ready flow starts for the first window.
- **Terminal states**: `app_terminated` only. It is terminal because process exit ends all timers, worker threads, and menu actions.

| Non-terminal State | All Possible Next States |
|--------------------|--------------------------|
| `main_bootstrap` | `worker_starting`, `app_terminating` |
| `worker_starting` | `running_idle`, `worker_failed`, `app_terminating` |
| `running_idle` | `save_request_pending`, `load_reading_file`, `offline_catchup_dispatch`, `running_idle`, `worker_failed`, `app_terminating` |
| `save_request_pending` | `save_atomic_write`, `recoverable_error`, `worker_failed`, `app_terminating` |
| `save_atomic_write` | `running_idle`, `recoverable_error`, `app_terminating` |
| `load_reading_file` | `load_decoding`, `running_idle`, `recoverable_error`, `app_terminating` |
| `load_decoding` | `load_hydrating`, `recoverable_error`, `app_terminating` |
| `load_hydrating` | `running_idle`, `recoverable_error`, `worker_failed`, `app_terminating` |
| `offline_catchup_dispatch` | `running_idle`, `recoverable_error`, `worker_failed`, `app_terminating` |
| `recoverable_error` | `running_idle`, `worker_failed`, `app_terminating` |
| `worker_failed` | `app_terminating` |
| `app_terminating` | `app_terminated` |

### Ready Handshake Compatibility (Canonical)
- Canonical v2 payload: `{ kind: 'ready'; protocolVersion: 2; stepSizeMs; nextStep; capabilities }`.
- Canonical legacy fallback payload: `{ kind: 'ready'; stepSizeMs; nextStep }` (missing `protocolVersion` and `capabilities`).
- Main normalization rule: when both `protocolVersion` and `capabilities` are missing, normalize to `protocolVersion: 1` with `capabilities = { canSerialize: false, canOfflineCatchup: false }`.
- Any other `ready` shape (for example, missing `stepSizeMs`, malformed capability booleans, or unsupported protocol versions) is invalid and handled as startup failure.

### Transitions
| From | Event/Condition | To | Side Effects |
|------|-----------------|-----|--------------|
| `main_bootstrap` | Window/controller creation succeeds | `worker_starting` | Create worker thread; send `init`; emit `simStatus: starting`; keep capability-gated menu items disabled. |
| `main_bootstrap` | App quit/close requested before worker is ready | `app_terminating` | Skip runtime startup and begin shutdown path. |
| `worker_starting` | Worker emits valid `ready` (v2 or legacy fallback) | `running_idle` | Normalize `ready` payload (`legacy -> protocolVersion: 1` + disabled capabilities), cache `stepSizeMs`/`nextStep` and capability flags; emit `simStatus: running`; start tick loop; refresh menu enabled flags. |
| `worker_starting` | Worker emits malformed/unsupported `ready` payload | `worker_failed` | Treat as startup protocol failure; stop tick loop; terminate worker; emit `simStatus: crashed/stopped`; disable Save/Load/Offline menu items; log validation reason. |
| `worker_starting` | Worker emits `error`/`messageerror`/`exit`, or no `ready` before `WORKER_READY_TIMEOUT_MS` | `worker_failed` | Stop tick loop; terminate worker; emit `simStatus: crashed/stopped`; disable Save/Load/Offline menu items; log reason. |
| `worker_starting` | App quit/close requested | `app_terminating` | Stop waiting for ready; terminate worker if present. |
| `running_idle` | Save action invoked and `canSerialize === true` | `save_request_pending` | Send worker `serialize` request; start serialize timeout timer; set operation lock. |
| `running_idle` | Load action invoked and `canSerialize === true` | `load_reading_file` | Open file picker; set operation lock. |
| `running_idle` | Offline Catch-Up action invoked and `canOfflineCatchup === true` | `offline_catchup_dispatch` | Build `OFFLINE_CATCHUP` command with `resourceDeltas: {}` and enqueue to worker. |
| `running_idle` | Action invoked but capability flag is false | `running_idle` | Ignore request (menu should already be disabled); optional debug log only. |
| `running_idle` | Worker failure (`error`/`messageerror`/`exit`) | `worker_failed` | Run global worker-failure handler; emit stopped/crashed status; disable capability-gated actions. |
| `running_idle` | App quit/close requested | `app_terminating` | Dispose controller; stop tick loop; terminate worker. |
| `save_request_pending` | Worker returns serialized bytes (`saveData`) before timeout | `save_atomic_write` | Resolve target path under `app.getPath('userData')`; prepare temp path in same directory. |
| `save_request_pending` | Serialize response timeout (`SERIALIZE_TIMEOUT_MS`) | `recoverable_error` | Clear op lock/timer; record timeout; surface Save failure without killing worker. |
| `save_request_pending` | Worker failure (`error`/`messageerror`/`exit`) | `worker_failed` | Abort pending save; run worker-failure handler. |
| `save_request_pending` | App quit/close requested | `app_terminating` | Cancel pending save and terminate worker. |
| `save_atomic_write` | Temp write + rename succeed | `running_idle` | Commit save atomically; best-effort delete temp file; clear op lock; surface Save success signal. |
| `save_atomic_write` | `writeFile`/`rename`/directory error | `recoverable_error` | Keep previous committed save untouched; best-effort cleanup temp file; clear op lock; log error. |
| `save_atomic_write` | App quit/close requested | `app_terminating` | Best-effort temp cleanup then shutdown. |
| `load_reading_file` | User cancels picker | `running_idle` | Clear op lock; no error state. |
| `load_reading_file` | File read succeeds | `load_decoding` | Store bytes in memory for decode/hydrate pipeline. |
| `load_reading_file` | File read fails (`ENOENT`, permission, I/O) | `recoverable_error` | Clear op lock; log read failure; surface Load failure. |
| `load_reading_file` | App quit/close requested | `app_terminating` | Abort load flow and shutdown. |
| `load_decoding` | Decode + schema validation/migration succeed | `load_hydrating` | Build hydrate payload for worker; start hydrate timeout timer. |
| `load_decoding` | Decode/validation/migration fails | `recoverable_error` | Clear op lock; log parse/validation error; surface invalid-save failure. |
| `load_decoding` | App quit/close requested | `app_terminating` | Abort decode flow and shutdown. |
| `load_hydrating` | Worker returns hydrate success (`hydrateResult: ok`) before timeout | `running_idle` | Clear op lock/timer; refresh capability cache if returned; surface Load success signal. |
| `load_hydrating` | Worker returns hydrate failure (`hydrateResult: error`) | `recoverable_error` | Clear op lock/timer; log hydrate rejection; surface Load failure. |
| `load_hydrating` | Hydrate response timeout (`HYDRATE_TIMEOUT_MS`) | `recoverable_error` | Clear op lock/timer; log timeout; keep pre-load runtime state unchanged. |
| `load_hydrating` | Worker failure (`error`/`messageerror`/`exit`) | `worker_failed` | Abort load flow; run worker-failure handler. |
| `load_hydrating` | App quit/close requested | `app_terminating` | Abort hydrate flow and shutdown. |
| `offline_catchup_dispatch` | Command enqueue succeeds | `running_idle` | Clear op lock; optionally emit completion status to renderer. |
| `offline_catchup_dispatch` | Payload/command creation throws or enqueue fails | `recoverable_error` | Clear op lock; log tooling failure; surface operation error. |
| `offline_catchup_dispatch` | Worker failure (`error`/`messageerror`/`exit`) | `worker_failed` | Abort catch-up flow; run worker-failure handler. |
| `offline_catchup_dispatch` | App quit/close requested | `app_terminating` | Abort flow and shutdown. |
| `recoverable_error` | User dismisses/retries and worker is still healthy | `running_idle` | Clear transient error UI/status; allow next operation. |
| `recoverable_error` | Worker failure occurs while in error state | `worker_failed` | Escalate to global worker-failure state and disable actions. |
| `recoverable_error` | App quit/close requested | `app_terminating` | Shutdown as normal. |
| `worker_failed` | App quit/close requested | `app_terminating` | Final cleanup with worker already terminated/failed. |
| `app_terminating` | Disposal complete and process exits | `app_terminated` | Stop timers, terminate worker, release resources, flush final logs. |

### Transition Reversibility
- Reversible transitions: Operation transitions that start in `running_idle` and return to `running_idle` (`save_*`, `load_*`, `offline_catchup_dispatch`, `recoverable_error`) are reversible by retrying the action.
- Irreversible transitions: Any transition to `worker_failed`, `app_terminating`, or `app_terminated` is irreversible for the current runtime session.
- Rollback model: Save rollback uses atomic rename semantics (old committed file remains valid if write fails). Load/hydrate rollback is logical only (runtime keeps pre-load state when hydrate fails/timeouts).

### Error Handling
| State | Error | Recovery State | Actions |
|-------|-------|----------------|---------|
| `main_bootstrap` | Window/controller init throws | `app_terminating` | Log startup failure and exit cleanly. |
| `worker_starting` | Invalid init params, malformed/unsupported ready payload (excluding canonical legacy fallback), worker crash, or ready timeout | `worker_failed` | Emit crashed/stopped status, disable actions, terminate worker, log root cause. |
| `running_idle` | `postMessage` throws or worker emits failure event | `worker_failed` | Invoke global worker-failure handler and stop tick loop. |
| `save_request_pending` | Serialize timeout | `recoverable_error` | Clear lock/timer and report save timeout. |
| `save_request_pending` | Worker failure during serialize | `worker_failed` | Abort operation and escalate to global worker-failure handling. |
| `save_atomic_write` | Temp write/rename/cleanup error | `recoverable_error` | Keep prior save, attempt temp cleanup, log filesystem error. |
| `load_reading_file` | Read denied/missing/corrupt-bytes read failure | `recoverable_error` | Clear lock, log read error, report load failure. |
| `load_decoding` | Decode failure, schema mismatch, migration failure | `recoverable_error` | Clear lock, log validation details, report invalid save. |
| `load_hydrating` | Hydrate rejected or timeout | `recoverable_error` | Clear lock/timer and preserve current runtime state. |
| `load_hydrating` | Worker failure during hydrate | `worker_failed` | Abort load and escalate to global worker-failure handling. |
| `offline_catchup_dispatch` | Command build/enqueue failure | `recoverable_error` | Clear lock and report catch-up tooling failure. |
| `offline_catchup_dispatch` | Worker failure during dispatch | `worker_failed` | Abort dispatch and escalate to global worker-failure handling. |
| `recoverable_error` | Error while reporting error (UI/log path fails) | `worker_failed` | Escalate to fail-safe worker-failed mode; keep app closable. |
| `worker_failed` | Additional worker events after failure | `worker_failed` | Ignore duplicate events; keep disabled state and await app termination. |
| `app_terminating` | Worker terminate promise rejects | `app_terminating` | Log and continue shutdown (best effort). |
| `app_terminated` | None (terminal) | `app_terminated` | No-op. |

Error handling model: per-state handling with one global sink for worker process failures (`handleWorkerFailure`-equivalent behavior) so crash semantics are consistent regardless of source state.

### Crash Recovery
- **Detection**: On next startup, detect interrupted save by scanning the save directory for stale temp files matching the atomic-write prefix pattern used by Save; also detect incomplete session by absence of in-memory operation completion (always true after crash/cold start).
- **Recovery state**: `worker_starting` (never resume inside `save_*`/`load_*` substates).
- **Cleanup**: Remove stale temp save files, clear any persisted operation lock metadata (if present), reset capability cache to unknown, keep Save/Load/Offline menu items disabled until `ready` is received again.

### Subprocesses (if applicable)
| Subprocess | Receives | Can Write | Failure Handling |
|------------|----------|-----------|------------------|
| `sim-worker` (Node worker thread) | Init config (`stepSizeMs`, `maxStepsPerFrame`), tick/enqueue commands, serialize/hydrate requests, offline catch-up command context. | Cannot write save files directly; only posts protocol messages (`ready`, `frame`, `saveData`, `hydrateResult`, `error`) to main process. | `error`/`messageerror`/`exit` => `worker_failed`; request hang => timeout transition (`recoverable_error` for operation timeouts, `worker_failed` for startup timeout). |

## 3. Interfaces

### Endpoints
| Method | Path | Input | Success | Errors |
|--------|------|-------|---------|--------|
| N/A | N/A | N/A | N/A | N/A |

This feature does not add or modify HTTP endpoints.

### CLI Commands
| Command | Arguments | Options | Output |
|---------|-----------|---------|--------|
| N/A | N/A | N/A | N/A |

This feature does not add CLI commands.

### Worker Commands
| Command | Invocation Pattern | Input | Success | Errors |
|---------|--------------------|-------|---------|--------|
| `serialize` | `worker.postMessage({ kind: 'serialize', requestId })` | `{ kind: 'serialize'; requestId: string }` | Worker emits `{ kind: 'saveData', requestId, ok: true, data: Uint8Array }`. Main writes `data` atomically to disk. | Worker emits `{ kind: 'saveData', requestId, ok: false, error: InterfaceError }` on capability or serialize failure. Main treats missing response before `SERIALIZE_TIMEOUT_MS` as `REQUEST_TIMEOUT`. Worker `error`/`exit` triggers `worker_failed`. |
| `hydrate` | `worker.postMessage({ kind: 'hydrate', requestId, save })` | `{ kind: 'hydrate'; requestId: string; save: GameStateSaveFormat }` | Worker emits `{ kind: 'hydrateResult', requestId, ok: true, nextStep: number }` and resumes normal ticking. | Worker emits `{ kind: 'hydrateResult', requestId, ok: false, error: InterfaceError }` when validation or hydrate fails. Main treats missing response before `HYDRATE_TIMEOUT_MS` as `REQUEST_TIMEOUT`. Worker `error`/`exit` triggers `worker_failed`. |
| `enqueueCommands` (`OFFLINE_CATCHUP`) | `worker.postMessage({ kind: 'enqueueCommands', commands: [command] })` | `command = { type: 'OFFLINE_CATCHUP', priority: SYSTEM, step, timestamp, payload: { elapsedMs, resourceDeltas, maxElapsedMs?, maxSteps? } }` | Message is accepted and queued; effect is visible on subsequent `frame` events. | Main-side input validation failure prevents dispatch (`INVALID_OFFLINE_CATCHUP_REQUEST`). Worker-side invalid payload becomes a no-op in the handler; worker transport failure triggers `worker_failed`. |

### Events
| Event | Trigger | Payload | Consumers |
|-------|---------|---------|-----------|
| `ready` | Worker processes valid `init` and runtime is ready. | V2 payload: `{ kind: 'ready'; protocolVersion: 2; stepSizeMs: number; nextStep: number; capabilities: { canSerialize: boolean; canOfflineCatchup: boolean } }`. Legacy compatibility payload: `{ kind: 'ready'; stepSizeMs: number; nextStep: number }` (normalized by main to protocol v1 with both capabilities `false`). | Main process (`SimWorkerController`) normalizes readiness, caches capability flags, and enables/disables Dev menu actions. |
| `saveData` | Worker completes a `serialize` request. | Success: `{ kind: 'saveData'; requestId: string; ok: true; data: Uint8Array }` or failure: `{ kind: 'saveData'; requestId: string; ok: false; error: InterfaceError }`. | Main process save flow (`save_request_pending` -> `save_atomic_write` or `recoverable_error`). |
| `hydrateResult` | Worker completes a `hydrate` request. | Success: `{ kind: 'hydrateResult'; requestId: string; ok: true; nextStep: number }` or failure: `{ kind: 'hydrateResult'; requestId: string; ok: false; error: InterfaceError }`. | Main process load flow (`load_hydrating` -> `running_idle` or `recoverable_error`). |
| `error` | Unhandled worker exception or protocol fault in worker. | `{ kind: 'error'; error: string }` | Main process failure handler transitions to `worker_failed`. |

### Validation Rules
| Field | Type | Constraints | Error | Message Template | Validation Mode |
|-------|------|-------------|-------|------------------|-----------------|
| `ready.protocolVersion` | `number \| undefined` | Optional; if present must be integer `1` or `2`; if omitted with omitted `ready.capabilities`, normalize to legacy protocol `1`. | `PROTOCOL_VALIDATION_FAILED` | `Invalid ready.protocolVersion: expected 1 or 2, received {actual}.` | Sync (main) |
| `ready.capabilities` | `{ canSerialize: boolean; canOfflineCatchup: boolean } \| undefined` | Required when `ready.protocolVersion === 2`; optional only for legacy fallback path (protocol `1`/omitted). | `PROTOCOL_VALIDATION_FAILED` | `Invalid ready.capabilities: expected { canSerialize: boolean; canOfflineCatchup: boolean } for protocolVersion 2.` | Sync (main) |
| `serialize.requestId` | `string` | Required; 1-64 chars; pattern `^[A-Za-z0-9_-]+$`. | `PROTOCOL_VALIDATION_FAILED` | `Invalid serialize.requestId: expected 1-64 chars matching ^[A-Za-z0-9_-]+$.` | Sync |
| `hydrate.requestId` | `string` | Required; 1-64 chars; pattern `^[A-Za-z0-9_-]+$`. | `PROTOCOL_VALIDATION_FAILED` | `Invalid hydrate.requestId: expected 1-64 chars matching ^[A-Za-z0-9_-]+$.` | Sync |
| `hydrate.save` | `GameStateSaveFormat` object | Required; must pass `loadGameStateSaveFormat`; version must resolve to `1`. | `INVALID_SAVE_DATA` | `Invalid hydrate.save: expected GameStateSaveFormat that resolves to version 1.` | Sync (worker), Async caller chain for file read/decode before worker call |
| `hydrate.save.savedAt` | `number` | Required; finite; `>= 0`. | `INVALID_SAVE_DATA` | `Invalid hydrate.save.savedAt: expected finite number >= 0.` | Sync |
| `hydrate.save.resources` | `object` | Required key present. | `INVALID_SAVE_DATA` | `Invalid hydrate.save.resources: expected object.` | Sync |
| `hydrate.save.progression` | `object` | Required key present. | `INVALID_SAVE_DATA` | `Invalid hydrate.save.progression: expected object.` | Sync |
| `hydrate.save.commandQueue` | `object` | Required key present. | `INVALID_SAVE_DATA` | `Invalid hydrate.save.commandQueue: expected object.` | Sync |
| `saveData.data` | `Uint8Array` | Required when `ok: true`; `byteLength > 0`. | `SERIALIZE_FAILED` | `Invalid saveData.data: expected non-empty Uint8Array.` | Sync |
| `offlineCatchup.elapsedMs` | `number` | Required; finite; `> 0`. | `INVALID_OFFLINE_CATCHUP_REQUEST` (main) or handler no-op (worker) | `Invalid offlineCatchup.elapsedMs: expected finite number > 0.` | Sync |
| `offlineCatchup.resourceDeltas` | `Record<string, number>` | Required by shell contract; object only; no arrays; default `{}` when no deltas provided. | `INVALID_OFFLINE_CATCHUP_REQUEST` (main) or handler no-op (worker) | `Invalid offlineCatchup.resourceDeltas: expected non-array object with numeric values.` | Sync |
| `offlineCatchup.maxElapsedMs` | `number` | Optional; if set, finite and `> 0`. | `INVALID_OFFLINE_CATCHUP_REQUEST` | `Invalid offlineCatchup.maxElapsedMs: expected finite number > 0 when provided.` | Sync |
| `offlineCatchup.maxSteps` | `number` | Optional; if set, integer and `>= 1`. | `INVALID_OFFLINE_CATCHUP_REQUEST` | `Invalid offlineCatchup.maxSteps: expected integer >= 1 when provided.` | Sync |
| `saveFilePath` | absolute path | Resolved under `app.getPath('userData')`; save writes use temp file in same dir then rename. | `IO_ERROR` | `Invalid saveFilePath: expected absolute path under app.getPath('userData').` | Async |
| `loadFileBytes` | `Uint8Array` | Required; non-empty; compression header must be supported before JSON parse. | `INVALID_SAVE_DATA` | `Invalid loadFileBytes: expected non-empty Uint8Array with supported compression header.` | Async decode + sync shape validation |

Validation failure behavior is consistent across commands: return an operation result with `ok: false` and `error: InterfaceError` when the worker remains healthy; transition to `worker_failed` only for worker process-level failures. Message strings are deterministic and must use the exact templates above (with placeholder substitution where applicable).

### Error Contract
All command-level failures use the same error envelope:

```ts
type InterfaceError = Readonly<{
  code:
    | 'PROTOCOL_VALIDATION_FAILED'
    | 'CAPABILITY_UNAVAILABLE'
    | 'SERIALIZE_FAILED'
    | 'INVALID_SAVE_DATA'
    | 'HYDRATE_FAILED'
    | 'INVALID_OFFLINE_CATCHUP_REQUEST'
    | 'REQUEST_TIMEOUT'
    | 'IO_ERROR';
  message: string;
  retriable: boolean;
}>;
```

### Contract Compatibility
| Gate | Decision |
|------|----------|
| Breaking change to existing interface? | **Yes, internal-only with explicit legacy handling**: protocol v2 workers send `ready.protocolVersion` + `ready.capabilities`; main also accepts legacy `ready` payloads that omit both fields. |
| Migration path | Ship main-process and worker updates together in the same release. Canonical compatibility behavior is fixed: missing `protocolVersion`/`capabilities` is treated as legacy protocol v1 with `{ canSerialize: false, canOfflineCatchup: false }`. |
| Versioning requirements | Main accepts `ready.protocolVersion` values `1` and `2` (with omission normalized to `1`). Any other value is rejected as protocol validation failure during startup and transitions to `worker_failed`. |

### UI Interactions
| Action | Request | Loading State | Success | Error |
|--------|---------|---------------|---------|-------|
| `Dev > Save` (`CmdOrCtrl+S`) | Send worker `serialize` command; then write returned bytes atomically to userData save path. | Save menu item disabled while request is in flight; optional "Saving..." status in dev overlay/log. | "Save complete" status/log; action re-enabled. | Show error with `InterfaceError.message`; keep previous committed save file unchanged. |
| `Dev > Load` (`CmdOrCtrl+O`) | Open file picker, read/decode/validate save, then send worker `hydrate`. | Load menu item disabled while file read/decode/hydrate is in flight. | "Load complete" status/log; runtime continues from hydrated step. | Show error for decode/validation/hydrate failure; runtime remains on pre-load state. |
| `Dev > Offline Catch-Up` | Build and enqueue `OFFLINE_CATCHUP` command (`resourceDeltas: {}` by default). | Action disabled while dialog/input validation and dispatch are in flight. | "Offline catch-up queued" status/log; simulation advances on subsequent ticks. | Show validation/dispatch error; no command is enqueued. |

UI state gates:
- Save and Load are enabled only when `capabilities.canSerialize === true` and worker status is `running`.
- Offline Catch-Up is enabled only when `capabilities.canOfflineCatchup === true` and worker status is `running`.
- Any active operation lock disables all three actions until completion.

## 4. Data
N/A - This feature does not add or modify data schemas.

## 5. Tasks

### Planning Gates
1. **Smallest independently testable unit**: one protocol/flow slice per layer (protocol types, runtime capability surface, worker request handlers, atomic filesystem utility, main-process orchestration/menu gating), each with a targeted test command.
2. **Dependencies between tasks**: yes. Worker handlers depend on protocol/runtime contracts, and main orchestration depends on worker protocol + atomic storage utility.
3. **Parallelizable tasks**: yes. `T1`, `T2`, and `T4` can be implemented in parallel. `T3` can start after `T1` + `T2`. `T5` starts after `T1` + `T3` + `T4`.
4. **Specific files per task**: listed in the breakdown and details for `T1`-`T5`.
5. **Acceptance criteria per task**: listed as concrete, verifiable checks for `T1`-`T5`.
6. **Verification command per task**: listed per task (package-scoped typecheck or Vitest file run).
7. **What must be done first**: protocol/runtime contracts (`T1`, `T2`) because all request/response handling depends on stable message and capability types.
8. **What must be done last**: main-process orchestration/menu/offline wiring (`T5`) after worker handlers and atomic storage utility exist.
9. **Circular dependencies**: none. The dependency graph is a DAG: foundational contracts -> worker/storage -> main wiring.
10. **Build/config changes needed**: none expected (`package.json`, `tsconfig`, workspace config unchanged).
11. **New dependencies to install**: none expected (uses existing `@idle-engine/core`, Electron, and Node `fs` APIs).
12. **Environment variables/secrets needed**: none.

### Goal-to-Task Mapping
- Goal: capability-based Save/Load enablement -> `T1`, `T2`, `T3`, `T5`
- Goal: atomic save writes -> `T4`, `T5`
- Goal: capability-based offline catch-up enablement -> `T3`, `T5`

### Task Dependency Graph
```
T1 (no deps)
T2 (no deps)
T4 (no deps)
T3 -> depends on T1, T2
T5 -> depends on T1, T3, T4
```

### Task Breakdown
| ID | Title | Summary | Files | Acceptance Criteria |
|----|-------|---------|-------|---------------------|
| T1 | Define Worker Protocol v2 Contracts | Extend worker protocol types with capability signaling and save/load envelopes. | `packages/shell-desktop/src/sim/worker-protocol.ts` | Protocol v2 `ready` includes protocol/capabilities; legacy `ready` compatibility shape (missing both fields) is modeled for main normalization; new `serialize`/`hydrate` request types and `saveData`/`hydrateResult` envelopes use `InterfaceError`. |
| T2 | Extend Sim Runtime Capability Surface | Add optional serialize/hydrate hooks to `SimRuntime` while preserving demo runtime behavior. | `packages/shell-desktop/src/sim/sim-runtime.ts`, `packages/shell-desktop/src/sim/sim-runtime.test.ts` | Runtime type exposes optional methods; existing tick/input behavior remains unchanged in tests. |
| T3 | Implement Worker Save/Load Handlers | Handle `serialize`/`hydrate` messages in worker and emit structured protocol v2 responses. | `packages/shell-desktop/src/sim-worker.ts`, `packages/shell-desktop/src/sim-worker.test.ts` | Worker emits protocol v2 `ready` with capabilities; serialize/hydrate success/failure paths and deterministic validation message templates are covered by tests. |
| T4 | Add Atomic Save Storage Utility | Implement temp-write + rename persistence and stale temp cleanup for save files. | `packages/shell-desktop/src/save-storage.ts`, `packages/shell-desktop/src/save-storage.test.ts` | Save writes are atomic, cleanup is best-effort, and utility tests cover success/failure/cleanup behavior. |
| T5 | Wire Main Save/Load + Dev Menu Actions | Integrate capability-gated Dev menu actions, request timeouts/locks, load decode/hydrate flow, and offline catch-up dispatch. | `packages/shell-desktop/src/main.ts`, `packages/shell-desktop/src/main.test.ts` | Dev menu actions gate correctly; save/load/offline flows handle success + recoverable errors + worker failures; canonical `ready` normalization fallback (missing protocol/capabilities => protocol v1 with disabled capabilities) is covered. |

### Task Details

**T1: Define Worker Protocol v2 Contracts**
- Summary: Introduce explicit protocol v2 message contracts and shared interface error envelope used by save/load operations.
- Files:
  - `packages/shell-desktop/src/sim/worker-protocol.ts` - add protocol v2 `ready` (`protocolVersion`/`capabilities`), explicit legacy `ready` compatibility shape (missing both fields), new inbound `serialize`/`hydrate` messages, outbound `saveData`/`hydrateResult` messages, and `InterfaceError` union codes.
- Acceptance Criteria:
  1. Protocol v2 `SimWorkerReadyMessage` requires `protocolVersion: 2` and `capabilities.canSerialize` + `capabilities.canOfflineCatchup`.
  2. Legacy compatibility `ready` shape (`{ kind: 'ready'; stepSizeMs; nextStep }`) is represented for main-process normalization to protocol v1 disabled capabilities.
  3. `SimWorkerInboundMessage` includes `{ kind: 'serialize'; requestId: string }` and `{ kind: 'hydrate'; requestId: string; save: GameStateSaveFormat }`.
  4. `SimWorkerOutboundMessage` includes success/error variants for `saveData` and `hydrateResult` using `InterfaceError`.
- Dependencies: None
- Verification: `pnpm --filter @idle-engine/shell-desktop typecheck`

**T2: Extend Sim Runtime Capability Surface**
- Summary: Expand `SimRuntime` contract so worker can detect save/load capabilities while retaining current demo behavior.
- Files:
  - `packages/shell-desktop/src/sim/sim-runtime.ts` - add optional `serialize`/`hydrate` methods to `SimRuntime` type and keep existing command/tick behavior stable.
  - `packages/shell-desktop/src/sim/sim-runtime.test.ts` - assert runtime API compatibility and no regressions in current command handling.
- Acceptance Criteria:
  1. `SimRuntime` type allows optional `serialize()` and `hydrate(save)` methods without breaking existing call sites.
  2. Demo runtime continues to process `COLLECT_RESOURCE` and `INPUT_EVENT` exactly as before.
  3. Existing `hasCommandHandler` behavior remains valid for capability detection tests.
- Dependencies: None
- Verification: `pnpm --filter @idle-engine/shell-desktop test -- src/sim/sim-runtime.test.ts`

**T3: Implement Worker Save/Load Handlers**
- Summary: Add worker-side request handling for serialize/hydrate and capability reporting in the `ready` message.
- Files:
  - `packages/shell-desktop/src/sim-worker.ts` - emit protocol v2 `ready`, validate request envelopes, call runtime serialize/hydrate when available, and return structured `InterfaceError` failures.
  - `packages/shell-desktop/src/sim-worker.test.ts` - add tests for serialize/hydrate success, capability-unavailable failures, and malformed request rejection.
- Acceptance Criteria:
  1. `init` emits `ready` with `protocolVersion: 2` and capability flags derived from runtime.
  2. `serialize` emits `saveData` success with non-empty bytes when supported, otherwise `CAPABILITY_UNAVAILABLE`.
  3. `hydrate` emits `hydrateResult` success/error and does not break tick/enqueue/shutdown behavior.
  4. Invalid request IDs or malformed payloads return `PROTOCOL_VALIDATION_FAILED`/`INVALID_SAVE_DATA` responses with deterministic messages from Section 3 templates.
- Dependencies: `T1`, `T2`
- Verification: `pnpm --filter @idle-engine/shell-desktop test -- src/sim-worker.test.ts`

**T4: Add Atomic Save Storage Utility**
- Summary: Implement filesystem helpers for atomic writes, reads, and stale temp cleanup in the shell main process.
- Files:
  - `packages/shell-desktop/src/save-storage.ts` - add save path resolution under `app.getPath('userData')`, temp write + rename, and stale temp cleanup helper.
  - `packages/shell-desktop/src/save-storage.test.ts` - add unit tests for atomic success path and cleanup on failure.
- Acceptance Criteria:
  1. Save writes always use temp file in the target directory followed by `rename`.
  2. Failure during write/rename leaves previously committed save untouched and performs best-effort temp cleanup.
  3. Startup cleanup removes stale temp files matching the save temp naming convention.
- Dependencies: None
- Verification: `pnpm --filter @idle-engine/shell-desktop test -- src/save-storage.test.ts`

**T5: Wire Main Save/Load + Dev Menu Actions**
- Summary: Integrate end-to-end main-process orchestration for save/load/offline dev tooling with capability-based gating.
- Files:
  - `packages/shell-desktop/src/main.ts` - add capability cache, request timeout/operation lock handling, save/load orchestration, offline catch-up dispatch, and Dev menu items with accelerators + enabled gating.
  - `packages/shell-desktop/src/main.test.ts` - add/update tests for menu gating, save/load success/failure/timeouts, protocol compatibility fallback, and offline catch-up dispatch.
- Acceptance Criteria:
  1. Dev menu includes `Save`, `Load`, and `Offline Catch-Up` actions with `CmdOrCtrl+S`/`CmdOrCtrl+O` accelerators and correct enabled/disabled state.
  2. Save flow sends `serialize`, handles matching `saveData`, and persists bytes via atomic storage utility.
  3. Load flow reads selected file, decodes/validates save data, sends `hydrate`, and preserves current runtime on failure.
  4. Offline catch-up action enqueues `OFFLINE_CATCHUP` with validated payload and default `resourceDeltas: {}`.
  5. Missing `protocolVersion`/`capabilities` in `ready` is normalized to protocol v1 with disabled capability-gated actions.
  6. Any other malformed/unsupported `ready` payload is rejected during startup and transitions to `worker_failed`.
- Dependencies: `T1`, `T3`, `T4`
- Verification: `pnpm --filter @idle-engine/shell-desktop test -- src/main.test.ts`

## 6. Validation

### Pre-Implementation Checks
- [ ] All dependencies installed: `pnpm install`
- [ ] Types check baseline: `pnpm typecheck`
- [ ] Existing tests baseline: `pnpm test`

### Post-Implementation Checks
- [ ] Types check: `pnpm typecheck`
- [ ] Lint passes: `pnpm lint`
- [ ] All tests pass: `pnpm test`
- [ ] Targeted tests added/updated for:
  - `packages/shell-desktop/src/sim/sim-runtime.test.ts`
  - `packages/shell-desktop/src/sim-worker.test.ts`
  - `packages/shell-desktop/src/save-storage.test.ts`
  - `packages/shell-desktop/src/main.test.ts`
- [ ] Coverage docs regenerated and tracked: `pnpm coverage:md` (includes updated `docs/coverage/index.md`)

### Manual Verification (if applicable)
- [ ] Start shell desktop (`pnpm --filter @idle-engine/shell-desktop start`) and confirm Dev menu exists with Save/Load/Offline Catch-Up actions.
- [ ] Confirm Save/Load/Offline actions are disabled until worker `ready`, then enabled only for reported capabilities.
- [ ] Trigger Save and verify a save file is written under `app.getPath('userData')` with no leftover temp file.
- [ ] Trigger Load with an invalid/corrupt file and confirm recoverable error handling (no worker crash, runtime continues).
