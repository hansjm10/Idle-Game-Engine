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
- Lefthook hooks (`pnpm prepare`) to ensure lint, test, and build checks run
  locally before commits

## Pre-commit hooks

- Lefthook inspects staged files and only runs the commands they need:
  - `pnpm lint`, `pnpm typecheck`, and `pnpm build` fire when JavaScript/TypeScript
    workspace code or shared config changes.
  - `pnpm generate --check` runs for `content/**`, content tooling, and schema
    updates so packs stay fresh.
  - Runtime changes trigger `pnpm --filter @idle-engine/core run --if-present test:ci`.
  - Content pipeline changes trigger `pnpm --filter @idle-engine/content-compiler --filter @idle-engine/content-schema --filter @idle-engine/content-sample --filter @idle-engine/content-validation-cli run --if-present test:ci`.
  - The targeted markdown checks for `docs/content-dsl-usage-guidelines-design.md`
    remain unchanged.
- Typical warm-cache timings:
  - Docs-only commits finish in ~3s (doc lint only).
  - Core/runtime edits run lint/typecheck/build plus targeted Vitest in ≈17s.
  - Content pack/schema edits (including property-based tests) finish in ≈26s.
  - Forced full runs (`pnpm exec lefthook run pre-commit --all-files --force`)
    still execute the entire matrix (~3m40s) for comparison with CI.
- Optional fast pass: use `pnpm fast:check` or `pnpm exec lefthook run pre-commit-fast`
  to run cached linting plus `test:ci` scoped to affected packages. Use
  `FAST_SCOPE=staged` to scope to staged files only and `FAST_BASE_REF=<ref>` to
  compare against a different base. Fast checks are opt-in and do not replace the
  default pre-commit guardrails.
- `pnpm test:ci` runs workspace tests in parallel with `--no-sort` (tune with
  `TEST_CI_WORKSPACE_CONCURRENCY`); use `pnpm test:ci:serial` when you need
  topological ordering or easier debugging.
- Use `LEFTHOOK=0 git commit ...` sparingly when you must bypass hooks; CI still
  runs the full `pnpm test:ci` matrix and remains the ultimate gate.

## CI timing baseline

- Latest CI quality gate baseline (2025-12-24, run 20479903522): workflow
  completed in ~5m06s on `ubuntu-latest` with lint, typecheck, build (except
  docs), generate, coverage, and `pnpm test:ci`.
- Docs build runs in the Docs Preview workflow for PRs that touch docs and in
  Docs Deploy for `main` when docs content changes.
- When you make changes that affect CI duration, record before/after numbers in
  the issue and update this baseline if the steady-state timing changes.

## Repository layout

- `packages/core` — deterministic runtime, command queue, telemetry
- `packages/content-*` — declarative content DSL and sample packs
- `tools/` — validation CLIs and development helpers
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
```

We use `vitest-llm-reporter`, so test runs print a final JSON object. Avoid extra
console output around that summary to keep downstream tooling happy.

## Coding style

### Type-only imports and exports

- Always mark symbols that only exist during type-checking with `import type` / `export type`. The ESLint preset (`@idle-engine/config-eslint`) enforces [issue #366](https://github.com/hansjm10/Idle-Game-Engine/issues/366), so mixing runtime and type-only imports on the same line will fail lint.
- Keep runtime values in a dedicated `import { ... }` statement and put types in a separate `import type { ... }` statement so bundlers such as Vite/esbuild do not attempt to load phantom exports and break hot reloads.
- When you create a new `tsconfig`, carry over `verbatimModuleSyntax: true` and `preserveValueImports: true` (see [issue #367](https://github.com/hansjm10/Idle-Game-Engine/issues/367)) so TypeScript preserves the explicit syntax instead of rewriting the statements during emit.

```ts
// ✅ Do: value imports stay live, types are marked as such.
import { useEffect } from 'react';
import type { ResourceDefinition } from '@idle-engine/core';

export type { ResourceDefinition } from '@idle-engine/core';

export function useResource(def: ResourceDefinition) {
  useEffect(() => {
    /* ... */
  }, [def.id]);
}
```

```ts
// 🚫 Don't: bundlers will expect a runtime ResourceDefinition export.
import { useEffect, ResourceDefinition } from '@idle-engine/core';

export { ResourceDefinition } from '@idle-engine/core';
```

The deterministic runtime never ships type metadata, so the “don’t” example
will surface `ResourceDefinition is not exported` errors at runtime even though
TypeScript accepts the code. Following the explicit type-only pattern keeps Vite
and esbuild aligned with `tsc`, avoids unused import churn, and documents intent
for future contributors skimming barrel files.

### Regenerate coverage report

- Run `pnpm coverage:md` from the repository root after changing tests. The command executes coverage-enabled Vitest suites for every package and rewrites `docs/coverage/index.md`.
- Commit the updated `docs/coverage/index.md` file alongside your code so CI stays in sync with the documentation site.
- The generated page surfaces under **Diagnostics & Quality → Coverage Report** in the Docusaurus sidebar.

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

## Documentation Infrastructure

- [Documentation Hosting Recommendation](docs-hosting-recommendation.md) - Evaluation and recommendation for hosting the public documentation site

## Pull request expectations

- Follow Conventional Commit prefixes (`feat:`, `fix:`, `chore:`…)
- Include test commands executed (Vitest filters, etc.)
- Note known gaps so follow-up work is clear to reviewers

Questions? Start a discussion on the issue tracker or tag the feature owner
listed in the relevant design doc.
