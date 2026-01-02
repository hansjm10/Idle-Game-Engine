/**
 * Synthetic Content Pack Generator for Benchmarking
 *
 * Generates valid ContentPack objects with configurable entity counts.
 * Uses seeded PRNG for deterministic, reproducible generation.
 */

/**
 * Mulberry32 PRNG - fast, deterministic 32-bit generator.
 * @param {number} seed
 * @returns {() => number} A function that returns the next random number in [0, 1).
 */
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Seeded random utilities class.
 */
class SeededRandom {
  /**
   * @param {number} seed
   */
  constructor(seed) {
    this._next = mulberry32(seed);
  }

  /** @returns {number} Random float in [0, 1) */
  random() {
    return this._next();
  }

  /**
   * Random integer in [min, max] inclusive.
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  int(min, max) {
    return Math.floor(this.random() * (max - min + 1)) + min;
  }

  /**
   * Random float in [min, max].
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  float(min, max) {
    return this.random() * (max - min) + min;
  }

  /**
   * Pick a random element from an array.
   * @template T
   * @param {T[]} array
   * @returns {T}
   */
  pick(array) {
    return array[this.int(0, array.length - 1)];
  }

  /**
   * Pick multiple unique elements from an array.
   * @template T
   * @param {T[]} array
   * @param {number} count
   * @returns {T[]}
   */
  pickMultiple(array, count) {
    const copy = [...array];
    const result = [];
    const n = Math.min(count, copy.length);
    for (let i = 0; i < n; i++) {
      const idx = this.int(0, copy.length - 1);
      result.push(copy[idx]);
      copy.splice(idx, 1);
    }
    return result;
  }

  /**
   * Returns true with given probability.
   * @param {number} probability Value between 0 and 1.
   * @returns {boolean}
   */
  chance(probability) {
    return this.random() < probability;
  }
}

// Resource categories available for generation
const RESOURCE_CATEGORIES = ['primary', 'prestige', 'automation', 'currency', 'misc'];

/**
 * Create a LocalizedText object from a string.
 * @param {string} text - The default text value.
 * @returns {{ default: string, variants: {} }}
 */
function localized(text) {
  return { default: text, variants: {} };
}

/**
 * Create a LocalizedSummary object from a string (max 500 chars).
 * @param {string} text - The default summary value.
 * @returns {{ default: string, variants: {} }}
 */
function localizedSummary(text) {
  return { default: text.slice(0, 500), variants: {} };
}

// Achievement categories available for generation
const ACHIEVEMENT_CATEGORIES = ['progression', 'prestige', 'automation', 'collection'];

// Achievement tiers available for generation
const ACHIEVEMENT_TIERS = ['bronze', 'silver', 'gold', 'platinum'];

// Upgrade categories available for generation
const UPGRADE_CATEGORIES = ['global', 'resource', 'generator', 'automation', 'prestige'];

// Automation target types (excluding 'system' for simplicity)
const AUTOMATION_TARGET_TYPES = ['generator', 'upgrade', 'purchaseGenerator'];

/**
 * Generate a random numeric formula.
 * Uses a mix of constant, linear, polynomial, and exponential formulas.
 * @param {SeededRandom} rng
 * @param {'cost' | 'rate' | 'threshold'} [context='rate']
 * @returns {object}
 */
function generateFormula(rng, context = 'rate') {
  const roll = rng.random();

  // 40% constant
  if (roll < 0.4) {
    const value =
      context === 'cost'
        ? rng.float(10, 1000)
        : context === 'threshold'
          ? rng.float(100, 10000)
          : rng.float(0.1, 10);
    return { kind: 'constant', value: Math.round(value * 100) / 100 };
  }

  // 30% linear
  if (roll < 0.7) {
    const base =
      context === 'cost'
        ? rng.float(5, 100)
        : context === 'threshold'
          ? rng.float(50, 500)
          : rng.float(1, 5);
    const slope =
      context === 'cost'
        ? rng.float(1, 50)
        : context === 'threshold'
          ? rng.float(10, 100)
          : rng.float(0.1, 2);
    return {
      kind: 'linear',
      base: Math.round(base * 100) / 100,
      slope: Math.round(slope * 100) / 100,
    };
  }

  // 20% polynomial (degree 2 or 3)
  if (roll < 0.9) {
    const degree = rng.int(2, 3);
    const coefficients = [];
    for (let i = 0; i <= degree; i++) {
      const coef =
        context === 'cost'
          ? rng.float(1, 20) / (i + 1)
          : context === 'threshold'
            ? rng.float(5, 50) / (i + 1)
            : rng.float(0.1, 2) / (i + 1);
      coefficients.push(Math.round(coef * 1000) / 1000);
    }
    return { kind: 'polynomial', coefficients };
  }

  // 10% exponential
  const base =
    context === 'cost'
      ? rng.float(5, 50)
      : context === 'threshold'
        ? rng.float(50, 200)
        : rng.float(1, 3);
  const growth = rng.float(1.01, 1.15);
  return {
    kind: 'exponential',
    base: Math.round(base * 100) / 100,
    growth: Math.round(growth * 10000) / 10000,
  };
}

