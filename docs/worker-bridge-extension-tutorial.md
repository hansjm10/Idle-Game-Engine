---
title: Worker Bridge Extension Tutorial
description: Walkthrough for adding a custom runtime command that flows from React through the worker bridge into the deterministic runtime.
---

# Worker Bridge Extension Tutorial

Create the developer tutorial promised in [docs/runtime-react-worker-bridge-design.md §14.2](runtime-react-worker-bridge-design.md#142-remaining-items) so contributors can extend the runtime→React worker bridge with confidence. This guide anchors every step back to the design doc for issue #16 and highlights the code you will touch when shipping a new command end-to-end.

## Before You Start

- Read the worker bridge design, especially [§6.2 Detailed Design](runtime-react-worker-bridge-design.md#62-detailed-design) for the message contract and [§10 Testing & Validation Plan](runtime-react-worker-bridge-design.md#10-testing--validation-plan) for required checks.
- Confirm your workspace is synced with `pnpm install` (Node ≥20.10, pnpm ≥8) and that `pnpm lint` and `pnpm test` pass on `main`.
- Keep `packages/shell-web/src/modules/worker-bridge.ts` and `packages/shell-web/src/runtime.worker.ts` open—most bridge changes live there.
- When UI surfaces change, plan to run `pnpm test:a11y` as called out in the [Accessibility smoke test design](accessibility-smoke-tests-design.md).

## 1. Map the Bridge Contract

The worker bridge enforces a discriminated union of messages. Before adding anything new:

1. Inspect `packages/shell-web/src/modules/worker-bridge.ts` (`WorkerBridge.sendCommand`) to see how UI payloads are wrapped with `source`, `requestId`, and the `WORKER_MESSAGE_SCHEMA_VERSION`.
2. Review the command validation path inside `packages/shell-web/src/runtime.worker.ts` (`handleCommandMessage`, replay protection, and error telemetry). This code implements the READY/ERROR handshake and schema guardrails described in [§6.2](runtime-react-worker-bridge-design.md#62-detailed-design).
3. Decide whether your command belongs to the core runtime (`@idle-engine/core`) or a feature module. The worker simply enqueues commands; the runtime is responsible for registering handlers and publishing events.

Document the command intent and payload shape up front—future agents rely on these notes when auditing bridge changes.

## 2. Define the Runtime Command

The runtime owns canonical command definitions. Add a new payload type, identifier, and handler under `packages/core` so the bridge can dispatch it deterministically.

```ts title="packages/core/src/command.ts"
export const RUNTIME_COMMAND_TYPES = Object.freeze({
  PURCHASE_GENERATOR: 'PURCHASE_GENERATOR',
  TOGGLE_GENERATOR: 'TOGGLE_GENERATOR',
  COLLECT_RESOURCE: 'COLLECT_RESOURCE',
  PRESTIGE_RESET: 'PRESTIGE_RESET',
  OFFLINE_CATCHUP: 'OFFLINE_CATCHUP',
  APPLY_MIGRATION: 'APPLY_MIGRATION',
  GRANT_RESOURCE_BONUS: 'GRANT_RESOURCE_BONUS',
} as const);

export interface GrantResourceBonusPayload {
  readonly resourceId: string;
  readonly amount: number;
  readonly reason?: string;
}

export interface RuntimeCommandPayloads {
  readonly PURCHASE_GENERATOR: PurchaseGeneratorPayload;
  readonly TOGGLE_GENERATOR: ToggleGeneratorPayload;
  readonly COLLECT_RESOURCE: CollectResourcePayload;
  readonly PRESTIGE_RESET: PrestigeResetPayload;
  readonly OFFLINE_CATCHUP: OfflineCatchupPayload;
  readonly APPLY_MIGRATION: ApplyMigrationPayload;
  readonly GRANT_RESOURCE_BONUS: GrantResourceBonusPayload;
}
```

With the payload in place, register a handler so the dispatcher knows how to execute it. This example wires directly into the existing resource helpers, but your feature may live elsewhere:

```ts title="packages/core/src/resource-command-handlers.ts"
dispatcher.register<GrantResourceBonusPayload>(
  RUNTIME_COMMAND_TYPES.GRANT_RESOURCE_BONUS,
  (payload, context) => {
    if (!Number.isFinite(payload.amount) || payload.amount <= 0) {
      telemetry.recordError('ResourceBonusInvalidAmount', {
        resourceId: payload.resourceId,
        amount: payload.amount,
        step: context.step,
      });
      return;
    }

    const index = resources.requireIndex(payload.resourceId);
    resources.addAmount(index, payload.amount);

    telemetry.recordProgress('ResourceBonusGranted', {
      resourceId: payload.resourceId,
      amount: payload.amount,
      reason: payload.reason,
      step: context.step,
    });
  },
);
```

Update or create Vitest coverage so the new dispatcher path is enforced (see `packages/core/src/resource-command-handlers.test.ts` for patterns). The runtime design mandates deterministic behaviour, so tests should assert ordering, validation, and telemetry.

> **Design doc tie-back:** This work satisfies “Publish an authoritative Worker message contract” and “Ship reusable bridge surfaces” from [§3 Goals](runtime-react-worker-bridge-design.md#3-goals--non-goals) by keeping type information centralised in `@idle-engine/core`.

## 3. Allow the Worker to Enqueue the Command

The worker already enqueues any `COMMAND` payloads that pass validation, but you should double-check whether additional safeguards are needed:

- If the command must run with a different priority (e.g., automation/system), set the `source` accordingly when you call `sendCommand`, or adjust the worker enqueue logic near `handleCommandMessage` in `packages/shell-web/src/runtime.worker.ts` to map known command identifiers to alternate `CommandPriority` values.
- Validate that `WORKER_MESSAGE_SCHEMA_VERSION` remains unchanged. If you add new envelope fields, bump the version and extend the discriminated union in `packages/shell-web/src/modules/runtime-worker-protocol.ts` per [§6.2 Data & Schemas](runtime-react-worker-bridge-design.md#62-detailed-design).
- Extend the worker Vitest suite (`packages/shell-web/src/runtime.worker.test.ts`) with a case exercising your new command. Follow the replay-protection and schema tests that reference `'PING'` for guidance.

When the worker needs to respond with additional data (for example, command-specific errors), update the `RuntimeWorkerOutboundMessage` union and emit the new envelope from the worker so the bridge can surface it to React.

## 4. Send and Observe the Command from React

React components interact with the worker through `useWorkerBridge`. The tutorial example adds a button that boosts a generator; adjust the payload to match your own feature.

```tsx title="packages/shell-web/src/modules/App.tsx"
const bridge = useWorkerBridge();

const handleGrantBonus = async () => {
  await bridge.awaitReady();
  bridge.sendCommand(RUNTIME_COMMAND_TYPES.GRANT_RESOURCE_BONUS, {
    resourceId: selectedResourceId,
    amount: 150,
    reason: 'tutorial-demo',
  });
};

return (
  <button type="button" onClick={handleGrantBonus}>
    Grant Bonus Resource
  </button>
);
```

If you need to surface responses, register an `onStateUpdate` or `onError` callback:

```ts
useEffect(() => {
  const handleError = (error: RuntimeWorkerErrorDetails) => {
    if (error.code === 'INVALID_COMMAND_PAYLOAD') {
      toast.error(error.message);
    }
  };

  bridge.onError(handleError);
  return () => bridge.offError(handleError);
}, [bridge]);
```

> **Diagnostics:** For features that ship diagnostics, wire `enableDiagnostics` / `onDiagnosticsUpdate` to capture performance data as described in [§6.2 APIs & Contracts](runtime-react-worker-bridge-design.md#62-detailed-design).

## 5. Validate the Extension

When the implementation is complete, run the full validation checklist referenced in the issue:

```bash
pnpm lint
pnpm test --filter shell-web
pnpm test --filter core
# Required when UI flows change
pnpm test:a11y
```

- Keep the `vitest-llm-reporter` JSON footer intact—avoid extra console output.
- If your command modifies the UI, capture screenshots or recordings for the Presentation Shell review.
- Update documentation and tests alongside code so future agents inherit a working baseline.

## Troubleshooting

| Symptom | Likely Cause | Remediation |
| --- | --- | --- |
| `WorkerBridge` rejects the command with `INVALID_COMMAND_PAYLOAD` | Payload is missing required fields or `issuedAt` is not finite | Inspect the React call site and ensure payload matches the runtime type definition. |
| Worker logs `SCHEMA_VERSION_MISMATCH` | Bridge and worker disagree on `WORKER_MESSAGE_SCHEMA_VERSION` | Bump the version and regenerate all envelopes per [§6.2](runtime-react-worker-bridge-design.md#62-detailed-design); confirm UI and worker bundles rebuilt. |
| Commands appear to hang during session restore | `restoreSession` is pending and the bridge queues messages | Await `bridge.restoreSession()` before issuing commands or ensure the worker emits `SESSION_RESTORED`. |
| Runtime executes command out of order | Command priority or replay guard misconfigured | Verify `source` and `CommandPriority` mapping, and expand tests in `runtime.worker.test.ts` to cover the new path. |

## Next Steps

- Submit the change for review by the Presentation Shell lead, referencing this tutorial and the design doc in your PR summary.
- Record any follow-up work (additional diagnostics, UX polish) in new issues linked from the tutorial so future contributors can iterate.
