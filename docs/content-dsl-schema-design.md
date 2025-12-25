---
title: Content DSL Schema Design
---

# Content DSL Schema Design

This design document specifies the canonical Zod schema contract for Idle Engine content packs. The schema guards authoring-time invariants, normalises inputs for the compiler, and aligns with the content expectations outlined in the main engine design.

## Document Control
- **Title**: Define canonical Zod schema contract for content DSL
- **Authors**: Design team
- **Reviewers**: N/A
- **Status**: Design
- **Last Updated**: 2025-10-18
- **Related Issues**: #11
- **Execution Mode**: AI-led

## 1. Summary

The Idle Engine content DSL bridges designer-authored data and the deterministic runtime. Today, sample packs provide ad-hoc TypeScript interfaces, but the monorepo lacks an enforceable schema. This document specifies the Zod schemas, normalisation rules, and validation flow that future CLI tooling will use before content is compiled into runtime-ready definitions. The goal is to deliver a single package that validates metadata, resources, generators, upgrades, metrics, achievements, prestige layers, automations, transforms, runtime event extensions, guild perks, and pack dependency metadata while providing strong typing for TypeScript consumers.

## 2. Context & Problem Statement

### Background
- `packages/content-sample/src/index.ts` now re-exports the compiler-generated sample pack (rehydrated content, digest, summary, indices), maintaining the import-time warning guard without reparsing `content/pack.json`.
- No shared schema package exists. Content authors must rely on informal conventions captured in `docs/idle-engine-design.md`.
- `tools/content-schema-cli` is a stub focused on runtime event manifests and does not validate content pack data.
- Tests, lint rules, and CI do not exercise schema validation because the schema is missing.

### Problem
The monorepo lacks an enforceable schema for content packs. Authors cannot validate their content at authoring time, leading to errors discovered late in the pipeline. There is no canonical source of truth for content structure, and runtime expectations are not aligned with authoring-time validation.

### Forces
- Must support localisation-ready text, formula-driven values, and unlock conditions without constraining downstream compiler optimisations.
- Schema evolution must remain explicit through semantic metadata, enabling future packs to opt into new capabilities without breaking prototype-era content.
- Performance is critical for large content packs during CLI validation.
- Backward compatibility with existing runtime versions must be maintained.

## 3. Goals & Non-Goals

### Goals
1. Provide a canonical `@idle-engine/content-schema` package exporting Zod schemas and inferred TypeScript types for every content DSL module, including metrics, achievements, runtime event definitions, and pack dependency metadata.
2. Normalise author input (trim strings, apply defaults, sort deterministically) so the compiler and runtime receive stable, replayable definitions.
3. Surface referential, balancing, and compatibility errors at authoring time with actionable messages for future CLI integrations.
4. Support localisation-ready text, formula-driven values, and unlock conditions without constraining downstream compiler optimisations.
5. Keep schema evolution explicit through semantic metadata, enabling future packs to opt into new capabilities without breaking prototype-era content.

### Non-Goals
- Implementing the compiler that emits runtime-ready typed arrays, manifests, or worker bundles (tracked in a follow-up issue).
- Executing or optimising numeric formulas beyond structural validation.
- Delivering the localisation pipeline, documentation site generation, or in-editor authoring experience.
- Shipping gameplay logic changes in the runtime; this document only constrains the content contract.
- Rewriting existing sample data; migrations will land once the schema package exists.

## 4. Stakeholders, Agents & Impacted Surfaces

### Primary Stakeholders
- Content authors who create game content using the DSL
- Runtime implementation team
- CLI tooling maintainers

### Agent Roles
- **Schema Implementation Agent**: Implements Zod schemas for all content modules
- **Validation Agent**: Implements cross-reference validation and normalisation
- **Testing Agent**: Creates comprehensive test suites for schema validation

### Affected Packages/Services
- `packages/content-schema` (new package)
- `packages/content-sample`
- `tools/content-schema-cli`
- `packages/core` (runtime validation alignment)

### Compatibility Considerations
- Schema must validate content packs targeting different runtime versions
- Backward compatibility through `metadata.engine` semver ranges
- Forward compatibility through feature gates aligned with runtime milestones

## 5. Current State

The current state is outlined in section 2 (Context & Problem Statement - Background). Key points:
- Sample packs use ad-hoc TypeScript interfaces
- No shared schema package exists
- Content validation is informal and convention-based
- CLI tooling is incomplete

## 6. Proposed Solution

### 6.1 Architecture Overview

**Narrative**: Create a new `packages/content-schema` package that exports Zod schemas for all content DSL modules. The package provides both structural validation (via base schemas) and semantic validation (via a validator factory that performs cross-reference checking, normalisation, and warning collection). Content flows through: raw input → structural parse → cross-reference validation → normalisation → output with warnings.

**Diagram**: N/A

### 6.2 Detailed Design

#### Package Layout & Ownership

Create `packages/content-schema` exporting common schema primitives, DSL module schemas, and composite pack schemas. The package remains private until the contract is stabilised.

