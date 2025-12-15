import type { z } from 'zod';

import {
  resourceDefinitionSchema,
  type Resource,
} from './modules/resources.js';
import {
  generatorDefinitionSchema,
  type Generator,
} from './modules/generators.js';
import {
  upgradeDefinitionSchema,
  type Upgrade,
} from './modules/upgrades.js';
import {
  metricDefinitionSchema,
  type MetricDefinition,
} from './modules/metrics.js';
import {
  achievementDefinitionSchema,
  type AchievementDefinition,
} from './modules/achievements.js';
import {
  automationDefinitionSchema,
  type AutomationDefinition,
} from './modules/automations.js';
import {
  transformDefinitionSchema,
  type TransformDefinition,
} from './modules/transforms.js';
import {
  prestigeLayerSchema,
  type PrestigeLayerDefinition,
} from './modules/prestige.js';
import {
  guildPerkDefinitionSchema,
  type GuildPerkDefinition,
} from './modules/guild-perks.js';

// ============================================================================
// Input Types
// ============================================================================
// These types represent the plain-object inputs that each factory accepts.
// They use the Zod schema's input type, which accepts plain strings instead
// of branded types, making content authoring more ergonomic.

/** Input type for creating a resource definition. */
export type ResourceInput = z.input<typeof resourceDefinitionSchema>;

/** Input type for creating a generator definition. */
export type GeneratorInput = z.input<typeof generatorDefinitionSchema>;

/** Input type for creating an upgrade definition. */
export type UpgradeInput = z.input<typeof upgradeDefinitionSchema>;

/** Input type for creating a metric definition. */
export type MetricInput = z.input<typeof metricDefinitionSchema>;

/** Input type for creating an achievement definition. */
export type AchievementInput = z.input<typeof achievementDefinitionSchema>;

/** Input type for creating an automation definition. */
export type AutomationInput = z.input<typeof automationDefinitionSchema>;

/** Input type for creating a transform definition. */
export type TransformInput = z.input<typeof transformDefinitionSchema>;

/** Input type for creating a prestige layer definition. */
export type PrestigeLayerInput = z.input<typeof prestigeLayerSchema>;

/** Input type for creating a guild perk definition. */
export type GuildPerkInput = z.input<typeof guildPerkDefinitionSchema>;

// ============================================================================
// Factory Functions
// ============================================================================
// Each factory validates and normalizes plain input into the corresponding
// normalized type. These eliminate the need for `as unknown as` type
// assertions when authoring content manually.

/**
 * Creates a normalized resource definition from plain input.
 *
 * @example
 * ```typescript
 * const energy = createResource({
 *   id: 'my-pack.energy',
 *   name: { default: 'Energy' },
 *   category: 'currency',
 *   tier: 1,
 * });
 * ```
 */
export function createResource(input: ResourceInput): Resource {
  return resourceDefinitionSchema.parse(input);
}

/**
 * Creates a normalized generator definition from plain input.
 *
 * @example
 * ```typescript
 * const solarPanel = createGenerator({
 *   id: 'my-pack.solar-panel',
 *   name: { default: 'Solar Panel' },
 *   produces: [{ resourceId: 'my-pack.energy', rate: { kind: 'constant', value: 1 } }],
 *   purchase: { currencyId: 'my-pack.gold', baseCost: 10, costCurve: { kind: 'constant', value: 1 } },
 *   // Or: purchase: { costs: [{ resourceId: 'my-pack.gold', baseCost: 10, costCurve: { kind: 'constant', value: 1 } }] },
 *   baseUnlock: { kind: 'always' },
 * });
 * ```
 */
export function createGenerator(input: GeneratorInput): Generator {
  return generatorDefinitionSchema.parse(input);
}

/**
 * Creates a normalized upgrade definition from plain input.
 *
 * @example
 * ```typescript
 * const efficiency = createUpgrade({
 *   id: 'my-pack.efficiency',
 *   name: { default: 'Efficiency I' },
 *   category: 'generator',
 *   targets: [{ kind: 'generator', id: 'my-pack.solar-panel' }],
 *   cost: { currencyId: 'my-pack.gold', baseCost: 100, costCurve: { kind: 'constant', value: 1 } },
 *   // Or: cost: { costs: [{ resourceId: 'my-pack.gold', baseCost: 100, costCurve: { kind: 'constant', value: 1 } }] },
 *   effects: [{ kind: 'modifyGeneratorRate', generatorId: 'my-pack.solar-panel', operation: 'multiply', value: { kind: 'constant', value: 1.5 } }],
 * });
 * ```
 */