/**
 * Generate a condition for unlocks/visibility.
 * @param {SeededRandom} rng
 * @param {string[]} resourceIds - Available resource IDs.
 * @param {string[]} generatorIds - Available generator IDs.
 * @param {string[]} upgradeIds - Available upgrade IDs.
 * @returns {object}
 */
function generateCondition(rng, resourceIds, generatorIds, upgradeIds) {
  const roll = rng.random();

  // 30% always (simple)
  if (roll < 0.3 || (resourceIds.length === 0 && generatorIds.length === 0)) {
    return { kind: 'always' };
  }

  // 30% resource threshold
  if (roll < 0.6 && resourceIds.length > 0) {
    return {
      kind: 'resourceThreshold',
      resourceId: rng.pick(resourceIds),
      comparator: 'gte',
      amount: generateFormula(rng, 'threshold'),
    };
  }

  // 20% generator level
  if (roll < 0.8 && generatorIds.length > 0) {
    return {
      kind: 'generatorLevel',
      generatorId: rng.pick(generatorIds),
      comparator: 'gte',
      level: { kind: 'constant', value: rng.int(1, 10) },
    };
  }

  // 20% upgrade owned
  if (upgradeIds.length > 0) {
    return {
      kind: 'upgradeOwned',
      upgradeId: rng.pick(upgradeIds),
      requiredPurchases: 1,
    };
  }

  return { kind: 'always' };
}

/**
 * @typedef {object} GenerateSyntheticPackOptions
 * @property {number} resources - Number of resources to generate.
 * @property {number} generators - Number of generators to generate.
 * @property {number} upgrades - Number of upgrades to generate.
 * @property {number} [achievements] - Number of achievements (defaults to resources / 10).
 * @property {number} [automations] - Number of automations (defaults to generators / 10).
 * @property {number} [seed] - Seed for reproducible generation (defaults to 12345).
 */

/**
 * Generate a synthetic content pack with the specified entity counts.
 *
 * @param {GenerateSyntheticPackOptions} options
 * @returns {object} A valid ContentPack object.
 */
