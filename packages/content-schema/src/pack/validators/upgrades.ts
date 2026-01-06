import { ensureFormulaReferencesAtPath } from './formulas.js';
import { validateConditionNode } from './conditions.js';
import { validateUpgradeEffect } from './upgrade-effects.js';
import type { CrossReferenceState } from './state.js';
import type { ParsedContentPack } from '../schema.js';

type UpgradeTarget = ParsedContentPack['upgrades'][number]['targets'][number];
type UpgradeTargetByKind<K extends UpgradeTarget['kind']> = Extract<
  UpgradeTarget,
  { kind: K }
>;

export const validateUpgrades = (state: CrossReferenceState) => {
  const { pack, ctx, indexes, formulaMaps, ensureContentReference } = state;
  const {
    resources: resourceIndex,
    generators: generatorIndex,
    automations: automationIndex,
    prestigeLayers: prestigeIndex,
  } = indexes;

  const upgradeTargetHandlers = {
    resource: (
      target: UpgradeTargetByKind<'resource'>,
      path: readonly (string | number)[],
      upgradeId: string,
    ) => {
      ensureContentReference(
        resourceIndex,
        target.id,
        path,
        `Upgrade "${upgradeId}" targets unknown resource "${target.id}".`,
      );
    },
    generator: (
      target: UpgradeTargetByKind<'generator'>,
      path: readonly (string | number)[],
      upgradeId: string,
    ) => {
      ensureContentReference(
        generatorIndex,
        target.id,
        path,
        `Upgrade "${upgradeId}" targets unknown generator "${target.id}".`,
      );
    },
    automation: (
      target: UpgradeTargetByKind<'automation'>,
      path: readonly (string | number)[],
      upgradeId: string,
    ) => {
      ensureContentReference(
        automationIndex,
        target.id,
        path,
        `Upgrade "${upgradeId}" targets unknown automation "${target.id}".`,
      );
    },
    prestigeLayer: (
      target: UpgradeTargetByKind<'prestigeLayer'>,
      path: readonly (string | number)[],
      upgradeId: string,
    ) => {
      ensureContentReference(
        prestigeIndex,
        target.id,
        path,
        `Upgrade "${upgradeId}" targets unknown prestige layer "${target.id}".`,
      );
    },
    global: () => undefined,
  } satisfies {
    [K in UpgradeTarget['kind']]: (
      target: UpgradeTargetByKind<K>,
      path: readonly (string | number)[],
      upgradeId: string,
    ) => void;
  };

  const handleUpgradeTarget = (
    target: UpgradeTarget,
    path: readonly (string | number)[],
    upgradeId: string,
  ) => {
    const handler = upgradeTargetHandlers[target.kind] as (
      entry: UpgradeTarget,
      currentPath: readonly (string | number)[],
      currentUpgradeId: string,
    ) => void;
    handler(target, path, upgradeId);
  };

  pack.upgrades.forEach((upgrade, index) => {
    upgrade.targets.forEach((target, targetIndex) => {
      handleUpgradeTarget(
        target,
        ['upgrades', index, 'targets', targetIndex, 'id'],
        upgrade.id,
      );
    });
    if ('costs' in upgrade.cost) {
      upgrade.cost.costs.forEach((cost, costIndex) => {
        ensureContentReference(
          resourceIndex,
          cost.resourceId,
          ['upgrades', index, 'cost', 'costs', costIndex, 'resourceId'],
          `Upgrade "${upgrade.id}" references unknown cost resource "${cost.resourceId}".`,
        );
        ensureFormulaReferencesAtPath(
          cost.costCurve,
          ['upgrades', index, 'cost', 'costs', costIndex, 'costCurve'],
          ctx,
          formulaMaps,
        );
      });
    } else {
      ensureContentReference(
        resourceIndex,
        upgrade.cost.currencyId,
        ['upgrades', index, 'cost', 'currencyId'],
        `Upgrade "${upgrade.id}" references unknown currency "${upgrade.cost.currencyId}".`,
      );
      ensureFormulaReferencesAtPath(
        upgrade.cost.costCurve,
        ['upgrades', index, 'cost', 'costCurve'],
        ctx,
        formulaMaps,
      );
    }
    upgrade.effects.forEach((effect, effectIndex) => {
      validateUpgradeEffect(
        {
          ctx,
          context: state.context,
          indexes,
          formulaMaps,
          knownRuntimeEvents: state.knownRuntimeEvents,
        },
        effect,
        ['upgrades', index, 'effects', effectIndex],
      );
    });
    upgrade.prerequisites.forEach((prerequisite, prerequisiteIndex) => {
      validateConditionNode(state, prerequisite, [
        'upgrades',
        index,
        'prerequisites',
        prerequisiteIndex,
      ]);
    });
    if (upgrade.unlockCondition) {
      validateConditionNode(state, upgrade.unlockCondition, [
        'upgrades',
        index,
        'unlockCondition',
      ]);
    }
    if (upgrade.visibilityCondition) {
      validateConditionNode(state, upgrade.visibilityCondition, [
        'upgrades',
        index,
        'visibilityCondition',
      ]);
    }
  });
};
