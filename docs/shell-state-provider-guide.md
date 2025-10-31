---
title: Shell State Provider Integration Guide
description: How presentation-shell modules consume ShellStateProvider hooks, diagnostics, and social command flows.
---

# Shell State Provider Integration Guide

This guide fulfils the documentation follow-up in [docs/shell-state-provider-design.md §14](shell-state-provider-design.md#14-follow-up-work). It explains how React modules integrate with the shared Shell state context, tying every step back to the approved design so contributors can migrate safely.

## Before You Start

- Review the design’s architecture notes, especially [§6.2 Detailed Design](shell-state-provider-design.md#62-detailed-design) for API contracts and [§7.3 Coordination Notes](shell-state-provider-design.md#73-coordination-notes) for affected modules.
- Scan the migration expectations in [§12 Rollout Plan](shell-state-provider-design.md#12-rollout-plan) so your rollout matches the planned sequencing.
- Ensure local setup matches the repository guidelines (Node ≥20.10, pnpm ≥8) and that you can run `pnpm lint`, `pnpm test`, and `pnpm test:a11y` without failures.
- Keep these files handy while implementing:
  - `packages/shell-web/src/modules/ShellStateProvider.tsx`
  - `packages/shell-web/src/modules/shell-state.types.ts`
  - `packages/shell-web/src/modules/shell-state-store.ts`
  - `packages/shell-web/src/modules/App.tsx` (reference implementation)

## 1. Map the Provider Surface

The provider colocates runtime snapshots, bridge commands, diagnostics, and social metadata behind a trio of hooks. Each hook throws if used outside the provider boundary, so ensure your component tree mounts `<ShellStateProvider>` near the shell root.

| Hook | Purpose | Common Uses |
| --- | --- | --- |
| `useShellState()` | Exposes aggregated runtime, bridge, social, and diagnostics state. | Rendering ticks, event history, back-pressure metrics, pending social requests. |
| `useShellBridge()` | Wraps worker bridge commands (`awaitReady`, `sendCommand`, `sendSocialCommand`, `restoreSession`, `isSocialFeatureEnabled`). | Dispatch runtime commands, kick off session restore, gate social UI. |
| `useShellDiagnostics()` | Manages diagnostics subscription lifecycle and mirrors diagnostics timeline state. | Enable profiling panels, stream timeline updates to charts. |

> **Design tie-back:** These hooks implement the API contract committed in [design §6.2](shell-state-provider-design.md#62-detailed-design). Avoid importing `useWorkerBridge` directly—doing so reintroduces the fragmentation called out in the problem statement.

### Provider Configuration

`ShellStateProvider` accepts optional configuration that mirrors the reducer defaults in `shell-state-store.ts`:

```tsx title="packages/shell-web/src/modules/App.tsx"
const EVENT_HISTORY_LIMIT = 50;

export function App() {
  return (
    <ShellStateProvider maxEventHistory={EVENT_HISTORY_LIMIT}>
      <ShellAppSurface />
    </ShellStateProvider>
  );
}
```

- `maxEventHistory` defaults to `DEFAULT_MAX_EVENT_HISTORY` (200) and bounds the FIFO snapshot window (see [design §13](shell-state-provider-design.md#13-resolved-questions)).
- `maxErrorHistory` defaults to `DEFAULT_MAX_ERROR_HISTORY` and caps telemetry-visible bridge errors.
- Only tune these limits when UX requirements demand it; keep the defaults aligned with runtime determinism guarantees.

### Restore Payloads

If you need to hydrate from a saved session, pass a `restorePayload` prop. The provider invokes `restoreSession(payload)` once on mount, surfacing loading state through `ShellState.bridge.isRestoring`. Catch errors via telemetry (`ShellStateProviderRestoreFailed` / `ShellStateProviderRestoreEffectFailed`) instead of wrapping restore in component-level try/catch. This behaviour matches the session flow described in [design §6.2 APIs & Contracts](shell-state-provider-design.md#62-detailed-design).

## 2. Consume Runtime State

`ShellState.runtime` exposes a derived snapshot assembled in the reducer. Typical patterns:

```tsx
import { useShellState } from '@idle-engine/shell-web/modules';

export function TickCounter(): JSX.Element {
  const {
    runtime: { currentStep, events, backPressure },
  } = useShellState();

  return (
    <section>
      <h2>Runtime</h2>
      <p>Current deterministic step: {currentStep}</p>
      <p>Events in buffer: {events.length}</p>
      {backPressure ? (
        <p>Soft limited channels: {backPressure.counters.softLimited}</p>
      ) : null}
    </section>
  );
}
```

- Treat values as read-only snapshots. Mutating event payloads breaks determinism.
- When you need the latest worker frame, rely on `runtime.lastSnapshot` rather than storing your own reference.
- Use the existing selectors or derive new data in memoised components—avoid extending the reducer unless the design explicitly calls for it.

## 3. Dispatch Commands Through the Bridge

`useShellBridge()` wraps `useWorkerBridge` with telemetry-aware helpers:

```tsx
const bridge = useShellBridge();

const handlePing = async () => {
  await bridge.awaitReady();
  bridge.sendCommand('PING', { issuedAt: performance.now() });
};
```

- Always call `awaitReady()` before the first command or social operation to honour the worker handshake. Failed awaits raise `ShellStateProviderAwaitReadyFailed`.
- For social operations, prefer `sendSocialCommand(kind, payload)`. The provider tracks optimistic state in `ShellState.social.pendingRequests` and records telemetry if the worker responds with domain-specific errors (`ShellStateProviderSocialCommandFailed`). Display `ShellState.social.lastFailure` to keep the operator informed.
- When gating UI on feature availability, use `bridge.isSocialFeatureEnabled()` rather than importing feature flags manually—this remains the single source of truth per [design §6.2](shell-state-provider-design.md#62-detailed-design).

## 4. Integrate Diagnostics

Diagnostics fan out to subscribers while the provider manages worker reference counting:

```tsx
const { latest, subscribe, isEnabled } = useShellDiagnostics();

useEffect(() => {
  if (isEnabled) {
    return;
  }
  const unsubscribe = subscribe((timeline) => {
    // Render charts or persist snapshots.
  });
  return unsubscribe;
}, [isEnabled, subscribe]);
```

- Subscribing automatically calls `bridge.enableDiagnostics()` when the first listener registers and disables diagnostics when the last listener unsubscribes (guarding the risk listed in [design §11](shell-state-provider-design.md#11-risks--mitigations)).
- Guard subscription callbacks; exceptions are reported as `ShellStateProviderDiagnosticsSubscriberError` with phase metadata.
- Access `latest` for immediate renders—`subscribe` emits the current timeline before the worker sends updates.

## 5. Migration Checklist

When upgrading an existing module:

1. Wrap the surface with `<ShellStateProvider>` (usually in `App.tsx`) and remove direct calls to `useWorkerBridge`.
2. Replace custom state stores with `useShellState()` selectors. Keep derived state colocated with components to avoid reintroducing shared mutable caches.
3. Swap manual telemetry hooks for the provider-managed versions—telemetry payload keys already match the design’s schema.
4. Confirm diagnostics panels use `useShellDiagnostics()` and drop obsolete bridge `enableDiagnostics()/disableDiagnostics()` wiring.
5. Update tests to mount the provider around components under test. Reuse helpers from `ShellStateProvider.telemetry.test.tsx` when mocking the worker.

This sequence mirrors the rollout plan in [design §12](shell-state-provider-design.md#12-rollout-plan) and the coordination guidance in [§7.3](shell-state-provider-design.md#73-coordination-notes).

## 6. Validation & Tooling

After changes:

```bash
pnpm lint --filter shell-web
pnpm test --filter shell-web
# Run when diagnostics or UI flows change per design guardrails.
pnpm test:a11y
```

- The Vitest suites (e.g., `ShellStateProvider.telemetry.test.tsx`) assert telemetry coverage promised in [design §6.2](shell-state-provider-design.md#62-detailed-design). Extend them if you introduce new reducer events or telemetry codes.
- Keep console output clean so the `vitest-llm-reporter` summary remains parseable.

If you uncover provider gaps (new reducer cases, telemetry fields, or diagnostics channels), document assumptions in your PR and sync with the Presentation Shell Lead—the acceptance criteria for Issue #285 require that review.

## 7. Reference Summary

| Topic | Source |
| --- | --- |
| Provider architecture, APIs, risks | [Shell State Provider Design](shell-state-provider-design.md) |
| Worker bridge contracts | [Runtime React Worker Bridge Design](runtime-react-worker-bridge-design.md) |
| Accessibility smoke expectations | [Accessibility Smoke Tests Design](accessibility-smoke-tests-design.md) |
| Existing provider usage | `packages/shell-web/src/modules/App.tsx`, `packages/shell-web/src/modules/EventInspector.tsx`, `packages/shell-web/src/modules/SocialDevPanel.tsx` |

Keep this guide updated as the provider evolves so future contributors inherit current integration practices.
