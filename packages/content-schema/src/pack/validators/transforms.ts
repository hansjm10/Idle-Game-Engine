import { z } from 'zod';

import type { NumericFormula } from '../../base/formulas.js';
import { validateConditionNode } from './conditions.js';
import { ensureFormulaReferencesAtPath } from './formulas.js';
import type { CrossReferenceState } from './state.js';
import type { ParsedContentPack } from '../schema.js';
import { toMutablePath } from '../utils.js';

type TransformTrigger = ParsedContentPack['transforms'][number]['trigger'];
type TransformTriggerByKind<K extends TransformTrigger['kind']> = Extract<
  TransformTrigger,
  { kind: K }
>;
type TransformEntityRequirement = NonNullable<
  ParsedContentPack['transforms'][number]['entityRequirements']
>[number];

const validateTransformBasics = (
  state: CrossReferenceState,
  transform: ParsedContentPack['transforms'][number],
  index: number,
) => {
  const {
    ctx,
    indexes,
    formulaMaps,
    ensureContentReference,
    ensureRuntimeEventKnown,
    runtimeEventSeverity,
  } = state;
  const {
    resources: resourceIndex,
    automations: automationIndex,
  } = indexes;

  transform.inputs.forEach((input, inputIndex) => {
    ensureContentReference(
      resourceIndex,
      input.resourceId,
      ['transforms', index, 'inputs', inputIndex, 'resourceId'],
      `Transform "${transform.id}" consumes unknown resource "${input.resourceId}".`,
    );
    ensureFormulaReferencesAtPath(
      input.amount,
      ['transforms', index, 'inputs', inputIndex, 'amount'],
      ctx,
      formulaMaps,
    );
  });
  transform.outputs.forEach((output, outputIndex) => {
    ensureContentReference(
      resourceIndex,
      output.resourceId,
      ['transforms', index, 'outputs', outputIndex, 'resourceId'],
      `Transform "${transform.id}" produces unknown resource "${output.resourceId}".`,
    );
    ensureFormulaReferencesAtPath(
      output.amount,
      ['transforms', index, 'outputs', outputIndex, 'amount'],
      ctx,
      formulaMaps,
    );
  });
  if (transform.duration) {
    ensureFormulaReferencesAtPath(transform.duration, ['transforms', index, 'duration'], ctx, formulaMaps);
  }
  if (transform.cooldown) {
    ensureFormulaReferencesAtPath(transform.cooldown, ['transforms', index, 'cooldown'], ctx, formulaMaps);
  }
  if (transform.successRate) {
    ensureFormulaReferencesAtPath(
      transform.successRate.baseRate,
      ['transforms', index, 'successRate', 'baseRate'],
      ctx,
      formulaMaps,
    );
    transform.successRate.statModifiers?.forEach((modifier, modifierIndex) => {
      ensureFormulaReferencesAtPath(
        modifier.weight,
        ['transforms', index, 'successRate', 'statModifiers', modifierIndex, 'weight'],
        ctx,
        formulaMaps,
      );
    });
  }

  const transformTriggerHandlers = {
    automation: (
      trigger: TransformTriggerByKind<'automation'>,
      triggerPath: readonly (string | number)[],
      transformId: string,
    ) => {
      ensureContentReference(
        automationIndex,
        trigger.automationId,
        [...triggerPath, 'automationId'],
        `Transform "${transformId}" references unknown automation "${trigger.automationId}".`,
      );
    },
    condition: (trigger: TransformTriggerByKind<'condition'>, triggerPath: readonly (string | number)[]) => {
      validateConditionNode(state, trigger.condition, [...triggerPath, 'condition']);
    },
    event: (trigger: TransformTriggerByKind<'event'>, triggerPath: readonly (string | number)[]) => {
      ensureRuntimeEventKnown(
        trigger.eventId,
        [...triggerPath, 'eventId'],
        runtimeEventSeverity,
      );
    },
    manual: () => undefined,
  } satisfies {
    [K in TransformTrigger['kind']]: (
      trigger: TransformTriggerByKind<K>,
      triggerPath: readonly (string | number)[],
      transformId: string,
    ) => void;
  };

  const handleTransformTrigger = (
    trigger: TransformTrigger,
    triggerPath: readonly (string | number)[],
    transformId: string,
  ) => {
    const handler = transformTriggerHandlers[trigger.kind] as (
      entry: TransformTrigger,
      currentPath: readonly (string | number)[],
      currentTransformId: string,
    ) => void;
    handler(trigger, triggerPath, transformId);
  };

  handleTransformTrigger(transform.trigger, ['transforms', index, 'trigger'], transform.id);
  if (transform.automation) {
    ensureContentReference(
      automationIndex,
      transform.automation.automationId,
      ['transforms', index, 'automation', 'automationId'],
      `Transform "${transform.id}" references unknown automation "${transform.automation.automationId}".`,
    );
  }
  if (transform.unlockCondition) {
    validateConditionNode(state, transform.unlockCondition, ['transforms', index, 'unlockCondition']);
  }
  if (transform.visibilityCondition) {
    validateConditionNode(state, transform.visibilityCondition, [
      'transforms',
      index,
      'visibilityCondition',
    ]);
  }
};