export function generateSyntheticPack(options) {
  const {
    resources: resourceCount,
    generators: generatorCount,
    upgrades: upgradeCount,
    achievements: achievementCount = Math.max(1, Math.floor(resourceCount / 10)),
    automations: automationCount = Math.max(1, Math.floor(generatorCount / 10)),
    seed = 12345,
  } = options;

  const rng = new SeededRandom(seed);

  // Generate pack ID
  const packId = `synth-pack-${seed}`;

  // ===================
  // Generate Resources
  // ===================
  const resources = [];
  const resourceIds = [];

  for (let i = 0; i < resourceCount; i++) {
    const id = `res_${i}`;
    resourceIds.push(id);

    const tier = Math.floor(i / Math.max(1, Math.ceil(resourceCount / 5))) + 1;
    const category = rng.pick(RESOURCE_CATEGORIES);

    resources.push({
      id,
      name: localized(`Resource ${i}`),
      category,
      tier,
      startAmount: i === 0 ? 100 : 0, // First resource starts with some amount
      capacity: rng.chance(0.3) ? rng.int(1000, 100000) : null,
      visible: true,
      unlocked: i < 5, // First few are unlocked
      order: i,
    });
  }

  // ===================
  // Generate Generators
  // ===================
  const generators = [];
  const generatorIds = [];

  for (let i = 0; i < generatorCount; i++) {
    const id = `gen_${i}`;
    generatorIds.push(id);

    // Each generator produces 1-3 resources
    const producesCount = rng.int(1, Math.min(3, resourceCount));
    const producedResourceIds = rng.pickMultiple(resourceIds, producesCount);

    const produces = producedResourceIds.map((resourceId) => ({
      resourceId,
      rate: generateFormula(rng, 'rate'),
    }));

    // 30% chance to consume a resource
    const consumes = [];
    if (rng.chance(0.3) && resourceCount > 1) {
      const availableForConsumption = resourceIds.filter(
        (rid) => !producedResourceIds.includes(rid),
      );
      if (availableForConsumption.length > 0) {
        consumes.push({
          resourceId: rng.pick(availableForConsumption),
          rate: generateFormula(rng, 'rate'),
        });
      }
    }

    // Cost uses first resource or a random currency-tier resource
    const costCurrencyId = resourceIds[Math.min(i % resourceCount, resourceCount - 1)];

    const purchase = {
      currencyId: costCurrencyId,
      costMultiplier: rng.float(1, 10),
      costCurve: generateFormula(rng, 'cost'),
    };

    // Base unlock condition
    const baseUnlock =
      i < 3
        ? { kind: 'always' }
        : generateCondition(
            rng,
            resourceIds.slice(0, Math.min(i, resourceIds.length)),
            generatorIds.slice(0, i),
            [],
          );

    generators.push({
      id,
      name: localized(`Generator ${i}`),
      produces,
      consumes,
      purchase,
      initialLevel: i === 0 ? 1 : 0,
      maxLevel: rng.chance(0.2) ? rng.int(50, 200) : undefined,
      order: i,
      baseUnlock,
    });
  }

  // ===================
  // Generate Upgrades
  // ===================
  const upgrades = [];
  const upgradeIds = [];

  for (let i = 0; i < upgradeCount; i++) {
    const id = `upg_${i}`;
    upgradeIds.push(id);

    const category = rng.pick(UPGRADE_CATEGORIES);

    // Determine targets based on category
    let targets;
    switch (category) {
      case 'global':
        targets = [{ kind: 'global' }];
        break;
      case 'resource':
        targets = [{ kind: 'resource', id: rng.pick(resourceIds) }];
        break;
      case 'generator':
        targets =
          generatorIds.length > 0
            ? [{ kind: 'generator', id: rng.pick(generatorIds) }]
            : [{ kind: 'global' }];
        break;
      default:
        targets = [{ kind: 'global' }];
    }

    // Cost
    const costCurrencyId = rng.pick(resourceIds);
    const cost = {
      currencyId: costCurrencyId,
      costMultiplier: rng.float(1, 5),
      costCurve: generateFormula(rng, 'cost'),
    };

    // Effects - generate 1-2 effects
    const effects = [];
    const effectCount = rng.int(1, 2);

    for (let j = 0; j < effectCount; j++) {
      const effectRoll = rng.random();

      if (effectRoll < 0.4 && resourceIds.length > 0) {
        effects.push({
          kind: 'modifyResourceRate',
          resourceId: rng.pick(resourceIds),
          operation: rng.pick(['add', 'multiply']),
          value: generateFormula(rng, 'rate'),
        });
      } else if (effectRoll < 0.7 && generatorIds.length > 0) {
        effects.push({
          kind: 'modifyGeneratorRate',
          generatorId: rng.pick(generatorIds),
          operation: rng.pick(['add', 'multiply']),
          value: generateFormula(rng, 'rate'),
        });
      } else if (effectRoll < 0.85 && generatorIds.length > 0) {
        effects.push({
          kind: 'modifyGeneratorCost',
          generatorId: rng.pick(generatorIds),
          operation: 'multiply',
          value: { kind: 'constant', value: rng.float(0.8, 0.95) },
        });
      } else {
        // Default fallback effect
        effects.push({
          kind: 'modifyResourceRate',
          resourceId: rng.pick(resourceIds),
          operation: 'multiply',
          value: { kind: 'constant', value: rng.float(1.1, 1.5) },
        });
      }
    }

    // Prerequisites (only for upgrades after the first few)
    const prerequisites = [];
    if (i > 5 && upgradeIds.length > 1 && rng.chance(0.5)) {
      // Add 1-2 prerequisite upgrades from earlier upgrades
      const availablePrereqs = upgradeIds.slice(0, i);
      const prereqCount = rng.int(1, Math.min(2, availablePrereqs.length));
      const prereqIds = rng.pickMultiple(availablePrereqs, prereqCount);
      prereqIds.forEach((prereqId) => {
        prerequisites.push({
          kind: 'upgradeOwned',
          upgradeId: prereqId,
          requiredPurchases: 1,
        });
      });
    }

    // Repeatable config (30% of upgrades)
    const repeatable = rng.chance(0.3)
      ? {
          maxPurchases: rng.int(5, 20),
          costCurve: generateFormula(rng, 'cost'),
        }
      : undefined;

    upgrades.push({
      id,
      name: localized(`Upgrade ${i}`),
      category,
      targets,
      cost,
      effects,
      prerequisites,
      repeatable,
      order: i,
    });
  }

  // ===================
  // Generate Achievements
  // ===================
  const achievements = [];

  for (let i = 0; i < achievementCount; i++) {
    const id = `ach_${i}`;

    const category = rng.pick(ACHIEVEMENT_CATEGORIES);
    const tier = rng.pick(ACHIEVEMENT_TIERS);

    // Track - typically resource threshold
    let track;
    const trackRoll = rng.random();

    if (trackRoll < 0.6 && resourceIds.length > 0) {
      track = {
        kind: 'resource',
        resourceId: rng.pick(resourceIds),
        threshold: generateFormula(rng, 'threshold'),
        comparator: 'gte',
      };
    } else if (trackRoll < 0.9 && generatorIds.length > 0) {
      track = {
        kind: 'generator-level',
        generatorId: rng.pick(generatorIds),
        level: { kind: 'constant', value: rng.int(5, 50) },
      };
    } else if (upgradeIds.length > 0) {
      track = {
        kind: 'upgrade-owned',
        upgradeId: rng.pick(upgradeIds),
        purchases: { kind: 'constant', value: 1 },
      };
    } else {
      // Fallback to resource if we somehow have no generators/upgrades
      track = {
        kind: 'resource',
        resourceId: rng.pick(resourceIds),
        threshold: { kind: 'constant', value: 100 },
        comparator: 'gte',
      };
    }

    achievements.push({
      id,
      name: localized(`Achievement ${i}`),
      description: localizedSummary(`Complete achievement ${i} to earn rewards.`),
      category,
      tier,
      track,
      displayOrder: i,
    });
  }

  // ===================
  // Generate Automations
  // ===================
  const automations = [];

  for (let i = 0; i < automationCount; i++) {
    const id = `auto_${i}`;

    const targetType = rng.pick(AUTOMATION_TARGET_TYPES);

    let targetId;
    switch (targetType) {
      case 'generator':
      case 'purchaseGenerator':
        targetId = generatorIds.length > 0 ? rng.pick(generatorIds) : undefined;
        break;
      case 'upgrade':
        targetId = upgradeIds.length > 0 ? rng.pick(upgradeIds) : undefined;
        break;
      default:
        targetId = undefined;
    }

    // Skip if we don't have a valid target
    if (!targetId) {
      continue;
    }

    // Trigger - interval-based
    const trigger = {
      kind: 'interval',
      interval: { kind: 'constant', value: rng.float(1000, 10000) },
    };

    // Unlock condition
    const unlockCondition =
      i < 2
        ? { kind: 'always' }
        : generateCondition(rng, resourceIds, generatorIds, upgradeIds.slice(0, Math.floor(upgradeIds.length / 2)));

    // Build automation object based on target type
    const automation = {
      id,
      name: localized(`Automation ${i}`),
      description: localized(`Automatically ${targetType === 'generator' ? 'toggles' : 'purchases'} ${targetId}.`),
      targetType,
      targetId,
      trigger,
      unlockCondition,
      enabledByDefault: false,
      order: i,
    };

    // Add target-specific fields
    if (targetType === 'generator') {
      automation.targetEnabled = true;
    } else if (targetType === 'purchaseGenerator') {
      automation.targetCount = { kind: 'constant', value: rng.int(1, 10) };
    }

    automations.push(automation);
  }

  // ===================
  // Build Content Pack
  // ===================
  return {
    metadata: {
      id: packId,
      title: localized(`Synthetic Pack (seed: ${seed})`),
      version: '1.0.0',
      engine: '>=0.1.0',
      authors: ['Benchmark Generator'],
      defaultLocale: 'en',
      supportedLocales: ['en'],
    },
    resources,
    generators,
    upgrades,
    achievements,
    automations,
    metrics: [],
    transforms: [],
    prestigeLayers: [],
    runtimeEvents: [],
  };
}

