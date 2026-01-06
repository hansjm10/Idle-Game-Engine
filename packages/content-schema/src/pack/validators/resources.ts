import { ensureFormulaReferencesAtPath } from './formulas.js';
import { validateConditionNode } from './conditions.js';
import type { CrossReferenceState } from './state.js';

export const validateResources = (state: CrossReferenceState) => {
  const { pack, ctx, formulaMaps, ensureContentReference } = state;
  const { prestigeLayers: prestigeIndex } = state.indexes;

  pack.resources.forEach((resource, index) => {
    if (resource.unlockCondition) {
      validateConditionNode(state, resource.unlockCondition, [
        'resources',
        index,
        'unlockCondition',
      ]);
    }

    if (resource.visibilityCondition) {
      validateConditionNode(state, resource.visibilityCondition, [
        'resources',
        index,
        'visibilityCondition',
      ]);
    }

    if (resource.prestige) {
      ensureContentReference(
        prestigeIndex,
        resource.prestige.layerId,
        ['resources', index, 'prestige', 'layerId'],
        `Resource "${resource.id}" references unknown prestige layer "${resource.prestige.layerId}".`,
      );

      if (resource.prestige.resetRetention) {
        ensureFormulaReferencesAtPath(
          resource.prestige.resetRetention,
          ['resources', index, 'prestige', 'resetRetention'],
          ctx,
          formulaMaps,
        );
      }
    }
  });
};
