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
[To be completed in design_workflow phase]

## 3. Interfaces
[To be completed in design_api phase]

## 4. Data
[To be completed in design_data phase]

## 5. Tasks
[To be completed in design_plan phase]

## 6. Validation
[To be completed in design_plan phase]
