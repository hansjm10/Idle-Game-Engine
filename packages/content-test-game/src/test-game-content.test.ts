import { describe, expect, it } from 'vitest';

import {
  testGameContent,
  testGameContentDigest,
  testGameContentArtifactHash,
  testGameContentIndices,
  testGameContentSummary,
  testGameEventDefinitions,
  testGameEventTypes,
} from './index.js';

describe('test-game content pack', () => {
  it('should have valid metadata', () => {
    expect(testGameContent.metadata.id).toBe('@idle-engine/test-game');
    expect(testGameContent.metadata.version).toBe('0.1.0');
    expect(testGameContent.metadata.authors).toContain('Idle Engine Team');
  });

  it('should have expected resource count', () => {
    expect(testGameContent.resources.length).toBe(10);
  });

  it('should have expected generator count', () => {
    expect(testGameContent.generators.length).toBe(8);
  });

  it('should have expected upgrade count', () => {
    expect(testGameContent.upgrades.length).toBe(15);
  });

  it('should have expected achievement count', () => {
    expect(testGameContent.achievements.length).toBe(12);
  });

  it('should have expected automation count', () => {
    expect(testGameContent.automations.length).toBe(6);
  });

  it('should have expected entity count', () => {
    expect(testGameContent.entities.length).toBe(3);
  });

  it('should have expected transform count', () => {
    expect(testGameContent.transforms.length).toBe(3);
  });

  it('should have expected prestige layer count', () => {
    expect(testGameContent.prestigeLayers.length).toBe(2);
  });

  it('should have expected metrics count', () => {
    expect(testGameContent.metrics.length).toBe(5);
  });

  it('should have content digest', () => {
    expect(testGameContentDigest).toBeDefined();
    expect(testGameContentDigest.hash).toBeDefined();
    expect(testGameContentDigest.version).toBeDefined();
  });

  it('should have artifact hash', () => {
    expect(typeof testGameContentArtifactHash).toBe('string');
    expect(testGameContentArtifactHash.length).toBeGreaterThan(0);
  });

  it('should have content indices', () => {
    expect(testGameContentIndices).toBeDefined();
    expect(testGameContentIndices.resources).toBeDefined();
    expect(testGameContentIndices.generators).toBeDefined();
  });

  it('should have content summary', () => {
    expect(testGameContentSummary).toBeDefined();
    expect(testGameContentSummary.slug).toBe('@idle-engine/test-game');
    expect(testGameContentSummary.warningCount).toBe(0);
  });

  it('should have runtime event definitions', () => {
    expect(testGameEventDefinitions).toBeDefined();
    expect(Array.isArray(testGameEventDefinitions)).toBe(true);
  });

  it('should have runtime event types', () => {
    expect(testGameEventTypes).toBeDefined();
    expect(Array.isArray(testGameEventTypes)).toBe(true);
  });
});

describe('test-game resources', () => {
  it('should have gold resource starting with 100', () => {
    const gold = testGameContent.resources.find((r) => r.id === 'test-game.gold');
    expect(gold).toBeDefined();
    expect(gold?.startAmount).toBe(100);
    expect(gold?.tier).toBe(1);
  });

  it('should have mana resource with capacity', () => {
    const mana = testGameContent.resources.find((r) => r.id === 'test-game.mana');
    expect(mana).toBeDefined();
    expect(mana?.capacity).toBe(1000);
  });

  it('should have prestige resources', () => {
    const prestigePoints = testGameContent.resources.find(
      (r) => r.id === 'test-game.prestige-points',
    );
    const omegaPoints = testGameContent.resources.find(
      (r) => r.id === 'test-game.omega-points',
    );
    expect(prestigePoints).toBeDefined();
    expect(omegaPoints).toBeDefined();
    expect(prestigePoints?.category).toBe('prestige');
    expect(omegaPoints?.category).toBe('prestige');
  });

  it('should have prestige count resources for each layer', () => {
    const ascensionCount = testGameContent.resources.find(
      (r) => r.id === 'test-game.ascension-prestige-count',
    );
    const omegaCount = testGameContent.resources.find(
      (r) => r.id === 'test-game.omega-prestige-count',
    );
    expect(ascensionCount).toBeDefined();
    expect(omegaCount).toBeDefined();
  });
});

describe('test-game generators', () => {
  it('should have gold mine with exponential cost curve', () => {
    const goldMine = testGameContent.generators.find(
      (g) => g.id === 'test-game.gold-mine',
    );
    expect(goldMine).toBeDefined();
    expect(goldMine?.purchase.costCurve.kind).toBe('exponential');
  });

  it('should have mana well with polynomial cost curve', () => {
    const manaWell = testGameContent.generators.find(
      (g) => g.id === 'test-game.mana-well',
    );
    expect(manaWell).toBeDefined();
    expect(manaWell?.purchase.costCurve.kind).toBe('polynomial');
  });

  it('should have essence refinery with piecewise cost curve', () => {
    const refinery = testGameContent.generators.find(
      (g) => g.id === 'test-game.essence-refinery',
    );
    expect(refinery).toBeDefined();
    expect(refinery?.purchase.costCurve.kind).toBe('piecewise');
  });
});

