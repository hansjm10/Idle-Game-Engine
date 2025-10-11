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
- On fresh Linux environments you might need to install Playwright system dependencies once via `pnpm exec playwright install-deps`.
- Vitest suites inherit the shared `@idle-engine/config-vitest` defaults, which now include `vitest-llm-reporter` with streaming disabled. Each run prints a JSON summary block at the end of the output so AI agents and CI jobs can parse results without scraping console text.
