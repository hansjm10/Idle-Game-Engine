import {
  createResource,
  createGenerator,
  createUpgrade,
  createAchievement,
  createAutomation,
  createPrestigeLayer,
  parseContentPack,
} from '@idle-engine/content-schema';

// ============================================================================
// Resources
// ============================================================================

// Tier 1 - Humble Kitchen
const flour = createResource({
  id: 'cosmic-bakery.flour',
  name: { default: 'Flour', variants: {} },
  category: 'primary' as const,
  tier: 1,
  startAmount: 10,
  capacity: 100,
  visible: true,
  unlocked: true,
});

const sugar = createResource({
  id: 'cosmic-bakery.sugar',
  name: { default: 'Sugar', variants: {} },
  category: 'primary' as const,
  tier: 1,
  capacity: 100,
  visible: true,
  unlockCondition: {
    kind: 'resourceThreshold' as const,
    resourceId: 'cosmic-bakery.flour',
    comparator: 'gte' as const,
    amount: { kind: 'constant', value: 15 },
  },
});

const dough = createResource({
  id: 'cosmic-bakery.dough',
  name: { default: 'Dough', variants: {} },
  category: 'primary' as const,
  tier: 1,
  capacity: 500,
  visible: true,
  unlockCondition: {
    kind: 'resourceThreshold' as const,
    resourceId: 'cosmic-bakery.flour',
    comparator: 'gte' as const,
    amount: { kind: 'constant', value: 25 },
  },
});

// Tier 2 - Enchanted Kitchen
const stardust = createResource({
  id: 'cosmic-bakery.stardust',
  name: { default: 'Stardust', variants: {} },
  category: 'primary' as const,
  tier: 2,
  capacity: 250,
  visible: true,
  unlockCondition: {
    kind: 'resourceThreshold' as const,
    resourceId: 'cosmic-bakery.dough',
    comparator: 'gte' as const,
    amount: { kind: 'constant', value: 50 },
  },
});

const moonCream = createResource({
  id: 'cosmic-bakery.moon-cream',
  name: { default: 'Moon Cream', variants: {} },
  category: 'primary' as const,
  tier: 2,
  capacity: 250,
  visible: true,
  unlockCondition: {
    kind: 'resourceThreshold' as const,
    resourceId: 'cosmic-bakery.stardust',
    comparator: 'gte' as const,
    amount: { kind: 'constant', value: 25 },
  },
});

const enchantedPastries = createResource({
  id: 'cosmic-bakery.enchanted-pastries',
  name: { default: 'Enchanted Pastries', variants: {} },
  category: 'primary' as const,
  tier: 2,
  capacity: 1000,
  visible: true,
  unlockCondition: {
    kind: 'resourceThreshold' as const,
    resourceId: 'cosmic-bakery.stardust',
    comparator: 'gte' as const,
    amount: { kind: 'constant', value: 50 },
  },
});

// Tier 3 - Cosmic Kitchen
const voidEssence = createResource({
  id: 'cosmic-bakery.void-essence',
  name: { default: 'Void Essence', variants: {} },
  category: 'primary' as const,
  tier: 3,
  capacity: 500,
  visible: true,
  unlockCondition: {
    kind: 'resourceThreshold' as const,
    resourceId: 'cosmic-bakery.enchanted-pastries',
    comparator: 'gte' as const,
    amount: { kind: 'constant', value: 100 },
  },
});

const realityDough = createResource({
  id: 'cosmic-bakery.reality-dough',
  name: { default: 'Reality Dough', variants: {} },
  category: 'primary' as const,
  tier: 3,
  capacity: null,
  visible: true,
  unlockCondition: {
    kind: 'resourceThreshold' as const,
    resourceId: 'cosmic-bakery.void-essence',
    comparator: 'gte' as const,
    amount: { kind: 'constant', value: 50 },
  },
});

// Special Resources
const celestialGems = createResource({
  id: 'cosmic-bakery.celestial-gems',
  name: { default: 'Celestial Gems', variants: {} },
  category: 'currency' as const,
  economyClassification: 'hard' as const,
  tier: 1,
  visible: true,
  unlocked: true,
});

const ascensionStars = createResource({
  id: 'cosmic-bakery.ascension-stars',
  name: { default: 'Ascension Stars', variants: {} },
  category: 'prestige' as const,
  tier: 3,
  visible: true,
  unlockCondition: {
    kind: 'prestigeUnlocked' as const,
    prestigeLayerId: 'cosmic-bakery.celestial-ascension',
  },
});

const cosmicFlour = createResource({
  id: 'cosmic-bakery.cosmic-flour',
  name: { default: 'Cosmic Flour', variants: {} },
  category: 'prestige' as const,
  tier: 3,
  visible: true,
  unlockCondition: {
    kind: 'prestigeUnlocked' as const,
    prestigeLayerId: 'cosmic-bakery.celestial-ascension',
  },
});

const prestigeCount = createResource({
  id: 'cosmic-bakery.prestige-count',
  name: { default: 'Prestige Count', variants: {} },
  category: 'misc' as const,
  tier: 1,
  visible: false,
});

// ============================================================================
// Generators
// ============================================================================

