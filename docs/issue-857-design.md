---
title: "shell-desktop: embed MCP server for AI agent workflows (Issue 857)"
sidebar_position: 99
---

# shell-desktop: embed MCP server for AI agent workflows (Issue 857)

## Document Control
- **Title**: Integrate an embedded MCP server into `@idle-engine/shell-desktop`
- **Authors**: Ralph (AI)
- **Reviewers**: @hansjm10
- **Status**: Draft
- **Last Updated**: 2026-01-27
- **Related Issues**: https://github.com/hansjm10/Idle-Game-Engine/issues/857
- **Execution Mode**: AI-led

## 1. Summary
Add an embedded Model Context Protocol (MCP) server to the Electron desktop shell (`@idle-engine/shell-desktop`) so AI agents (Claude Desktop, Cursor, etc.) can programmatically control the simulation, inject inputs, inspect state/diagnostics, capture screenshots, and interact with replays/assets during development and testing. The MCP server runs in the Electron main process, is opt-in (dev-only by default), exposes a constrained tool surface, and bridges to the sim worker and `BrowserWindow` APIs through typed handlers with unit test coverage.

## 2. Context & Problem Statement
- **Background**:
  - The repo already has a first-party Electron shell and WebGPU renderer pathway (see `packages/shell-desktop/src/main.ts` and `docs/desktop-shell-webgpu-renderer-replay-design-issue-778.md`).
  - The shell runs a sim worker (`node:worker_threads`) driven by a tick loop in the main process and forwards frames to the renderer via typed IPC (`packages/shell-desktop/src/ipc.ts`).
  - The Model Context Protocol (MCP) is emerging as a standard for agent-to-tool integrations, with growing ecosystem support in agent UIs.
- **Problem**:
  - There is no supported, automation-friendly API for external tools/agents to control the shell or introspect runtime state, which limits:
    - automated regression workflows (“drive sim → capture state/screenshot → assert”),
    - interactive debug assistance (“inspect live state when issue reported”),
    - AI-assisted content iteration (“preview changes quickly with scripted steps”).
  - Existing “Electron MCP servers” typically rely on Chrome DevTools Protocol (CDP) and remote-debug flags, which do not provide direct access to the shell’s typed IPC channels, sim worker messaging, or deterministic command queue.
- **Forces**:
  - Preserve determinism: control APIs must not introduce nondeterministic side effects into simulation.
  - Safety: the server must be local-only, opt-in, and constrained (no arbitrary file/process access).
  - Keep the integration maintainable: tool inputs/outputs should be validated and testable without launching a full Electron UI.

## 3. Goals & Non-Goals
- **Goals**:
  1. Provide an embedded MCP server in the Electron main process that can be enabled via flag/env var.
  2. Expose a type-validated tool surface for:
     - simulation lifecycle and stepping,
     - command enqueueing / control-event injection,
     - window inspection and screenshot capture,
     - asset listing/reading (compiled assets only),
     - (phase 2) replay IO and basic state inspection/query.
  3. Ensure handlers are testable with existing `vitest` mocking patterns (similar to `packages/shell-desktop/src/main.test.ts`).
  4. Document how to configure common agent clients (Claude Desktop, Cursor) to connect.
- **Non-Goals**:
  - Exposing privileged OS automation (global keyboard/mouse, filesystem writes outside controlled directories, process spawning).
  - Running an always-on automation endpoint in production builds by default.
  - Guaranteeing a stable “full game state schema” immediately; state surfaces may start as a debug snapshot and evolve.

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**:
  - Shell maintainers (`packages/shell-desktop`)
  - Runtime/core maintainers (`packages/core`) for command/replay/state abstractions
  - Docs/tooling maintainers (agent integration docs; local dev workflows)
- **Agent Roles**:
  - **Runtime/Shell Agent**: Implement MCP server lifecycle + bridging to shell components.
  - **Tool Handler Agent**: Implement tool schemas + handlers (sim/window/input/state/replay/asset).
  - **Test Agent**: Add deterministic unit tests for handlers and transport plumbing.
  - **Docs Agent**: Document setup for agent clients and provide example prompts/workflows.
- **Affected Packages/Services**:
  - `packages/shell-desktop` (new MCP server module and integration wiring)
  - `packages/core` (potentially: expose additional replay/state helpers if needed)
  - `docs/` (new design doc + connection/setup instructions)
