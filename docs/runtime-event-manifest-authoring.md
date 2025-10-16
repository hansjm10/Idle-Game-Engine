# Runtime Event Manifest Authoring

Content packs extend the runtime event catalogue through offline manifests that are merged during `pnpm generate`. This guide outlines the contract for pack maintainers and the guarantees enforced by the build tooling.

## Manifest layout

- Each pack ships a `content/event-types.json` manifest describing the events it owns.
- Entries are grouped by `packSlug` and contain:
  - `namespace` – short identifier for the domain (e.g. `sample` or `automation`)
  - `name` – event name within that namespace
  - `version` – positive integer bumped when payload compatibility changes
  - `schema` – relative path to a JSON Schema file validating the payload
- Example (`packages/content-sample/content/event-types.json`):

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

## Generation workflow

1. Update the manifest and referenced schema files inside the content package.
2. Run `pnpm generate` from the repository root.
3. Commit the regenerated outputs:
   - `packages/core/src/events/runtime-event-manifest.generated.ts`
   - any updated schema files or manifests inside the content package
4. (Optional) Filtered sample exports such as `sampleEventDefinitions` can keep demos aligned with the generated catalogue.

The generator sorts content definitions by `(packSlug, namespace:name)` and merges them with the core event catalogue. It recomputes the manifest hash using the same FNV-1a algorithm shipped in the runtime. The hash is embedded in:

- event frames captured by the command recorder
- replay validation checkpoints

If the runtime attempts to record or replay events with a different hash, it fails fast with guidance to rerun `pnpm generate`.

## Outputs and consumption

- `ContentRuntimeEventType` extends the core `RuntimeEventType` union so content code can type-check event identifiers.
- `CONTENT_EVENT_CHANNELS` augments the event bus configuration; the runtime appends these channels automatically when building the registry.
- `GENERATED_RUNTIME_EVENT_DEFINITIONS` lists the merged catalogue with channel numbers, source packs, and schema references for tooling or documentation.

Run `pnpm --filter @idle-engine/core test` after generation to confirm the deterministic manifest hash is recognised by the recorder.
