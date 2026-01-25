import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type PackJson = Readonly<Record<string, unknown>>;

const FORMULA_KINDS = Object.freeze([
  'constant',
  'linear',
  'exponential',
  'polynomial',
  'piecewise',
  'expression',
]);

const CONDITION_KINDS = Object.freeze([
  'always',
  'never',
  'resourceThreshold',
  'generatorLevel',
  'upgradeOwned',
  'prestigeCountThreshold',
  'prestigeCompleted',
  'prestigeUnlocked',
  'flag',
  'allOf',
  'anyOf',
  'not',
]);

const REQUIRED_ACHIEVEMENT_TRACK_KINDS = Object.freeze([
  'resource',
  'generator-level',
  'generator-count',
  'upgrade-owned',
  'flag',
  'custom-metric',
]);

const REQUIRED_AUTOMATION_TRIGGER_KINDS = Object.freeze([
  'interval',
  'resourceThreshold',
  'commandQueueEmpty',
  'event',
]);

const loadPackJson = (): PackJson => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const packPath = path.resolve(__dirname, '../content/pack.json');
  return JSON.parse(fs.readFileSync(packPath, 'utf8')) as PackJson;
};

const pack = loadPackJson();

const walkDeep = (value: unknown, visitor: (node: unknown) => void): void => {
  visitor(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      walkDeep(item, visitor);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      walkDeep(item, visitor);
    }
  }
};

const computeConditionDepth = (value: unknown): number => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 0;
  }

  const kind = (value as { kind?: unknown }).kind;
  if (typeof kind !== 'string') {
    return 0;
  }

  if (kind === 'allOf' || kind === 'anyOf') {
    const children = (value as { conditions?: unknown }).conditions;
    const depths = Array.isArray(children) ? children.map(computeConditionDepth) : [];
    return 1 + Math.max(0, ...depths);
  }

  if (kind === 'not') {
    return 1 + computeConditionDepth((value as { condition?: unknown }).condition);
  }

  return 1;
};

