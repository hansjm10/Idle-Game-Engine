---
title: Runtime Event Manifest Authoring
---
# Runtime Event Manifest Authoring
Use this document to understand how content packs extend the runtime event catalogue through offline manifests and how to maintain event-types.json files correctly.
## Document Control
- **Title**: Runtime Event Manifest Authoring
- **Authors**: N/A
- **Reviewers**: N/A
- **Status**: Approved
- **Last Updated**: 2025-12-21
- **Related Issues**: N/A
- **Execution Mode**: Manual
## 1. Summary
Content packs extend the runtime event catalogue through offline manifests (`event-types.json`) that are merged during the `pnpm generate` build step. This document defines the contract for pack maintainers and the guarantees enforced by the build tooling to ensure runtime event systems function correctly.
## 2. Context & Problem Statement
- **Background**: The Idle Engine runtime event system requires a deterministic catalogue of event types across core and content packages. Events are versioned, schema-validated, and assigned channel numbers for the event bus. The manifest hash is embedded in event frames for replay validation.
- **Problem**: Content pack maintainers must understand how to correctly author and maintain event-types.json manifests. Accidental deletion or misconfiguration causes runtime crashes when automations attempt to register event listeners.
- **Forces**: Build-time generation must remain deterministic. The manifest hash must be stable across builds to support command recording and replay. Content packs must be able to evolve event schemas without breaking existing automations.
## 3. Goals & Non-Goals
- **Goals**:
  1. Define the manifest layout and required fields for content pack event definitions.
  2. Document the generation workflow and what gets regenerated.
  3. Explain the critical requirement to maintain event-types.json files.
  4. Describe validation steps to verify correct generation.
  5. Clarify the outputs and how they are consumed by the runtime.
- **Non-Goals**:
  - Implementation details of the FNV-1a hashing algorithm.
  - Internal architecture of the event bus or command recorder.
  - Migration strategies for changing existing event schemas.
## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**: Content pack maintainers, core runtime developers.
- **Agent Roles**: N/A (Manual authoring workflow).
- **Affected Packages/Services**:
  - `packages/core` (runtime-event-manifest.generated.ts, event channels)
  - All content packages with event-types.json manifests
  - `tools/content-schema-cli` (generator tooling)
- **Compatibility Considerations**: Event version numbers must be bumped when payload compatibility changes. The manifest hash ensures runtime/manifest alignment.
## 5. Current State
Content packs define runtime events in `pack.json` and ship a corresponding `content/event-types.json` manifest. The generator (`pnpm generate`) merges these manifests into a single runtime catalogue with deterministic ordering by `(packSlug, namespace:name)`. The FNV-1a manifest hash is embedded in event frames for replay validation. Generated outputs include `runtime-event-manifest.generated.ts` with type-safe event identifiers, channel configurations, and schema references.
## 6. Proposed Solution
### 6.1 Architecture Overview
- **Narrative**: Content packs author event-types.json manifests describing their event types. The build tooling merges these with core events, generates TypeScript definitions, and computes a deterministic manifest hash. The runtime uses these outputs to configure the event bus and validate recorded event frames.
- **Diagram**: N/A
### 6.2 Detailed Design
- **Runtime Changes**: N/A (describes existing authoring workflow).
- **Data & Schemas**: Each manifest entry contains `namespace`, `name`, `version`, and `schema` (path to JSON Schema file). Entries are grouped by `packSlug`.
- **APIs & Contracts**:
  - `ContentRuntimeEventType` extends core `RuntimeEventType` union
  - `CONTENT_EVENT_CHANNELS` provides event bus channel configurations
  - `GENERATED_RUNTIME_EVENT_DEFINITIONS` lists merged catalogue with metadata
- **Tooling & Automation**: `pnpm generate` merges manifests, generates TypeScript, and computes manifest hash.
### 6.3 Operational Considerations
- **Deployment**: N/A (build-time tooling).
- **Telemetry & Observability**: Runtime fails fast with guidance to rerun `pnpm generate` if manifest hash mismatches.
- **Security & Compliance**: N/A
## 7. Work Breakdown & Delivery Plan
### 7.1 Issue Map
N/A (authoring guide for existing workflow).
### 7.2 Milestones
N/A
### 7.3 Coordination Notes
N/A
## 8. Agent Guidance & Guardrails
- **Context Packets**: N/A
- **Prompting & Constraints**: N/A
- **Safety Rails**:
  - **Critical**: Do not delete `content/event-types.json` from content packs that define runtime events in `pack.json`. Deletion causes runtime crashes when automations register listeners.
  - Always run `pnpm generate` after updating event manifests or schemas.
  - Commit all regenerated outputs including `runtime-event-manifest.generated.ts` and core dist updates.