Structure:
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
  pack/
    index.ts
    schema.ts
    normalize.ts
    validate-cross-references.ts
    validate-dependencies.ts
    validate-cycles.ts
    types.ts
    utils.ts
  errors.ts
  vitest.config.ts
```

`index.ts` re-exports the base `contentPackSchema`, the `createContentPackValidator` factory, a convenience `parseContentPack` helper that returns `{ pack, warnings }`, `NormalizedContentPack`, and other targeted schemas for focused validation.

#### Shared Scalar Schemas & Utilities

Define shared primitives with Zod brands for stronger inference:

- `contentIdSchema`: case-insensitive slug `[A-Za-z0-9][A-Za-z0-9-_/.:]{0,63}` trimmed and canonicalised to lowercase via `.transform`, ensuring consistent hashing while still accepting mixed author input. The transform rebrands the result with `.pipe(z.string().brand<'ContentId'>())` so TypeScript keeps the nominal type. The grammar deliberately excludes `@`, keeping scoped identifiers reserved for pack slugs.

- `packSlugSchema`: accepts both unscoped ids (`sample-pack`) and npm-style scoped ids (`@idle-engine/core`), trimming whitespace, collapsing duplicate separators, and canonicalising to lowercase before rebranding the output with `PackId`. The schema mirrors npm's published scope rules—`@scope/name` with URL-safe characters—so content packs can reference workspace packages such as `@idle-engine/core` without loosening the general-purpose DSL id grammar.

- `localeCodeSchema`: BCP-47 compliant subset matching language tags used in the UI.

- `flagIdSchema` and `scriptIdSchema`: trimmed, lowercase slugs that reuse the content id grammar but keep bespoke `FlagId`/`ScriptId` brands. Normalisation collapses duplicate separators and canonicalises casing so allowlists and authored packs compare against the same canonical form.

- `systemAutomationTargetIdSchema`: alias for curated system toggle ids (`offline-catchup`, `research-daemon`, etc.) that trims, lowercases, and validates the identifier against an enum derived from the runtime.

- `semverSchema` and `semverRangeSchema`: validated via the `semver` library (`semver@7`) inside `.superRefine`.

- `hexColorSchema`, `iconPathSchema`, `urlSchema` for UI metadata.

- `nonNegativeNumberSchema`, `percentSchema`, `positiveIntSchema`.

**Localised Text Schema**:

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

`localizedTextSchema` treats the `default` field as the authoritative copy for the pack's default locale. Localised transforms run inside `normalizeContentPack`, where `normalizeLocalizedText(metadata, text, warningSink)` backfills a missing `variants[metadata.defaultLocale]` entry so localisation tools that expect keyed entries remain compatible without forcing authors to duplicate strings. When authors supply a variant that differs from `default`, the helper records a warning instead of overwriting the authored copy so intentional locale tweaks remain intact.

`localizedSummarySchema` extends the same structure with a relaxed ceiling (`max(512)`) for synopsis copy so `metadata.summary` can hold longer blurbs.

All schemas are `strict()` to reject unknown keys. Optional fields apply defaults through `.default` or `.transform`, and scalar schemas use `.coerce` where CLI or JSON-driven inputs frequently arrive as strings.

#### Numeric Formula Schema

Provide `numericFormulaSchema`, a discriminated union that supports both common progression curves and explicit expressions:

- `constant`: `{ kind: 'constant'; value: number }`
- `linear`: `{ kind: 'linear'; base: number; slope: number }`
- `exponential`: `{ kind: 'exponential'; base?: number; growth: number; offset?: number }` (`base` defaults to `1`)
- `polynomial`: `{ kind: 'polynomial'; coefficients: number[] }`
- `piecewise`: `{ kind: 'piecewise'; pieces: { untilLevel?: number; formula: NumericFormula }[] }`
- `expression`: embeds an AST validated by `expressionNodeSchema`

Expression nodes form a recursive Zod schema using `z.lazy` with node types:

- `literal`: constant number
- `ref`: structured references that avoid stringly typed identifiers. The schema permits either runtime variables `{ kind: 'ref'; target: { type: 'variable'; name: 'level' | 'time' | 'deltaTime' } }` or entity handles `{ kind: 'ref'; target: { type: 'resource' | 'generator' | 'upgrade' | 'automation' | 'prestigeLayer'; id: ContentId } }`
- `binary`: `op` in `{ add, sub, mul, div, pow, min, max }` with two operands
- `unary`: `op` in `{ abs, ceil, floor, round, sqrt, log10, ln }`
- `call`: named function (e.g., `clamp`, `lerp`) with `args: Expression[]`

Validation enforces finite numbers, non-empty coefficient arrays, and monotonic `piecewise` sequences. Piecewise nodes must supply strictly increasing `untilLevel` values and terminate with a catch-all segment (omitting `untilLevel`) so evaluation order stays deterministic. Structured references keep lookups type-aware—validators dispatch by `target.type` without having to parse dotted strings—so the compiler can flag missing entities early while still permitting `level`/`time` references. Function call nodes are checked against a deterministic allowlist (`clamp`, `lerp`, `min3`, `max3`, `pow10`, `root`, etc.).

#### Condition Schema

`conditionSchema` uses `z.discriminatedUnion('kind', …)` so every node spells out the payload required for validation and graph analysis. The following TypeScript shape shows the intended structure:

```ts
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
  | {
      kind: 'prestigeCountThreshold';
      prestigeLayerId: ContentId;
      comparator?: 'gte' | 'gt' | 'lte' | 'lt'; // defaults to 'gte'
      count?: number; // positive int, defaults to 1
    }
  | { kind: 'prestigeCompleted'; prestigeLayerId: ContentId }
  | { kind: 'prestigeUnlocked'; prestigeLayerId: ContentId }
  | { kind: 'flag'; flagId: FlagId }
  | { kind: 'script'; scriptId: ScriptId }
  | { kind: 'allOf'; conditions: readonly Condition[] }
  | { kind: 'anyOf'; conditions: readonly Condition[] }
  | { kind: 'not'; condition: Condition };
