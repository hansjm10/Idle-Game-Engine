---
title: Content Quick Reference
description: Condensed content-authoring cheatsheet for Idle Engine packs.
---

Use this as a fast lookup. For narrative guidance and full examples, see
`docs/content-dsl-usage-guidelines.md`.

## Quick start (createGame)

Once you have a normalized content pack, bootstrap a runtime with the high-level factory:

```ts
import { createGame } from '@idle-engine/core';

const game = createGame(contentPack);
game.start();

const snapshot = game.getSnapshot();
game.purchaseGenerator('generator.mine', 1);
```

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