// Tier 1 Generators
const handMixer = createGenerator({
  id: 'cosmic-bakery.hand-mixer',
  name: { default: 'Hand Mixer', variants: {} },
  produces: [
    {
      resourceId: 'cosmic-bakery.flour',
      rate: { kind: 'constant', value: 1 },
    },
  ],
  consumes: [],
  purchase: {
    currencyId: 'cosmic-bakery.flour',
    baseCost: 10,
    costCurve: { kind: 'exponential', base: 10, growth: 1.15, offset: 0 },
  },
  maxLevel: 50,
  baseUnlock: { kind: 'always' as const },
});

const sugarMill = createGenerator({
  id: 'cosmic-bakery.sugar-mill',
  name: { default: 'Sugar Mill', variants: {} },
  produces: [
    {
      resourceId: 'cosmic-bakery.sugar',
      rate: { kind: 'constant', value: 0.5 },
    },
  ],
  consumes: [],
  purchase: {
    currencyId: 'cosmic-bakery.flour',
    baseCost: 25,
    costCurve: { kind: 'exponential', base: 25, growth: 1.2, offset: 0 },
  },
  maxLevel: 40,
  baseUnlock: {
    kind: 'resourceThreshold' as const,
    resourceId: 'cosmic-bakery.flour',
    comparator: 'gte' as const,
    amount: { kind: 'constant', value: 15 },
  },
});

const kneadingStation = createGenerator({
  id: 'cosmic-bakery.kneading-station',
  name: { default: 'Kneading Station', variants: {} },
  produces: [
    {
      resourceId: 'cosmic-bakery.dough',
      rate: { kind: 'constant', value: 0.25 },
    },
  ],
  consumes: [
    {
      resourceId: 'cosmic-bakery.flour',
      rate: { kind: 'constant', value: 0.1 },
    },
    {
      resourceId: 'cosmic-bakery.sugar',
      rate: { kind: 'constant', value: 0.05 },
    },
  ],
  purchase: {
    currencyId: 'cosmic-bakery.flour',
    baseCost: 50,
    costCurve: { kind: 'exponential', base: 50, growth: 1.25, offset: 0 },
  },
  maxLevel: 35,
  baseUnlock: {
    kind: 'resourceThreshold' as const,
    resourceId: 'cosmic-bakery.flour',
    comparator: 'gte' as const,
    amount: { kind: 'constant', value: 25 },
  },
});

// Tier 2 Generators
const starCollector = createGenerator({
  id: 'cosmic-bakery.star-collector',
  name: { default: 'Star Collector', variants: {} },
  produces: [
    {
      resourceId: 'cosmic-bakery.stardust',
      rate: { kind: 'constant', value: 0.1 },
    },
  ],
  consumes: [
    {
      resourceId: 'cosmic-bakery.dough',
      rate: { kind: 'constant', value: 0.2 },
    },
  ],
  purchase: {
    currencyId: 'cosmic-bakery.dough',
    baseCost: 100,
    costCurve: { kind: 'exponential', base: 100, growth: 1.3, offset: 0 },
  },
  maxLevel: 30,
  baseUnlock: {
    kind: 'resourceThreshold' as const,
    resourceId: 'cosmic-bakery.dough',
    comparator: 'gte' as const,
    amount: { kind: 'constant', value: 50 },
  },
});

const moonbeamChurn = createGenerator({
  id: 'cosmic-bakery.moonbeam-churn',
  name: { default: 'Moonbeam Churn', variants: {} },
  produces: [
    {
      resourceId: 'cosmic-bakery.moon-cream',
      rate: { kind: 'constant', value: 0.08 },
    },
  ],
  consumes: [
    {
      resourceId: 'cosmic-bakery.stardust',
      rate: { kind: 'constant', value: 0.15 },
    },
  ],
  purchase: {
    currencyId: 'cosmic-bakery.stardust',
    baseCost: 50,
    costCurve: { kind: 'exponential', base: 50, growth: 1.35, offset: 0 },
  },
  maxLevel: 25,
  baseUnlock: {
    kind: 'resourceThreshold' as const,
    resourceId: 'cosmic-bakery.stardust',
    comparator: 'gte' as const,
    amount: { kind: 'constant', value: 25 },
  },
});

const enchantedOven = createGenerator({
  id: 'cosmic-bakery.enchanted-oven',
  name: { default: 'Enchanted Oven', variants: {} },
  produces: [
    {
      resourceId: 'cosmic-bakery.enchanted-pastries',
      rate: { kind: 'constant', value: 0.05 },
    },
  ],
  consumes: [
    {
      resourceId: 'cosmic-bakery.dough',
      rate: { kind: 'constant', value: 0.1 },
    },
    {
      resourceId: 'cosmic-bakery.stardust',
      rate: { kind: 'constant', value: 0.05 },
    },
    {
      resourceId: 'cosmic-bakery.moon-cream',
      rate: { kind: 'constant', value: 0.03 },
    },
  ],
  purchase: {
    currencyId: 'cosmic-bakery.stardust',
    baseCost: 100,
    costCurve: { kind: 'exponential', base: 100, growth: 1.4, offset: 0 },
  },
  maxLevel: 25,
  baseUnlock: {
    kind: 'resourceThreshold' as const,
    resourceId: 'cosmic-bakery.stardust',
    comparator: 'gte' as const,
    amount: { kind: 'constant', value: 50 },
  },
});

