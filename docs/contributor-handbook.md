---
title: Contributor Handbook
sidebar_position: 2
---

# Contributor Handbook

This guide covers day-to-day development in the Idle Engine monorepo. Pair it
with the design documents linked throughout when you need deeper architectural
context.

## Prerequisites

- Node.js ≥20.10 (matches the docs site requirement; stay on the 20.x LTS stream)
- pnpm ≥8 (we track the exact version in `packageManager` inside `package.json`)
- Playwright system dependencies (`pnpm exec playwright install-deps`) on fresh
  Linux hosts before running accessibility smoke tests
- Lefthook hooks (`pnpm prepare`) to ensure lint, test, and build checks run
  locally before commits

## Repository layout

- `packages/core` — deterministic runtime, command queue, telemetry
- `packages/shell-web` — Vite/React shell that embeds the runtime worker
- `packages/content-*` — declarative content DSL and sample packs
- `services/` — backend experiments (leaderboards, guild services, auth)
- `tools/` — validation CLIs, a11y harnesses, and development helpers
- `docs/` — design documents and the source for this documentation site

See `docs/implementation-plan.md` for the current roadmap and open milestones.

## Common workflows

```bash
# install dependencies
pnpm install

# run the entire test matrix
pnpm test

# focused package scripts
pnpm --filter @idle-engine/core test
pnpm --filter @idle-engine/shell-web dev

# run accessibility smoke tests (headless)
pnpm test:a11y
```

We use `vitest-llm-reporter`, so test runs print a final JSON object. Avoid extra
console output around that summary to keep downstream tooling happy.

## Documentation contributions

- Add or update design docs alongside code changes.
- Reference the relevant doc in your PR description (`docs/runtime-step-lifecycle.md`
  for lifecycle updates, etc.).
- Keep sections deterministic by including reproduction steps or validation
  commands (`pnpm test --filter <pkg>`).
- Draft new proposals using `docs/design-document-template.md` and migrate older
  specs into that format when making substantial edits.
- When editing `docs/content-dsl-usage-guidelines-design.md`, run
  `pnpm --filter @idle-engine/docs lint` (or the underlying
  `pnpm exec markdownlint` / `markdown-link-check` commands) so the markdownlint
  and link checks pass locally; Lefthook enforces the same guardrails pre-commit.
- Propose substantial architecture changes through the RFC process described in
  `docs/implementation-plan.md`.

## Pull request expectations

- Follow Conventional Commit prefixes (`feat:`, `fix:`, `chore:`…)
- Include test commands executed (Vitest filters, `pnpm test:a11y`, etc.)
- Attach screenshots or recordings when touching `packages/shell-web`
- Note known gaps so follow-up work is clear to reviewers

Questions? Start a discussion on the issue tracker or tag the feature owner
listed in the relevant design doc.
