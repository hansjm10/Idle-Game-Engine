---
title: Content Quick Reference
description: Condensed content-authoring cheatsheet for Idle Engine packs.
---

Use this as a fast lookup. For narrative guidance and full examples, see
`docs/content-dsl-usage-guidelines.md`.

## Required tsconfig.json settings

Content packs must include these settings in `tsconfig.json` for proper module
resolution and type exports:

```json
{
  "compilerOptions": {
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "types": ["node"]
  }
}
```

> **Why `NodeNext`?** The content compiler generates ESM-compatible imports with
> explicit `.js` extensions. `NodeNext` module resolution allows TypeScript to
> resolve these `.js` imports to their corresponding `.ts` source files.

See `packages/content-sample/tsconfig.json` for the complete template.

## Required eslint.config.js

Content packs must include an `eslint.config.js` file for ESLint 9.x flat config:

```javascript
import { createConfig } from '@idle-engine/config-eslint';

export default createConfig({
  restrictCoreInternals: 'error',
});
```

Use `'error'` for content packs, `'warn'` for tooling, or `false` to disable.
See `docs/content-dsl-usage-guidelines.md` for full details.

## Quick start (createGame)

Once you have a normalized content pack, bootstrap a runtime with the high-level factory:

```ts
import { createGame } from '@idle-engine/core';

const game = createGame(contentPack);
game.start();

const snapshot = game.getSnapshot();
game.purchaseGenerator('generator.mine', 1);
game.toggleGenerator('generator.mine', true);
game.collectResource('resource.gold', 10);
```

Notes:
- `game.start()` ticks with a fixed delta equal to the scheduler interval (defaults to the runtime `stepSizeMs`).
- `game.hydrate(save)` accepts raw parsed saves (including older schema versions) and will throw if the save is from an earlier step than the current runtime. If the built-in scheduler is running, hydration pauses it and restores the running state when `hydrate(...)` returns or throws.
- Facade actions return a `CommandResult` (`{ success: true }` or `{ success: false, error }`). Failures include `COMMAND_UNSUPPORTED` (no handler registered for this game instance) and `COMMAND_REJECTED` (queue refused the command, e.g. backpressure/max size). Some actions may also validate inputs (for example `INVALID_COLLECT_AMOUNT` / `UNKNOWN_RESOURCE` / `INVALID_PURCHASE_COUNT`).
- `game.purchaseGenerator(id, count)` expects `count` to be a positive integer (values are floored; values < 1 return `INVALID_PURCHASE_COUNT`).

## Required fields by content type

| Type | Required fields |
| --- | --- |
| Resource | `id`, `name`, `category`, `tier` |
| Entity | `id`, `name`, `description`, `stats` |
| Generator | `id`, `name`, `produces`, `purchase`, `baseUnlock` |
| Upgrade | `id`, `name`, `category`, `targets`, `cost`, `effects` |
| Achievement | `id`, `name`, `description`, `category`, `tier`, `track` |
| Automation | `id`, `name`, `description`, `targetType`, `trigger`, `unlockCondition` + `targetId` or `systemTargetId` |
| Prestige Layer | `id`, `name`, `summary`, `resetTargets`, `unlockCondition`, `reward` |
| Metric | `id`, `name`, `kind`, `source` |
| Transform | `id`, `name`, `description`, `mode`, `inputs`, `trigger` (+ `outputs` for non-mission; + `entityRequirements` + `outcomes` for missions) |

## Conditions cheat sheet

- `always` / `never`
- `resourceThreshold`: `resourceId`, `comparator`, `amount`
- `generatorLevel`: `generatorId`, `comparator`, `level`
- `upgradeOwned`: `upgradeId`, `requiredPurchases?`
- `prestigeCountThreshold`: `prestigeLayerId`, `comparator?`, `count?`
- `prestigeCompleted`: `prestigeLayerId`
- `prestigeUnlocked`: `prestigeLayerId`
- `flag`: `flagId`
- `script`: `scriptId`
- `allOf` / `anyOf`: `conditions[]`
- `not`: `condition`

## Formula cheat sheet

- `constant`: `{ value }`
- `linear`: `{ base, slope }`
- `exponential`: `{ growth, base?, offset? }`
- `polynomial`: `{ coefficients[] }`
- `piecewise`: `{ pieces: [{ untilLevel?, formula }] }`
- `expression`: `{ expression }` (refs + math ops)

## Effect kinds

`modifyResourceRate`, `modifyResourceCapacity`, `modifyGeneratorRate`,
`modifyGeneratorCost`, `modifyGeneratorConsumption`, `grantAutomation`,
`grantFlag`, `unlockResource`, `unlockGenerator`, `alterDirtyTolerance`,
`emitEvent`

