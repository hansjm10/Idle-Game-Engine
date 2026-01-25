---
title: Document Content Schema Enums
sidebar_position: 4
---

# Document Content Schema Enums

This reference documents specific enum values and discriminated union kinds used within the content schema. Use this guide to determine valid values for fields like `category`, `kind`, and `targetType`.

:::info Source of Truth
These definitions are derived from `packages/content-schema`. If you encounter validation errors, please verify against the latest schema definitions in the source code.
:::

## Upgrade Categories

Used in the `category` field of an Upgrade definition.

| Value | Description |
| :--- | :--- |
| `global` | Upgrades that affect the entire game state or multiple unrelated entities. |
| `resource` | Upgrades primarily associated with a specific resource (e.g., increasing capacity or generation). |
| `generator` | Upgrades tied to a specific generator (e.g., efficiency, cost reduction). |
| `automation` | Upgrades related to automation features. |
| `prestige` | Upgrades associated with prestige layers or mechanics. |

## Achievement Track Kinds

Used in the `track` field of an Achievement definition to determine how progress is measured.

| Kind | Required Fields | Description |
| :--- | :--- | :--- |
| `resource` | `resourceId`, `threshold`, `comparator` | Tracks the amount of a specific resource. |
| `generator-level` | `generatorId`, `level` | Tracks the level of a specific generator. |
| `generator-count` | `threshold`, `comparator` (optional: `generatorIds`) | Tracks the total number of owned generators, optionally filtered to a subset. |
| `upgrade-owned` | `upgradeId` (optional: `purchases`) | Tracks if a specific upgrade has been purchased. |
| `flag` | `flagId` | Tracks if a specific game flag is set. |
| `script` | `scriptId` | specific script execution conditions (see script docs). |
| `custom-metric` | `metricId`, `threshold` | Tracks a custom defined metric. |

### Examples

```json
// Resource Track
{
  "kind": "resource",
  "resourceId": "gold",
  "threshold": { "kind": "constant", "value": 1000 },
  "comparator": "gte"
}

// Generator Level Track
{
  "kind": "generator-level",
  "generatorId": "mine",
  "level": { "kind": "constant", "value": 10 }
}

// Generator Count Track
{
  "kind": "generator-count",
  "threshold": { "kind": "constant", "value": 25 },
  "comparator": "gte",
  "generatorIds": ["cursor", "grandma"]
}
```

## Automation Target Types

Used in the `targetType` field of an Automation definition. The `targetType` determines which other fields are valid/required.

| Value | Description | Required/Valid Fields |
| :--- | :--- | :--- |
| `generator` | Automates a generator. | Requires `targetId` (generator ID). Can use `targetEnabled`. |
| `upgrade` | Automates buying upgrades. | Requires `targetId` (upgrade ID). |
| `purchaseGenerator` | Automates purchasing generator levels. | Requires `targetId`. Can use `targetCount`. |
| `collectResource` | Automates collecting resources (e.g. clicker). | Requires `targetId` (resource ID). Can use `targetAmount`. |
| `system` | Automates system functions. | Requires `systemTargetId`. MUST NOT have `targetId`, `targetEnabled`, etc. |

## Condition Kinds

Used in `unlockCondition`, `visibilityCondition`, and other conditional logic fields.

| Kind | Description | Key Properties |
| :--- | :--- | :--- |
| `always` | Always evaluates to true. | None |
| `never` | Always evaluates to false. | None |
| `resourceThreshold` | Checks if a resource meets a criteria. | `resourceId`, `comparator`, `amount` |
| `generatorLevel` | Checks if a generator reaches a level. | `generatorId`, `comparator`, `level` |
| `upgradeOwned` | Checks if an upgrade is owned. | `upgradeId`, `requiredPurchases` (default: 1) |
| `prestigeCountThreshold`| Checks prestige count. | `prestigeLayerId`, `comparator`, `count` |
| `prestigeCompleted` | Checks if a prestige layer is completed. | `prestigeLayerId` |
| `prestigeUnlocked` | Checks if a prestige layer is unlocked. | `prestigeLayerId` |
| `flag` | Checks if a flag is active. | `flagId` |
| `script` | Checks a script condition. | `scriptId` |
| `allOf` | Logical AND. | `conditions` (array) |
| `anyOf` | Logical OR. | `conditions` (array) |
| `not` | Logical NOT. | `condition` (single node) |

### Examples

```json
// Resource Threshold
{
  "kind": "resourceThreshold",
  "resourceId": "mana",
  "comparator": "gte",
  "amount": 50
}

// Logic Composition (AND)
{
  "kind": "allOf",
  "conditions": [
    { "kind": "upgradeOwned", "upgradeId": "magic_wand" },
    { "kind": "resourceThreshold", "resourceId": "mana", "amount": 100 }
  ]
}
```
