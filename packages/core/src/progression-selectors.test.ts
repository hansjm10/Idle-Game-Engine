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
    unlocked: overrides.unlocked ?? true,
    visible: overrides.visible ?? true,
    perTick: overrides.perTick ?? 0,
    ...(overrides.capacity !== undefined ? { capacity: overrides.capacity } : {}),
  });
}

function createGenerator(
  overrides: Partial<GeneratorView> & Pick<GeneratorView, 'id'>,
): GeneratorView {
  const costs = overrides.costs ?? Object.freeze([]);
  const canAfford =
    overrides.canAfford ?? costs.every((cost) => cost.canAfford);
  return Object.freeze({
    id: overrides.id,
    displayName: overrides.displayName ?? overrides.id,
    owned: overrides.owned ?? 0,
    enabled: overrides.enabled ?? true,
    unlocked: overrides.unlocked ?? true,
    visible: overrides.visible ?? true,
    costs,
    canAfford,
    produces: overrides.produces ?? Object.freeze([]),
    consumes: overrides.consumes ?? Object.freeze([]),
    nextPurchaseReadyAtStep: overrides.nextPurchaseReadyAtStep ?? 0,
  });
}

function createUpgrade(
  overrides: Partial<UpgradeView> & Pick<UpgradeView, 'id'>,
): UpgradeView {
  const canAfford =
    overrides.canAfford ??
    (overrides.costs ? overrides.costs.every((cost) => cost.canAfford) : true);
  return Object.freeze({
    id: overrides.id,
    displayName: overrides.displayName ?? overrides.id,
    status: overrides.status ?? 'locked',
    canAfford,
    ...(overrides.costs !== undefined ? { costs: overrides.costs } : {}),
    ...(overrides.unlockHint !== undefined
      ? { unlockHint: overrides.unlockHint }
      : {}),
    visible: overrides.visible ?? true,
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
    automations: overrides.automations ?? Object.freeze([]),
    transforms: overrides.transforms ?? Object.freeze([]),
    prestigeLayers: overrides.prestigeLayers ?? Object.freeze([]),
    ...(overrides.achievements ? { achievements: overrides.achievements } : {}),
  });
}

describe('progression snapshot selectors', () => {
  it('filters visible and unlocked generators', () => {
    const snapshot = createSnapshot({
      generators: Object.freeze([
        createGenerator({ id: 'gen.visible.unlocked', visible: true, unlocked: true }),
        createGenerator({ id: 'gen.hidden', visible: false, unlocked: true }),
        createGenerator({ id: 'gen.locked', visible: true, unlocked: false }),
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
          costs: Object.freeze([
            { resourceId: 'energy', amount: 50, canAfford: true },
          ]),
          nextPurchaseReadyAtStep: 11,
        }),
        createGenerator({
          id: 'gen.cooldown',
          costs: Object.freeze([
            { resourceId: 'energy', amount: 50, canAfford: true },
          ]),
          nextPurchaseReadyAtStep: 12,
        }),
        createGenerator({
          id: 'gen.expensive',
          costs: Object.freeze([
            { resourceId: 'energy', amount: 150, canAfford: false },
          ]),
          nextPurchaseReadyAtStep: 11,
        }),
        createGenerator({
          id: 'gen.hidden',
          costs: Object.freeze([
            { resourceId: 'energy', amount: 1, canAfford: true },
          ]),
          nextPurchaseReadyAtStep: 11,
          visible: false,
        }),
        createGenerator({
          id: 'gen.locked',
          costs: Object.freeze([
            { resourceId: 'energy', amount: 1, canAfford: true },
          ]),
          nextPurchaseReadyAtStep: 11,
          unlocked: false,
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
          costs: Object.freeze([
            { resourceId: 'energy', amount: 10, canAfford: true },
          ]),
          visible: true,
        }),
        createUpgrade({
          id: 'upgrade.available.expensive',
          status: 'available',
          costs: Object.freeze([
            { resourceId: 'energy', amount: 50, canAfford: false },
          ]),
          visible: true,
        }),
        createUpgrade({
          id: 'upgrade.locked.visible',
          status: 'locked',
          costs: Object.freeze([
            { resourceId: 'energy', amount: 1, canAfford: true },
          ]),
          visible: true,
        }),
        createUpgrade({
          id: 'upgrade.locked.hidden',
          status: 'locked',
          costs: Object.freeze([
            { resourceId: 'energy', amount: 1, canAfford: true },
          ]),
          visible: false,
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
          visible: true,
        }),
        createUpgrade({
          id: 'upgrade.locked.empty',
          status: 'locked',
          unlockHint: '   ',
          visible: true,
        }),
        createUpgrade({
          id: 'upgrade.locked.hidden',
          status: 'locked',
          unlockHint: 'Hidden',
          visible: false,
        }),
        createUpgrade({
          id: 'upgrade.available.hint',
          status: 'available',
          unlockHint: 'Not locked',
          visible: true,
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
          costs: Object.freeze([
            { resourceId: 'energy', amount: 10, canAfford: true },
          ]),
          nextPurchaseReadyAtStep: 6,
        }),
      ]),
      upgrades: Object.freeze([
        createUpgrade({
          id: 'upgrade.actionable',
          status: 'available',
          costs: Object.freeze([
            { resourceId: 'energy', amount: 10, canAfford: true },
          ]),
          visible: true,
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