const validateTransformEntityRequirement = (
  state: CrossReferenceState,
  transform: ParsedContentPack['transforms'][number],
  index: number,
  requirement: TransformEntityRequirement,
  requirementIndex: number,
  availableStats: Set<string>,
) => {
  const { ctx, indexes, formulaMaps, ensureContentReference } = state;
  const { entities: entityIndex } = indexes;

  const entry = entityIndex.get(requirement.entityId);
  if (!entry) {
    ensureContentReference(
      entityIndex,
      requirement.entityId,
      ['transforms', index, 'entityRequirements', requirementIndex, 'entityId'],
      `Transform "${transform.id}" references unknown entity "${requirement.entityId}".`,
    );
    return;
  }

  const statIds = new Set<string>(entry.value.stats.map((stat) => stat.id as string));
  entry.value.stats.forEach((stat) => {
    availableStats.add(stat.id);
  });

  ensureFormulaReferencesAtPath(
    requirement.count,
    ['transforms', index, 'entityRequirements', requirementIndex, 'count'],
    ctx,
    formulaMaps,
  );

  if (requirement.minStats) {
    for (const [statId, formula] of Object.entries(requirement.minStats)) {
      if (!statIds.has(statId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: toMutablePath([
            'transforms',
            index,
            'entityRequirements',
            requirementIndex,
            'minStats',
            statId,
          ]),
          message: `Transform "${transform.id}" references unknown stat "${statId}" for entity "${requirement.entityId}".`,
        });
      }
      if (!formula) {
        continue;
      }
      ensureFormulaReferencesAtPath(
        formula,
        ['transforms', index, 'entityRequirements', requirementIndex, 'minStats', statId],
        ctx,
        formulaMaps,
      );
    }
  }

  requirement.preferHighStats?.forEach((statId, statIndex) => {
    if (!statIds.has(statId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: toMutablePath([
          'transforms',
          index,
          'entityRequirements',
          requirementIndex,
          'preferHighStats',
          statIndex,
        ]),
        message: `Transform "${transform.id}" references unknown stat "${statId}" for entity "${requirement.entityId}".`,
      });
    }
  });
};

const validateTransformSuccessRateModifiers = (
  state: CrossReferenceState,
  transform: ParsedContentPack['transforms'][number],
  index: number,
  availableStats: Set<string>,
) => {
  const { ctx } = state;

  if (!transform.successRate?.statModifiers) {
    return;
  }
  transform.successRate.statModifiers.forEach((modifier, modifierIndex) => {
    if (!availableStats.has(modifier.stat)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: toMutablePath([
          'transforms',
          index,
          'successRate',
          'statModifiers',
          modifierIndex,
          'stat',
        ]),
        message: `Transform "${transform.id}" references unknown stat "${modifier.stat}" in success rate modifiers.`,
      });
    }
  });
};

const validateTransformOutcome = (
  state: CrossReferenceState,
  transform: ParsedContentPack['transforms'][number],
  outcome:
    | {
        outputs: readonly { resourceId: string; amount: NumericFormula }[];
        entityExperience?: NumericFormula;
        entityDamage?: NumericFormula;
      }
    | undefined,
  outcomePath: readonly (string | number)[],
) => {
  const { ctx, indexes, formulaMaps, ensureContentReference } = state;
  const { resources: resourceIndex } = indexes;

  if (!outcome) {
    return;
  }
  for (const [outputIndex, output] of outcome.outputs.entries()) {
    ensureContentReference(
      resourceIndex,
      output.resourceId,
      [...outcomePath, 'outputs', outputIndex, 'resourceId'],
      `Transform "${transform.id}" produces unknown resource "${output.resourceId}".`,
    );
    ensureFormulaReferencesAtPath(
      output.amount,
      [...outcomePath, 'outputs', outputIndex, 'amount'],
      ctx,
      formulaMaps,
    );
  }
  if (outcome.entityExperience) {
    ensureFormulaReferencesAtPath(
      outcome.entityExperience,
      [...outcomePath, 'entityExperience'],
      ctx,
      formulaMaps,
    );
  }
  if (outcome.entityDamage) {
    ensureFormulaReferencesAtPath(
      outcome.entityDamage,
      [...outcomePath, 'entityDamage'],
      ctx,
      formulaMaps,
    );
  }
};

const validateTransformOutcomes = (
  state: CrossReferenceState,
  transform: ParsedContentPack['transforms'][number],
  index: number,
) => {
  const { ctx, formulaMaps } = state;

  if (!transform.outcomes) {
    return;
  }
  validateTransformOutcome(state, transform, transform.outcomes.success, [
    'transforms',
    index,
    'outcomes',
    'success',
  ]);
  validateTransformOutcome(state, transform, transform.outcomes.failure, [
    'transforms',
    index,
    'outcomes',
    'failure',
  ]);
  validateTransformOutcome(state, transform, transform.outcomes.critical, [
    'transforms',
    index,
    'outcomes',
    'critical',
  ]);
  if (transform.outcomes.critical?.chance) {
    ensureFormulaReferencesAtPath(
      transform.outcomes.critical.chance,
      ['transforms', index, 'outcomes', 'critical', 'chance'],
      ctx,
      formulaMaps,
    );
  }
};

const validateTransformMissionRequirements = (
  state: CrossReferenceState,
  transform: ParsedContentPack['transforms'][number],
  index: number,
) => {
  if (transform.mode !== 'mission' || !transform.entityRequirements) {
    return;
  }

  const availableStats = new Set<string>();
  transform.entityRequirements.forEach((requirement, requirementIndex) => {
    validateTransformEntityRequirement(
      state,
      transform,
      index,
      requirement,
      requirementIndex,
      availableStats,
    );
  });

  validateTransformSuccessRateModifiers(state, transform, index, availableStats);
  validateTransformOutcomes(state, transform, index);
};

export const validateTransforms = (state: CrossReferenceState) => {
  const { pack } = state;

  for (const [index, transform] of pack.transforms.entries()) {
    validateTransformBasics(state, transform, index);
    validateTransformMissionRequirements(state, transform, index);
  }
};
