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
| `worker_starting` | Main creates sim worker controller, sends `init`, and waits for `ready` with capabilities. | `main_bootstrap` completes controller construction. |
| `running_idle` | Worker is ready, tick loop runs, and Save/Load/Offline Catch-Up actions are accepted only when capability flags allow them. | `worker_starting` receives valid `ready` payload. |
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

### Transitions
| From | Event/Condition | To | Side Effects |
|------|-----------------|-----|--------------|
| `main_bootstrap` | Window/controller creation succeeds | `worker_starting` | Create worker thread; send `init`; emit `simStatus: starting`; keep capability-gated menu items disabled. |
| `main_bootstrap` | App quit/close requested before worker is ready | `app_terminating` | Skip runtime startup and begin shutdown path. |
| `worker_starting` | Worker emits valid `ready` with capabilities | `running_idle` | Cache `stepSizeMs`/`nextStep`; cache `canSerialize`/`canOfflineCatchup`; emit `simStatus: running`; start tick loop; refresh menu enabled flags. |
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
| `worker_starting` | Invalid init params, bad ready payload, worker crash, or ready timeout | `worker_failed` | Emit crashed/stopped status, disable actions, terminate worker, log root cause. |
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
[To be completed in design_api phase]

## 4. Data
[To be completed in design_data phase]

## 5. Tasks
[To be completed in design_plan phase]

## 6. Validation
[To be completed in design_plan phase]
