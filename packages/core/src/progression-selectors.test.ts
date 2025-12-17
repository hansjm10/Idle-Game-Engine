import { describe, expect, it } from 'vitest';

import {
  selectAvailableUpgrades,
  selectLockedUpgradesWithHints,
  selectPurchasableGenerators,
  selectPurchasableUpgrades,
  selectTopNActionables,
  selectUnlockedGenerators,
  selectVisibleGenerators,
  selectVisibleUpgrades,
} from './progression-selectors.js';
import type {
  GeneratorView,
  ProgressionSnapshot,
  ResourceView,
  UpgradeView,
} from './progression.js';

function createResource(
  overrides: Partial<ResourceView> & Pick<ResourceView, 'id'>,
): ResourceView {
  return Object.freeze({
    id: overrides.id,
    displayName: overrides.displayName ?? overrides.id,
    amount: overrides.amount ?? 0,
    isUnlocked: overrides.isUnlocked ?? true,
    isVisible: overrides.isVisible ?? true,
    perTick: overrides.perTick ?? 0,
    ...(overrides.capacity !== undefined ? { capacity: overrides.capacity } : {}),
  });
}

function createGenerator(
  overrides: Partial<GeneratorView> & Pick<GeneratorView, 'id'>,
): GeneratorView {
  return Object.freeze({
    id: overrides.id,
    displayName: overrides.displayName ?? overrides.id,
    owned: overrides.owned ?? 0,
    enabled: overrides.enabled ?? true,
    isUnlocked: overrides.isUnlocked ?? true,
    isVisible: overrides.isVisible ?? true,
    costs: overrides.costs ?? Object.freeze([]),
    produces: overrides.produces ?? Object.freeze([]),
    consumes: overrides.consumes ?? Object.freeze([]),
    nextPurchaseReadyAtStep: overrides.nextPurchaseReadyAtStep ?? 0,
  });
}

function createUpgrade(
  overrides: Partial<UpgradeView> & Pick<UpgradeView, 'id'>,
): UpgradeView {
  return Object.freeze({
    id: overrides.id,
    displayName: overrides.displayName ?? overrides.id,
    status: overrides.status ?? 'locked',
    ...(overrides.costs !== undefined ? { costs: overrides.costs } : {}),
    ...(overrides.unlockHint !== undefined
      ? { unlockHint: overrides.unlockHint }
      : {}),
    isVisible: overrides.isVisible ?? true,
  });
}

function createSnapshot(
  overrides: Partial<ProgressionSnapshot> = {},
): ProgressionSnapshot {
  return Object.freeze({
    step: overrides.step ?? 10,
    publishedAt: overrides.publishedAt ?? 0,
    resources: overrides.resources ?? Object.freeze([]),
    generators: overrides.generators ?? Object.freeze([]),
    upgrades: overrides.upgrades ?? Object.freeze([]),
    prestigeLayers: overrides.prestigeLayers ?? Object.freeze([]),
    ...(overrides.achievements ? { achievements: overrides.achievements } : {}),
  });
}

