# Issue #61: Author Resource State Storage Design Document

**Stage:** Backlog  
**Workstream:** Runtime Core  
**Blocked by:** #7  
**Artifacts:** `docs/resource-state-storage-design.md`

## Summary

Capture the struct-of-arrays design for the runtime `ResourceState` container so
implementation work on issue #7 has an approved blueprint. The document must
explain data layout, mutation helpers, snapshot contracts, and integration plan
with the command queue and telemetry.

## Problem

- No canonical reference describes how resources are stored or mutated inside
  the runtime.
- Command handlers and systems lack a shared API for applying resource deltas,
  which risks divergent implementations.
- Presentation and persistence layers do not know what data to expect from
  resource snapshots, blocking UI wiring and save-game work.

## Scope

- Author `docs/resource-state-storage-design.md` outlining:
  - Typed array buffers and indexing strategy.
  - Mutation semantics (`add`, `spend`, `capacity`, visibility/unlock flags).
  - Snapshot and persistence contracts, including dirty-delta support.
  - Telemetry hooks and integration with existing runtime modules.
- Circulate the document for review and update per feedback.

## Definition of Done

- Design document merged with reviewer sign-off.
- Follow-up implementation steps and risks captured in the doc.
- Issue #7 is unblocked and references the finalized design.

## Out of Scope

- Writing the resource-state implementation or unit tests.
- Modifying existing command handlers or systems.