- **Compatibility Considerations**:
  - The server must be disabled by default and bound to `localhost` when enabled.
  - Tool contracts should be versioned (server “capabilities” include a version string) so clients can adapt.

## 5. Current State
- `packages/shell-desktop/src/main.ts`:
  - creates a sandboxed `BrowserWindow` and loads `renderer/index.html`.
  - drives a `Worker` (`./sim-worker.js`) via a main-process tick loop (`setInterval`), forwarding `RenderCommandBuffer` frames to the renderer over IPC.
  - handles IPC:
    - `ping` and `readAsset` as invoke handlers,
    - `controlEvent` as a fire-and-forget event mapped into runtime commands.
- `packages/shell-desktop/src/sim-worker.ts` and `packages/shell-desktop/src/sim/sim-runtime.ts`:
  - implement a simple sim runtime (`IdleEngineRuntime`) and accept `tick` + `enqueueCommands` messages.
  - do not currently expose a request/response RPC for “get status/state” from the main process.
- Tests exist for the main process behavior and IPC contracts (`packages/shell-desktop/src/main.test.ts`, `packages/shell-desktop/src/ipc.test.ts`) and demonstrate a mocking approach suitable for MCP tool handler tests.

## 6. Proposed Solution
### 6.1 Architecture Overview
Embed an MCP server in the Electron main process and bridge its tools to existing shell primitives:

```
AI Client (Claude/Cursor)
  │  MCP (stdio or SSE)
  ▼
Electron main process
  - MCP server + tool handlers
  - BrowserWindow control (screenshot/devtools/resize)
  - Sim worker controller (pause/resume/step/enqueue)
  │
  ▼
Sim worker (node:worker_threads)
  - Sim runtime (IdleEngineRuntime)
  - Optional debug/state RPC
```

Transport is configurable:
1. **SSE/HTTP on localhost** (recommended for “attach to a running app” workflows).
2. **stdio** (optional) for clients that prefer spawning a process as the MCP server.

### 6.2 Detailed Design
- **Runtime Changes**:
  - Introduce a new module in `packages/shell-desktop/src/mcp/` that:
    - constructs an MCP server using `@modelcontextprotocol/sdk`,
    - registers tools and their input/output schemas,
    - binds handlers to a “shell context” object (main window + sim controller).
  - Extend the existing sim worker controller to support:
    - `pause`/`resume` by stopping/restarting the main-process tick loop,
    - `step(n)` while paused by sending `tick` messages with deterministic `deltaMs` (`stepSizeMs * n` or repeated single-step ticks),
    - `start`/`stop` by creating/terminating the sim worker and emitting sim status updates.
  - Add a minimal request/response RPC between main process and sim worker for debug/state queries:
    - `getStatus` → `{ stepSizeMs, nextStep, running, paused }`
    - `getDebugState` → JSON-friendly snapshot (initially demo-only, expandable).
- **Data & Schemas**:
  - Define tool inputs/outputs as JSON-serializable shapes; treat “state snapshots” as debug-only payloads and avoid leaking internal object graphs.
  - Add a server “capabilities” response (or tool) that includes:
    - `serverVersion`,
    - supported tool list,
    - feature flags (e.g., replay support enabled).
- **APIs & Contracts** (initial tool set; names stable, schemas versioned):
  - `sim/status`: current sim status + step/stepSizeMs.
  - `sim/start` / `sim/stop`: worker lifecycle control (dev only).
  - `sim/pause` / `sim/resume` / `sim/step`: deterministic control of the tick loop.
  - `sim/enqueue`: enqueue runtime commands (validated + normalized similarly to `normalizeCommand` in `packages/shell-desktop/src/sim/sim-runtime.ts`).
  - `input/controlEvent`: send a `ShellControlEvent` through the same path as IPC (`packages/shell-desktop/src/ipc.ts`), ensuring parity with UI events.
  - `window/info` / `window/resize` / `window/devtools` / `window/screenshot`: wrap `BrowserWindow` operations (screenshot returns base64 PNG and optionally writes to a controlled output dir).
  - `asset/list` / `asset/read`: list/read assets limited to the compiled assets root (reuse the path traversal checks in `packages/shell-desktop/src/main.ts`’s `readAsset` handler logic).
  - (Phase 2) `state/get` / `state/query`: debug snapshot + path query for small state surfaces.
  - (Phase 2) `replay/*`: list/load/save/scrub/compare using existing replay formats from `packages/core/src/replay/*` and a shell-local replay directory.