describe('progression snapshot selectors', () => {
  it('filters visible and unlocked generators', () => {
    const snapshot = createSnapshot({
      generators: Object.freeze([
        createGenerator({ id: 'gen.visible.unlocked', isVisible: true, isUnlocked: true }),
        createGenerator({ id: 'gen.hidden', isVisible: false, isUnlocked: true }),
        createGenerator({ id: 'gen.locked', isVisible: true, isUnlocked: false }),
      ]),
    });

    expect(selectVisibleGenerators(snapshot).map((g) => g.id)).toEqual([
      'gen.visible.unlocked',
      'gen.locked',
    ]);
    expect(selectUnlockedGenerators(snapshot).map((g) => g.id)).toEqual([
      'gen.visible.unlocked',
      'gen.hidden',
    ]);
  });

  it('selects purchasable generators using affordability and cooldown', () => {
    const snapshot = createSnapshot({
      step: 10,
      resources: Object.freeze([
        createResource({ id: 'energy', amount: 100 }),
        createResource({ id: 'crystal', amount: 1 }),
      ]),
      generators: Object.freeze([
        createGenerator({
          id: 'gen.ready.affordable',
          costs: Object.freeze([{ resourceId: 'energy', amount: 50 }]),
          nextPurchaseReadyAtStep: 11,
        }),
        createGenerator({
          id: 'gen.cooldown',
          costs: Object.freeze([{ resourceId: 'energy', amount: 50 }]),
          nextPurchaseReadyAtStep: 12,
        }),
        createGenerator({
          id: 'gen.expensive',
          costs: Object.freeze([{ resourceId: 'energy', amount: 150 }]),
          nextPurchaseReadyAtStep: 11,
        }),
        createGenerator({
          id: 'gen.hidden',
          costs: Object.freeze([{ resourceId: 'energy', amount: 1 }]),
          nextPurchaseReadyAtStep: 11,
          isVisible: false,
        }),
        createGenerator({
          id: 'gen.locked',
          costs: Object.freeze([{ resourceId: 'energy', amount: 1 }]),
          nextPurchaseReadyAtStep: 11,
          isUnlocked: false,
        }),
      ]),
    });

    expect(selectPurchasableGenerators(snapshot).map((g) => g.id)).toEqual([
      'gen.ready.affordable',
    ]);
  });

  it('filters visible, available, and purchasable upgrades', () => {
    const snapshot = createSnapshot({
      resources: Object.freeze([createResource({ id: 'energy', amount: 25 })]),
      upgrades: Object.freeze([
        createUpgrade({
          id: 'upgrade.available.affordable',
          status: 'available',
          costs: Object.freeze([{ resourceId: 'energy', amount: 10 }]),
          isVisible: true,
        }),
        createUpgrade({
          id: 'upgrade.available.expensive',
          status: 'available',
          costs: Object.freeze([{ resourceId: 'energy', amount: 50 }]),
          isVisible: true,
        }),
        createUpgrade({
          id: 'upgrade.locked.visible',
          status: 'locked',
          costs: Object.freeze([{ resourceId: 'energy', amount: 1 }]),
          isVisible: true,
        }),
        createUpgrade({
          id: 'upgrade.locked.hidden',
          status: 'locked',
          costs: Object.freeze([{ resourceId: 'energy', amount: 1 }]),
          isVisible: false,
        }),
      ]),
    });

    expect(selectVisibleUpgrades(snapshot).map((u) => u.id)).toEqual([
      'upgrade.available.affordable',
      'upgrade.available.expensive',
      'upgrade.locked.visible',
    ]);

    expect(selectAvailableUpgrades(snapshot).map((u) => u.id)).toEqual([
      'upgrade.available.affordable',
      'upgrade.available.expensive',
    ]);

    expect(selectPurchasableUpgrades(snapshot).map((u) => u.id)).toEqual([
      'upgrade.available.affordable',
    ]);
  });

  it('selects locked upgrades with visible hints', () => {
    const snapshot = createSnapshot({
      upgrades: Object.freeze([
        createUpgrade({
          id: 'upgrade.locked.hint',
          status: 'locked',
          unlockHint: 'Collect more energy',
          isVisible: true,
        }),
        createUpgrade({
          id: 'upgrade.locked.empty',
          status: 'locked',
          unlockHint: '   ',
          isVisible: true,
        }),
        createUpgrade({
          id: 'upgrade.locked.hidden',
          status: 'locked',
          unlockHint: 'Hidden',
          isVisible: false,
        }),
        createUpgrade({
          id: 'upgrade.available.hint',
          status: 'available',
          unlockHint: 'Not locked',
          isVisible: true,
        }),
      ]),
    });

    expect(selectLockedUpgradesWithHints(snapshot).map((u) => u.id)).toEqual([
      'upgrade.locked.hint',
    ]);
  });

  it('returns top N actionables in stable order', () => {
    const snapshot = createSnapshot({
      step: 5,
      resources: Object.freeze([createResource({ id: 'energy', amount: 100 })]),
      generators: Object.freeze([
        createGenerator({
          id: 'gen.actionable',
          costs: Object.freeze([{ resourceId: 'energy', amount: 10 }]),
          nextPurchaseReadyAtStep: 6,
        }),
      ]),
      upgrades: Object.freeze([
        createUpgrade({
          id: 'upgrade.actionable',
          status: 'available',
          costs: Object.freeze([{ resourceId: 'energy', amount: 10 }]),
          isVisible: true,
        }),
      ]),
    });

    expect(selectTopNActionables(snapshot, 1)).toEqual([
      { kind: 'generator', generator: snapshot.generators[0] },
    ]);

    expect(selectTopNActionables(snapshot, 2)).toEqual([
      { kind: 'generator', generator: snapshot.generators[0] },
      { kind: 'upgrade', upgrade: snapshot.upgrades[0] },
    ]);
  });
});