// Tier 3 Generators
const voidPortal = createGenerator({
  id: 'cosmic-bakery.void-portal',
  name: { default: 'Void Portal', variants: {} },
  produces: [
    {
      resourceId: 'cosmic-bakery.void-essence',
      rate: { kind: 'constant', value: 0.03 },
    },
  ],
  consumes: [
    {
      resourceId: 'cosmic-bakery.enchanted-pastries',
      rate: { kind: 'constant', value: 0.08 },
    },
  ],
  purchase: {
    currencyId: 'cosmic-bakery.enchanted-pastries',
    baseCost: 200,
    costCurve: { kind: 'exponential', base: 200, growth: 1.45, offset: 0 },
  },
  maxLevel: 20,
  baseUnlock: {
    kind: 'resourceThreshold' as const,
    resourceId: 'cosmic-bakery.enchanted-pastries',
    comparator: 'gte' as const,
    amount: { kind: 'constant', value: 100 },
  },
});

const realityForge = createGenerator({
  id: 'cosmic-bakery.reality-forge',
  name: { default: 'Reality Forge', variants: {} },
  produces: [
    {
      resourceId: 'cosmic-bakery.reality-dough',
      rate: { kind: 'constant', value: 0.02 },
    },
  ],
  consumes: [
    {
      resourceId: 'cosmic-bakery.void-essence',
      rate: { kind: 'constant', value: 0.05 },
    },
    {
      resourceId: 'cosmic-bakery.cosmic-flour',
      rate: { kind: 'constant', value: 0.01 },
    },
  ],
  purchase: {
    currencyId: 'cosmic-bakery.void-essence',
    baseCost: 100,
    costCurve: { kind: 'exponential', base: 100, growth: 1.5, offset: 0 },
  },
  maxLevel: 15,
  baseUnlock: {
    kind: 'allOf' as const,
    conditions: [
      {
        kind: 'prestigeUnlocked' as const,
        prestigeLayerId: 'cosmic-bakery.celestial-ascension',
      },
      {
        kind: 'resourceThreshold' as const,
        resourceId: 'cosmic-bakery.void-essence',
        comparator: 'gte' as const,
        amount: { kind: 'constant', value: 50 },
      },
    ],
  },
});

const celestialBakery = createGenerator({
  id: 'cosmic-bakery.celestial-bakery',
  name: { default: 'Celestial Bakery', variants: {} },
  produces: [
    {
      resourceId: 'cosmic-bakery.ascension-stars',
      rate: { kind: 'constant', value: 0.01 },
    },
  ],
  consumes: [
    {
      resourceId: 'cosmic-bakery.reality-dough',
      rate: { kind: 'constant', value: 0.03 },
    },
  ],
  purchase: {
    currencyId: 'cosmic-bakery.reality-dough',
    baseCost: 50,
    costCurve: { kind: 'exponential', base: 50, growth: 1.6, offset: 0 },
  },
  maxLevel: 10,
  baseUnlock: {
    kind: 'prestigeUnlocked' as const,
    prestigeLayerId: 'cosmic-bakery.celestial-ascension',
  },
});

// ============================================================================
// Upgrades
// ============================================================================

// Tier 1 Upgrades
const betterWhisks = createUpgrade({
  id: 'cosmic-bakery.better-whisks',
  name: { default: 'Better Whisks', variants: {} },
  category: 'generator' as const,
  targets: [{ kind: 'generator' as const, id: 'cosmic-bakery.hand-mixer' }],
  cost: {
    currencyId: 'cosmic-bakery.flour',
    baseCost: 50,
    costCurve: { kind: 'constant', value: 50 },
  },
  effects: [
    {
      kind: 'modifyGeneratorRate' as const,
      generatorId: 'cosmic-bakery.hand-mixer',
      operation: 'multiply' as const,
      value: { kind: 'constant', value: 1.25 },
    },
  ],
  unlockCondition: { kind: 'always' as const },
});

const refinedSugar = createUpgrade({
  id: 'cosmic-bakery.refined-sugar',
  name: { default: 'Refined Sugar', variants: {} },
  category: 'generator' as const,
  targets: [{ kind: 'generator' as const, id: 'cosmic-bakery.sugar-mill' }],
  cost: {
    currencyId: 'cosmic-bakery.flour',
    baseCost: 75,
    costCurve: { kind: 'constant', value: 75 },
  },
  effects: [
    {
      kind: 'modifyGeneratorRate' as const,
      generatorId: 'cosmic-bakery.sugar-mill',
      operation: 'multiply' as const,
      value: { kind: 'constant', value: 1.25 },
    },
  ],
  unlockCondition: {
    kind: 'upgradeOwned' as const,
    upgradeId: 'cosmic-bakery.better-whisks',
    requiredPurchases: 1,
  },
});

const elasticGluten = createUpgrade({
  id: 'cosmic-bakery.elastic-gluten',
  name: { default: 'Elastic Gluten', variants: {} },
  category: 'generator' as const,
  targets: [{ kind: 'generator' as const, id: 'cosmic-bakery.kneading-station' }],
  cost: {
    currencyId: 'cosmic-bakery.flour',
    baseCost: 100,
    costCurve: { kind: 'constant', value: 100 },
  },
  effects: [
    {
      kind: 'modifyGeneratorRate' as const,
      generatorId: 'cosmic-bakery.kneading-station',
      operation: 'multiply' as const,
      value: { kind: 'constant', value: 1.5 },
    },
  ],
  unlockCondition: { kind: 'always' as const },
});