describe('test-game upgrades', () => {
  it('should have expression formula upgrade', () => {
    const expressionUpgrade = testGameContent.upgrades.find(
      (u) => u.id === 'test-game.expression-upgrade',
    );
    expect(expressionUpgrade).toBeDefined();
    const effect = expressionUpgrade?.effects[0];
    expect(effect?.kind).toBe('modifyResourceRate');
    if (effect?.kind === 'modifyResourceRate') {
      expect(effect.value.kind).toBe('expression');
    }
  });

  it('should have repeatable upgrade', () => {
    const repeatableUpgrade = testGameContent.upgrades.find(
      (u) => u.id === 'test-game.essence-rate-2',
    );
    expect(repeatableUpgrade).toBeDefined();
    expect(repeatableUpgrade?.repeatable).toBeDefined();
    expect(repeatableUpgrade?.repeatable?.maxPurchases).toBe(10);
  });
});

describe('test-game achievements', () => {
  it('should have all track kinds', () => {
    const trackKinds = new Set(
      testGameContent.achievements.map((a) => a.track.kind),
    );
    expect(trackKinds.has('resource')).toBe(true);
    expect(trackKinds.has('generator-level')).toBe(true);
    expect(trackKinds.has('generator-count')).toBe(true);
    expect(trackKinds.has('upgrade-owned')).toBe(true);
    expect(trackKinds.has('flag')).toBe(true);
    expect(trackKinds.has('custom-metric')).toBe(true);
  });

  it('should have achievement with repeatable progress', () => {
    const customTracker = testGameContent.achievements.find(
      (a) => a.id === 'test-game.custom-tracker',
    );
    expect(customTracker).toBeDefined();
    expect(customTracker?.progress.mode).toBe('repeatable');
    expect(customTracker?.progress.repeatable).toBeDefined();
  });

  it('should have achievement with lt comparator', () => {
    const minimalist = testGameContent.achievements.find(
      (a) => a.id === 'test-game.low-resource',
    );
    expect(minimalist).toBeDefined();
    if (minimalist?.track.kind === 'resource') {
      expect(minimalist.track.comparator).toBe('lt');
    }
  });
});

describe('test-game automations', () => {
  it('should have all trigger kinds', () => {
    const triggerKinds = new Set(
      testGameContent.automations.map((a) => a.trigger.kind),
    );
    expect(triggerKinds.has('interval')).toBe(true);
    expect(triggerKinds.has('resourceThreshold')).toBe(true);
    expect(triggerKinds.has('commandQueueEmpty')).toBe(true);
    expect(triggerKinds.has('event')).toBe(true);
  });

  it('should have automation with formula-based interval', () => {
    const formulaAuto = testGameContent.automations.find(
      (a) => a.id === 'test-game.formula-cooldown-auto',
    );
    expect(formulaAuto).toBeDefined();
    if (formulaAuto?.trigger.kind === 'interval') {
      expect(formulaAuto.trigger.interval.kind).toBe('expression');
    }
  });

  it('should have system target automation', () => {
    const autoPrestige = testGameContent.automations.find(
      (a) => a.id === 'test-game.auto-prestige',
    );
    expect(autoPrestige).toBeDefined();
    expect(autoPrestige?.targetType).toBe('system');
  });
});

describe('test-game entities', () => {
  it('should have hero entity with XP progression', () => {
    const hero = testGameContent.entities.find((e) => e.id === 'test-game.hero');
    expect(hero).toBeDefined();
    expect(hero?.progression).toBeDefined();
    expect(hero?.progression?.maxLevel).toBe(50);
    expect(hero?.trackInstances).toBe(true);
  });

  it('should have artifact entity without instance tracking', () => {
    const artifact = testGameContent.entities.find(
      (e) => e.id === 'test-game.artifact',
    );
    expect(artifact).toBeDefined();
    expect(artifact?.trackInstances).toBe(false);
  });
});

describe('test-game transforms', () => {
  it('should have instant transform', () => {
    const refineEssence = testGameContent.transforms.find(
      (t) => t.id === 'test-game.refine-essence',
    );
    expect(refineEssence).toBeDefined();
    expect(refineEssence?.mode).toBe('instant');
  });

  it('should have batch transform', () => {
    const batchProduction = testGameContent.transforms.find(
      (t) => t.id === 'test-game.batch-production',
    );
    expect(batchProduction).toBeDefined();
    expect(batchProduction?.mode).toBe('batch');
    expect(batchProduction?.safety?.maxOutstandingBatches).toBe(5);
  });

  it('should have mission transform', () => {
    const expedition = testGameContent.transforms.find(
      (t) => t.id === 'test-game.expedition',
    );
    expect(expedition).toBeDefined();
    expect(expedition?.mode).toBe('mission');
    expect(expedition?.entityRequirements).toBeDefined();
    expect(expedition?.outcomes).toBeDefined();
  });
});

describe('test-game prestige layers', () => {
  it('should have two prestige layers', () => {
    expect(testGameContent.prestigeLayers.length).toBe(2);
  });

  it('should have ascension layer with expression reward', () => {
    const ascension = testGameContent.prestigeLayers.find(
      (p) => p.id === 'test-game.ascension',
    );
    expect(ascension).toBeDefined();
    expect(ascension?.reward.baseReward.kind).toBe('expression');
  });

  it('should have omega layer requiring prestige count', () => {
    const omega = testGameContent.prestigeLayers.find(
      (p) => p.id === 'test-game.omega',
    );
    expect(omega).toBeDefined();
    // Check unlock condition references prestige count
    expect(omega?.unlockCondition.kind).toBe('allOf');
  });
});
