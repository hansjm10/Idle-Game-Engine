# Runtime->React Worker Bridge Operational Runbook

Issue: [#261](https://github.com/hansjm10/Idle-Game-Engine/issues/261)  
Design Source: [runtime-react-worker-bridge-design.md](runtime-react-worker-bridge-design.md) §§3, 6.3, 12

## 1. Purpose & Scope
- Stabilise day-to-day build, deployment, and troubleshooting for the runtime worker bridge delivered by issues [#253](https://github.com/hansjm10/Idle-Game-Engine/issues/253) and [#254](https://github.com/hansjm10/Idle-Game-Engine/issues/254). The implementation lives in `packages/shell-web/src/runtime.worker.ts` and `packages/shell-web/src/modules/worker-bridge.ts`.
- Reinforce the design goals in §3 (deterministic messaging, diagnostics gating, lifecycle hygiene) and the operational guardrails from §6.3 (deployment, observability, security).
- Provide a single checklist that Presentation Shell and Runtime Core leads can approve before enabling or rolling back the worker bridge.

## 2. Ownership & Review Path
- **Primary contacts**: Runtime Core maintainers (command queue invariants) and Presentation Shell lead (React integration). Tag both parties for every runbook or bridge code change—this satisfies the “Guidance reviewed by Runtime Core and Presentation Shell leads” acceptance criterion.
- **Escalation**: file incidents in the project board (`Presentation Shell` workstream) and page Runtime Core if determinism or command sequencing is in doubt.
- **Telemetry routing**: the worker surfaces incidents through `globalThis.__IDLE_ENGINE_TELEMETRY__` (`packages/shell-web/src/modules/worker-bridge.ts:41`); coordinate with analytics before mutating that facade.

## 3. Build & Rollout Workflow
### 3.1 Local build matrix
1. `pnpm install` (repository root) – ensures Vite and shared configs are present.
2. `pnpm --filter shell-web dev` – spins up the worker-enabled shell at http://localhost:5173 for interactive validation.
3. `pnpm build --filter shell-web` – produces the production bundle under `packages/shell-web/dist/`. The build emits a hashed worker artifact (for example `dist/assets/runtime.worker-*.js`) alongside the main entrypoint; confirm both files exist before promoting a release.
4. `pnpm preview --filter shell-web -- --open` – optional smoke of the built assets via Vite’s preview server.

### 3.2 Feature flag rollout
- **Release staging**: publish the built assets to your CDN under a canary prefix (e.g. `/shell/worker-canary/`). Keep the previous non-worker build available so flips are instant.
- **Flag control**: gate the shell’s HTML entrypoint behind a deployment-level flag such as `presentationShell.workerBridge.enabled`. When false, serve the legacy build; when true, serve the worker-backed bundle. This mirrors the design requirement in §12 to promote behind a feature guard. (A runtime toggle inside the React shell does not exist yet—track that follow-up separately.)
- **Rollback**: disable the flag to fall back to the legacy artifact, or redeploy the last known-good bundle. No code change is required provided both builds remain in storage.
- **Environment parity**: enable the flag progressively (dev → staging → canary → production). Each promotion should include the validation checklist in Section 5 and sign-off from both leads.

### 3.3 Configuration knobs
- `VITE_ENABLE_SOCIAL_COMMANDS` / `VITE_SOCIAL_SERVICE_BASE_URL` – opt-in to social-worker calls; default is disabled (see `packages/shell-web/src/modules/social-config.ts`).
- `__IDLE_ENGINE_TELEMETRY__` – optional global injected by hosts for telemetry forwarding (errors surfaced through the bridge call this automatically).
- Future runtime toggle: design §12 calls for a dedicated worker bridge flag inside the shell; document and wire it when implemented.

## 4. Operational Procedures
### 4.1 Worker lifecycle
- **Instantiation**: `useWorkerBridge()` (React hook) spins up the worker via `new Worker(new URL('../runtime.worker.ts', import.meta.url), { type: 'module' })` and returns a singleton bridge (`packages/shell-web/src/modules/worker-bridge.ts:604-623`).
- **Handshake**: the worker posts a `READY` message once initialised (`packages/shell-web/src/runtime.worker.ts:877`). Clients must `await bridge.awaitReady()` before sending commands; messages issued earlier are queued.
- **Session restore**: `bridge.restoreSession()` forwards a `RESTORE_SESSION` envelope and defers command flush until `SESSION_RESTORED` arrives. Commands sent during restore are stored and replayed automatically (`runtime.worker.ts:195-223`, `worker-bridge.ts:150-188`).
- **Disposal**: the hook’s `useEffect` unregisters listeners and calls `bridge.dispose()` on unmount, preventing worker leaks (`worker-bridge.ts:614-622`). Always unmount providers during route transitions to avoid stray workers.

### 4.2 Command channel
- Commands must include a monotonic `issuedAt` (usually `performance.now()`). The worker drops stale envelopes and emits `STALE_COMMAND` errors (`runtime.worker.ts:712-735`). React clients should reuse `bridge.sendCommand` which stamps the fields correctly.
- The worker enqueues everything at `CommandPriority.PLAYER`, guarding against privilege escalation across the bridge (`runtime.worker.ts:759-770`).
- Social commands remain behind `VITE_ENABLE_SOCIAL_COMMANDS` and proxy through fetch helpers (`runtime.worker.ts:240-520`). Unsupported kinds throw `WorkerBridgeSocialCommandError`.

### 4.3 Diagnostics opt-in
- Call `bridge.enableDiagnostics()` to subscribe; pair it with `bridge.onDiagnosticsUpdate(handler)` to receive `DiagnosticTimelineResult` deltas. Updates throttle automatically and include dropped-entry counters (`runtime.worker.ts:90-118`).
- Disable streaming via `bridge.disableDiagnostics()` and `bridge.offDiagnosticsUpdate(handler)` to reduce noise. Diagnostics are opt-in by default to preserve the main-thread budget (§6.3).
- For automated analysis, register `__IDLE_ENGINE_TELEMETRY__.recordError` so worker-surfaced errors federate into the hosting app’s pipeline (`worker-bridge.ts:30-44`).

### 4.4 READY/ERROR signalling
- Monitor the console for `[runtime.worker]` warnings. Errors propagate through `bridge.onError` callbacks with typed detail (`RuntimeWorkerErrorDetails`) and request IDs for social commands.
- Common codes:
  - `INVALID_COMMAND_PAYLOAD` – schema/version mismatch or malformed payload.
  - `SCHEMA_VERSION_MISMATCH` – client bundle using different `WORKER_MESSAGE_SCHEMA_VERSION` (currently `2`).
  - `RESTORE_FAILED` – session payload rejected; inspect `.details` for reconciliation logs.
  - `STALE_COMMAND` – command `issuedAt` < last accepted; ensure callers use the bridge helpers.

## 5. Validation Checklist
Run these commands from the repository root before promoting or flipping the feature flag:

```bash
pnpm lint
pnpm test --filter shell-web
pnpm build --filter shell-web
```

- Attach logs (including the final `vitest-llm-reporter` JSON) to the release note.
- If UI flows change (e.g., diagnostics panel, social tooling), run `pnpm test:a11y` and capture any residual gaps in the deployment summary.
- Verify `packages/shell-web/dist/index.html` references the hashed worker asset; mismatches indicate a stale build.

## 6. Troubleshooting Playbook
| Symptom | Likely Cause | Checks & Fix |
| --- | --- | --- |
| No `READY` message, `awaitReady()` never resolves | Worker asset missing or blocked by CSP | Confirm `dist/assets/runtime.worker-*.js` exists and is served with `Content-Type: text/javascript`; inspect network panel for 404/blocked requests. |
| `RESTORE_FAILED` errors on boot | Serialized state incompatible with runtime or corrupted payload | Capture `error.details` and rerun `pnpm test --filter shell-web --runInBand` to reproduce with fixture saves. Validate content digests before calling `restoreSession`. |
| Commands silently dropped | Non-monotonic `issuedAt` or commands queued during restore | Ensure callers await `bridge.awaitReady()` and reuse `sendCommand`. Monitor worker warnings for `Dropping stale command`. |
| Diagnostics callbacks never fire | `enableDiagnostics` not invoked or subscription removed | Confirm subscription sequence (enable → onDiagnosticsUpdate) and ensure diagnostics remains enabled in the worker. Remember diagnostics are disabled if the bridge disposes between renders. |
| Worker leaks after navigation | Hook unmounted without disposing or multiple bridges instantiated | Verify only one `useWorkerBridge` consumer is active; ensure providers unmount on route changes. Use React DevTools to confirm no lingering bridge instance. |
| Social commands reject with `"Social commands are disabled in this shell"` / worker error code `SOCIAL_COMMANDS_DISABLED` | `VITE_ENABLE_SOCIAL_COMMANDS` not set in the build environment | Enable the env var (or launch flag) and redeploy; social command support stays off by default. |

## 7. Verification Artifacts
- Automated coverage: `packages/shell-web/src/runtime.worker.test.ts` (handshake, diagnostics, command validation) and `packages/shell-web/src/modules/worker-bridge.test.ts` (bridge queueing, disposal, social command gating). These correspond to implementations expected by issues #253 and #254.
- Manual smoke (record in release notes):
  1. Launch `pnpm --filter shell-web dev`, open http://localhost:5173, and confirm commands increment the runtime step counter.
  2. Toggle diagnostics via DevTools snippet (run after the shell mounts):
     ```js
     (async () => {
       const bridge = window.__IDLE_WORKER_BRIDGE__;
       if (!bridge) {
         throw new Error('Worker bridge has not initialised yet');
       }
       await bridge.awaitReady();
       bridge.enableDiagnostics();
       bridge.onDiagnosticsUpdate(console.log);
     })();
     ```
     Ensure console prints deltas and no dropped-entry spikes after idling 30s. Call `bridge.disableDiagnostics()` when finished.
  3. Flip the deployment feature flag off/on in staging to validate rollback path.

## 8. Follow-Up & Assumptions
- **Pending runtime toggle**: implement an explicit worker bridge feature flag in the shell to satisfy design §12 without relying solely on CDN routing.
- **Persistence integration**: coordinate with issue #258 (Worker↔Shell persistence handoff) before enabling offline progression; the runbook will require updates once snapshot flows ship.
- **Telemetry completeness**: register the analytics sink tracked in issue #267 so worker errors reach dashboards; document the configuration here when available.

Maintain this runbook alongside bridge code changes—update sections 3–6 whenever the worker protocol, diagnostics behaviour, or deployment strategy evolves. Tag both leads for review to keep operational guidance authoritative.
