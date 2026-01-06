import { ensureFormulaReferencesAtPath } from './formulas.js';
import { validateConditionNode } from './conditions.js';
import { validateUpgradeEffect } from './upgrade-effects.js';
import type { CrossReferenceState } from './state.js';

export const validateGenerators = (state: CrossReferenceState) => {
  const { pack, ctx, context, indexes, formulaMaps, ensureContentReference } = state;
  const {
    resources: resourceIndex,
    automations: automationIndex,
  } = indexes;

  pack.generators.forEach((generator, index) => {
    generator.produces.forEach((entry, produceIndex) => {
      ensureContentReference(
        resourceIndex,
        entry.resourceId,
        ['generators', index, 'produces', produceIndex, 'resourceId'],
        `Generator "${generator.id}" produces unknown resource "${entry.resourceId}".`,
      );
      ensureFormulaReferencesAtPath(
        entry.rate,
        ['generators', index, 'produces', produceIndex, 'rate'],
        ctx,
        formulaMaps,
      );
    });
    generator.consumes.forEach((entry, consumeIndex) => {
      ensureContentReference(
        resourceIndex,
        entry.resourceId,
        ['generators', index, 'consumes', consumeIndex, 'resourceId'],
        `Generator "${generator.id}" consumes unknown resource "${entry.resourceId}".`,
      );
      ensureFormulaReferencesAtPath(
        entry.rate,
        ['generators', index, 'consumes', consumeIndex, 'rate'],
        ctx,
        formulaMaps,
      );
    });
    if ('costs' in generator.purchase) {
      generator.purchase.costs.forEach((cost, costIndex) => {
        ensureContentReference(
          resourceIndex,
          cost.resourceId,
          ['generators', index, 'purchase', 'costs', costIndex, 'resourceId'],
          `Generator "${generator.id}" references unknown cost resource "${cost.resourceId}".`,
        );
        ensureFormulaReferencesAtPath(
          cost.costCurve,
          ['generators', index, 'purchase', 'costs', costIndex, 'costCurve'],
          ctx,
          formulaMaps,
        );
      });
    } else {
      ensureContentReference(
        resourceIndex,
        generator.purchase.currencyId,
        ['generators', index, 'purchase', 'currencyId'],
        `Generator "${generator.id}" references unknown currency "${generator.purchase.currencyId}".`,
      );
      ensureFormulaReferencesAtPath(
        generator.purchase.costCurve,
        ['generators', index, 'purchase', 'costCurve'],
        ctx,
        formulaMaps,
      );
    }
    if (generator.automation) {
      ensureContentReference(
        automationIndex,
        generator.automation.automationId,
        ['generators', index, 'automation', 'automationId'],
        `Generator "${generator.id}" references unknown automation "${generator.automation.automationId}".`,
      );
    }
    if (generator.baseUnlock) {
      validateConditionNode(state, generator.baseUnlock, ['generators', index, 'baseUnlock']);
    }
    if (generator.visibilityCondition) {
      validateConditionNode(state, generator.visibilityCondition, [
        'generators',
        index,
        'visibilityCondition',
      ]);
    }
    generator.effects.forEach((effect, effectIndex) => {
      validateUpgradeEffect(
        { ctx, context, indexes, formulaMaps, knownRuntimeEvents: state.knownRuntimeEvents },
        effect,
        ['generators', index, 'effects', effectIndex],
      );
    });
  });
};