describe('test game pack coverage', () => {
  it('includes all top-level content collections', () => {
    expect(Array.isArray((pack as { resources?: unknown }).resources)).toBe(true);
    expect(Array.isArray((pack as { generators?: unknown }).generators)).toBe(true);
    expect(Array.isArray((pack as { upgrades?: unknown }).upgrades)).toBe(true);
    expect(Array.isArray((pack as { achievements?: unknown }).achievements)).toBe(true);
    expect(Array.isArray((pack as { automations?: unknown }).automations)).toBe(true);
    expect(Array.isArray((pack as { transforms?: unknown }).transforms)).toBe(true);
    expect(Array.isArray((pack as { entities?: unknown }).entities)).toBe(true);
    expect(Array.isArray((pack as { prestigeLayers?: unknown }).prestigeLayers)).toBe(true);
    expect(Array.isArray((pack as { metrics?: unknown }).metrics)).toBe(true);
    expect(Array.isArray((pack as { runtimeEvents?: unknown }).runtimeEvents)).toBe(true);
  });

  it('covers all formula kinds and condition kinds (including all comparators)', () => {
    const formulaKinds = new Set<string>();
    const conditionKinds = new Set<string>();
    const comparators = new Set<string>();
    let maxConditionDepth = 0;

    walkDeep(pack, (node) => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) {
        return;
      }

      const kind = (node as { kind?: unknown }).kind;
      if (typeof kind === 'string') {
        if ((FORMULA_KINDS as readonly string[]).includes(kind)) {
          formulaKinds.add(kind);
        }
        if ((CONDITION_KINDS as readonly string[]).includes(kind)) {
          conditionKinds.add(kind);
          maxConditionDepth = Math.max(maxConditionDepth, computeConditionDepth(node));
        }
      }

      const comparator = (node as { comparator?: unknown }).comparator;
      if (typeof comparator === 'string') {
        comparators.add(comparator);
      }
    });

    for (const kind of FORMULA_KINDS) {
      expect(formulaKinds.has(kind)).toBe(true);
    }

    for (const kind of CONDITION_KINDS) {
      expect(conditionKinds.has(kind)).toBe(true);
    }

    for (const comparator of ['gte', 'gt', 'lte', 'lt'] as const) {
      expect(comparators.has(comparator)).toBe(true);
    }

    expect(maxConditionDepth).toBeGreaterThanOrEqual(4);
  });

  it('covers achievement tracks, tiers, progress modes, and on-unlock events', () => {
    const achievements = (pack as { achievements?: unknown }).achievements;
    expect(Array.isArray(achievements)).toBe(true);

    const trackKinds = new Set<string>();
    const tiers = new Set<string>();
    const progressModes = new Set<string>();
    let hasOnUnlockEvents = false;

    for (const achievement of achievements as unknown[]) {
      if (!achievement || typeof achievement !== 'object' || Array.isArray(achievement)) {
        continue;
      }

      const tier = (achievement as { tier?: unknown }).tier;
      if (typeof tier === 'string') {
        tiers.add(tier);
      }

      const track = (achievement as { track?: unknown }).track;
      if (track && typeof track === 'object' && !Array.isArray(track)) {
        const kind = (track as { kind?: unknown }).kind;
        if (typeof kind === 'string') {
          trackKinds.add(kind);
        }
      }

      const progress = (achievement as { progress?: unknown }).progress;
      if (progress && typeof progress === 'object' && !Array.isArray(progress)) {
        const mode = (progress as { mode?: unknown }).mode;
        if (typeof mode === 'string') {
          progressModes.add(mode);
        }
      } else {
        progressModes.add('oneShot');
      }

      const onUnlockEvents = (achievement as { onUnlockEvents?: unknown }).onUnlockEvents;
      if (Array.isArray(onUnlockEvents) && onUnlockEvents.length > 0) {
        hasOnUnlockEvents = true;
      }
    }

    for (const kind of REQUIRED_ACHIEVEMENT_TRACK_KINDS) {
      expect(trackKinds.has(kind)).toBe(true);
    }

    for (const tier of ['bronze', 'silver', 'gold', 'platinum'] as const) {
      expect(tiers.has(tier)).toBe(true);
    }

    for (const mode of ['oneShot', 'incremental', 'repeatable'] as const) {
      expect(progressModes.has(mode)).toBe(true);
    }

    expect(hasOnUnlockEvents).toBe(true);
  });

  it('covers automation triggers, targets, cooldown formulas, and resource costs', () => {
    const automations = (pack as { automations?: unknown }).automations;
    expect(Array.isArray(automations)).toBe(true);

    const triggerKinds = new Set<string>();
    const targetTypes = new Set<string>();
    const systemTargetIds = new Set<string>();
    const thresholdComparators = new Set<string>();
    let hasFormulaCooldown = false;
    let hasResourceCost = false;

    for (const automation of automations as unknown[]) {
      if (!automation || typeof automation !== 'object' || Array.isArray(automation)) {
        continue;
      }

      const targetType = (automation as { targetType?: unknown }).targetType;
      if (typeof targetType === 'string') {
        targetTypes.add(targetType);
      }

      const systemTargetId = (automation as { systemTargetId?: unknown }).systemTargetId;
      if (typeof systemTargetId === 'string') {
        systemTargetIds.add(systemTargetId);
      }

      const trigger = (automation as { trigger?: unknown }).trigger;
      if (trigger && typeof trigger === 'object' && !Array.isArray(trigger)) {
        const kind = (trigger as { kind?: unknown }).kind;
        if (typeof kind === 'string') {
          triggerKinds.add(kind);
        }

        if (kind === 'resourceThreshold') {
          const comparator = (trigger as { comparator?: unknown }).comparator;
          if (typeof comparator === 'string') {
            thresholdComparators.add(comparator);
          }
        }
      }

      const cooldown = (automation as { cooldown?: unknown }).cooldown;
      if (cooldown && typeof cooldown === 'object' && !Array.isArray(cooldown)) {
        hasFormulaCooldown = true;
      }

      if ((automation as { resourceCost?: unknown }).resourceCost) {
        hasResourceCost = true;
      }
    }

    for (const kind of REQUIRED_AUTOMATION_TRIGGER_KINDS) {
      expect(triggerKinds.has(kind)).toBe(true);
    }

    for (const targetType of ['generator', 'upgrade', 'purchaseGenerator', 'collectResource', 'system'] as const) {
      expect(targetTypes.has(targetType)).toBe(true);
    }

    expect(systemTargetIds.has('offline-catchup')).toBe(true);
    expect(thresholdComparators.has('gte')).toBe(true);
    expect(thresholdComparators.has('lte')).toBe(true);
    expect(hasFormulaCooldown).toBe(true);
    expect(hasResourceCost).toBe(true);
  });
});