- **Validation Hooks**:
  - Verify `CONTENT_EVENT_DEFINITIONS` includes your events after generation.
  - Verify `CONTENT_EVENT_CHANNELS` includes channel configurations.
  - Run `pnpm --filter @idle-engine/core test` to confirm manifest hash is recognized.
  - Check tests in `packages/core/src/events/__tests__/content-event-channels.test.ts` pass.
## 9. Alternatives Considered
N/A
## 10. Testing & Validation Plan
- **Unit / Integration**: After running `pnpm generate`, verify that:
  - `CONTENT_EVENT_DEFINITIONS` includes your events
  - `CONTENT_EVENT_CHANNELS` includes channel configurations for your events
  - Tests in `packages/core/src/events/__tests__/content-event-channels.test.ts` pass
- **Performance**: N/A
- **Tooling / A11y**: N/A
## 11. Risks & Mitigations
- **Risk**: Accidental deletion of `event-types.json` causes runtime crashes that only manifest when automations try to register listeners.
  - **Mitigation**: Document the critical requirement prominently. Provide validation steps to check after generation. Runtime error messages guide users to rerun `pnpm generate`.
- **Risk**: Manifest hash mismatch between runtime and generated code causes replay validation failures.
  - **Mitigation**: Runtime fails fast with clear guidance. FNV-1a algorithm is deterministic and stable.
## 12. Rollout Plan
N/A (existing workflow documentation).
## 13. Open Questions
None.
## 14. Follow-Up Work
None identified.
## 15. References
- `packages/core/src/events/runtime-event-manifest.generated.ts` (generated output)
- `packages/core/src/events/__tests__/content-event-channels.test.ts` (validation tests)
- `packages/content-sample/content/event-types.json` (example manifest)
## Appendix A — Glossary
- **Content Pack**: A package that extends the Idle Engine with custom content, including event types, resources, and automations.
- **Event Manifest**: The `event-types.json` file in a content pack that declares runtime event types.
- **Manifest Hash**: A deterministic FNV-1a hash computed over the merged event catalogue, embedded in event frames for replay validation.
- **Pack Slug**: A unique identifier for a content pack (e.g., "sample-pack").
- **Namespace**: A short identifier for an event domain within a pack (e.g., "sample", "automation").
- **Event Bus**: The runtime system that routes events to registered listeners via numbered channels.
## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2025-12-21 | N/A    | Migrated to template format from original authoring guide |
---
## Manifest Layout Reference
Each pack ships a `content/event-types.json` manifest describing the events it owns. Entries are grouped by `packSlug` and contain:
- `namespace` – short identifier for the domain (e.g. `sample` or `automation`)
- `name` – event name within that namespace
- `version` – positive integer bumped when payload compatibility changes
- `schema` – relative path to a JSON Schema file validating the payload
### Example Manifest
From `packages/content-sample/content/event-types.json`:
```json
{
  "packSlug": "sample-pack",
  "eventTypes": [
    {
      "namespace": "sample",
      "name": "reactor-primed",
      "version": 1,
      "schema": "./schemas/events/reactor-primed.schema.json"
    }
  ]
}
```
## Generation Workflow
1. Update the manifest and referenced schema files inside the content package.
2. Run `pnpm generate` from the repository root.
3. Commit the regenerated outputs:
   - `packages/core/src/events/runtime-event-manifest.generated.ts`
   - Generated `packages/core/dist/` updates produced by the core build step so workspace consumers load the fresh manifest
   - Any updated schema files or manifests inside the content package
4. (Optional) Filtered sample exports such as `sampleEventDefinitions` can keep demos aligned with the generated catalogue.
The generator sorts content definitions by `(packSlug, namespace:name)` and merges them with the core event catalogue. It recomputes the manifest hash using the same FNV-1a algorithm shipped in the runtime. The hash is embedded in:
- Event frames captured by the command recorder
- Replay validation checkpoints
If the runtime attempts to record or replay events with a different hash, it fails fast with guidance to rerun `pnpm generate`.
## Outputs and Consumption
- `ContentRuntimeEventType` extends the core `RuntimeEventType` union so content code can type-check event identifiers.
- `CONTENT_EVENT_CHANNELS` augments the event bus configuration; the runtime appends these channels automatically when building the registry.
- `GENERATED_RUNTIME_EVENT_DEFINITIONS` lists the merged catalogue with channel numbers, source packs, and schema references for tooling or documentation.
Run `pnpm --filter @idle-engine/core test` after generation to confirm the deterministic manifest hash is recognised by the recorder.
