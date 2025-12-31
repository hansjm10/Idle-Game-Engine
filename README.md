# Idle Engine Monorepo

This repository hosts the idle-game engine, reference content packs, presentation shells, and supporting tooling described in `docs/idle-engine-design.md`.

## Environment
- Node: 22.20.0 (pinned for deterministic coverage). Run `nvm use` from the repo root to adopt the version from `.nvmrc`.
- pnpm: 10.18.1 or newer (see `packageManager` field). Install via `corepack enable` or your package manager.

## Structure
- `packages/` – core runtime and client-facing packages.
- `tools/` – developer tooling such as content validators and simulation CLIs.
- `docs/` – design documents and technical specs.

Refer to the design document for roadmap and subsystem detail.

## Content Authoring Docs
- `docs/content-dsl-usage-guidelines.md` – end-to-end authoring guide with field tables and examples.
- `docs/content-quick-reference.md` – condensed cheatsheet for content types, conditions, and formulas.
- `docs/examples/` – validated example packs referenced by the guides.

## Testing
- Vitest suites inherit the shared `@idle-engine/config-vitest` defaults, which now include `vitest-llm-reporter` with streaming disabled. Each run prints a JSON summary block at the end of the output so AI agents and CI jobs can parse results without scraping console text.
- `pnpm coverage:md` runs coverage-enabled Vitest suites for every package and writes `docs/coverage/index.md`. Commit the updated file after running the command so the docs build stays green. For consistent results with CI, run `nvm use` before generating coverage.
- For a fast local pass, use `pnpm fast:check`. It runs cached linting plus `test:ci` for packages inferred from `git diff` against `origin/main`. Use `FAST_SCOPE=staged` to scope to staged files only and `FAST_BASE_REF=<ref>` to compare against a different base.

## Benchmarks
- `pnpm benchmark` runs workspace benchmarks; pass pnpm filters like `--filter @idle-engine/core` and forward benchmark args after `--`.
- To validate trailing JSON output, pipe the logs into `node tools/scripts/assert-json-tail.mjs` (schema in `docs/benchmark-output-schema.md`).

```
pnpm benchmark --filter @idle-engine/core | node tools/scripts/assert-json-tail.mjs
```

## Content Validation & Generation
- `pnpm generate` now runs content validation before the compiler writes artifacts. Schema failures stop the pipeline immediately, so fix validation errors before retrying or the downstream artifacts will remain stale.
- Structured JSON logs (`content_pack.validated`, `content_pack.compiled`, `content_pack.validation_failed`, `watch.run`, etc.) stream to stdout. Use `--pretty` only when you want human-readable formatting; automation should consume the default JSON lines.
- Run `pnpm generate --check` (used by CI and Lefthook) to detect drift without rewriting artifacts. The command exits with code `1` when `content/compiled/` or manifest outputs would change, or when validation persists failure summaries.
- `pnpm generate --watch` keeps the validator/compiler pipeline running against content changes. Each iteration emits a `watch.run` summary describing duration, triggers, and outcome while leaving the process alive after failures.
- `content/compiled/index.json` is the canonical workspace summary. Consumers should always read this file (or override `--summary`) and treat it as stale if you skipped validation or the CLI reported failures—rerun `pnpm generate` to refresh it before consuming compiled artifacts.

## Headless Diagnostics (Tick Simulator)

Run a deterministic simulation of the runtime and emit diagnostics JSON:

```
pnpm core:tick-sim --ticks 1000 --step-ms 100 --fail-on-slow --queue-backlog-cap 0
```

Options:
- `--ticks <n>`: Number of ticks to execute (required)
- `--step-ms <ms>`: Fixed step duration (default 100)
- `--max-steps-per-frame <n>`: Clamp steps per frame (default 50)
- `--fail-on-slow`: Exit non-zero if any tick exceeds the configured budget
- `--queue-backlog-cap <n>`: Exit non-zero if queue backlog exceeds `n`

## Economy Verification CLI

Project maximum plausible currency deltas from an economy snapshot:

```
pnpm --silent core:economy-verify --snapshot tools/economy-verification/__fixtures__/snapshot.json --ticks 40
```

Flags:
- `--snapshot <file>`: EconomyStateSummary JSON (required).
- `--ticks <n>`: Tick count to simulate; omit and use `--offline-ms` to derive from offline duration.
- `--offline-ms <ms>`: Offline duration converted to ticks with `stepSizeMs`.
- `--definitions <file>`: Optional resource definitions (defaults to `@idle-engine/content-sample` resources).
- `--include-diagnostics`: Include diagnostic timeline in the JSON payload.

Use `pnpm --silent` (as above) or call `node --import tsx tools/economy-verification/src/index.ts ...` when piping stdout into automation to keep the output to a single JSON object.

## Code Quality (SonarCloud)

This project uses [SonarCloud](https://sonarcloud.io/) for continuous code quality analysis:

- **Configuration**: `sonar-project.properties` in project root
- **CI integration**: Runs automatically after tests in the quality-gate workflow
- **Coverage**: LCOV files from each package are sent to SonarCloud

The SonarCloud scan runs in CI after `pnpm coverage:md` generates coverage data. Each package outputs LCOV to `<package>/coverage/lcov.info`.
