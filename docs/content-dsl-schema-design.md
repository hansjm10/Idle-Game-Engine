# Content DSL Schema Design

**Issue:** #11  
**Workstream:** Content Pipeline  
**Status:** Design  
**Last Updated:** 2025-10-18

> Issue #11 defines the canonical Zod schema contract for Idle Engine content
> packs. The schema guards authoring-time invariants, normalises inputs for the
> compiler, and aligns with the content expectations outlined in
> `docs/idle-engine-design.md` §10.

## 1. Overview

The Idle Engine content DSL bridges designer-authored data and the deterministic
runtime. Today, sample packs provide ad-hoc TypeScript interfaces, but the
monorepo lacks an enforceable schema. This document specifies the Zod schemas,
normalisation rules, and validation flow that future CLI tooling will use before
content is compiled into runtime-ready definitions. The goal is to deliver a
  single package that validates metadata, resources, generators, upgrades,
  metrics, achievements, prestige layers, automations, transforms, runtime event
  extensions, guild perks, and pack dependency metadata while providing strong
  typing for TypeScript consumers.

## 2. Goals

- Provide a canonical `@idle-engine/content-schema` package exporting Zod
  schemas and inferred TypeScript types for every content DSL module, including
  metrics, achievements, runtime event definitions, and pack dependency metadata.
- Normalise author input (trim strings, apply defaults, sort deterministically)
  so the compiler and runtime receive stable, replayable definitions.
- Surface referential, balancing, and compatibility errors at authoring time
  with actionable messages for future CLI integrations.
- Support localisation-ready text, formula-driven values, and unlock conditions
  without constraining downstream compiler optimisations.
- Keep schema evolution explicit through semantic metadata, enabling future
  packs to opt into new capabilities without breaking prototype-era content.

## 3. Non-Goals

- Implementing the compiler that emits runtime-ready typed arrays, manifests, or
  worker bundles (tracked in a follow-up issue).
- Executing or optimising numeric formulas beyond structural validation.
- Delivering the localisation pipeline, documentation site generation, or
  in-editor authoring experience.
- Shipping gameplay logic changes in the runtime; this document only constrains
  the content contract.
- Rewriting existing sample data; migrations will land once the schema package
  exists.

## 4. Current State

- `packages/content-sample/src/index.ts` now re-exports the compiler-generated
  sample pack (rehydrated content, digest, summary, indices), maintaining the
  import-time warning guard without reparsing `content/pack.json`.
- No shared schema package exists. Content authors must rely on informal
  conventions captured in `docs/idle-engine-design.md`.
- `tools/content-schema-cli` is a stub focused on runtime event manifests and
  does not validate content pack data.
- Tests, lint rules, and CI do not exercise schema validation because the schema
  is missing.

## 5. Proposed Solution

### 5.1 Package Layout & Ownership

- Create `packages/content-schema` exporting common schema primitives, DSL
  module schemas, and composite pack schemas. The package remains private until
  the contract is stabilised.
- Structure the package as:

```
packages/content-schema/
  package.json
  src/
    index.ts
    base/
      ids.ts
      localization.ts
      numbers.ts
      formulas.ts
      conditions.ts
    modules/
      metadata.ts
      resources.ts
      generators.ts
      upgrades.ts
      metrics.ts
      achievements.ts
      automations.ts
      prestige.ts
      guild-perks.ts
      transforms.ts
      runtime-events.ts
      dependencies.ts
    runtime-compat.ts
    pack.ts
    errors.ts
  vitest.config.ts
```

- `index.ts` re-exports the base `contentPackSchema`, the
  `createContentPackValidator` factory, a convenience `parseContentPack`
  helper that returns `{ pack, warnings }`, `NormalizedContentPack`, and other
  targeted schemas for focused validation (e.g., `resourceDefinitionSchema`,
  `metricDefinitionSchema`, `achievementDefinitionSchema`,
  `runtimeEventContributionSchema`).
- Downstream tooling (`packages/content-sample`, CLI, compiler) imports only
  from this package.

### 5.2 Shared Scalar Schemas & Utilities