## Minimal templates

Resource

```json
{
  "id": "pack.resource-id",
  "name": { "default": "Resource" },
  "category": "currency",
  "tier": 1
}
```

Entity

```json
{
  "id": "pack.entity-id",
  "name": { "default": "Entity" },
  "description": { "default": "A unit with stats." },
  "stats": [
    { "id": "stat.health", "name": { "default": "Health" }, "baseValue": { "kind": "constant", "value": 10 } }
  ]
}
```

Generator

```json
{
  "id": "pack.generator-id",
  "name": { "default": "Generator" },
  "produces": [{ "resourceId": "pack.resource-id", "rate": { "kind": "constant", "value": 1 } }],
  "purchase": { "currencyId": "pack.resource-id", "costMultiplier": 10, "costCurve": { "kind": "constant", "value": 1 } },
  "baseUnlock": { "kind": "always" }
}
```

Upgrade

```json
{
  "id": "pack.upgrade-id",
  "name": { "default": "Upgrade" },
  "category": "generator",
  "targets": [{ "kind": "generator", "id": "pack.generator-id" }],
  "cost": { "currencyId": "pack.resource-id", "costMultiplier": 100, "costCurve": { "kind": "constant", "value": 1 } },
  "effects": [{ "kind": "modifyGeneratorRate", "generatorId": "pack.generator-id", "operation": "multiply", "value": { "kind": "constant", "value": 1.1 } }]
}
```

Achievement

```json
{
  "id": "pack.achievement-id",
  "name": { "default": "Achievement" },
  "description": { "default": "Do something." },
  "category": "progression",
  "tier": "bronze",
  "track": { "kind": "resource", "resourceId": "pack.resource-id", "comparator": "gte", "threshold": { "kind": "constant", "value": 1 } }
}
```

Automation

```json
{
  "id": "pack.automation-id",
  "name": { "default": "Automation" },
  "description": { "default": "Auto action." },
  "targetType": "purchaseGenerator",
  "targetId": "pack.generator-id",
  "targetCount": { "kind": "constant", "value": 1 },
  "trigger": { "kind": "interval", "interval": { "kind": "constant", "value": 10 } },
  "unlockCondition": { "kind": "always" }
}
```

Prestige layer

```json
{
  "id": "pack.prestige-id",
  "name": { "default": "Prestige" },
  "summary": { "default": "Reset for rewards." },
  "resetTargets": ["pack.resource-id"],
  "unlockCondition": { "kind": "resourceThreshold", "resourceId": "pack.resource-id", "comparator": "gte", "amount": { "kind": "constant", "value": 100 } },
  "reward": { "resourceId": "pack.prestige-resource", "baseReward": { "kind": "constant", "value": 1 } }
}
```

> **Note**: Each prestige layer requires a resource named `{id}-prestige-count` (for example `pack.prestige-id-prestige-count`) in the pack's `resources` array. The runtime uses it to track how many times the player has prestiged—do not include it in `resetTargets`.

```json
{
  "id": "pack.prestige-id-prestige-count",
  "name": { "default": "Prestige Count" },
  "category": "misc",
  "tier": 3,
  "startAmount": 0,
  "visible": false,
  "unlocked": true
}
```

Metric

```json
{
  "id": "pack.metric-id",
  "name": { "default": "Metric" },
  "kind": "counter",
  "source": { "kind": "runtime" }
}
```

Transform

```json
{
  "id": "pack.transform-id",
  "name": { "default": "Transform" },
  "description": { "default": "Convert inputs to outputs." },
  "mode": "instant",
  "inputs": [{ "resourceId": "pack.resource-id", "amount": { "kind": "constant", "value": 10 } }],
  "outputs": [{ "resourceId": "pack.resource-id", "amount": { "kind": "constant", "value": 1 } }],
  "trigger": { "kind": "manual" }
}
```

Mission transform

```json
{
  "id": "pack.mission-id",
  "name": { "default": "Mission" },
  "description": { "default": "Deploy entities for rewards." },
  "mode": "mission",
  "inputs": [{ "resourceId": "pack.resource-id", "amount": { "kind": "constant", "value": 1 } }],
  "outputs": [],
  "duration": { "kind": "constant", "value": 60000 },
  "trigger": { "kind": "manual" },
  "entityRequirements": [{ "entityId": "pack.entity-id", "count": { "kind": "constant", "value": 1 } }],
  "outcomes": {
    "success": {
      "outputs": [{ "resourceId": "pack.resource-id", "amount": { "kind": "constant", "value": 2 } }]
    }
  }
}
```