export function createUpgrade(input: UpgradeInput): Upgrade {
  return upgradeDefinitionSchema.parse(input);
}

/**
 * Creates a normalized metric definition from plain input.
 *
 * @example
 * ```typescript
 * const totalEnergy = createMetric({
 *   id: 'my-pack.total-energy',
 *   name: { default: 'Total Energy Generated' },
 *   kind: 'counter',
 *   unit: 'energy',
 *   source: { kind: 'runtime' },
 * });
 * ```
 */
export function createMetric(input: MetricInput): MetricDefinition {
  return metricDefinitionSchema.parse(input);
}

/**
 * Creates a normalized achievement definition from plain input.
 *
 * @example
 * ```typescript
 * const firstSpark = createAchievement({
 *   id: 'my-pack.first-spark',
 *   name: { default: 'First Spark' },
 *   description: { default: 'Generate your first energy' },
 *   tier: 'bronze',
 *   category: 'progression',
 *   track: { kind: 'resource', resourceId: 'my-pack.energy', comparator: 'gte', threshold: { kind: 'constant', value: 1 } },
 * });
 * ```
 */
export function createAchievement(input: AchievementInput): AchievementDefinition {
  return achievementDefinitionSchema.parse(input);
}

/**
 * Creates a normalized automation definition from plain input.
 *
 * @example
 * ```typescript
 * const autoBuy = createAutomation({
 *   id: 'my-pack.auto-buy',
 *   name: { default: 'Auto Buy' },
 *   description: { default: 'Automatically purchases generators' },
 *   targetType: 'generator',
 *   targetId: 'my-pack.solar-panel',
 *   trigger: { kind: 'resourceThreshold', resourceId: 'my-pack.gold', threshold: { kind: 'constant', value: 100 } },
 *   unlockCondition: { kind: 'always' },
 * });
 * ```
 */
export function createAutomation(input: AutomationInput): AutomationDefinition {
  return automationDefinitionSchema.parse(input);
}

/**
 * Creates a normalized transform definition from plain input.
 *
 * @example
 * ```typescript
 * const convert = createTransform({
 *   id: 'my-pack.convert',
 *   name: { default: 'Convert Energy' },
 *   description: { default: 'Convert energy to gold' },
 *   mode: 'instant',
 *   trigger: { kind: 'manual' },
 *   inputs: [{ resourceId: 'my-pack.energy', amount: { kind: 'constant', value: 10 } }],
 *   outputs: [{ resourceId: 'my-pack.gold', amount: { kind: 'constant', value: 1 } }],
 * });
 * ```
 */
export function createTransform(input: TransformInput): TransformDefinition {
  return transformDefinitionSchema.parse(input);
}

/**
 * Creates a normalized prestige layer definition from plain input.
 *
 * @example
 * ```typescript
 * const rebirth = createPrestigeLayer({
 *   id: 'my-pack.rebirth',
 *   name: { default: 'Rebirth' },
 *   summary: { default: 'Reset for prestige points' },
 *   unlockCondition: { kind: 'resourceThreshold', resourceId: 'my-pack.energy', comparator: 'gte', amount: { kind: 'constant', value: 1000 } },
 *   reward: { resourceId: 'my-pack.prestige-points', baseReward: { kind: 'constant', value: 1 } },
 *   resetTargets: ['my-pack.energy'],
 * });
 * ```
 */
export function createPrestigeLayer(input: PrestigeLayerInput): PrestigeLayerDefinition {
  return prestigeLayerSchema.parse(input);
}

/**
 * Creates a normalized guild perk definition from plain input.
 *
 * @example
 * ```typescript
 * const guildBonus = createGuildPerk({
 *   id: 'my-pack.guild-bonus',
 *   name: { default: 'Guild Bonus' },
 *   description: { default: 'Increases production for all guild members' },
 *   category: 'buff',
 *   maxRank: 10,
 *   effects: [{ kind: 'modifyResourceRate', resourceId: 'my-pack.energy', operation: 'multiply', value: { kind: 'constant', value: 1.1 } }],
 *   cost: { kind: 'currency', resourceId: 'my-pack.guild-points', amount: { kind: 'constant', value: 100 } },
 * });
 * ```
 */
export function createGuildPerk(input: GuildPerkInput): GuildPerkDefinition {
  return guildPerkDefinitionSchema.parse(input);
}