const bulkMixing = createUpgrade({
  id: 'cosmic-bakery.bulk-mixing',
  name: { default: 'Bulk Mixing', variants: {} },
  category: 'generator' as const,
  targets: [{ kind: 'generator' as const, id: 'cosmic-bakery.hand-mixer' }],
  cost: {
    currencyId: 'cosmic-bakery.flour',
    baseCost: 150,
    costCurve: { kind: 'constant', value: 150 },
  },
  repeatable: {
    maxPurchases: 5,
    costCurve: { kind: 'linear', base: 150, slope: 50 },
  },
  effects: [
    {
      kind: 'modifyGeneratorCost' as const,
      generatorId: 'cosmic-bakery.hand-mixer',
      operation: 'multiply' as const,
      value: { kind: 'constant', value: 0.9 },
    },
  ],
  unlockCondition: { kind: 'always' as const },
});

const doubleBatch = createUpgrade({
  id: 'cosmic-bakery.double-batch',
  name: { default: 'Double Batch', variants: {} },
  category: 'global' as const,
  targets: [{ kind: 'global' as const }],
  cost: {
    currencyId: 'cosmic-bakery.flour',
    baseCost: 200,
    costCurve: { kind: 'constant', value: 200 },
  },
  effects: [
    {
      kind: 'modifyGeneratorRate' as const,
      generatorId: 'cosmic-bakery.hand-mixer',
      operation: 'multiply' as const,
      value: { kind: 'constant', value: 1.15 },
    },
    {
      kind: 'modifyGeneratorRate' as const,
      generatorId: 'cosmic-bakery.sugar-mill',
      operation: 'multiply' as const,
      value: { kind: 'constant', value: 1.15 },
    },
    {
      kind: 'modifyGeneratorRate' as const,
      generatorId: 'cosmic-bakery.kneading-station',
      operation: 'multiply' as const,
      value: { kind: 'constant', value: 1.15 },
    },
  ],
  unlockCondition: { kind: 'always' as const },
});

// Tier 2 Upgrades
const stellarAlignment = createUpgrade({
  id: 'cosmic-bakery.stellar-alignment',
  name: { default: 'Stellar Alignment', variants: {} },
  category: 'generator' as const,
  targets: [{ kind: 'generator' as const, id: 'cosmic-bakery.star-collector' }],
  cost: {
    currencyId: 'cosmic-bakery.dough',
    baseCost: 200,
    costCurve: { kind: 'constant', value: 200 },
  },
  effects: [
    {
      kind: 'modifyGeneratorRate' as const,
      generatorId: 'cosmic-bakery.star-collector',
      operation: 'multiply' as const,
      value: { kind: 'constant', value: 1.4 },
    },
  ],
  unlockCondition: { kind: 'always' as const },
});

const lunarCycleSync = createUpgrade({
  id: 'cosmic-bakery.lunar-cycle-sync',
  name: { default: 'Lunar Cycle Sync', variants: {} },
  category: 'generator' as const,
  targets: [{ kind: 'generator' as const, id: 'cosmic-bakery.moonbeam-churn' }],
  cost: {
    currencyId: 'cosmic-bakery.stardust',
    baseCost: 50,
    costCurve: { kind: 'constant', value: 50 },
  },
  effects: [
    {
      kind: 'modifyGeneratorRate' as const,
      generatorId: 'cosmic-bakery.moonbeam-churn',
      operation: 'multiply' as const,
      value: { kind: 'constant', value: 1.35 },
    },
  ],
  unlockCondition: { kind: 'always' as const },
});

const enchantmentMastery = createUpgrade({
  id: 'cosmic-bakery.enchantment-mastery',
  name: { default: 'Enchantment Mastery', variants: {} },
  category: 'generator' as const,
  targets: [{ kind: 'generator' as const, id: 'cosmic-bakery.enchanted-oven' }],
  cost: {
    currencyId: 'cosmic-bakery.stardust',
    baseCost: 100,
    costCurve: { kind: 'constant', value: 100 },
  },
  effects: [
    {
      kind: 'modifyGeneratorRate' as const,
      generatorId: 'cosmic-bakery.enchanted-oven',
      operation: 'multiply' as const,
      value: { kind: 'constant', value: 1.5 },
    },
  ],
  unlockCondition: { kind: 'always' as const },
});

const cosmicResonance = createUpgrade({
  id: 'cosmic-bakery.cosmic-resonance',
  name: { default: 'Cosmic Resonance', variants: {} },
  category: 'global' as const,
  targets: [{ kind: 'global' as const }],
  cost: {
    currencyId: 'cosmic-bakery.moon-cream',
    baseCost: 150,
    costCurve: { kind: 'constant', value: 150 },
  },
  effects: [
    {
      kind: 'modifyGeneratorRate' as const,
      generatorId: 'cosmic-bakery.star-collector',
      operation: 'multiply' as const,
      value: { kind: 'constant', value: 1.2 },
    },
    {
      kind: 'modifyGeneratorRate' as const,
      generatorId: 'cosmic-bakery.moonbeam-churn',
      operation: 'multiply' as const,
      value: { kind: 'constant', value: 1.2 },
    },
    {
      kind: 'modifyGeneratorRate' as const,
      generatorId: 'cosmic-bakery.enchanted-oven',
      operation: 'multiply' as const,
      value: { kind: 'constant', value: 1.2 },
    },
  ],
  unlockCondition: { kind: 'always' as const },
});

