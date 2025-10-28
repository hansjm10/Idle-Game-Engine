# Idle Engine Monorepo

This repository hosts the idle-game engine, reference content packs, presentation shells, and supporting services described in `docs/idle-engine-design.md`.

## Structure
- `packages/` – core runtime and client-facing packages.
- `services/` – backend services (leaderboards, guilds, auth integrations).
- `tools/` – developer tooling such as content validators and simulation CLIs.
- `docs/` – design documents and technical specs.

Refer to the design document for roadmap and subsystem detail.

## Testing
- `pnpm test:a11y` runs the Playwright-based accessibility smoke suite against the web shell. Additional Playwright flags can be forwarded when debugging locally, but the interactive UI mode is disabled.
- `pnpm test --filter shell-web` scopes Vitest to the web shell worker bridge and presentation infrastructure; run this after touching diagnostics or bridge logic so the issue #255 coverage stays green.
- On fresh Linux environments you might need to install Playwright system dependencies once via `pnpm exec playwright install-deps`.
- Vitest suites inherit the shared `@idle-engine/config-vitest` defaults, which now include `vitest-llm-reporter` with streaming disabled. Each run prints a JSON summary block at the end of the output so AI agents and CI jobs can parse results without scraping console text.

## Content Validation & Generation
- `pnpm generate` now runs content validation before the compiler writes artifacts. Schema failures stop the pipeline immediately, so fix validation errors before retrying or the downstream artifacts will remain stale.
- Structured JSON logs (`content_pack.validated`, `content_pack.compiled`, `content_pack.validation_failed`, `watch.run`, etc.) stream to stdout. Use `--pretty` only when you want human-readable formatting; automation should consume the default JSON lines.
- Run `pnpm generate --check` (used by CI and Lefthook) to detect drift without rewriting artifacts. The command exits with code `1` when `content/compiled/` or manifest outputs would change, or when validation persists failure summaries.
- `pnpm generate --watch` keeps the validator/compiler pipeline running against content changes. Each iteration emits a `watch.run` summary describing duration, triggers, and outcome while leaving the process alive after failures.
- `content/compiled/index.json` is the canonical workspace summary. Consumers should always read this file (or override `--summary`) and treat it as stale if you skipped validation or the CLI reported failures—rerun `pnpm generate` to refresh it before consuming compiled artifacts.
