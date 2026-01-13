---
title: Testing Guidelines
sidebar_position: 4
---

# Testing Guidelines

These guidelines keep Vitest suites deterministic, easy to navigate, and safe to
run in parallel across the pnpm workspace.

## Where tests live

- **Default**: co-locate `*.test.ts` next to the implementation under
  `packages/<pkg>/src/`.
- **Large suites**: place related files under `packages/<pkg>/src/__tests__/`,
  grouped by subsystem (for example, `packages/core/src/__tests__/progression-coordinator/`).

## Organization patterns

- Prefer multiple small files over single multi-thousand-line suites.
- Split by concern (trigger evaluation vs. integration wiring vs. edge cases).
- Keep each test file under **1,500 lines** so failures are easy to isolate and
  review diffs stay tractable.

## Fixtures & helpers

- Put suite-specific helpers next to the suite (for example,
  `packages/core/src/__tests__/automation-system/`).
- Put helpers shared across multiple suites in `packages/core/src/__tests__/helpers/`.
- Prefer pure helpers that return fresh objects to avoid cross-test shared state.

## Determinism & output

- Avoid wall-clock time (`Date.now`) and non-seeded randomness (`Math.random`)
  inside runtime tests.
- Do not add `console.*` noise in tests; CI consumes machine-readable Vitest
  output (`vitest-llm-reporter`).

## Running tests

- While iterating: `pnpm test --filter @idle-engine/core`
- Full workspace: `pnpm test`
- After changing tests: regenerate coverage docs via `pnpm coverage:md` (updates
  `docs/coverage/index.md`).