// Tier 3 Upgrades
const voidStabilizers = createUpgrade({
  id: 'cosmic-bakery.void-stabilizers',
  name: { default: 'Void Stabilizers', variants: {} },
  category: 'generator' as const,
  targets: [{ kind: 'generator' as const, id: 'cosmic-bakery.void-portal' }],
  cost: {
    currencyId: 'cosmic-bakery.void-essence',
    baseCost: 50,
    costCurve: { kind: 'constant', value: 50 },
  },
  effects: [
    {
      kind: 'modifyGeneratorRate' as const,
      generatorId: 'cosmic-bakery.void-portal',
      operation: 'multiply' as const,
      value: { kind: 'constant', value: 1.3 },
    },
  ],
  unlockCondition: { kind: 'always' as const },
});

const realityThreads = createUpgrade({
  id: 'cosmic-bakery.reality-threads',
  name: { default: 'Reality Threads', variants: {} },
  category: 'generator' as const,
  targets: [{ kind: 'generator' as const, id: 'cosmic-bakery.reality-forge' }],
  cost: {
    currencyId: 'cosmic-bakery.reality-dough',
    baseCost: 25,
    costCurve: { kind: 'constant', value: 25 },
  },
  effects: [
    {
      kind: 'modifyGeneratorRate' as const,
      generatorId: 'cosmic-bakery.reality-forge',
      operation: 'multiply' as const,
      value: { kind: 'constant', value: 1.25 },
    },
  ],
  unlockCondition: { kind: 'always' as const },
});

// Prestige Upgrades
const rememberedRecipes = createUpgrade({
  id: 'cosmic-bakery.remembered-recipes',
  name: { default: 'Remembered Recipes', variants: {} },
  category: 'resource' as const,
  targets: [{ kind: 'resource' as const, id: 'cosmic-bakery.flour' }],
  cost: {
    currencyId: 'cosmic-bakery.ascension-stars',
    baseCost: 1,
    costCurve: { kind: 'constant', value: 1 },
  },
  effects: [
    {
      kind: 'modifyResourceRate' as const,
      resourceId: 'cosmic-bakery.flour',
      operation: 'add' as const,
      value: { kind: 'constant', value: 50 },
    },
  ],
  unlockCondition: {
    kind: 'prestigeUnlocked' as const,
    prestigeLayerId: 'cosmic-bakery.celestial-ascension',
  },
});

const timelessTechniques = createUpgrade({
  id: 'cosmic-bakery.timeless-techniques',
  name: { default: 'Timeless Techniques', variants: {} },
  category: 'global' as const,
  targets: [{ kind: 'global' as const }],
  cost: {
    currencyId: 'cosmic-bakery.ascension-stars',
    baseCost: 3,
    costCurve: { kind: 'constant', value: 3 },
  },
  effects: [
    {
      kind: 'modifyGeneratorRate' as const,
      generatorId: 'cosmic-bakery.hand-mixer',
      operation: 'multiply' as const,
      value: { kind: 'constant', value: 1.1 },
    },
    {
      kind: 'modifyGeneratorRate' as const,
      generatorId: 'cosmic-bakery.sugar-mill',
      operation: 'multiply' as const,
      value: { kind: 'constant', value: 1.1 },
    },
    {
      kind: 'modifyGeneratorRate' as const,
      generatorId: 'cosmic-bakery.kneading-station',
      operation: 'multiply' as const,
      value: { kind: 'constant', value: 1.1 },
    },
  ],
  unlockCondition: {
    kind: 'prestigeUnlocked' as const,
    prestigeLayerId: 'cosmic-bakery.celestial-ascension',
  },
});

const celestialBlessing = createUpgrade({
  id: 'cosmic-bakery.celestial-blessing',
  name: { default: 'Celestial Blessing', variants: {} },
  category: 'global' as const,
  targets: [{ kind: 'global' as const }],
  cost: {
    currencyId: 'cosmic-bakery.ascension-stars',
    baseCost: 5,
    costCurve: { kind: 'constant', value: 5 },
  },
  repeatable: {
    maxPurchases: 10,
    costCurve: { kind: 'linear', base: 5, slope: 5 },
  },
  effects: [
    {
      kind: 'modifyGeneratorRate' as const,
      generatorId: 'cosmic-bakery.hand-mixer',
      operation: 'multiply' as const,
      value: { kind: 'constant', value: 1.05 },
    },
    {
      kind: 'modifyGeneratorRate' as const,
      generatorId: 'cosmic-bakery.sugar-mill',
      operation: 'multiply' as const,
      value: { kind: 'constant', value: 1.05 },
    },
    {
      kind: 'modifyGeneratorRate' as const,
      generatorId: 'cosmic-bakery.kneading-station',
      operation: 'multiply' as const,
      value: { kind: 'constant', value: 1.05 },
    },
    {
      kind: 'modifyGeneratorRate' as const,
      generatorId: 'cosmic-bakery.star-collector',
      operation: 'multiply' as const,
      value: { kind: 'constant', value: 1.05 },
    },
    {
      kind: 'modifyGeneratorRate' as const,
      generatorId: 'cosmic-bakery.moonbeam-churn',
      operation: 'multiply' as const,
      value: { kind: 'constant', value: 1.05 },
    },
    {
      kind: 'modifyGeneratorRate' as const,
      generatorId: 'cosmic-bakery.enchanted-oven',
      operation: 'multiply' as const,
      value: { kind: 'constant', value: 1.05 },
    },
    {
      kind: 'modifyGeneratorRate' as const,
      generatorId: 'cosmic-bakery.void-portal',
      operation: 'multiply' as const,
      value: { kind: 'constant', value: 1.05 },
    },
    {
      kind: 'modifyGeneratorRate' as const,
      generatorId: 'cosmic-bakery.reality-forge',
      operation: 'multiply' as const,
      value: { kind: 'constant', value: 1.05 },
    },
    {
      kind: 'modifyGeneratorRate' as const,
      generatorId: 'cosmic-bakery.celestial-bakery',
      operation: 'multiply' as const,
      value: { kind: 'constant', value: 1.05 },
    },
  ],
  unlockCondition: {
    kind: 'prestigeUnlocked' as const,
    prestigeLayerId: 'cosmic-bakery.celestial-ascension',
  },
});