- **Tooling & Automation**:
  - Enable/disable via explicit env/flag (examples):
    - `IDLE_ENGINE_ENABLE_MCP=1`
    - `IDLE_ENGINE_MCP_TRANSPORT=sse|stdio`
    - `IDLE_ENGINE_MCP_PORT=...` (SSE)
  - Add an internal audit log (dev only) for tool invocations (tool name + sanitized args + timestamp).

### 6.3 Operational Considerations
- **Deployment**:
  - Dev-only default: enable MCP server automatically when `NODE_ENV=development` and the explicit env/flag is set.
  - Production builds require explicit opt-in and bind to `localhost` only.
- **Telemetry & Observability**:
  - Log tool invocations (dev only) and optionally provide a `debug/logs` tool that returns recent entries (bounded).
- **Security & Compliance**:
  - Hard safety constraints:
    - bind to `127.0.0.1` only (SSE),
    - strict allowlist of tool operations,
    - constrain filesystem reads to compiled assets and constrained replay directories,
    - no arbitrary command execution, no network proxying, no secrets export.
  - Optional: require a one-time session token printed to console (or shown in the UI) that clients must provide.

## 7. Work Breakdown & Delivery Plan
### 7.1 Issue Map
| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| `feat(shell-desktop): add embedded MCP server scaffold` | Add MCP server module, feature flagging, and a transport (SSE recommended first) with a minimal “health/capabilities” tool. | Runtime/Shell Agent | Doc approval | MCP server starts when enabled; binds to localhost; exposes at least one tool; unit tests cover tool registration and enable/disable behavior. |
| `feat(shell-desktop): implement sim/* MCP tools` | Implement `sim/status`, `sim/start`, `sim/stop`, `sim/pause`, `sim/resume`, `sim/step`, `sim/enqueue` bridging to the sim worker controller. | Tool Handler Agent | MCP scaffold | Tools behave deterministically; invalid inputs are rejected; sim lifecycle is test-covered with worker/electron mocks. |
| `feat(shell-desktop): implement window/* + input/* MCP tools` | Implement window inspection/screenshot/resize/devtools and `input/controlEvent` (and optional key/mouse helpers). | Tool Handler Agent | MCP scaffold | Screenshot returns PNG bytes/base64; window operations are local-only; `input/controlEvent` matches existing IPC semantics; tests cover critical branches. |
| `feat(shell-desktop): implement asset/* MCP tools` | Implement `asset/list` and `asset/read` limited to compiled assets root with robust path traversal protection. | Tool Handler Agent | MCP scaffold | Assets can be enumerated and read; path traversal is rejected; behavior is unit tested. |
| `docs(shell-desktop): document MCP setup + example workflows` | Document enablement flags, Claude Desktop/Cursor config, and example prompts for regression, debugging, and content iteration. | Docs Agent | Core tools implemented | Docs include a minimal quickstart; example prompts are provided; design doc references updated if scope changes. |

### 7.2 Milestones
- **Phase 1 (MVP)**: MCP scaffold + `sim/*`, `window/*`, `input/*`, and `asset/*` tools with unit tests and docs.
- **Phase 2**: Add `state/*` (debug snapshot + query) and `replay/*` tools once the shell has a stable replay IO surface.
- **Phase 3**: Hardening (token auth, richer diagnostics), and optional stdio transport if client demand requires it.

### 7.3 Coordination Notes
- **Hand-off Package**:
  - Source: `packages/shell-desktop/src/main.ts`, `packages/shell-desktop/src/sim-worker.ts`, `packages/shell-desktop/src/ipc.ts`.
  - Reference designs: `docs/desktop-shell-webgpu-renderer-replay-design-issue-778.md`, `docs/automation-system-api.md` (agent/tooling conventions).
- **Communication Cadence**:
  - Keep tools small and ship in slices; each PR should include handler tests and docs updates as appropriate.

