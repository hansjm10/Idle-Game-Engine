---
title: Role Index
sidebar_position: 3
---

# Role Index

Find the entry point that matches how you interact with the Idle Engine. Each
section links to the primary design documents and implementation spots you will
touch most often.

## Runtime contributors

- Read `docs/idle-engine-design.md` for the overall architecture.
- Dive into queue and lifecycle docs:
  - `docs/runtime-command-queue-design.md`
  - `docs/runtime-step-lifecycle.md`
  - `docs/tick-accumulator-coverage-design.md`
  - `docs/diagnostic-timeline-design.md`
- Implementation hotspots live in `packages/core/src/`; refer to the colocated
  `*.test.ts` files for current coverage.

## Content pipeline authors

- Start with `docs/content-dsl-schema-design.md` to understand the DSL.
- Review `docs/content-compiler-design.md` and
  `docs/content-validation-cli-design.md` before editing
  `packages/content-compiler`.
- Use `packages/content-sample/README.md` for generator commands and regenerate
  artifacts with `pnpm generate`.

## Shell & UX engineers

- `docs/accessibility-smoke-tests-design.md` outlines the Playwright suites.
- `packages/shell-web/README.md` documents local dev commands and Vite setup.
- When integrating new runtime events, consult
  `docs/runtime-event-manifest-authoring.md` and the generated manifest exports
  in `@idle-engine/core`.

## Tooling & operations

- `docs/project-board-workflow.md` describes backlog triage.
- `docs/implementation-plan.md` tracks roadmap workstreams.
- `docs/design-document-template.md` standardises future proposals and
  outlines the migration checklist for legacy docs.
- Service experiments in `services/` should cross-reference
  `docs/resource-state-storage-design.md` and
  `docs/runtime-event-bus-decisions.md` for data contract expectations.