// ============================================================================
// Achievements
// ============================================================================

// Progression Achievements
const firstBatch = createAchievement({
  id: 'cosmic-bakery.first-batch',
  name: { default: 'First Batch', variants: {} },
  description: { default: 'Purchase your first hand mixer', variants: {} },
  category: 'progression' as const,
  tier: 'bronze' as const,
  track: {
    kind: 'generator-level' as const,
    generatorId: 'cosmic-bakery.hand-mixer',
    level: { kind: 'constant', value: 1 },
  },
});

const sugarRush = createAchievement({
  id: 'cosmic-bakery.sugar-rush',
  name: { default: 'Sugar Rush', variants: {} },
  description: { default: 'Unlock sugar production', variants: {} },
  category: 'progression' as const,
  tier: 'bronze' as const,
  track: {
    kind: 'resource' as const,
    resourceId: 'cosmic-bakery.sugar',
    comparator: 'gte' as const,
    threshold: { kind: 'constant', value: 1 },
  },
});

const risingStar = createAchievement({
  id: 'cosmic-bakery.rising-star',
  name: { default: 'Rising Star', variants: {} },
  description: { default: 'Unlock stardust production', variants: {} },
  category: 'progression' as const,
  tier: 'bronze' as const,
  track: {
    kind: 'resource' as const,
    resourceId: 'cosmic-bakery.stardust',
    comparator: 'gte' as const,
    threshold: { kind: 'constant', value: 1 },
  },
});

const enchantedChef = createAchievement({
  id: 'cosmic-bakery.enchanted-chef',
  name: { default: 'Enchanted Chef', variants: {} },
  description: { default: 'Create your first enchanted pastry', variants: {} },
  category: 'progression' as const,
  tier: 'silver' as const,
  track: {
    kind: 'resource' as const,
    resourceId: 'cosmic-bakery.enchanted-pastries',
    comparator: 'gte' as const,
    threshold: { kind: 'constant', value: 1 },
  },
});

const voidWalker = createAchievement({
  id: 'cosmic-bakery.void-walker',
  name: { default: 'Void Walker', variants: {} },
  description: { default: 'Harness the power of void essence', variants: {} },
  category: 'progression' as const,
  tier: 'silver' as const,
  track: {
    kind: 'resource' as const,
    resourceId: 'cosmic-bakery.void-essence',
    comparator: 'gte' as const,
    threshold: { kind: 'constant', value: 1 },
  },
});

const realityBaker = createAchievement({
  id: 'cosmic-bakery.reality-baker',
  name: { default: 'Reality Baker', variants: {} },
  description: { default: 'Forge your first reality dough', variants: {} },
  category: 'progression' as const,
  tier: 'gold' as const,
  track: {
    kind: 'resource' as const,
    resourceId: 'cosmic-bakery.reality-dough',
    comparator: 'gte' as const,
    threshold: { kind: 'constant', value: 1 },
  },
});

// Collection Achievements
const flourPower = createAchievement({
  id: 'cosmic-bakery.flour-power',
  name: { default: 'Flour Power', variants: {} },
  description: { default: 'Own 10 hand mixers', variants: {} },
  category: 'collection' as const,
  tier: 'bronze' as const,
  track: {
    kind: 'generator-level' as const,
    generatorId: 'cosmic-bakery.hand-mixer',
    level: { kind: 'constant', value: 10 },
  },
});

const sweetEmpire = createAchievement({
  id: 'cosmic-bakery.sweet-empire',
  name: { default: 'Sweet Empire', variants: {} },
  description: { default: 'Own 10 sugar mills', variants: {} },
  category: 'collection' as const,
  tier: 'bronze' as const,
  track: {
    kind: 'generator-level' as const,
    generatorId: 'cosmic-bakery.sugar-mill',
    level: { kind: 'constant', value: 10 },
  },
});

const masterKneader = createAchievement({
  id: 'cosmic-bakery.master-kneader',
  name: { default: 'Master Kneader', variants: {} },
  description: { default: 'Own 10 kneading stations', variants: {} },
  category: 'collection' as const,
  tier: 'silver' as const,
  track: {
    kind: 'generator-level' as const,
    generatorId: 'cosmic-bakery.kneading-station',
    level: { kind: 'constant', value: 10 },
  },
});