```

Conditions are `strict()` objects and reuse `numericFormulaSchema` wherever a numeric comparison is required. Cross-reference checks use the explicit `resourceId`, `generatorId`, `upgradeId`, and `prestigeLayerId` fields when validating existence and building dependency graphs.

Aggregation nodes (`allOf`, `anyOf`) require at least one nested condition via `.min(1)`. Cycle detection only introduces edges for monotonic predicates that participate in `allOf` and other positive contexts. Negated predicates (`not`) and disjunction branches (`anyOf`) still undergo existence checks, but they do not register graph edges.

`resourceThreshold` is permitted to reference the current resource in its own unlock condition (to model "unlock after first production"); this self-edge does not register as a cycle dependency.

##### Condition Evaluation Semantics (Runtime Behavior)

This subsection documents the **existing runtime implementation** of condition evaluation in `packages/core/src/condition-evaluator.ts`.

**Evaluation Context**:

Conditions are evaluated against live game state via a `ConditionContext` interface that provides:
- `getResourceAmount(resourceId: string): number`
- `getGeneratorLevel(generatorId: string): number`
- `getUpgradePurchases(upgradeId: string): number`
- `hasPrestigeLayerUnlocked?(prestigeLayerId: string): boolean`
- `isFlagSet?(flagId: string): boolean`
- `evaluateScriptCondition?(scriptId: string): boolean`
- `onError?: (error: Error) => void`

**Static Threshold Evaluation**:

Unlock conditions use **static thresholds** that do not scale with progression. All numeric formulas in unlock conditions are evaluated with `level: 0`. This differs from **dynamic cost curves** which evaluate with `level: purchaseIndex` to scale costs as players buy more units.

**Evaluation Rules by Condition Type**:

- **`always`**: Returns `true` immediately
- **`never`**: Returns `false`
- **`resourceThreshold`**: Retrieves current resource amount, evaluates `amount` formula with `level: 0`, compares using specified comparator
- **`generatorLevel`**: Retrieves generator owned count, evaluates `level` formula with `level: 0`, compares using specified comparator
- **`upgradeOwned`**: Checks if upgrade purchases ≥ `requiredPurchases` (defaults to 1)
- **`prestigeUnlocked`**: Uses `context.hasPrestigeLayerUnlocked(prestigeLayerId)` - checks if prestige layer is currently available/unlocked
- **`prestigeCompleted`**: Shorthand for "has prestiged at least once" - reads the prestige counter resource using convention `{prestigeLayerId}-prestige-count` and checks it is ≥ 1
- **`prestigeCountThreshold`**: Reads prestige counter resource, compares against `count` using `comparator`
- **`flag`**: Uses `context.isFlagSet(flagId)` when supplied
- **`script`**: Uses `context.evaluateScriptCondition(scriptId)` when supplied
- **`allOf`**: Returns `true` only if every condition passes (logical AND), short-circuits on first failure
- **`anyOf`**: Returns `true` if any condition passes (logical OR), short-circuits on first success
- **`not`**: Inverts the nested condition result

**Error Handling**:

Unknown condition kinds or comparators trigger fail-safe behavior:
- **Development**: Calls `context.onError(error)` for test assertions
- **Production**: Logs `console.warn(error.message)` and returns `false`
- **Rationale**: Graceful degradation prevents crashes when content contains unrecognized condition types

**Persistent Unlock Semantics**:

When conditions are used for `baseUnlock` on generators, the progression coordinator implements **persistent unlock** behavior. Once a generator's `baseUnlock` condition evaluates to `true`, the `isUnlocked` flag never reverts to `false`, even if the condition later fails. This ensures generators remain available after being discovered.

In contrast, `visibilityCondition` is re-evaluated every game step and can toggle between `true` and `false`.

When `visibilityCondition` is omitted, the runtime treats visibility as following
unlock by default: generators and upgrades stay hidden until unlocked, and
resources that start hidden become visible once unlocked.

**Human-Readable Descriptions**:

The runtime generates unlock hints for locked content using `describeCondition()`:
- `resourceThreshold` → "Requires energy >= 100"
- `generatorLevel` → "Requires reactor >= 5"
- `upgradeOwned` → "Requires owning 3× efficiency"
- `allOf` → "Requires energy >= 100, Requires reactor >= 5"
- `anyOf` → "Requires any of: energy >= 100 or reactor >= 5"
- `not` → "Not (Requires energy >= 100)"
- `always` → `undefined`
- `never` → "Unavailable in this build"

**Implementation Reference**:
- Condition evaluator: `packages/core/src/condition-evaluator.ts`
- Condition evaluation tests: `packages/core/src/condition-evaluator.test.ts`
- Progression coordinator integration: `packages/core/src/progression-coordinator.ts`

**Content Authoring Guidelines**:

1. Use `always` for unconditionally unlocked content
2. Avoid circular dependencies
3. Prefer simple thresholds over complex `allOf` nesting
4. Test negative conditions carefully (`not` and `anyOf` introduce non-monotonic logic)
5. Remember that `baseUnlock` is persistent—don't use it for temporary gates
6. Use `visibilityCondition` for temporary gates

#### Module Schemas

**Metadata Schema**:

`metadataSchema` covers content-level metadata:
- `id`: pack slug (`packSlugSchema`)
- `title`: `localizedTextSchema`
- `summary`: optional `localizedSummarySchema` with longer copy (≤512 chars)
- `version`: semantic version string validated by `semver`
- `engine`: semver range describing supported runtime versions
- `authors`: array of trimmed strings (≤64 chars) with de-duplication
- `defaultLocale`: `localeCodeSchema` that maps to the `title.default` property
- `supportedLocales`: non-empty array of `localeCodeSchema` entries representing every locale shipped with the pack
- `tags`: array of slugs (≤24 chars) reserved for tooling filters
- `links`: optional array of URL metadata `{ kind, label, href }`
- `createdAt` / `updatedAt`: ISO-8601 timestamps (optional)
- `visibility`: optional enum `public | private | experimental`
- `offlineProgression`: optional offline fast path metadata `{ mode, preconditions }` (preconditions: `constantRates`, `noUnlocks`, `noAchievements`, `noAutomation`, `modeledResourceBounds`)
- `dependencies`: optional object shaped by `packDependencySchema` with `requires`, `optional`, `conflicts`, and `provides` arrays

The schema normalises whitespace, enforces canonical casing, validates offline progression metadata, and ensures `engine` ranges include the active runtime version when known and that `supportedLocales` contains `defaultLocale`.

When authors pass `ContentSchemaOptions.runtimeVersion`, `validateCrossReferences` performs two compatibility checks:
1. `semver.satisfies(runtimeVersion, metadata.engine)` must be true
2. The validator consults the `FEATURE_GATES` map in `runtime-compat.ts` to ensure non-prototype modules match their minimum runtime versions

**Resource Schema**:

`resourceDefinitionSchema` extends the runtime-facing definition with content metadata:
- `id`: `contentIdSchema`
- `name`: `localizedTextSchema`
- `category`: enum (`primary`, `prestige`, `automation`, `currency`, `misc`)
- `economyClassification`: enum (`hard`, `soft`) - defaults to `soft`
- `tier`: positive integer for UI grouping
- `icon`: optional icon path (SVG/PNG) resolved at build time
- `startAmount`: non-negative number (defaults to `0`)
- `capacity`: nullable number; `null` maps to infinity at runtime
- `visible`: boolean default `true`
- `unlocked`: boolean default `false`
- `dirtyTolerance`: optional override (validated against runtime ceilings)
- `order`: optional float for deterministic sort
- `unlockCondition` / `visibilityCondition`: `conditionSchema` nodes
- `prestige`: optional block describing prestige currency linkage `{ layerId, resetRetention?: NumericFormula }`
- `tags`: array of slugs for analytics or UI filters

`.superRefine` performs per-definition checks including `startAmount ≤ capacity` when capacity is finite.

**Generator Schema**:

`generatorDefinitionSchema` models production structures:
- `id`, `name`, `icon`, `tags` similar to resources
- `produces`: array of `{ resourceId, rate: NumericFormula }`
- `consumes`: optional array of `{ resourceId, rate: NumericFormula }`
- `purchase`: strict object describing purchase costs (supports both single-currency and multi-resource forms)
- `initialLevel`: optional non-negative integer defaulting to `0`, applied as the starting owned count when initializing a new game state
- `maxLevel`: optional positive integer
- `order`: optional float controlling list ordering
- `baseUnlock`: `conditionSchema` gating initial availability
- `visibilityCondition`: `conditionSchema` for UI reveal
- `automation`: optional reference `{ automationId }` linking to automation definitions
- `effects`: optional array for generator-specific effects

Cross-validation ensures referenced resources exist, consumption and production rates are finite, and `maxBulk` respects `maxLevel`.

**Upgrade Schema**:

`upgradeDefinitionSchema` captures upgrade catalog entries:
- `id`, `name`, `icon`, `tags`
- `category`: enum (`global`, `resource`, `generator`, `automation`, `prestige`, `guild`)
- `targets`: array of typed handles
- `cost`: same schema as generator `purchase`
- `repeatable`: optional block describing stacking rules
- `prerequisites`: array of `conditionSchema` or upgrade ids
- `order`: optional float
- `effects`: array of discriminated union entries (modifyResourceRate, modifyResourceCapacity, modifyGeneratorRate, modifyGeneratorCost, modifyGeneratorConsumption, grantAutomation, grantFlag, unlockResource, unlockGenerator, alterDirtyTolerance, emitEvent)
- `unlockCondition` / `visibilityCondition`

Runtime semantics for repeatable upgrades are documented in detail in the source document.

**Metric Schema**:

`metricDefinitionSchema` describes pack-authored telemetry counters:
- `id`: `contentIdSchema` canonical slug
- `name`: `localizedTextSchema`
- `description`: optional `localizedSummarySchema`
- `kind`: enum (`counter`, `gauge`, `histogram`, `upDownCounter`) mapping onto OpenTelemetry instrument semantics
- `unit`: optional string validated against a trimmed ASCII grammar
- `aggregation`: optional enum (`sum`, `delta`, `cumulative`, `distribution`)
- `attributes`: optional array of attribute keys
- `source`: enum describing how the pack emits the metric (`runtime`, `script`, `content`)
- `order`: optional float

Validation rejects duplicate metric ids and surfaces warnings when attribute key counts exceed three.

**Achievement Schema**:

`achievementDefinitionSchema` models milestone tracking:
- `id`: `contentIdSchema`
- `name`: `localizedTextSchema`
- `description`: `localizedSummarySchema`
- `category`: enum (`progression`, `prestige`, `automation`, `social`, `collection`)
- `tier`: enum (`bronze`, `silver`, `gold`, `platinum`)
- `icon`: optional icon path
- `tags`: array for analytics or in-game filters
- `track`: discriminated union describing progress measurement (resource, generatorLevel, upgradeOwned, flag, script, customMetric)
- `progress`: object describing accumulation semantics with `target`, `mode`, and optional `repeatable` block
- `reward`: optional union (grantResource, grantUpgrade, grantGuildPerk, emitEvent, unlockAutomation, grantFlag)
- `unlockCondition` / `visibilityCondition`
- `onUnlockEvents`: optional array of runtime event ids
- `displayOrder`: optional float

Cross-validation ensures `progress.target` evaluates to a positive, finite number and referenced ids exist.

**Automation Schema**:

`automationDefinitionSchema` describes automation toggles:
- `id`: `contentIdSchema`
- `name`: `localizedTextSchema`
- `description`: `localizedTextSchema`
- `targetType`: enum (`generator`, `upgrade`, `purchaseGenerator`, `collectResource`, `system`)
- `targetId`: required when `targetType` is specific entity types
- `systemTargetId`: required when `targetType === 'system'`
- `trigger`: union of deterministic triggers (`interval`, `resourceThreshold`, `commandQueueEmpty`, `event`)
- `cooldown`: optional `NumericFormula` (ms; numeric shorthand allowed)
- `resourceCost`: optional upkeep cost schema
- `unlockCondition`: `conditionSchema`
- `visibilityCondition`: optional `conditionSchema`
- `enabledByDefault`: boolean default `false`
- `order`: optional float

System targets validate against a curated allowlist. Event-triggered automations are cross-checked against the merged runtime event catalogue.

**Transform Schema**:

`transformDefinitionSchema` captures deterministic conversions:
- `id`: `contentIdSchema`
- `name`: `localizedTextSchema`
- `description`: `localizedSummarySchema`
- `mode`: enum (`instant`, `continuous`, `batch`)
- `inputs`: non-empty array of `{ resourceId: ContentId; amount: NumericFormula }`
- `outputs`: non-empty array of `{ resourceId: ContentId; amount: NumericFormula }`
- `duration`: optional `NumericFormula` (ms) for timed conversions
- `cooldown`: optional `NumericFormula` (ms; numeric shorthand allowed)
- `trigger`: discriminated union (manual, automation, condition, event)
- `unlockCondition` / `visibilityCondition`
- `automation`: optional `{ automationId: ContentId }`
- `tags`: array for analytics/UX filters
- `safety`: optional guard specifying `maxRunsPerTick` and `maxOutstandingBatches`
- `order`: optional float

Validation confirms every transform references declared resources, batch modes declare a finite `duration`, and continuous transforms specify at least one consumption or production rate.

**Prestige Layer Schema**:

`prestigeLayerSchema` supports reset mechanics:
- `id`, `name`, `icon`
- `summary`: `localizedTextSchema`
- `resetTargets`: array of resource ids reset when the layer triggers
- `resetGenerators`: optional array of generator ids
- `resetUpgrades`: optional array of upgrade ids
- `unlockCondition`: `conditionSchema`
- `reward`: block specifying output currency
- `retention`: optional array describing retained resources/generators/upgrades
- `automation`: optional reference enabling auto-prestige triggers
- `order`: optional float

Validation enforces that prestige rewards reference prestige-class resources and that reset targets cover at least one non-prestige resource.

**Guild Perk Schema**:

`guildPerkSchema` provides hooks for social systems:
- `id`: `contentIdSchema`
- `name`: `localizedTextSchema`
- `description`: `localizedTextSchema`
- `category`: enum (`buff`, `utility`, `cosmetic`)
- `maxRank`: positive integer
- `effects`: union aligned with upgrade effects plus guild-specific entries
- `cost`: block referencing guild currency or contribution metrics
- `unlockCondition`: `conditionSchema`
- `order`: optional float
- `visibilityCondition`

Guild perks can be optional for prototype packs; schema allows empty arrays.

**Runtime Event Contribution Schema**:

Content packs augment the runtime event catalogue. The schema ensures authored entries align with the manifest generator:
- `id`: `contentIdSchema`, derived from canonical runtime event type `namespace:name`
- `namespace`: trimmed slug (≤32 chars)
- `name`: trimmed string (≤48 chars)
- `version`: positive integer
- `payload`: discriminated union (zod or jsonSchema)
- `emits`: optional array documenting which content entries publish the event
- `tags`: optional analytics strings

Normalisation always emits the canonical id (`namespace:name`) even when authors omit the field. Validation ensures schema paths remain pack-relative and `emits` references existing content ids.

#### Content Pack Root Schema

`contentPackSchema` composes the module schemas for structural validation and type inference. The exported instance stays stateless.

A validator factory wraps the base schema with cross-reference checks, normalisation, and warning aggregation:

```ts
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

