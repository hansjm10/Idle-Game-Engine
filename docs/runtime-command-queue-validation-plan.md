# Runtime Command Queue Validation Tracker

Issue: GH#49 (parent GH#6) — alignment with `docs/runtime-command-queue-design.md` §§11–16.

## Scope Recap
- Ensure testing, rollout, and follow-up work for the runtime command queue matches the design doc.
- Provide a living checklist that can be linked from status updates on GH#6.
- Capture verification evidence (tests, telemetry) plus outstanding risks or follow-up actions.

## §11 Test Coverage
- [x] **Unit** — priority and ordering guarantees covered by `packages/core/src/command-queue.test.ts:60` and the new high-volume regression at `packages/core/src/command-queue.test.ts:112`.
- [x] **Unit** — dispatcher authorization/telemetry at `packages/core/src/command-dispatcher.test.ts:1`.
- [x] **Integration** — runtime/queue sequencing exercised via `packages/core/src/index.test.ts:1` (IdleEngineRuntime) and worker bridge flow in `packages/shell-web/src/runtime.worker.test.ts:1`.
- [x] **Replay** — determinism, immutability, and RNG restoration validated by `packages/core/src/command-recorder.test.ts:144`.
- [ ] **Replay fixtures for external consumers** — TODO: publish reusable sample logs per §11.3 (pending owner).

## §12 Execution Checklist

| Task | Status | Notes |
| --- | --- | --- |
| 12.1 Implement CommandQueue data structure | ✅ | `packages/core/src/command-queue.ts:1`, unit coverage listed above. |
| 12.1 Implement CommandDispatcher | ✅ | `packages/core/src/command-dispatcher.ts:1`. |
| 12.1 Define command payloads | ✅ | `packages/core/src/command.ts:1`. |
| 12.1 Write queue ordering tests | ✅ | See §11 bullets. |
| 12.2 Integrate queue into tick loop | ✅ | `packages/core/src/index.ts:1` with coverage at `packages/core/src/index.test.ts:1`. |
| 12.2 Implement purchase/toggle handlers | 🟡 | Not yet present in repo; follow-up issue required (design references §5). |
| 12.2 Worker bridge for incoming cmds | ✅ | `packages/shell-web/src/runtime.worker.ts:1`, tests at `packages/shell-web/src/runtime.worker.test.ts:1`. |
| 12.2 End-to-end command flow tests | ✅ | Runtime + worker suites noted in §11. |
| 12.3 Implement CommandRecorder | ✅ | `packages/core/src/command-recorder.ts:1` + tests. |
| 12.3 Validation layer & error handling | 🟡 | Queue/dispatcher emit telemetry (`packages/core/src/command-queue.ts:62`, `packages/core/src/command-dispatcher.ts:58`), but handler-level guards are still TODO (design §10/§12.3). |
| 12.3 Queue capacity / overflow | ✅ | Max size enforcement in `packages/core/src/command-queue.ts:62`, tests at `packages/core/src/command-queue.test.ts:414`. |
| 12.3 Document command API contracts | 🔴 | Missing artifact; recommended follow-up doc or README update. |

Legend: ✅ complete · 🟡 partially complete · 🔴 not started.

## §13 Success Criteria Status
- **Determinism** — ✅ `packages/core/src/command-recorder.test.ts:144` restores snapshots and matches live state.
- **Priority guarantees (1000+)** — ✅ regression at `packages/core/src/command-queue.test.ts:112` plus runtime tick test `packages/core/src/index.test.ts:381`.
- **Performance (<5% overhead @60Hz)** — 🔴 Pending profiling; no benchmarks checked in.
- **Integration with React shell** — 🟡 Worker bridge validated (`packages/shell-web/src/runtime.worker.test.ts:1`), but shell UI assertions still TODO once React components consume queue.
- **Observability metrics** — 🟡 Telemetry hooks exist (`packages/core/src/telemetry.ts:1`, queue overflow logs at `packages/core/src/command-queue.test.ts:414`), but dashboards/export pending.

## §14 Future Enhancements (Follow-ups)
- Conditional/Macro commands — log potential backlog item; depends on handler implementation (`design §14`, owner TBD).
- Network sync & rollback — requires recorder APIs for serialization; capture under future milestone (#6 follow-up).
- Compression & telemetry dashboards — coordinate with observability squad; note dependency on metrics plumbing.

## §15 Resolved Decisions (Reference)
- Automation prestige guard enforced in queue (`packages/core/src/command-queue.test.ts:896`) and dispatcher (`packages/core/src/command-dispatcher.test.ts:93`).
- RNG seed capture/restoration validated in recorder (`packages/core/src/command-recorder.test.ts:423`), aligns with design decision.

## §16 References & Dependencies
- `docs/runtime-command-queue-design.md`
- `docs/runtime-step-lifecycle.md`
- GH#6 for milestone roll-up
- Pending issues: “Implement purchase/toggle handlers”, “Document command API contracts”, “Performance profiling for queue”, “Shell integration tests”.
