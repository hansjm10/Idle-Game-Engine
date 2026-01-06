import { ensureFormulaReferencesAtPath } from './formulas.js';
import { validateConditionNode } from './conditions.js';
import type { CrossReferenceState } from './state.js';

export const validateEntities = (state: CrossReferenceState) => {
  const { pack, ctx, formulaMaps, ensureContentReference } = state;
  const { resources: resourceIndex } = state.indexes;

  pack.entities.forEach((entity, index) => {
    entity.stats.forEach((stat, statIndex) => {
      ensureFormulaReferencesAtPath(
        stat.baseValue,
        ['entities', index, 'stats', statIndex, 'baseValue'],
        ctx,
        formulaMaps,
      );
      if (stat.minValue) {
        ensureFormulaReferencesAtPath(
          stat.minValue,
          ['entities', index, 'stats', statIndex, 'minValue'],
          ctx,
          formulaMaps,
        );
      }
      if (stat.maxValue) {
        ensureFormulaReferencesAtPath(
          stat.maxValue,
          ['entities', index, 'stats', statIndex, 'maxValue'],
          ctx,
          formulaMaps,
        );
      }
    });

    if (entity.maxCount) {
      ensureFormulaReferencesAtPath(
        entity.maxCount,
        ['entities', index, 'maxCount'],
        ctx,
        formulaMaps,
      );
    }

    if (entity.progression) {
      ensureFormulaReferencesAtPath(
        entity.progression.levelFormula,
        ['entities', index, 'progression', 'levelFormula'],
        ctx,
        formulaMaps,
      );
      if (entity.progression.experienceResource) {
        ensureContentReference(
          resourceIndex,
          entity.progression.experienceResource,
          ['entities', index, 'progression', 'experienceResource'],
          `Entity "${entity.id}" references unknown experience resource "${entity.progression.experienceResource}".`,
        );
      }
      for (const [statId, growth] of Object.entries(entity.progression.statGrowth)) {
        if (!growth) continue;
        ensureFormulaReferencesAtPath(
          growth,
          ['entities', index, 'progression', 'statGrowth', statId],
          ctx,
          formulaMaps,
        );
      }
    }

    if (entity.unlockCondition) {
      validateConditionNode(state, entity.unlockCondition, [
        'entities',
        index,
        'unlockCondition',
      ]);
    }
    if (entity.visibilityCondition) {
      validateConditionNode(state, entity.visibilityCondition, [
        'entities',
        index,
        'visibilityCondition',
      ]);
    }
  });
};
