# @idle-engine/content-sample

Sample content pack for the expanded economy, prestige layer, and balance
validation described in
[Expand Sample Pack and Balance Validation](../../docs/sample-pack-balance-validation-design-issue-420.md).
The pack slug is `@idle-engine/sample-pack`, and all content IDs use the
`sample-pack.*` namespace so they stay unique across the workspace. See the
[Content DSL Usage Guidelines](../../docs/content-dsl-usage-guidelines.md) for
the naming, versioning, and compatibility rules this package demonstrates in
practice.

## Content validation & generation

- Authoring sources live in `content/pack.json`. Run `pnpm generate` (or
  `pnpm generate --check` to fail on drift) after editing content to rebuild the
  compiled artifacts under `content/compiled/` and `src/generated/`.
- Balance validation runs with schema validation: defaults sample purchase
  indices 0–100, caps per-step growth at 20×, and fails on balance errors. CLI
  logs surface `content_pack.balance_warning` / `content_pack.balance_failed`—
  treat any warning as a regression before shipping.
- Follow the usage guide’s rules for slug casing and Semantic
  Versioning—`content/pack.json` keeps the scoped pack slug and
  `metadata.engine` range explicit so regeneration stays deterministic.
- The generated module (`src/generated/@idle-engine/sample-pack.generated.ts`)
  rehydrates a frozen `NormalizedContentPack`, exposes digest and artifact hash
  metadata, and ships positional indices so runtime consumers avoid recomputing
  lookup tables.
- `src/index.ts` re-exports the generated pack, digest, indices, and summary. It
  throws during import when the compiler recorded schema or balance warnings,
  keeping the sample pack warning-free by default.
- Property-based suites that guard balance and formulas are seeded (fast-check
  seeds in the 422000 range) to keep `vitest-llm-reporter` output stable; only
  adjust seeds when debugging failures.

## Sample contents

- Resources: Energy (start 10, tier 1), Crystal (hard currency, unlocks at
  Energy ≥ 25), Alloy (tier 2, unlocks at Crystal ≥ 50), Data Core (tier 2,
  unlocks at Alloy ≥ 40), Prestige Flux (prestige-only; hidden until prestige
  unlock).
- Generators: Reactor (Energy), Crystal Harvester (consumes Energy), Forge
  (Energy + Crystal → Alloy; linear cost base 75, slope 12), Research Lab
  (Energy + Alloy → Data Core; exponential cost base 120, growth 1.12), Gate
  Reactor (Data Core → Prestige Flux; prestige-gated).
- Upgrades: reactor chain (Insulation → Overclock → Phase Cooling), harvester
  chain with repeatable Quantum Sieve, forge tuning (Heat Shield, Auto-Feed),
  lab boosts (Insight Boost + repeatable Simulation Stack gated on Prestige
  Flux), and the prestige-centric Ascension Surge multiplier.
- Automations: see `content/pack.json` for interval, threshold, idle, and event
  triggers plus costed examples.

## Prestige flow

- Prestige layer `sample-pack.ascension-alpha` unlocks when Data Core ≥ 500 and
  Reactor level ≥ 10. It resets base resources/generators/upgrades and grants
  Prestige Flux via `floor((energy + crystal + 2 * data-core) / 750)` clamped to
  1–5000, retaining at least 1 Flux after each reset.
- Gate Reactor and prestige upgrades/bonuses remain hidden until the layer is
  unlocked; Prestige Flux fuels Simulation Stack (lab repeatable) and Ascension
  Surge multipliers across generators.

## Package exports

The package.json exports configuration provides multiple entry points:

- **Main export** (`"."`) - Primary entry point at `dist/index.js` that
  re-exports the generated content pack, digest, indices, and summary metadata.
  Use this for standard imports:
  `import { samplePack } from '@idle-engine/content-sample'`.
- **Dist wildcard** (`"./dist/*"`) - Direct access to compiled TypeScript output
  for advanced use cases.
- **Generated sources** (`"./src/generated/*"`) - Forward-looking infrastructure
  for potential direct imports of generated content files from build tools like
  Vite. **Currently unused externally**—the generated module is only imported
  internally via `src/index.ts`. This export was added to support proper ESM
  module resolution and Vite path aliasing, but no packages currently import
  from this path.

## Runtime event manifests

Custom runtime events for the sample pack live in `content/event-types.json`.
After editing the manifest (or associated schema files) run `pnpm generate`
from the repository root to regenerate:

- the consolidated manifest hash used by the command recorder
- `packages/core/src/events/runtime-event-manifest.generated.ts`
- the `ContentRuntimeEventType` union exported by `@idle-engine/core`

`sampleEventDefinitions` and `sampleEventTypes` in `src/index.ts` mirror the
generated output to keep tests and examples in sync with the manifest. If you
add new event schemas, regenerate the manifest and commit the updated compiler
artifacts alongside the changes.

## Progression sample data

The expanded pack supports the progression UI examples described in docs (see
`docs/build-resource-generator-upgrade-ui-components-design.md`) and exercises
balance validation:

- Generators: `sample-pack.reactor`, `sample-pack.harvester`,
  `sample-pack.forge`, `sample-pack.lab`, `sample-pack.gate-reactor`.
- Upgrades: reactor chain (Insulation → Overclock → Phase Cooling), harvester
  chain (Efficiency → Deep Core → repeatable Quantum Sieve), forge tuning (Heat
  Shield, Auto-Feed), lab boosts (Insight Boost + repeatable Simulation Stack),
  and the prestige-oriented `sample-pack.ascension-surge`.
- Progression snapshots and balance checks expect monotone costs and non-negative
  rates; regenerate artifacts with `pnpm generate` after any change and commit
  the updated outputs alongside `content/pack.json`.

## Automations

The sample pack includes a small set of automations to demonstrate triggers,
cooldowns, and resource costs:

- `sample-pack.auto-reactor` — Interval trigger enabling the reactor every 5s
  (no cost).
- `sample-pack.auto-harvester-on-energy` — Resource-threshold trigger at ≥50
  Energy (no cost) with a 5s cooldown.
- `sample-pack.idle-collector` — Fires when the command queue is empty, with a
  10s cooldown.
- `sample-pack.auto-harvester-on-primed` — Event-driven enable when the reactor
  is primed.
- `sample-pack.auto-reactor-burst` — Interval trigger every 2s with
  `resourceCost` of 2 Energy per fire.
- `sample-pack.autobuy-reactor-insulation` — Interval trigger every 8s with
  `resourceCost` of 1 Energy per attempt; targets the `reactor-insulation`
  upgrade.

These costed examples align with the automation resourceCost design and serve as
references for content authors. See `content/pack.json` for definitions and run
`pnpm generate` to validate/compile the pack.