## 8. Agent Guidance & Guardrails
- Do not edit checked-in `dist/**` outputs by hand; rely on package build scripts.
- Keep simulation deterministic: `sim/step` and `sim/enqueue` must not depend on wall-clock time (derive timestamps from `step * stepSizeMs` like existing code).
- Prefer pure tool handlers with explicit validation and bounded outputs; avoid returning huge object graphs.
- Validation hooks:
  - `pnpm lint`
  - `pnpm test --filter @idle-engine/shell-desktop`

## 9. Alternatives Considered
1. **External CDP-based automation** (Playwright/CDP MCP servers): easy UI driving, but cannot directly access main-process APIs, sim worker wiring, or typed IPC; requires debug ports/flags.
2. **Separate MCP bridge process** that talks to the app via custom IPC: keeps app cleaner but violates the “embedded” goal and adds operational complexity (discoverability, lifecycle coordination).
3. **Expose a bespoke HTTP API**: simpler technically, but loses MCP ecosystem interoperability and tool schema conventions.

## 10. Testing & Validation Plan
- **Unit / Integration**:
  - Add `packages/shell-desktop/src/mcp/*.test.ts` covering:
    - server enablement/disablement,
    - tool schema validation,
    - handler behavior with mocked `BrowserWindow`, `Worker`, and tick loop.
  - Add focused tests for path traversal protection (`asset/read`).
- **Performance**:
  - Ensure screenshot capture and asset reads are bounded; avoid large memory spikes (cap screenshot size or provide downscale option).
- **Tooling / A11y**:
  - N/A (developer tooling), but ensure no extra console noise in tests that could break `vitest-llm-reporter` output.

## 11. Risks & Mitigations
- **Security exposure**: Even localhost endpoints can be abused (malware/other local processes).
  - Mitigation: opt-in flags, localhost bind, optional session token, strict allowlist.
- **API creep**: tools expand to “do everything” and become unmaintainable.
  - Mitigation: phased roadmap; require design update for new tool categories.
- **Flaky tests / Electron coupling**:
  - Mitigation: keep handlers pure; mock Electron/Worker layers like existing `main.test.ts`.
- **State query ambiguity**:
  - Mitigation: start with explicit debug snapshots and add stable state APIs only once schemas are ready.

## 12. Rollout Plan
1. Land MCP scaffold behind explicit enable flag.
2. Add core tool set (`sim/*`, `window/*`, `input/*`, `asset/*`) with tests.
3. Document setup for common clients and provide example workflows.
4. Iterate on state/replay tools once shell runtime IO surfaces stabilize.

## 13. Open Questions
1. **Transport**: Do we prioritize SSE-only first, or must we deliver stdio from day one for Claude Desktop compatibility?
2. **Auth model**: Is a session token required even for localhost? How is it communicated (console vs UI)?
3. **State surface**: What is the “blessed” debug state snapshot for `shell-desktop` today (demo state vs progression snapshot vs diagnostics timeline)?
4. **Replay storage**: Where should replays live (repo-local dev folder vs `app.getPath('userData')`) and what is the default format (JSONL per `packages/core/src/replay/*`)?
5. **Tool scope**: Which “proposed tools” are required for the initial acceptance criteria vs follow-up phases (especially `replay/*` and rich `state/*`)?

## 14. Follow-Up Work
- Add `state/*` tools once a stable, JSON-friendly debug snapshot is defined for the shell runtime.
- Add `replay/*` tools and integrate with the core replay pipeline (including compare tooling and visual regression hooks).
- Add richer diagnostics tools (`diagnostics/timeline`, command failures/outcomes) if needed for debugging workflows.
- Consider a “stdio bridge” helper if SSE is insufficient for some clients.

## 15. References
- Issue: https://github.com/hansjm10/Idle-Game-Engine/issues/857
- MCP: https://modelcontextprotocol.io/
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- Electron security guide: https://www.electronjs.org/docs/latest/tutorial/security
- Shell architecture: `packages/shell-desktop/src/main.ts`, `packages/shell-desktop/src/ipc.ts`, `packages/shell-desktop/src/sim-worker.ts`

## Appendix A — Glossary
- **MCP**: Model Context Protocol; a standard for tool-based integrations with AI agents.
- **SSE**: Server-Sent Events; a simple HTTP streaming transport.
- **CDP**: Chrome DevTools Protocol; remote debugging/automation protocol for Chromium.
- **IPC**: Inter-process communication; here, Electron renderer ↔ main process messaging.

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2026-01-27 | Ralph (AI) | Initial draft. |