export const createContentPackValidator = (
  options: ContentSchemaOptions = {},
) => ({
  parse(input: unknown): ContentPackValidationResult,
  safeParse(input: unknown): ContentPackSafeParseResult,
});

export const parseContentPack = (
  input: unknown,
  options?: ContentSchemaOptions,
): ContentPackValidationResult;
```

`runtime-compat.ts` hosts the feature gate matrix:

```ts
export const FEATURE_GATES = [
  {
    module: 'automations',
    introducedIn: '0.2.0',
    docRef: 'docs/idle-engine-design.md (§6.2)',
  },
  {
    module: 'transforms',
    introducedIn: '0.3.0',
    docRef: 'docs/idle-engine-design.md (§6.2)',
  },
  {
    module: 'runtimeEvents',
    introducedIn: '0.3.0',
    docRef: 'docs/runtime-event-pubsub-design.md',
  },
  {
    module: 'prestigeLayers',
    introducedIn: '0.4.0',
    docRef: 'docs/idle-engine-design.md (§6.2)',
  },
  {
    module: 'guildPerks',
    introducedIn: '0.5.0',
    docRef: 'docs/idle-engine-design.md (§6.2)',
  },
] as const;
```

`validateCrossReferences` performs:
- Id uniqueness within each module
- Ensuring conditions reference defined ids
- Verifying generator/upgrade/metric/achievement/automation/transform references resolve against declared entities
- Enforcing runtime feature gates
- Validating `metadata.dependencies`
- Detecting orphaned prestige currencies
- Blocking engine-reserved namespace segments
- Resolving `flag` and `script` conditions against allowlists
- Rejecting runtime event contributions whose canonical id collides with core manifests
- Confirming `achievementDefinition.onUnlockEvents` ids exist in the merged catalogue
- Detecting cyclic dependencies across unlock and visibility conditions
- Walking every `numericFormulaSchema` node to collect and validate references
- Emitting warnings for soft issues

`normalizeContentPack` sorts arrays deterministically, injects derived lookup maps, applies default booleans, and produces hashes.

#### Normalisation & Derived Artifacts

`normalizeContentPack` returns a `NormalizedContentPack`:

```ts
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
    readonly runtimeEvents: ReadonlyMap<ContentId, NormalizedRuntimeEventContribution>;
  };
  readonly serializedLookup: {
    readonly resourceById: Readonly<Record<string, NormalizedResource>>;
    readonly generatorById: Readonly<Record<string, NormalizedGenerator>>;
    readonly upgradeById: Readonly<Record<string, NormalizedUpgrade>>;
    readonly metricById: Readonly<Record<string, NormalizedMetric>>;
    readonly achievementById: Readonly<Record<string, NormalizedAchievement>>;
    readonly automationById: Readonly<Record<string, NormalizedAutomation>>;
    readonly transformById: Readonly<Record<string, NormalizedTransform>>;
    readonly prestigeLayerById: Readonly<Record<string, NormalizedPrestigeLayer>>;
    readonly guildPerkById: Readonly<Record<string, NormalizedGuildPerk>>;
    readonly runtimeEventById: Readonly<Record<string, NormalizedRuntimeEventContribution>>;
  };
  readonly digest: {
    readonly version: number;
    readonly hash: string;
  };
}
```

Lookup maps retain the `ContentId` brand by exposing immutable `ReadonlyMap` instances. `serializedLookup` carries downgraded `Record<string, …>` copies for JSON transport. Digests use FNV-1a hashing aligned with runtime manifest hashing.

#### APIs & Contracts

The package exports:
- `contentPackSchema`: base Zod schema for structural validation
- `createContentPackValidator(options)`: factory that returns `{ parse, safeParse }` with cross-reference validation
- `parseContentPack(input, options)`: convenience helper
- Individual module schemas: `resourceDefinitionSchema`, `metricDefinitionSchema`, etc.
- Type exports: `NormalizedContentPack`, `SchemaWarning`, `ContentSchemaOptions`, etc.
- Scalar schemas: `contentIdSchema`, `packSlugSchema`, `numericFormulaSchema`, `conditionSchema`, etc.

#### Tooling & Automation

CLI changes in `tools/content-schema-cli` (follow-up work):
- Consume `@idle-engine/content-schema`
- Validate packs and emit structured JSON log entries
- Support `--check` mode for CI/Lefthook
- Support `--watch` mode for authoring
- Compile artifacts after successful validation

### 6.3 Operational Considerations

**Deployment**: N/A (library package)

**Telemetry & Observability**: CLI tooling will emit structured warnings and errors. Schema validation performance should be monitored for large packs.

**Security & Compliance**: Schema paths are validated to prevent directory traversal. No PII handling concerns.

## 7. Work Breakdown & Delivery Plan

### 7.1 Issue Map

| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| Scaffold content-schema package | Create package structure, tsconfig, vitest config | Schema Implementation Agent | None | Package builds and tests run |
| Implement scalar schemas | ids, numbers, localization primitives | Schema Implementation Agent | Package scaffold | Unit tests pass, types exported |
| Implement formula & condition schemas | Recursive schemas with z.lazy | Schema Implementation Agent | Scalar schemas | Tests cover recursion, edge cases |
| Implement module schemas | All DSL modules (resources, generators, etc.) | Schema Implementation Agent | Formula & condition schemas | Each module has passing tests |
| Implement runtime event schema | Runtime event contribution schema | Schema Implementation Agent | Module schemas | Event validation tests pass |
| Implement pack root schema & validator factory | contentPackSchema, createContentPackValidator | Validation Agent | All module schemas | Validator factory works |
| Implement cross-reference validation | validateCrossReferences with cycle detection | Validation Agent | Pack root schema | Cycle detection tests pass |
| Implement normalisation | normalizeContentPack with lookup maps | Validation Agent | Cross-reference validation | Digest stability tests pass |
| Update CLI tooling | Integrate schema into content-schema-cli | CLI Agent | Schema package complete | CLI validates sample packs |

### 7.2 Milestones

**Phase 1**: Schema implementation (base schemas → module schemas → pack schema)
**Phase 2**: Validation & normalisation (cross-reference checks → normalisation → digests)
**Phase 3**: Integration (CLI tooling → sample pack migration)

### 7.3 Coordination Notes

**Hand-off Package**: Share schema package documentation with CLI maintainers, provide sample validation code

**Communication Cadence**: Weekly sync on schema evolution, ad-hoc reviews for breaking changes

## 8. Agent Guidance & Guardrails

**Context Packets**:
- `docs/idle-engine-design.md` for runtime contract alignment
- `docs/runtime-event-pubsub-design.md` for event system integration
- `docs/runtime-event-manifest-authoring.md` for manifest generation expectations

**Prompting & Constraints**:
- All schemas must be `strict()` to reject unknown keys
- Use `.transform` for normalisation, `.superRefine` for cross-field validation
- Brand types with Zod's `.brand()` for stronger type safety
- Follow existing code style in `packages/core`

**Safety Rails**:
- Do not modify runtime code in `packages/core` without explicit approval
- Do not change existing sample pack data until schema package is stable
- Do not skip tests—coverage must remain at current levels or higher

**Validation Hooks**:
- Run `pnpm test --filter content-schema` before marking implementation complete
- Run `pnpm build --filter content-schema` to verify TypeScript compilation
- Verify type exports work correctly in downstream packages

## 9. Alternatives Considered

**Alternative 1: JSON Schema instead of Zod**
- **Rejected**: Zod provides better TypeScript integration, runtime validation, and transformation capabilities. JSON Schema would require separate type generation tooling.

**Alternative 2: Joi or Yup for validation**
- **Rejected**: Zod is more TypeScript-native and has better ecosystem support in the monorepo.

**Alternative 3: Runtime-only validation (no schema package)**
- **Rejected**: Authoring-time validation is critical for content creators. Runtime-only validation discovers errors too late.

**Alternative 4: Separate schema packages per module**
- **Rejected**: A single schema package ensures consistency and simplifies cross-reference validation.

## 10. Testing & Validation Plan

### Unit / Integration
- Unit tests for each schema module covering success and failure cases
- Property-based tests for `numericFormulaSchema` ensuring generated curves remain finite and monotonic
- Integration fixtures for full packs: valid sample pack, pack with missing references, pack with cyclic unlock conditions, pack with localisation gaps, pack with dependency cycles, pack with invalid runtime event contributions
- Validator factory tests ensuring warnings are collected properly
- Snapshot tests for `normalizeContentPack` verifying deterministic ordering and digest stability
- Type-level tests using `expectTypeOf` to ensure inferred types align with runtime expectations

### Performance
- Benchmark validation performance on large content packs (1000+ resources/generators)
- Profile normalisation overhead
- Success threshold: Validation completes in `<100ms` for typical packs (`<100 entities` per module)

### Tooling / A11y
- CLI integration tests using `tools/content-schema-cli`
- Vitest coverage target: >90% line coverage for schema package

## 11. Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Formula explosion (deeply nested expressions) | Performance degradation | Medium | Recursion depth limits and AST node count caps in `expressionNodeSchema` |
| Schema drift vs runtime | Runtime evolution breaks validation | Medium | CI checks that validate `@idle-engine/core` against schema digest before publish |
| Author friction from strict schemas | Reduced adoption | Low | Descriptive error messages and non-fatal warnings for soft constraints |
| Compatibility versioning complexity | Breaking changes affect old packs | Medium | Version schema transforms, allow compiler to downgrade gracefully based on `metadata.engine` |
| Transform loops (runaway production) | Runtime instability | Low | Enforce `safety` guards in schema, cover loop detection in integration tests |
| Performance on large packs | Slow CLI validation | Medium | Cache normalised results, reuse lookup maps between CLI runs |

## 12. Rollout Plan

### Milestones
- **Phase 1 (Weeks 1-2)**: Scaffold package, implement base schemas
- **Phase 2 (Weeks 3-4)**: Implement module schemas, formula & condition schemas
- **Phase 3 (Week 5)**: Implement pack root schema, validator factory, cross-reference validation
- **Phase 4 (Week 6)**: Implement normalisation, integrate with CLI tooling

### Migration Strategy
- No data migrations required initially (schema package is new)
- Existing sample packs will be migrated in follow-up work after schema stabilises
- Feature flags in `runtime-compat.ts` handle version compatibility

### Communication
- Document schema updates in changelog
- Share schema evolution notes with content authors
- Publish migration guide when sample packs are converted

## 13. Open Questions

- Should the schema expose calculated presentation defaults (e.g., auto-generated icon paths) or leave that to the compiler?
- How will guild perk costs interface with social-service data when live persistence lands?
- Do we need additional effect types (e.g., scripted modifiers) before schema v1.0, or can they wait for the scripting design doc?
- What is the migration strategy when schema digests change (e.g., do we embed the digest into save files similar to event manifests)?
- Should we migrate remaining TypeScript/hand-authored sample data into the CLI-discoverable pack format before or after schema v1.0?

## 14. Follow-Up Work

- Integrate schema into `tools/content-schema-cli` (separate PR)
- Migrate `packages/content-sample` to use schema validation
- Add CI checks to validate runtime alignment with schema
- Document authoring best practices in dedicated guide
- Implement schema version migration tooling
- Add performance benchmarks for large packs

## 15. References

- `docs/idle-engine-design.md` - Main engine design document
- `docs/runtime-event-pubsub-design.md` - Runtime event system design
- `docs/runtime-event-manifest-authoring.md` - Event manifest generation
- `docs/progression-coordinator-design.md` - Persistent unlock behavior (§6.2.4)
- `packages/core/src/condition-evaluator.ts` - Condition evaluation implementation
- `packages/core/src/events/event-bus.ts` - Event bus implementation
- [Zod Documentation](https://zod.dev/) - Schema validation library
- [OpenTelemetry Metrics API](https://raw.githubusercontent.com/open-telemetry/opentelemetry-specification/main/specification/metrics/api.md) - Metrics instrumentation guidance
- [npm Scoped Packages](https://docs.npmjs.com/cli/v10/using-npm/scope) - Package naming conventions
- [Coding Horror: Stringly Typed](https://blog.codinghorror.com/new-programming-jargon/#7-stringly-typed) - Avoiding string-based references
- [Non-monotonic logic - Wikipedia](https://en.wikipedia.org/wiki/Non-monotonic_logic) - Cycle detection rationale

## Appendix A — Glossary

- **Content DSL**: Domain-Specific Language for authoring game content
- **Zod**: TypeScript-first schema validation library
- **Normalisation**: Process of transforming authored content into canonical form (lowercased ids, sorted arrays, applied defaults)
- **Cross-reference validation**: Checking that entity references (e.g., `resourceId` in conditions) point to declared entities
- **Branded types**: TypeScript nominal types using Zod's `.brand()` for stronger type safety
- **Feature gates**: Runtime version requirements for specific content modules
- **FNV-1a**: Fast hash algorithm used for content digests
- **Monotonic predicate**: Condition that becomes true and stays true (used for unlock logic)
- **Non-monotonic logic**: Logic where adding information can invalidate prior inferences (e.g., negation)

## Appendix B — Change Log

| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2025-10-18 | Design team | Initial design draft (migrated to template format 2025-12-21) |