const stargazer = createAchievement({
  id: 'cosmic-bakery.stargazer',
  name: { default: 'Stargazer', variants: {} },
  description: { default: 'Own 5 star collectors', variants: {} },
  category: 'collection' as const,
  tier: 'silver' as const,
  track: {
    kind: 'generator-level' as const,
    generatorId: 'cosmic-bakery.star-collector',
    level: { kind: 'constant', value: 5 },
  },
});

const moonChild = createAchievement({
  id: 'cosmic-bakery.moon-child',
  name: { default: 'Moon Child', variants: {} },
  description: { default: 'Own 5 moonbeam churns', variants: {} },
  category: 'collection' as const,
  tier: 'gold' as const,
  track: {
    kind: 'generator-level' as const,
    generatorId: 'cosmic-bakery.moonbeam-churn',
    level: { kind: 'constant', value: 5 },
  },
});

const ovenMaster = createAchievement({
  id: 'cosmic-bakery.oven-master',
  name: { default: 'Oven Master', variants: {} },
  description: { default: 'Own 10 enchanted ovens', variants: {} },
  category: 'collection' as const,
  tier: 'gold' as const,
  track: {
    kind: 'generator-level' as const,
    generatorId: 'cosmic-bakery.enchanted-oven',
    level: { kind: 'constant', value: 10 },
  },
});

// ============================================================================
// Automations
// ============================================================================

// Tier 1 Automations
const autoMixer = createAutomation({
  id: 'cosmic-bakery.auto-mixer',
  name: { default: 'Auto Mixer', variants: {} },
  description: { default: 'Automatically purchases hand mixers', variants: {} },
  targetType: 'generator' as const,
  targetId: 'cosmic-bakery.hand-mixer',
  trigger: {
    kind: 'resourceThreshold' as const,
    resourceId: 'cosmic-bakery.flour',
    comparator: 'gte' as const,
    threshold: { kind: 'constant', value: 100 },
  },
  resourceCost: {
    resourceId: 'cosmic-bakery.flour',
    rate: { kind: 'constant', value: 500 },
  },
  unlockCondition: { kind: 'always' as const },
});

const autoMill = createAutomation({
  id: 'cosmic-bakery.auto-mill',
  name: { default: 'Auto Mill', variants: {} },
  description: { default: 'Automatically purchases sugar mills', variants: {} },
  targetType: 'generator' as const,
  targetId: 'cosmic-bakery.sugar-mill',
  trigger: {
    kind: 'resourceThreshold' as const,
    resourceId: 'cosmic-bakery.flour',
    comparator: 'gte' as const,
    threshold: { kind: 'constant', value: 200 },
  },
  resourceCost: {
    resourceId: 'cosmic-bakery.flour',
    rate: { kind: 'constant', value: 750 },
  },
  unlockCondition: { kind: 'always' as const },
});

const autoKnead = createAutomation({
  id: 'cosmic-bakery.auto-knead',
  name: { default: 'Auto Knead', variants: {} },
  description: { default: 'Automatically purchases kneading stations', variants: {} },
  targetType: 'generator' as const,
  targetId: 'cosmic-bakery.kneading-station',
  trigger: {
    kind: 'resourceThreshold' as const,
    resourceId: 'cosmic-bakery.flour',
    comparator: 'gte' as const,
    threshold: { kind: 'constant', value: 300 },
  },
  resourceCost: {
    resourceId: 'cosmic-bakery.flour',
    rate: { kind: 'constant', value: 1000 },
  },
  unlockCondition: { kind: 'always' as const },
});

// Tier 2 Automations
const stardustCollector = createAutomation({
  id: 'cosmic-bakery.stardust-collector',
  name: { default: 'Stardust Collector', variants: {} },
  description: { default: 'Automatically purchases star collectors', variants: {} },
  targetType: 'generator' as const,
  targetId: 'cosmic-bakery.star-collector',
  trigger: {
    kind: 'resourceThreshold' as const,
    resourceId: 'cosmic-bakery.dough',
    comparator: 'gte' as const,
    threshold: { kind: 'constant', value: 500 },
  },
  resourceCost: {
    resourceId: 'cosmic-bakery.dough',
    rate: { kind: 'constant', value: 2000 },
  },
  unlockCondition: { kind: 'always' as const },
});

const smartChurn = createAutomation({
  id: 'cosmic-bakery.smart-churn',
  name: { default: 'Smart Churn', variants: {} },
  description: { default: 'Automatically purchases moonbeam churns', variants: {} },
  targetType: 'generator' as const,
  targetId: 'cosmic-bakery.moonbeam-churn',
  trigger: {
    kind: 'resourceThreshold' as const,
    resourceId: 'cosmic-bakery.stardust',
    comparator: 'gte' as const,
    threshold: { kind: 'constant', value: 200 },
  },
  resourceCost: {
    resourceId: 'cosmic-bakery.stardust',
    rate: { kind: 'constant', value: 500 },
  },
  unlockCondition: { kind: 'always' as const },
});

const smartOven = createAutomation({
  id: 'cosmic-bakery.smart-oven',
  name: { default: 'Smart Oven', variants: {} },
  description: { default: 'Automatically purchases enchanted ovens', variants: {} },
  targetType: 'generator' as const,
  targetId: 'cosmic-bakery.enchanted-oven',
  trigger: {
    kind: 'resourceThreshold' as const,
    resourceId: 'cosmic-bakery.stardust',
    comparator: 'gte' as const,
    threshold: { kind: 'constant', value: 500 },
  },
  resourceCost: {
    resourceId: 'cosmic-bakery.stardust',
    rate: { kind: 'constant', value: 1000 },
  },
  unlockCondition: { kind: 'always' as const },
});