- Define shared primitives with Zod brands for stronger inference:
  - `contentIdSchema`: case-insensitive slug
    `[A-Za-z0-9][A-Za-z0-9-_/.:]{0,63}` trimmed and canonicalised to lowercase
    via `.transform`, ensuring consistent hashing while still accepting mixed
    author input. The transform rebrands the result with
    `.pipe(z.string().brand<'ContentId'>())` so TypeScript keeps the nominal
    type that downstream code relies on, matching the guidance from the Zod
    maintainers that transforms otherwise shed brands
    ([colinhacks/zod#5183](https://github.com/colinhacks/zod/issues/5183)).
    The grammar deliberately excludes `@`, keeping scoped identifiers reserved
    for pack slugs.
  - `packSlugSchema`: accepts both unscoped ids (`sample-pack`) and npm-style
    scoped ids (`@idle-engine/core`, mirrored from `packages/core/src/events/runtime-event-manifest.generated.ts:57`),
    trimming whitespace, collapsing duplicate
    separators, and canonicalising to lowercase before rebranding the output
    with `PackId`. The schema mirrors npm’s published scope rules—`@scope/name`
    with URL-safe characters—so content packs can reference workspace packages
    such as `@idle-engine/core` without loosening the general-purpose DSL id
    grammar.[^npm-scope]
  - `localeCodeSchema`: BCP-47 compliant subset matching language tags used in
    the UI.
  - `flagIdSchema` and `scriptIdSchema`: trimmed, lowercase slugs that reuse the
    content id grammar but keep bespoke `FlagId`/`ScriptId` brands. Normalisation
    collapses duplicate separators and canonicalises casing so allowlists and
    authored packs compare against the same canonical form.
  - `systemAutomationTargetIdSchema`: alias for curated system toggle ids
    (`offline-catchup`, `research-daemon`, etc.) that trims, lowercases, and
    validates the identifier against an enum derived from the runtime.
  - `semverSchema` and `semverRangeSchema`: validated via the `semver`
    library (`semver@7`) inside `.superRefine`.
  - `hexColorSchema`, `iconPathSchema`, `urlSchema` for UI metadata.
  - `nonNegativeNumberSchema`, `percentSchema`, `positiveIntSchema`.

[^npm-scope]: *Scoped packages* — npm Docs. Demonstrates npm’s scoped package
  naming convention using `@myorg/mypackage`, which the schema mirrors so packs
  can reference scoped workspace ids. https://docs.npmjs.com/cli/v10/using-npm/scope
- Localised text uses a strict object:

```ts
const localizedTextSchema = z
  .object({
    default: z.string().trim().min(1).max(256),
    variants: z
      .record(localeCodeSchema, z.string().trim().min(1).max(256))
      .default({})
      .transform((value) => structuredClone(value)),
  })
  .strict();
```

- `localizedTextSchema` treats the `default` field as the authoritative copy for
  the pack's default locale. Localised transforms run inside
  `normalizeContentPack`, where `normalizeLocalizedText(metadata, text,
  warningSink)` backfills a missing
  `variants[metadata.defaultLocale]` entry so localisation tools that expect
  keyed entries remain compatible without forcing authors to duplicate strings.
  When authors supply a variant that differs from `default`, the helper records
  a warning instead of overwriting the authored copy so intentional locale
  tweaks remain intact. Because Zod reuses the same object instance supplied to
  `.default({})`, `normalizeLocalizedText` always clones the incoming variants
  map (using the platform
  [`structuredClone`](https://developer.mozilla.org/en-US/docs/Web/API/structuredClone)
  API or a fallback) before applying mutations so later parses cannot observe
  stale state carried over from previous callers.
- `normalizeLocalizedText` receives the parsed metadata and supported locale
  list from the surrounding normalisation step, letting it emit structured
  warnings for missing translations while keeping the base schema free of
  cross-field knowledge.
- Invalid locale keys or empty variant strings surface as parse failures; we no
  longer swallow malformed author input via `.catch({})`, keeping localisation
  mistakes visible to tooling.
- `localizedSummarySchema` extends the same structure with a relaxed ceiling
  (`max(512)`) for synopsis copy so `metadata.summary` can hold longer blurbs.
- All schemas are `strict()` to reject unknown keys. Optional fields apply
  defaults through `.default` or `.transform`, and scalar schemas use `.coerce`
  where CLI or JSON-driven inputs frequently arrive as strings so authoring
  tools do not need to hand-roll conversions.

### 5.3 Numeric Formula Schema

- Provide `numericFormulaSchema`, a discriminated union that supports both
  common progression curves and explicit expressions:
  - `constant`: `{ kind: 'constant'; value: number }`.
  - `linear`: `{ kind: 'linear'; base: number; slope: number }`.
  - `exponential`: `{ kind: 'exponential'; base: number; growth: number;
    offset?: number }`.
  - `polynomial`: `{ kind: 'polynomial'; coefficients: number[] }`.
  - `piecewise`: `{ kind: 'piecewise'; pieces: { untilLevel?: number;
    formula: NumericFormula }[] }`.
  - `expression`: embeds an AST validated by `expressionNodeSchema`.
- Expression nodes form a recursive Zod schema using `z.lazy` with node types:
  - `literal`: constant number.
  - `ref`: structured references that avoid stringly typed identifiers
    ([Coding Horror – “Stringly Typed”](https://blog.codinghorror.com/new-programming-jargon/#7-stringly-typed)).
    The schema permits either runtime variables
    `{ kind: 'ref'; target: { type: 'variable'; name: 'level' | 'time' | 'deltaTime' } }`
    or entity handles
    `{ kind: 'ref'; target: { type: 'resource' | 'generator' | 'upgrade' | 'automation' | 'prestigeLayer'; id: ContentId } }`.
  - `binary`: `op` in `{ add, sub, mul, div, pow, min, max }` with two operands.
  - `unary`: `op` in `{ abs, ceil, floor, round, sqrt, log10, ln }`.
  - `call`: named function (e.g., `clamp`, `lerp`) with `args: Expression[]`.
- Validation enforces finite numbers, non-empty coefficient arrays, and monotonic
  `piecewise` sequences. Piecewise nodes must supply strictly increasing
  `untilLevel` values and terminate with a catch-all segment (omitting
  `untilLevel`) so evaluation order stays deterministic and never depends on
  engine sort stability. Structured references keep lookups type-aware—validators
  dispatch by `target.type` (`resource`, `generator`, etc.) or the runtime
  variable enum without having to parse dotted strings—so the compiler can flag
  missing entities early while still permitting `level`/`time` references.
  Function call nodes are checked against a deterministic allowlist (`clamp`,
  `lerp`, `min3`, `max3`, `pow10`, `root`, etc.) so unexpected identifiers
  produce structured errors instead of leaking to runtime.

### 5.4 Condition Schema

- `conditionSchema` uses `z.discriminatedUnion('kind', …)` so every node spells
  out the payload required for validation and graph analysis. The snippet below
  shows the intended TypeScript shape using the types inferred from
  `contentIdSchema` and `numericFormulaSchema`:

```ts
// z imported from 'zod'
type ContentId = z.infer<typeof contentIdSchema>;
type NumericFormula = z.infer<typeof numericFormulaSchema>;
type FlagId = z.infer<typeof flagIdSchema>;
type ScriptId = z.infer<typeof scriptIdSchema>;

type Condition =
  | { kind: 'always' }
  | { kind: 'never' }
  | {
      kind: 'resourceThreshold';
      resourceId: ContentId;
      comparator: 'gte' | 'gt' | 'lte' | 'lt';
      amount: NumericFormula;
    }
  | {
      kind: 'generatorLevel';
      generatorId: ContentId;
      comparator: 'gte' | 'gt' | 'lte' | 'lt';
      level: NumericFormula;
    }
  | {
      kind: 'upgradeOwned';
      upgradeId: ContentId;
      requiredPurchases?: number; // defaults to 1 during normalisation
    }
  | { kind: 'prestigeUnlocked'; prestigeLayerId: ContentId }
  | { kind: 'flag'; flagId: FlagId }
  | { kind: 'script'; scriptId: ScriptId }
  | { kind: 'allOf'; conditions: readonly Condition[] }
  | { kind: 'anyOf'; conditions: readonly Condition[] }
  | { kind: 'not'; condition: Condition };
```

- Conditions are `strict()` objects and reuse `numericFormulaSchema` wherever a
  numeric comparison is required (`amount`, `level`). Cross-reference checks use
  the explicit `resourceId`, `generatorId`, `upgradeId`, and
  `prestigeLayerId` fields when validating existence and building dependency
  graphs. Future iterations can introduce additional condition variants (for
  example, achievement, automation, or transform predicates); until then the
  validator limits cross-references to the nodes above. `flag` and `script`
  nodes are validated against
  `ContentSchemaOptions.allowlists`; the factory accepts arrays or sets for the
  inputs and normalises them (via the same canonical schemas used on conditions)
  to `ReadonlySet` lookups. Entries marked `required` remain hard failures,
  while `soft` allow missing lookups with a warning.
- Aggregation nodes (`allOf`, `anyOf`) require at least one nested condition via
  `.min(1)` so unlock logic never defaults to vacuous truth.
- Cycle detection only introduces edges for monotonic predicates (`resource`
  thresholds, generator levels, upgrade ownership, prestige unlocks, flag/script
  allowlists) that participate in `allOf` and other positive contexts. Negated
  predicates (`not`) and disjunction branches (`anyOf`) still undergo existence
  checks, but they do not register graph edges; instead they are captured as
  advisory constraints so authors can express absence-based gating without
  creating non-monotonic cycles that would otherwise surface as false positives
  during validation.[^non-monotonic]

[^non-monotonic]: “Non-monotonic logic” — Wikipedia. Notes that adding new
information can invalidate prior inferences, so negative knowledge behaves
non-monotonically and must be modelled separately from positive dependency
edges. https://en.wikipedia.org/wiki/Non-monotonic_logic

### 5.5 Metadata Schema

- `metadataSchema` covers content-level metadata:
  - `id`: pack slug (`packSlugSchema`).
  - `title`: `localizedTextSchema`.
  - `summary`: optional `localizedSummarySchema` with longer copy (≤512 chars).
  - `version`: semantic version string validated by `semver`.
  - `engine`: semver range describing supported runtime versions.
  - `authors`: array of trimmed strings (≤64 chars) with de-duplication.
  - `defaultLocale`: `localeCodeSchema` that maps to the `title.default`
    property. Normalisation ensures the same string also appears in
    `title.variants` for tooling that expects locale keys.
  - `supportedLocales`: non-empty array of `localeCodeSchema` entries
    representing every locale shipped with the pack. Validation rejects inputs
    that omit `defaultLocale`, while normalisation removes duplicates and sorts
    the final list for deterministic hashing.
  - `tags`: array of slugs (≤24 chars) reserved for tooling filters.
  - `links`: optional array of URL metadata `{ kind, label, href }`.
  - `createdAt` / `updatedAt`: ISO-8601 timestamps (optional).
  - `visibility`: optional enum `public | private | experimental`.
  - `dependencies`: optional object shaped by `packDependencySchema` exported
    from `modules/dependencies.ts`:
    - `requires`: array of `{ packId: PackId; version: semverRangeSchema }`
      representing hard dependencies that must load before this pack.
    - `optional`: array with the same shape for soft integrations (warnings
      emitted when known installed packs omit the dependency; see §5.16).
    - `conflicts`: array restricting incompatible packs
      (`{ packId: PackId; message?: string }`).
    - `provides`: optional array of capability slugs for discovery tooling.
    Normalisation deduplicates entries, sorts them deterministically, and
    ensures packs never self-reference. Dependency cycle detection runs during
    cross-reference validation by combining the pack's declared `requires`
    edges with the dependency graph supplied through
    `ContentSchemaOptions.knownPacks` (see §5.16); when upstream data is
    missing, the validator still guards against self-references and duplicate
    entries.
- The schema normalises whitespace, enforces canonical casing, and ensures
  `engine` ranges include the active runtime version when known (checked in
  tests) and that `supportedLocales` contains `defaultLocale`. Optional
  dependencies only surface `optionalDependency.missing` warnings when callers
  supply `ContentSchemaOptions.activePackIds`; otherwise the entries stay
  informational so unpublished packs are not penalised while the pipeline lacks
  visibility into the installation graph. During the proof-of-concept phase we
  explicitly keep optional dependencies as warnings (never hard errors) to
  preserve iteration speed; once installation graphs are available we can
  revisit stricter enforcement. When authors pass `ContentSchemaOptions.runtimeVersion`,
  `validateCrossReferences` performs two compatibility checks:
  1. `semver.satisfies(runtimeVersion, metadata.engine)` must be true; otherwise
     a targeted error is raised (per the
     [`node-semver` README example](https://github.com/npm/node-semver#ranges)).
  2. The validator consults the `FEATURE_GATES` map in `runtime-compat.ts`. Each
     non-prototype module (anchored to the roadmap described in
     `docs/idle-engine-design.md` §18 and `docs/implementation-plan.md`)
     declares the minimum runtime version it supports. For example, automations
     require `>=0.2.0`, transforms and runtime event contributions require
     `>=0.3.0`, prestige layers require `>=0.4.0`, and guild perks require
     `>=0.5.0`. When a pack targets an older runtime yet includes gated modules,
     `validateCrossReferences` emits a structured error naming the offending
     feature and required version. Passing packs still receive warning hints
     when they depend on features from newer runtimes so maintainers know which
     modules to trim if they need to stay compatible.

### 5.6 Resource Schema

- `resourceDefinitionSchema` extends the runtime-facing definition with content
  metadata:
  - `id`: `contentIdSchema`.
  - `name`: `localizedTextSchema`.
  - `category`: enum (`primary`, `prestige`, `automation`, `currency`,
    `misc`).
  - `tier`: positive integer for UI grouping.
  - `icon`: optional icon path (SVG/PNG) resolved at build time.
  - `startAmount`: non-negative number (defaults to `0`).
  - `capacity`: nullable number; `null` maps to infinity at runtime.
  - `visible`: boolean default `true`.
  - `unlocked`: boolean default `false`.
  - `dirtyTolerance`: optional override (validated against runtime ceilings).
  - `order`: optional float for deterministic sort when content author wants
    manual ordering.
  - `unlockCondition` / `visibilityCondition`: `conditionSchema` nodes.
  - `prestige`: optional block describing prestige currency linkage
    `{ layerId, resetRetention?: NumericFormula }`.
  - `tags`: array of slugs for analytics or UI filters.
- `.superRefine` performs per-definition checks:
  - `startAmount ≤ capacity` when capacity is finite.
  - `dirtyTolerance` clamped to the runtime maximum with telemetry-friendly
    diagnostics.

### 5.7 Generator Schema

- `generatorDefinitionSchema` models production structures:
  - `id`, `name`, `icon`, `tags` similar to resources.
  - `produces`: array of `{ resourceId, rate: NumericFormula }`.
  - `consumes`: optional array of `{ resourceId, rate: NumericFormula }` for
    upkeep costs.
  - `purchase`: strict object with explicit scalar schemas:
    - `currencyId`: `contentIdSchema` (lowercased during normalisation).
    - `baseCost`: `nonNegativeNumberSchema` ensuring finite, ≥0 values.
    - `costCurve`: `numericFormulaSchema` evaluated in the runtime against the
      current purchase count.
    - `maxBulk`: optional `positiveIntSchema` constraining bulk-buy UI affordances.
  - `maxLevel`: optional positive integer.
  - `order`: optional float controlling list ordering (sorted before id during
    normalisation).
  - `baseUnlock`: `conditionSchema` gating initial availability.
  - `visibilityCondition`: `conditionSchema` for UI reveal.
  - `automation`: optional reference `{ automationId }` linking to automation
    definitions.
  - `effects`: optional array for generator-specific effects (e.g., passive
    bonuses) using shared effect schema from upgrades.
- Cross-validation ensures referenced resources exist, consumption and production
  rates are finite, and `maxBulk` respects `maxLevel`.

### 5.8 Upgrade Schema

- `upgradeDefinitionSchema` captures upgrade catalog entries:
  - `id`, `name`, `icon`, `tags`.
  - `category`: enum (`global`, `resource`, `generator`, `automation`,
    `prestige`, `guild`).
  - `targets`: array of typed handles
    (`{ kind: 'resource'; id: ContentId }`,
    `{ kind: 'generator'; id: ContentId }`,
    `{ kind: 'automation'; id: ContentId }`,
    `{ kind: 'prestigeLayer'; id: ContentId }`,
    `{ kind: 'guildPerk'; id: ContentId }`, or `{ kind: 'global' }`) so upgrade
    payloads stay strongly typed and avoid the stringly typed anti-pattern noted
    above.
  - `cost`: same schema as generator `purchase`, reusing the scalar contracts for
    `currencyId`, `baseCost`, `costCurve`, and `maxBulk`.
  - `repeatable`: optional block describing stacking rules (`maxPurchases`,
    `costCurve`, `effectCurve`).
  - `prerequisites`: array of `conditionSchema` or upgrade ids (internally
    normalised to condition nodes).
  - `order`: optional float aligning manual catalogue ordering with generator and
    resource lists.
  - `effects`: array of discriminated union entries:
    - `modifyResourceRate` (`resourceId`, `operation`, `value: NumericFormula`).
    - `modifyGeneratorRate`.
    - `modifyGeneratorCost`.
    - `grantAutomation`.
    - `grantFlag` (`{ kind: 'grantFlag'; flagId: FlagId; value?: boolean }`)
      declaring deterministic flag mutations; `value` defaults to `true` during
      normalisation so authors can focus on the ids they flip. The schema reuses
      `flagIdSchema` and validates the id against caller-supplied allowlists.
    - `unlockResource` / `unlockGenerator`.
    - `alterDirtyTolerance`.
    - `emitEvent` (hooks into runtime event bus).
  - `unlockCondition` / `visibilityCondition`.
- Validation ensures effect targets exist, repeatable upgrades specify consistent
  bounds, and cost curves match runtime expectations using the explicit `kind`
  information in `targets` and the effect payloads.

### 5.9 Metric Schema

- `metricDefinitionSchema` describes pack-authored telemetry counters that plug
  into the instrumentation pipeline promised in `docs/idle-engine-design.md` §16
  (“allow games to register custom metrics using shared instrumentation API”):
  - `id`: `contentIdSchema` canonical slug aligned with the instrumentation name
    grammar. Normalisation lowercases ids and collapses duplicate separators so
    authored metrics mirror the lookup keys used by runtime exporters.
  - `name`: `localizedTextSchema`.
  - `description`: optional `localizedSummarySchema`, surfaced in tooling so
    designers and analytics reviewers share human-friendly context for each
    measurement.
  - `kind`: enum (`counter`, `gauge`, `histogram`, `upDownCounter`) mapping onto
    OpenTelemetry instrument semantics to keep downstream aggregation predictable
    (matching the public guidance that instrument kind, unit, and description
    shape identity and cardinality constraints[^otel-metrics-api]).
  - `unit`: optional string validated against a trimmed ASCII grammar and capped
    at 32 characters. Normalisation defaults empty units to `'1'` for
    dimensionless counters, mirroring OpenTelemetry’s recommendation for unit
    fields.
  - `aggregation`: optional enum describing the preferred rollup
    (`sum`, `delta`, `cumulative`, `distribution`). The schema keeps the value
    advisory—tooling can respect author intent while still allowing fallback
    aggregation when runtimes lack support.
  - `attributes`: optional array of attribute keys (`slug` grammar,
    ≤16 chars) documenting the telemetry dimension set so validation can warn
    when authors declare high-cardinality combinations.
  - `source`: enum describing how the pack emits the metric (`runtime`, `script`,
    `content`) with optional payload describing bindings (e.g.,
    `{ kind: 'script'; scriptId: ScriptId }`). Validation ensures referenced
    script ids originate from allowlists and warns when runtime bindings cite
    modules gated by `FEATURE_GATES`.
  - `order`: optional float letting authors stabilise how metrics appear in CLI
    reports or documentation exports before falling back to id-based sorting.
- Validation rejects duplicate metric ids, enforces that histogram metrics
  declare an advisory aggregation, and surfaces warnings when attribute key
  counts exceed three (mirroring OpenTelemetry’s constraint on low-cardinality
  attribute sets to keep exporters efficient). Metrics participate in
  localisation checks and integrate with the warning sink so CLI tooling can
  flag ambiguous descriptions.

[^otel-metrics-api]: *Metrics API* — OpenTelemetry Specification. Highlights
instrument identity across `name`, `kind`, `unit`, and `description`, guiding
schema fields for metrics authored by packs.
https://raw.githubusercontent.com/open-telemetry/opentelemetry-specification/main/specification/metrics/api.md

### 5.10 Achievement Schema

- `achievementDefinitionSchema` models milestone tracking promised in
  `docs/idle-engine-design.md` §6 and §10:
  - `id`: `contentIdSchema`.
  - `name`: `localizedTextSchema`.
  - `description`: `localizedSummarySchema` (≤512 chars) so UI blurbs can be
    longer than upgrade tooltips.
  - `category`: enum (`progression`, `prestige`, `automation`, `social`,
    `collection`).
  - `tier`: enum (`bronze`, `silver`, `gold`, `platinum`) used for UI theming.
  - `icon`: optional icon path.
  - `tags`: array for analytics or in-game filters.
  - `track`: discriminated union describing progress measurement:
    - `resource`: `{ kind: 'resource'; resourceId: ContentId; threshold: NumericFormula; comparator?: 'gte' | 'gt' | 'lte' | 'lt' }`.
    - `generatorLevel`: `{ kind: 'generator-level'; generatorId: ContentId; level: NumericFormula }`.
    - `upgradeOwned`: `{ kind: 'upgrade-owned'; upgradeId: ContentId; purchases?: NumericFormula }`.
    - `flag`: `{ kind: 'flag'; flagId: FlagId }`.
    - `script`: `{ kind: 'script'; scriptId: ScriptId }`.
    - `customMetric`: `{ kind: 'custom-metric'; metricId: ContentId; threshold: NumericFormula }` for pack-defined telemetry counters. Validation ensures
      `metricId` references a metric declared in the same pack.
  - `progress`: object describing accumulation semantics:
    - `target`: optional `NumericFormula`. When omitted, normalisation derives a
      deterministic default: `threshold`, `level`, `purchases`, or `metric`
      requirements from the active `track` variant, and a constant `1` curve for
      boolean achievements (`flag`, `script`) so they still model a goal that
      resolves to completion.
    - `mode`: enum (`oneShot`, `incremental`, `repeatable`) guiding whether
      progress sticks after completion.
    - `repeatable`: optional object used when `mode === 'repeatable'`:
      `{ resetWindow: NumericFormula; maxRepeats?: number; rewardScaling?: NumericFormula }`.
      `resetWindow` defines the deterministic interval between repeats
      (expressed in runtime ticks). `maxRepeats` limits the total number of
      times the achievement can recur, and `rewardScaling` describes how repeat
      rewards scale (defaults to a constant `1` curve). Validation enforces
      presence of `resetWindow` whenever the repeatable block exists.
  - `reward`: optional union (`grantResource`, `grantUpgrade`, `grantGuildPerk`,
    `emitEvent`, `unlockAutomation`, `grantFlag`) reusing effect payload schemas.
    `grantFlag` mirrors the upgrade effect contract (`flagId`, optional `value`
    defaulting to `true`) and validates entries against the `flags` allowlist.
  - `unlockCondition`: optional `conditionSchema` gating visibility in the log.
  - `visibilityCondition`: optional `conditionSchema` enabling hidden feats.
  - `onUnlockEvents`: optional array of runtime event ids emitted when the
    achievement completes, ensuring content-authored events integrate with the
    manifest pipeline described in §5.15.
  - `displayOrder`: optional float for deterministic ordering alongside author
    supplied tiers.
- Cross-validation ensures the resolved `progress.target` (authored or inferred)
  evaluates to a positive, finite number, referenced ids exist (including
  `customMetric.metricId` entries), union variants include the correct handles,
  and repeatable achievements declare deterministic
  reset semantics via the
  `repeatable.resetWindow` field (while keeping `maxRepeats` finite and
  `rewardScaling` curves bounded). Achievements also participate in localisation
  checks so missing descriptions surface warnings.

### 5.11 Automation Schema

- `automationDefinitionSchema` describes automation toggles:
  - `id`: `contentIdSchema`.
  - `name`: `localizedTextSchema`.
  - `description`: `localizedTextSchema`.
  - `targetType`: enum (`generator`, `upgrade`, `system`).
  - `targetId`: required when `targetType` is `generator` or `upgrade` and
    validated against the relevant ids.
  - `systemTargetId`: required when `targetType === 'system'`, validated using
    `systemAutomationTargetIdSchema` against the curated allowlist
    (`offline-catchup`, `research-daemon`, etc.).
  - `trigger`: union of deterministic triggers (`interval`, `resourceThreshold`,
    `commandQueueEmpty`, `event`).
  - `cooldown`: optional number (`ms`).
  - `resourceCost`: optional upkeep cost schema reused from generators.
  - `unlockCondition`: `conditionSchema`.
  - `enabledByDefault`: boolean default `false`.
  - `order`: optional float guiding UI grouping.
- Automations can reference script hooks; validation ensures script ids adhere to
  the shared id schema. System targets validate against a curated allowlist
  encoded by `systemAutomationTargetIdSchema` (e.g., `offline-catchup`,
  `research-daemon`) so authors receive actionable errors instead of generic
  missing-id failures. Event-triggered automations (`trigger.kind === 'event'`)
  are cross-checked against the merged runtime event catalogue so dangling ids
  surface during validation rather than at runtime.

### 5.12 Transform Schema

- `transformDefinitionSchema` captures deterministic conversions sitting between
  generators and prestige resets, satisfying the “transforms” requirement in
  `docs/idle-engine-design.md` §6:
  - `id`: `contentIdSchema`.
  - `name`: `localizedTextSchema`.
  - `description`: `localizedSummarySchema` clarifying the conversion behaviour.
  - `mode`: enum (`instant`, `continuous`, `batch`) expressing whether the
    transform fires once, ticks every simulation step, or processes a finite
    batch when triggered.
  - `inputs`: non-empty array of `{ resourceId: ContentId; amount: NumericFormula }`.
  - `outputs`: non-empty array of `{ resourceId: ContentId; amount: NumericFormula }`.
  - `duration`: optional `NumericFormula` (ms) for timed conversions (required
    for `batch` mode).
  - `cooldown`: optional `NumericFormula` enforcing time between runs.
  - `trigger`: discriminated union describing how the transform activates:
    - `manual`: `{ kind: 'manual' }` for player-driven conversions.
    - `automation`: `{ kind: 'automation'; automationId: ContentId }`
      referencing an automation toggle that fires the transform.[^core-automation-tests]
    - `condition`: `{ kind: 'condition'; condition: Condition }` for inline
      predicates.
    - `event`: `{ kind: 'event'; eventId: ContentId }` bundling runtime event
      identifiers.
  - `unlockCondition`: optional `conditionSchema`.
  - `visibilityCondition`: optional `conditionSchema`.
  - `automation`: optional `{ automationId: ContentId }` linking to automation
    toggles for hands-off operation. When `trigger.kind === 'automation'` this
    block is required and must reference the same canonical id.
  - `tags`: array for analytics/UX filters.
  - `safety`: optional guard specifying `maxRunsPerTick` and
    `maxOutstandingBatches` so the runtime clamps runaway loops deterministically.
  - `order`: optional float allowing authors to stabilise transform ordering in
    menus.
- Validation confirms every transform references declared resources, batch modes
  declare a finite `duration`, continuous transforms specify at least one
  consumption or production rate, and the signed sum of input/output rates stays
  finite to protect hashing. When `trigger.kind === 'automation'` the validator
  ensures the embedded `automationId` exists and, when the optional `automation`
  block is present, that both references match. Event-triggered transforms verify
  `eventId` against the runtime contributions defined in §5.15.

### 5.13 Prestige Layer Schema

- `prestigeLayerSchema` supports reset mechanics:
  - `id`, `name`, `icon`.
  - `summary`: `localizedTextSchema`.
  - `resetTargets`: array of resource ids reset when the layer triggers.
  - `unlockCondition`: `conditionSchema`.
  - `reward`: block specifying output currency `{ resourceId, baseReward:
    NumericFormula, multiplierCurve?: NumericFormula }`.
  - `retention`: optional array describing retained resources/upgrades.
  - `automation`: optional reference enabling auto-prestige triggers.
  - `order`: optional float for menu ordering.
- Validation enforces that prestige rewards reference prestige-class resources
  and that reset targets cover at least one non-prestige resource.

### 5.14 Guild Perk Schema

- `guildPerkSchema` provides hooks for social systems:
  - `id`: `contentIdSchema`.
  - `name`: `localizedTextSchema`.
  - `description`: `localizedTextSchema`.
  - `category`: enum (`buff`, `utility`, `cosmetic`).
  - `maxRank`: positive integer.
  - `effects`: union aligned with upgrade effects plus guild-specific entries
    (`modifyGuildStorage`, `unlockGuildAutomation`).
  - `cost`: block referencing guild currency or contribution metrics.
  - `unlockCondition`: `conditionSchema` (allowing milestones or campaign
    progress).
  - `order`: optional float coordinating perk list ordering with prestige and
    upgrade entries.
  - `visibilityCondition`.
- Guild perks can be optional for prototype packs; schema allows empty arrays.

### 5.15 Runtime Event Contribution Schema

- Content packs augment the runtime event catalogue documented in
  `docs/runtime-event-pubsub-design.md` and
  `docs/runtime-event-manifest-authoring.md`. The schema ensures authored
  entries align with the manifest generator responsible for producing
  `GENERATED_RUNTIME_EVENT_DEFINITIONS`:
  - `id`: `contentIdSchema`, derived from the canonical runtime event type
    `namespace:name`. Authors may omit the field; when provided the
    schema verifies the value matches the derived identifier before emitting the
    canonical lowercased string.
  - `namespace`: trimmed slug (≤32 chars) for grouping related events.
  - `name`: trimmed string (≤48 chars) matching runtime naming conventions.
  - `version`: positive integer bumped whenever payload compatibility changes.
  - `payload`: discriminated union:
    - `zod`: `{ kind: 'zod'; schemaPath: string }` referencing a TypeScript
      module exporting a Zod schema.
    - `jsonSchema`: `{ kind: 'json-schema'; schemaPath: string }` referencing a
      JSON Schema document consumed by the generator.
  - `emits`: optional array of `{ source: 'achievement' | 'upgrade' | 'transform' | 'script'; id: ContentId }`
    documenting which content entries publish the event (surfaced in generated
    docs).
  - `tags`: optional analytics strings.
- Normalisation always emits the canonical id (`namespace:name`) even when
  authors omit the field so downstream references have a single stable key.
- Validation ensures schema paths remain pack-relative (rejecting absolute and
  parent-directory escapes), `version` increments monotonically under
  normalisation, and `emits` references existing content ids so manifest
  documentation can hyperlink back into DSL definitions. File-system existence
  checks continue to live in `tools/content-schema-cli`, which already loads the
  manifests and schema documents during `pnpm generate`, so the schema package
  stays environment-agnostic while tooling preserves the authoring guarantees
  documented in `docs/runtime-event-manifest-authoring.md`. Parsed
  contributions feed the merge pipeline, which recomputes manifest hashes
  alongside runtime events to keep replay safeguards intact.

### 5.16 Content Pack Root Schema

- `contentPackSchema` composes the module schemas for structural validation and
  type inference. The exported instance stays stateless so downstream tooling
  can call `contentPackSchema.parse` without inheriting warning collectors or
  runtime assumptions. This mirrors Zod's immutable API contract where methods
  always return new schema instances ([Zod README](https://raw.githubusercontent.com/colinhacks/zod/master/packages/zod/README.md#L86)).
- A validator factory wraps the base schema with cross-reference checks,
  normalisation, and warning aggregation. The allowlist inputs accept either
  arrays or sets so CLI JSON/YAML configs remain ergonomic (JSON cannot encode
  `Set` values without custom replacers per
  [MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify)):
- `ContentSchemaOptions.runtimeEventCatalogue` lets callers provide the core
  runtime event identifiers (for example, the union exported from
  `GENERATED_RUNTIME_EVENT_DEFINITIONS`) so the validator can flag dangling
  `onUnlockEvents` without importing `@idle-engine/core`:
- `ContentSchemaOptions.activePackIds` lists pack slugs already installed in
  the authoring environment; optional dependencies missing from this concrete
  set emit warnings instead of quietly passing validation.

```ts
// z imported from 'zod'
type ContentId = z.infer<typeof contentIdSchema>;
type PackId = z.infer<typeof packSlugSchema>;
type AllowlistEntries = readonly string[] | ReadonlySet<string>;

interface AllowlistSpecInput {
  readonly required?: AllowlistEntries;
  readonly soft?: AllowlistEntries;
}

interface NormalizedAllowlistSpec {
  readonly required: ReadonlySet<string>;
  readonly soft: ReadonlySet<string>;
}

type SchemaWarningSeverity = 'error' | 'warning' | 'info';

export interface SchemaWarning {
  readonly code: string;
  readonly message: string;
  readonly path: readonly (string | number)[];
  readonly severity: SchemaWarningSeverity;
  readonly suggestion?: string;
  readonly issues?: readonly z.ZodIssue[];
}

export interface ContentSchemaOptions {
  readonly allowlists?: {
    readonly flags?: AllowlistSpecInput;
    readonly scripts?: AllowlistSpecInput;
    readonly systemAutomationTargets?: AllowlistSpecInput;
  };
  readonly runtimeVersion?: string;
  readonly knownPacks?: readonly {
    readonly id: PackId;
    readonly version: string;
    readonly requires?: readonly {
      readonly packId: PackId;
      readonly version?: string;
    }[];
  }[];
  readonly runtimeEventCatalogue?: AllowlistEntries;
  readonly activePackIds?: AllowlistEntries;
  readonly warningSink?: (warning: SchemaWarning) => void;
}

export interface ContentPackValidationResult {
  readonly pack: NormalizedContentPack;
  readonly warnings: readonly SchemaWarning[];
}

type ContentPackInput = z.input<typeof baseContentPackSchema>;

type ContentPackSafeParseSuccess = {
  readonly success: true;
  readonly data: ContentPackValidationResult;
};

type ContentPackSafeParseFailure = {
  readonly success: false;
  readonly error: z.ZodError<ContentPackInput>;
};

type ContentPackSafeParseResult =
  | ContentPackSafeParseSuccess
  | ContentPackSafeParseFailure;

const toArray = (entries: AllowlistEntries | undefined): readonly string[] =>
  entries ? Array.from(entries) : [];

const normalizeAllowlistEntries = (
  entries: AllowlistEntries | undefined,
  schema: z.ZodType<string>,
  severity: SchemaWarningSeverity,
  warningSink: (warning: SchemaWarning) => void,
  pathPrefix: readonly (string | number)[],
): ReadonlySet<string> => {
  const normalized = new Set<string>();
  const issues: z.ZodIssue[] = [];
  toArray(entries).forEach((value, index) => {
    const result = schema.safeParse(value);
    if (!result.success) {
      const entryPath = [...pathPrefix, index];
      if (severity === 'error') {
        for (const issue of result.error.issues) {
          issues.push({
            ...issue,
            path: [...entryPath, ...issue.path],
          });
        }
        return;
      }
      warningSink({
        code: severity === 'warning'
          ? 'allowlist.invalidSoftEntry'
          : 'allowlist.invalidEntry',
        message: `Allowlist entry "${value}" failed validation.`,
        path: entryPath,
        severity,
        issues: result.error.issues,
      });
      return;
    }
    normalized.add(result.data);
  });
  if (severity === 'error' && issues.length > 0) {
    throw new z.ZodError(issues);
  }
  return normalized;
};

const normalizeAllowlistSpec = (
  spec: AllowlistSpecInput | undefined,
  schema: z.ZodType<string>,
  warningSink: (warning: SchemaWarning) => void,
  pathPrefix: readonly (string | number)[],
): NormalizedAllowlistSpec => ({
  required: normalizeAllowlistEntries(
    spec?.required,
    schema,
    'error',
    warningSink,
    [...pathPrefix, 'required'],
  ),
  soft: normalizeAllowlistEntries(
    spec?.soft,
    schema,
    'warning',
    warningSink,
    [...pathPrefix, 'soft'],
  ),
});

const normalizeRuntimeEventCatalogue = (
  entries: AllowlistEntries | undefined,
): ReadonlySet<string> =>
  new Set(
    toArray(entries).map((eventType) => contentIdSchema.parse(eventType)),
  );

const normalizeActivePackIds = (
  entries: AllowlistEntries | undefined,
): ReadonlySet<PackId> =>
  new Set(toArray(entries).map((packId) => packSlugSchema.parse(packId)));

// Reusing `contentIdSchema` keeps runtime catalogue entries canonicalised, so
// downstream comparisons against author-supplied ids remain case-insensitive.
// Invalid allowlist entries become contextual warnings for `soft` sets, while
// `required` entries accumulate their underlying `ZodIssue`s and raise a fresh
// `ZodError` whose paths point at `options.allowlists.<key>.required[index]`.
// This mirrors Zod’s guidance on surfacing issues from effects
// (`superRefine` / `safeParse`) without discarding the enriched path metadata or
// halting validation after the first failure.[^zod-superrefine]

export const FEATURE_GATES = [
  {
    module: 'automations',
    introducedIn: '0.2.0',
    docRef: 'docs/idle-engine-design.md (§9, §18)',
  },
  {
    module: 'transforms',
    introducedIn: '0.3.0',
    docRef: 'docs/idle-engine-design.md (§6)',
  },
  {
    module: 'runtimeEvents',
    introducedIn: '0.3.0',
    docRef: 'docs/runtime-event-pubsub-design.md',
  },
  {
    module: 'prestigeLayers',
    introducedIn: '0.4.0',
    docRef: 'docs/idle-engine-design.md (§6, §18)',
  },
  {
    module: 'guildPerks',
    introducedIn: '0.5.0',
    docRef: 'docs/idle-engine-design.md (§18)',
  },
] as const;
```

The helper functions in `runtime-compat.ts` expose `resolveFeatureViolations(
runtimeVersion, pack)` so `validateCrossReferences` can emit structured errors
for unsupported modules while still allowing the CLI to display contextual
documentation links.

```ts
const baseContentPackSchema = z
  .object({
    metadata: metadataSchema,
    resources: z.array(resourceDefinitionSchema),
    generators: z.array(generatorDefinitionSchema),
    upgrades: z.array(upgradeDefinitionSchema),
    metrics: z.array(metricDefinitionSchema).default([]),
    achievements: z.array(achievementDefinitionSchema).default([]),
    automations: z.array(automationDefinitionSchema).default([]),
    transforms: z.array(transformDefinitionSchema).default([]),
    prestigeLayers: z.array(prestigeLayerSchema).default([]),
    guildPerks: z.array(guildPerkSchema).default([]),
    runtimeEvents: z.array(runtimeEventContributionSchema).default([]),
  })
  .strict();

export const contentPackSchema = baseContentPackSchema;

const buildContentPackEffectsSchema = (
  options: ContentSchemaOptions,
  warningSink: (warning: SchemaWarning) => void,
) =>
  baseContentPackSchema
    .superRefine((pack, ctx) =>
      validateCrossReferences(pack, ctx, {
        allowlists: options.allowlists
          ? {
              flags: normalizeAllowlistSpec(
                options.allowlists.flags,
                flagIdSchema,
                warningSink,
                ['options', 'allowlists', 'flags'],
              ),
              scripts: normalizeAllowlistSpec(
                options.allowlists.scripts,
                scriptIdSchema,
                warningSink,
                ['options', 'allowlists', 'scripts'],
              ),
              systemAutomationTargets: normalizeAllowlistSpec(
                options.allowlists.systemAutomationTargets,
                systemAutomationTargetIdSchema,
                warningSink,
                ['options', 'allowlists', 'systemAutomationTargets'],
              ),
            }
          : undefined,
        warningSink,
        runtimeEventCatalogue: normalizeRuntimeEventCatalogue(
          options.runtimeEventCatalogue,
        ),
        runtimeVersion: options.runtimeVersion,
        activePackIds: normalizeActivePackIds(options.activePackIds),
      }),
    )
    .transform((pack) =>
      normalizeContentPack(pack, {
        runtimeVersion: options.runtimeVersion,
        warningSink,
      }),
    );

export const createContentPackValidator = (
  options: ContentSchemaOptions = {},
) => ({
  parse(input: unknown): ContentPackValidationResult {
    const warnings: SchemaWarning[] = [];
    const sink = (warning: SchemaWarning) => {
      warnings.push(warning);
      options.warningSink?.(warning);
    };
    const schema = buildContentPackEffectsSchema(options, sink);
    const pack = schema.parse(input);
    return { pack, warnings };
  },
  safeParse(input: unknown): ContentPackSafeParseResult {
    const warnings: SchemaWarning[] = [];
    const sink = (warning: SchemaWarning) => {
      warnings.push(warning);
      options.warningSink?.(warning);
    };
    const schema = buildContentPackEffectsSchema(options, sink);
    const result = schema.safeParse(input);
    if (result.success) {
      const success: ContentPackSafeParseSuccess = {
        success: true,
        data: { pack: result.data, warnings },
      };
      return success;
    }
    const failure: ContentPackSafeParseFailure = {
      success: false,
      error: result.error,
    };
    return failure;
  },
});

export const parseContentPack = (
  input: unknown,
  options?: ContentSchemaOptions,
): ContentPackValidationResult =>
  createContentPackValidator(options).parse(input);
```

- `runtime-compat.ts` hosts the feature gate matrix consumed by the validator.
  Helper utilities such as `resolveFeatureViolations(runtimeVersion, pack)`
  surface structured errors with links back to `docs/idle-engine-design.md` and
  `docs/runtime-event-pubsub-design.md` so authors understand when newer modules
  require runtime upgrades.
- Consumers that need cross-reference enforcement, normalisation, or warnings
  use `createContentPackValidator().parse` (or `parseContentPack`). Every call
  composes a fresh `ZodEffects` instance, preserving Zod's immutable guarantees
  and avoiding shared mutable state even when runs happen concurrently.
- `safeParse` mirrors the standard Zod API: successful parses return the
  normalised pack plus collected warnings, while failures surface the
  `ZodError<ContentPackInput>` emitted by `SafeParseReturnType<Input, Output>`
  so callers receive error paths in terms of the authored payload[^zod-safeparse].
  Direct calls to
  `contentPackSchema.parse` remain available for structural checks only (no
  cross-reference analysis or warnings).

[^zod-safeparse]: `SafeParseReturnType<Input, Output>` and
`SafeParseError<Input>` from the published `zod@3.23.8` type definitions show
that failure errors are parameterised over the input payload. See
`package/v3/types.d.ts` lines 44-70 inside the npm tarball:
https://registry.npmjs.org/zod/-/zod-3.23.8.tgz
[^zod-superrefine]: *Custom errors* — Zod Documentation. Demonstrates emitting
explicit issues inside `refine`/`superRefine` so invalid input fails parsing
with a `ZodError`. https://zod.dev/?id=custom-errors
[^core-automation-tests]: `packages/core/src/index.test.ts:676` and
`packages/core/src/index.test.ts:700` exercise automation toggles keyed by
canonical ids when emitting runtime events, underscoring why transform
automation triggers must capture the exact `automationId`.
- `validateCrossReferences` performs:
  - Id uniqueness within each module. Resources, generators, upgrades, metrics,
    achievements, automations, transforms, prestige layers, guild perks, and
    runtime events reject duplicate slugs inside their respective arrays, while
    cross-module reuse remains legal so content authors can intentionally mirror
    naming (for example, keeping an automation toggle slug aligned with the
    resource it affects). Reserved namespaces (such as the
    `idle-engine/` prefix) are still blocked globally.
  - Ensuring conditions reference defined ids across resources, generators,
    upgrades, prestige layers, and allowlisted flags and scripts; additional
    condition variants will extend this graph as new predicates ship.
  - Verifying generator `produces` / `consumes` entries, upgrade `targets` and
    `effects` (by `kind`), metric bindings, achievement `track` handles,
    automation
    `targetId`/`systemTargetId` and event-trigger handles, transform
    `inputs`/`outputs` plus optional `automationId`, runtime event `emits`
    handles, and prestige reset/reward resources resolve against
    declared entities, matching the pipeline guarantees laid out in
    `docs/idle-engine-design.md` §10.
  - Checking `customMetric` achievement tracks and automation/resource bindings
    against the pack's metric catalogue, verifying metric `source` hooks (e.g.,
    script bindings) against the relevant allowlists, emitting errors when
    references are missing, and warnings when metrics declare attribute sets
    exceeding three keys (to deter high-cardinality exports).
  - Enforcing runtime feature gates by comparing the parsed pack to the
    `FEATURE_GATES` map. When `ContentSchemaOptions.runtimeVersion` is provided,
    modules declared in the pack must satisfy their minimum runtime ranges; the
    validator emits errors for hard violations and warnings when the pack relies
    on features newer than the supplied runtime.
  - Validating `metadata.dependencies` by checking for self-references, duplicate
    pack ids, conflicting version ranges, and dependency cycles. When callers
    supply `ContentSchemaOptions.knownPacks`, the validator merges the pack's
    `requires` edges with the known graph (using the optional
    `requires` metadata on each known pack) to detect multi-pack cycles and flag
    incompatible version ranges. When `knownPacks` lacks an entry for a declared
    dependency, the validator records a warning (so unpublished packs remain
    authorable) while still catching self-references and duplicate ids.
    Optional dependencies compare against `options.activePackIds`; entries
    missing from that concrete set emit `optionalDependency.missing` warnings,
    while absent context downgrades the check to an informational note.
  - Detecting orphaned prestige currencies (reward resources marked prestige but
    not defined).
  - Blocking ids that attempt to use engine-reserved namespace segments (e.g.,
    an `idle-engine/` prefix), complementing the `contentIdSchema` slug rules.
  - Resolving `flag` and `script` conditions against the caller-provided
    allowlists using their canonical slug forms, treating ids in the `required`
    sets as hard dependencies while emitting warnings when lookups fail for
    entries marked `soft`. Invalid allowlist entries are caught during
    normalisation via the `allowlist.invalid*` warning codes so misconfigured
    options surface as structured errors instead of exploding during schema
    construction. The same lookups cover `grantFlag` upgrade effects and
    achievement rewards so flags cannot be granted unless they are declared in
    the active allowlist.
  - Rejecting runtime event contributions whose canonical id collides with an
    entry in the caller-supplied catalogue (including core manifests). The
    runtime bus refuses duplicate registrations already
    (`packages/core/src/events/event-bus.ts:330`), so catching collisions during
    schema validation keeps packs from producing manifests that would fail at
    bootstrap time.
  - Confirming `achievementDefinition.onUnlockEvents` ids exist in the merged
    runtime event catalogue built from the pack's own contributions plus the
    caller-supplied `ContentSchemaOptions.runtimeEventCatalogue`. When the
    catalogue is provided, missing ids become structured errors so packs cannot
    ship dangling hooks into the event bus defined in
    `docs/runtime-event-pubsub-design.md`; if the caller omits the catalogue, the
    validator emits warnings instead to keep authoring possible before the core
    manifest is available locally.
  - Detecting cyclic dependencies across unlock and visibility conditions by
    constructing a monotonic dependency graph. Nodes cover the entity classes
    that conditions can reference directly (`resources`, `generators`,
    `upgrades`, `prestigeLayers`, plus allowlisted `flags`/`scripts`) and extend
    to `automations`, `transforms`, `guildPerks`, and `achievements` through the
    derived relationships captured elsewhere in the schema (for example upgrade
    `targets`, automation bindings, and transform references). Positive
    predicates (thresholds, ownership, allowlisted flags/scripts) and the
    derived relationships above produce graph edges. Negated predicates and
    `anyOf` disjunction branches remain advisory constraints and are excluded
    from the strongly connected component walk, preventing absence-based gating
    from masquerading as a positive cycle. Depth-first search with path tracking
    raises a structured error when a positive loop (`A → B → … → A`) is
    discovered, pointing at the chain of ids that must be broken.
  - Walking every `numericFormulaSchema` node—including nested `piecewise`
    segments, expression trees, and function call arguments—to collect
    `{ target: { type, id } }` references. Each referenced id is validated
    against the same lookup tables used for conditions, guaranteeing that
    authored formulas cannot silently reference undefined resources, generators,
    upgrades, automations, or prestige layers.
  - Emitting warnings (captured via `SchemaWarning` array) for soft issues such
    as steep cost curves or missing localisation variants.
- `normalizeContentPack` sorts arrays deterministically, injects derived lookup
  maps, applies default booleans, and produces hashes used by the compiler.

### 5.17 Normalisation & Derived Artifacts

- `normalizeContentPack` returns a `NormalizedContentPack`:

```ts
type ContentId = z.infer<typeof contentIdSchema>;
type PackId = z.infer<typeof packSlugSchema>;

interface NormalizedContentPack {
  readonly metadata: NormalizedMetadata;
  readonly resources: readonly NormalizedResource[];
  readonly generators: readonly NormalizedGenerator[];
  readonly upgrades: readonly NormalizedUpgrade[];
  readonly metrics: readonly NormalizedMetric[];
  readonly achievements: readonly NormalizedAchievement[];
  readonly automations: readonly NormalizedAutomation[];
  readonly transforms: readonly NormalizedTransform[];
  readonly prestigeLayers: readonly NormalizedPrestigeLayer[];
  readonly guildPerks: readonly NormalizedGuildPerk[];
  readonly runtimeEvents: readonly NormalizedRuntimeEventContribution[];
  readonly lookup: {
    readonly resources: ReadonlyMap<ContentId, NormalizedResource>;
    readonly generators: ReadonlyMap<ContentId, NormalizedGenerator>;
    readonly upgrades: ReadonlyMap<ContentId, NormalizedUpgrade>;
    readonly metrics: ReadonlyMap<ContentId, NormalizedMetric>;
    readonly achievements: ReadonlyMap<ContentId, NormalizedAchievement>;
    readonly automations: ReadonlyMap<ContentId, NormalizedAutomation>;
    readonly transforms: ReadonlyMap<ContentId, NormalizedTransform>;
    readonly prestigeLayers: ReadonlyMap<ContentId, NormalizedPrestigeLayer>;
    readonly guildPerks: ReadonlyMap<ContentId, NormalizedGuildPerk>;
    readonly runtimeEvents: ReadonlyMap<
      ContentId,
      NormalizedRuntimeEventContribution
    >;
  };
  readonly serializedLookup: {
    readonly resourceById: Readonly<Record<string, NormalizedResource>>;
    readonly generatorById: Readonly<Record<string, NormalizedGenerator>>;
    readonly upgradeById: Readonly<Record<string, NormalizedUpgrade>>;
    readonly metricById: Readonly<Record<string, NormalizedMetric>>;
    readonly achievementById: Readonly<Record<string, NormalizedAchievement>>;
    readonly automationById: Readonly<Record<string, NormalizedAutomation>>;
    readonly transformById: Readonly<Record<string, NormalizedTransform>>;
    readonly prestigeLayerById: Readonly<
      Record<string, NormalizedPrestigeLayer>
    >;
    readonly guildPerkById: Readonly<Record<string, NormalizedGuildPerk>>;
    readonly runtimeEventById: Readonly<
      Record<string, NormalizedRuntimeEventContribution>
    >;
  };
  readonly digest: {
    readonly version: number;
    readonly hash: string;
  };
}
```

- `normalizeContentPack` accepts a `NormalizationContext` containing the active
  runtime version (for compatibility checks) and the shared warning sink used
  by cross-reference validation.
- `NormalizedMetadata` preserves the `PackId` brand on `id`, keeping downstream
  dependency graphs scoped-id aware.
- Lookup maps retain the `ContentId` brand by exposing immutable `ReadonlyMap`
  instances for every module (resources, generators, upgrades, metrics,
  achievements, automations, transforms, prestige layers, guild perks, runtime
  events). `serializedLookup` carries the downgraded `Record<string, …>` copies
  used when emitting JSON so transport layers can remain brand-agnostic without
  polluting consumer types. Helper utilities convert between the two
  representations when persisting or hydrating packs.
- With metadata already parsed, `normalizeContentPack` threads the resulting
  `NormalizedMetadata` into `normalizeLocalizedText` calls for titles, names,
  summaries, and descriptions so locale mirroring and missing-translation
  warnings stay consistent across modules.
- Metric normalisation emits `NormalizedMetric` entries with sorted attribute
  keys, deduplicated values, the `'1'` unit fallback, and resolved source
  bindings so telemetry exports and CLI reports stay deterministic.
- Digests use FNV-1a hashing aligned with runtime manifest hashing. Version
  increments whenever schema-breaking transformations occur. The hash excludes
  transient warning data so identical author input yields stable digests even
  when the warning set changes.
- Warnings follow the `SchemaWarning` contract (`{ code, message, path,
  severity, suggestion?, issues? }`) to support CLI displays and are returned
  alongside the normalized pack by the validator factory instead of being
  embedded in the normalized structure.
- Normalisation ensures arrays apply author-specified ordering keys when they
  exist (`order` on resources/generators/upgrades/metrics/automations/transforms/
  prestige/guild perks and `displayOrder` on achievements) and then fall back to
  canonical id comparisons, providing deterministic ties when authors omit
  explicit ordering. This avoids relying on JavaScript engine sort stability,
  keeps digests repeatable across runtimes, strips duplicate tags, and freezes
  string casing (ids lowercased, labels preserved). Helper utilities serialise
  the `ReadonlyMap` lookups into the accompanying `serializedLookup` object for
  persistence, and hydrate them back into branded maps when content packs are
  loaded.

### 5.18 Implementation Plan

1. Scaffold `packages/content-schema` with base tooling (tsconfig, lint, test).
2. Implement scalar schemas (`ids`, `numbers`, `localization`) with unit tests.
3. Land `numericFormulaSchema` and `conditionSchema`, including recursion guard
   tests and snapshot fixtures.
4. Implement module schemas incrementally with targeted validation tests:
   - `metadata` (including `dependencies`), `resources`, `generators`,
     `upgrades`, `metrics`, `achievements`, `automations`, `transforms`,
     `prestige`, `guild-perks`.
5. Add the runtime event contribution schema and manifest validation that
   mirrors `docs/runtime-event-manifest-authoring.md`, including fixtures for
   invalid schema paths and duplicate ids.
6. Compose `contentPackSchema`, wire up `createContentPackValidator` with a
   shared warning collector, implement `validateCrossReferences` (including the
   numeric-formula reference walk and cross-module cycle detector), and add
   failing fixtures covering duplicate ids, missing references, invalid
   formulas, and intertwined unlock loops.
7. Implement `normalizeContentPack`, compute digests, and expose typed lookup
   maps.
8. Update `tools/content-schema-cli` to consume the new package (follow-up PR),
   mirroring the structured error responses already used by social service
   routes. Wire validation into `pnpm test --filter content-schema` and add a
   lightweight `pnpm generate` step that refreshes schema digests alongside the
   event manifest pipeline.
9. Port `packages/content-sample` to validate via the schema in a separate
   change once the package stabilises.

### 5.19 Authoring Best Practices

- Provide human-readable error summaries and include `path` data so CLI
  consumers can surface issues consistently with existing Express handlers.
- Memoise normalised lookup maps between CLI runs to reduce validation latency
  for large packs.
- Normalise casing and deterministically sort arrays before hashing so content
  digests align with `docs/runtime-event-manifest-authoring.md`.
- Document schema additions in `docs/idle-engine-design.md` and call out
  migrations in `docs/implementation-plan.md` to keep the DSL contract in sync
  with runtime workstreams.
- Run `pnpm generate` after editing pack sources; the CLI validates packs via `@idle-engine/content-schema`, then compiles artifacts once validation succeeds, emitting structured JSON log entries (`content_pack.validated`, `content_pack.validation_failed`, `content_pack.compiled`, `watch.run`, etc.) for downstream automation.
- Use `pnpm generate --check` in CI, Lefthook, and verification scripts to detect drift without rewriting artifacts. `--watch` keeps the pipeline alive during authoring but still marks failures while emitting `watch.run` summaries so you can fix issues before exit.
- Treat `content/compiled/index.json` (or any path supplied via `--summary`) as the canonical workspace summary. If validation fails or the CLI reports drift, rerun `pnpm generate` before consuming the summary or committing compiled artifacts to avoid shipping stale data.
- Keep authoring sources in `<package>/content/pack.json`, resolve warnings before publishing, and annotate intentional suppressions so migration scripts can distinguish deliberate exceptions from regressions.

## 6. Testing Strategy

- Unit tests for each schema module covering success and failure cases, ensuring
  error messages include context (id, field path, offending value).
- Property-based tests for `numericFormulaSchema` ensuring generated exponential
  or linear curves remain finite and monotonic where required.
- Integration fixtures for full packs: valid sample pack, pack missing resource
  references, pack with cyclic unlock conditions, pack with localisation gaps,
  pack with dependency cycles, and pack with invalid runtime event contributions
  (missing schema paths or duplicate ids).
- Validator factory tests ensure `createContentPackValidator` returns collected
  warnings (missing translations, flagged scripts) alongside normalised packs.
- Snapshot tests for `normalizeContentPack` verifying deterministic ordering and
  digest stability.
- Type-level tests (using `expectTypeOf`) to ensure inferred types align with
  runtime expectations.

## 7. Risks & Mitigations

- **Formula explosion**: Recursive expression parsing may allow deeply nested
  structures, risking performance issues. Mitigate with recursion depth limits
  and AST node count caps inside `expressionNodeSchema`.
- **Schema drift vs runtime**: Runtime may evolve faster than schema updates.
  Mitigate by adding CI checks that `@idle-engine/core` validates resource
  definitions against the schema digest before publish.
- **Author friction**: Strict schemas may frustrate early adopters. Mitigate
  with descriptive error messages and non-fatal warnings for soft constraints.
- **Compatibility versioning**: Packs targeting older runtime versions must
  continue to parse. Mitigate by versioning schema transforms and allowing the
  compiler to downgrade gracefully when `metadata.engine` excludes new features.
- **Transform loops**: Misconfigured transforms may create runaway production
  chains. Mitigate by enforcing `safety` guards in the schema and covering loop
  detection in integration tests.
- **Performance**: Running complex validation on large content packs could be
  slow. Mitigate by caching normalised results and reusing lookup maps between
  CLI runs.

## 8. Decisions & Clarifications

- Ids are case-insensitive in validation but canonicalised to lowercase for
  deterministic hashing; `contentIdSchema` performs the lowercasing transform
  so display casing belongs exclusively in localisation strings.
- Pack metadata and dependency edges use `packSlugSchema`, allowing scoped
  identifiers such as `@idle-engine/core` while other module ids continue to
  rely on the stricter `contentIdSchema`.
- Schemas reject unknown keys to catch typos early; authors must explicitly
  include new fields when the schema evolves.
- Localised strings require at least the default locale; additional variants are
  optional but flagged when missing for locales declared in
  `metadata.supportedLocales`.
- Numeric formulas accept finite numbers only; `Infinity` is modelled through
  explicit flags (`capacity: null`) instead of raw numeric values.
- Warnings are returned alongside the normalised payload; it is up to CLI and
  compiler tooling to decide whether to treat specific warning codes as errors.
- Lookup tables are serialized as plain objects for transport; helper utilities
  create transient `Map` views when callers need richer ergonomics.

## 9. Acceptance Criteria

- `packages/content-schema` exists with exported schemas, inferred types, and
  Vitest coverage across every module (metadata + dependencies, resources,
  generators, upgrades, metrics, achievements, automations, transforms, prestige,
  guild perks, runtime event contributions).
- `createContentPackValidator.parse` (and the exported `parseContentPack`
  helper) validate sample fixtures, emit expected warnings, and produce deterministic
  normalised output with digest metadata, serialisable lookup objects, and
  branded `ContentId` keyed maps.
- Cross-reference validation rejects packs with missing or duplicate ids,
  dangling conditions, invalid formula references, runtime event contributions
  that cite unknown emitters, and dependency cycles whenever the caller
  provides sufficient `knownPacks.requires` data to build the cross-pack graph.
- Runtime compatibility gates reject packs that include modules introduced after
  the target runtime (`ContentSchemaOptions.runtimeVersion`), while emitting
  contextual warnings when the pack straddles newer features.
- Achievement `onUnlockEvents` lists are validated against the merged runtime
  event catalogue so packs cannot ship dangling hooks.
- Localisation checks ensure `metadata.supportedLocales` lists are honoured and
  missing variants surface as structured warnings.
- Documentation updates link this design with `docs/implementation-plan.md`
  and `docs/idle-engine-design.md`.
- A follow-up work item is opened to integrate the schema into
  `tools/content-schema-cli` and the sample content pack.

## 10. Open Questions & Follow-Ups

- Should the schema expose calculated presentation defaults (e.g., auto-generated
  icon paths) or leave that to the compiler?
- How will guild perk costs interface with social-service data when live
  persistence lands?
- Do we need additional effect types (e.g., scripted modifiers) before schema
  v1.0, or can they wait for the scripting design doc?
- What is the migration strategy when schema digests change (e.g., do we embed
  the digest into save files similar to event manifests)?
- Migrate remaining TypeScript/hand-authored sample data into the CLI-discoverable pack format and ensure the forthcoming DSL compiler emits the same schema-normalised structures.