/**
 * Preset configurations for common benchmark scenarios.
 */
export const PACK_PRESETS = {
  /** Tiny pack: ~40 entities total */
  tiny: {
    resources: 20,
    generators: 10,
    upgrades: 8,
    achievements: 2,
    automations: 1,
  },

  /** Medium pack: ~200 entities total */
  medium: {
    resources: 80,
    generators: 60,
    upgrades: 40,
    achievements: 15,
    automations: 6,
  },

  /** Large pack: ~850 entities total */
  large: {
    resources: 500,
    generators: 200,
    upgrades: 150,
    achievements: 50,
    automations: 20,
  },
};

/**
 * Generate a pack using a preset configuration.
 * @param {'tiny' | 'medium' | 'large'} preset
 * @param {number} [seed]
 * @returns {object}
 */
export function generatePresetPack(preset, seed) {
  const config = PACK_PRESETS[preset];
  if (!config) {
    throw new Error(`Unknown preset: ${preset}. Available: ${Object.keys(PACK_PRESETS).join(', ')}`);
  }
  return generateSyntheticPack({ ...config, seed });
}

/**
 * Calculate total entity count for a pack.
 * @param {object} pack
 * @returns {number}
 */
export function countPackEntities(pack) {
  return (
    (pack.resources?.length || 0) +
    (pack.generators?.length || 0) +
    (pack.upgrades?.length || 0) +
    (pack.achievements?.length || 0) +
    (pack.automations?.length || 0) +
    (pack.metrics?.length || 0) +
    (pack.transforms?.length || 0) +
    (pack.prestigeLayers?.length || 0) +
    (pack.runtimeEvents?.length || 0)
  );
}