// Tier 3 Automations
const voidAutomator = createAutomation({
  id: 'cosmic-bakery.void-automator',
  name: { default: 'Void Automator', variants: {} },
  description: { default: 'Automatically purchases void portals', variants: {} },
  targetType: 'generator' as const,
  targetId: 'cosmic-bakery.void-portal',
  trigger: {
    kind: 'resourceThreshold' as const,
    resourceId: 'cosmic-bakery.enchanted-pastries',
    comparator: 'gte' as const,
    threshold: { kind: 'constant', value: 1000 },
  },
  resourceCost: {
    resourceId: 'cosmic-bakery.enchanted-pastries',
    rate: { kind: 'constant', value: 5000 },
  },
  unlockCondition: { kind: 'always' as const },
});

// ============================================================================
// Prestige Layer
// ============================================================================

const celestialAscension = createPrestigeLayer({
  id: 'cosmic-bakery.celestial-ascension',
  name: { default: 'Celestial Ascension', variants: {} },
  summary: { default: 'Ascend to the celestial realm and gain powerful bonuses', variants: {} },
  unlockCondition: {
    kind: 'allOf' as const,
    conditions: [
      {
        kind: 'resourceThreshold' as const,
        resourceId: 'cosmic-bakery.enchanted-pastries',
        comparator: 'gte' as const,
        amount: { kind: 'constant', value: 500 },
      },
      {
        kind: 'generatorLevel' as const,
        generatorId: 'cosmic-bakery.enchanted-oven',
        comparator: 'gte' as const,
        level: { kind: 'constant', value: 10 },
      },
    ],
  },
  resetTargets: [
    'cosmic-bakery.flour',
    'cosmic-bakery.sugar',
    'cosmic-bakery.dough',
    'cosmic-bakery.stardust',
    'cosmic-bakery.moon-cream',
    'cosmic-bakery.enchanted-pastries',
    'cosmic-bakery.void-essence',
  ],
  retention: [
    { kind: 'resource' as const, resourceId: 'cosmic-bakery.ascension-stars' },
    { kind: 'resource' as const, resourceId: 'cosmic-bakery.cosmic-flour' },
    { kind: 'resource' as const, resourceId: 'cosmic-bakery.celestial-gems' },
  ],
  reward: {
    resourceId: 'cosmic-bakery.ascension-stars',
    baseReward: {
      kind: 'expression',
      expression: {
        kind: 'call',
        name: 'clamp',
        args: [
          {
            kind: 'binary',
            op: 'max',
            left: {
              kind: 'binary',
              op: 'div',
              left: {
                kind: 'ref',
                target: {
                  type: 'resource',
                  id: 'cosmic-bakery.enchanted-pastries',
                },
              },
              right: { kind: 'literal', value: 100 },
            },
            right: { kind: 'literal', value: 1 },
          },
          { kind: 'literal', value: 1 },
          { kind: 'literal', value: 1000 },
        ],
      },
    },
  },
});

// ============================================================================
// Content Pack Export
// ============================================================================

const packResult = parseContentPack({
  metadata: {
    id: '@idle-engine/cosmic-bakery',
    title: { default: 'Cosmic Bakery', variants: {} },
    summary: { default: 'A whimsical idle game about cosmic baking', variants: {} },
    version: '0.1.0',
    engine: '>=0.4.0 <1.0.0',
    authors: ['Idle Engine Team'],
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
    tags: ['game', 'cosmic', 'bakery'],
    links: [],
  },
  resources: [
    flour,
    sugar,
    dough,
    stardust,
    moonCream,
    enchantedPastries,
    voidEssence,
    realityDough,
    celestialGems,
    ascensionStars,
    cosmicFlour,
    prestigeCount,
  ],
  generators: [
    handMixer,
    sugarMill,
    kneadingStation,
    starCollector,
    moonbeamChurn,
    enchantedOven,
    voidPortal,
    realityForge,
    celestialBakery,
  ],
  upgrades: [
    betterWhisks,
    refinedSugar,
    elasticGluten,
    bulkMixing,
    doubleBatch,
    stellarAlignment,
    lunarCycleSync,
    enchantmentMastery,
    cosmicResonance,
    voidStabilizers,
    realityThreads,
    rememberedRecipes,
    timelessTechniques,
    celestialBlessing,
  ],
  achievements: [
    firstBatch,
    sugarRush,
    risingStar,
    enchantedChef,
    voidWalker,
    realityBaker,
    flourPower,
    sweetEmpire,
    masterKneader,
    stargazer,
    moonChild,
    ovenMaster,
  ],
  automations: [
    autoMixer,
    autoMill,
    autoKnead,
    stardustCollector,
    smartChurn,
    smartOven,
    voidAutomator,
  ],
  prestigeLayers: [celestialAscension],
  metrics: [],
  transforms: [],
  guildPerks: [],
  runtimeEvents: [],
});

if (packResult.balanceErrors.length > 0) {
  throw new Error(`Content pack validation failed: ${JSON.stringify(packResult.balanceErrors, null, 2)}`);
}

export const cosmicBakeryContent = packResult.pack;
