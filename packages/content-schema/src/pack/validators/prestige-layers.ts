import { validateConditionNode } from './conditions.js';
import { ensureFormulaReferencesAtPath } from './formulas.js';
import type { CrossReferenceState } from './state.js';

export const validatePrestigeLayers = (state: CrossReferenceState) => {
  const { pack, ctx, indexes, formulaMaps, ensureContentReference } = state;
  const {
    resources: resourceIndex,
    generators: generatorIndex,
    upgrades: upgradeIndex,
    automations: automationIndex,
  } = indexes;

  pack.prestigeLayers.forEach((layer, index) => {
    layer.resetTargets.forEach((target, targetIndex) => {
      ensureContentReference(
        resourceIndex,
        target,
        ['prestigeLayers', index, 'resetTargets', targetIndex],
        `Prestige layer "${layer.id}" resets unknown resource "${target}".`,
      );
    });
    layer.resetGenerators?.forEach((target, targetIndex) => {
      ensureContentReference(
        generatorIndex,
        target,
        ['prestigeLayers', index, 'resetGenerators', targetIndex],
        `Prestige layer "${layer.id}" resets unknown generator "${target}".`,
      );
    });
    layer.resetUpgrades?.forEach((target, targetIndex) => {
      ensureContentReference(
        upgradeIndex,
        target,
        ['prestigeLayers', index, 'resetUpgrades', targetIndex],
        `Prestige layer "${layer.id}" resets unknown upgrade "${target}".`,
      );
    });
    ensureContentReference(
      resourceIndex,
      layer.reward.resourceId,
      ['prestigeLayers', index, 'reward', 'resourceId'],
      `Prestige layer "${layer.id}" rewards unknown resource "${layer.reward.resourceId}".`,
    );
    ensureFormulaReferencesAtPath(
      layer.reward.baseReward,
      ['prestigeLayers', index, 'reward', 'baseReward'],
      ctx,
      formulaMaps,
    );
    if (layer.reward.multiplierCurve) {
      ensureFormulaReferencesAtPath(
        layer.reward.multiplierCurve,
        ['prestigeLayers', index, 'reward', 'multiplierCurve'],
        ctx,
        formulaMaps,
      );
    }
    layer.retention.forEach((entry, retentionIndex) => {
      if (entry.kind === 'resource') {
        ensureContentReference(
          resourceIndex,
          entry.resourceId,
          ['prestigeLayers', index, 'retention', retentionIndex, 'resourceId'],
          `Prestige layer "${layer.id}" retains unknown resource "${entry.resourceId}".`,
        );
      } else if (entry.kind === 'generator') {
        ensureContentReference(
          generatorIndex,
          entry.generatorId,
          ['prestigeLayers', index, 'retention', retentionIndex, 'generatorId'],
          `Prestige layer "${layer.id}" retains unknown generator "${entry.generatorId}".`,
        );
      } else if (entry.kind === 'upgrade') {
        ensureContentReference(
          upgradeIndex,
          entry.upgradeId,
          ['prestigeLayers', index, 'retention', retentionIndex, 'upgradeId'],
          `Prestige layer "${layer.id}" retains unknown upgrade "${entry.upgradeId}".`,
        );
      }
    });
    if (layer.automation) {
      ensureContentReference(
        automationIndex,
        layer.automation.automationId,
        ['prestigeLayers', index, 'automation', 'automationId'],
        `Prestige layer "${layer.id}" references unknown automation "${layer.automation.automationId}".`,
      );
    }
    validateConditionNode(state, layer.unlockCondition, ['prestigeLayers', index, 'unlockCondition']);
    const prestigeCountId = `${layer.id}-prestige-count`;
    ensureContentReference(
      resourceIndex,
      prestigeCountId,
      ['prestigeLayers', index, 'id'],
      `Prestige layer "${layer.id}" requires a resource named "${prestigeCountId}" to track prestige count. ` +
        `Add this resource to your content pack's resources array.`,
    );
  });
};
