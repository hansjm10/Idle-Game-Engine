# Economy Verification CLI

Wraps the runtime verification helpers from `@idle-engine/core` to project plausible currency deltas over a bounded offline window.

## Usage

Run with a snapshot (an `EconomyStateSummary` JSON) plus either `--ticks` or `--offline-ms`:

```
pnpm --silent core:economy-verify --snapshot path/to/snapshot.json --ticks 40
```

Options:
- `--snapshot <file>`: required snapshot JSON built via `buildEconomyStateSummary`.
- `--ticks <n>`: number of ticks to simulate; if omitted, derive from `--offline-ms / stepSizeMs`.
- `--offline-ms <ms>`: offline duration; converted to ticks when `--ticks` is absent.
- `--definitions <file>`: optional resource definitions (array, `{ resources }`, or `{ modules.resources }`). Defaults to `@idle-engine/content-sample` resources.
- `--include-diagnostics`: include diagnostic timeline in the JSON output.

The CLI silences telemetry and emits a single JSON object on stdout; use `pnpm --silent` (as above) or invoke directly via `node --import tsx tools/economy-verification/src/index.ts ...` when piping output to automation.

## Fixtures

`./__fixtures__/snapshot.json` and `./__fixtures__/definitions.json` demonstrate the expected input shapes and power the automated test coverage. Snapshots with mismatched resource digests surface via the `reconciliation` field in the JSON report.
