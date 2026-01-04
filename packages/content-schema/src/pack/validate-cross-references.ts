import { z } from 'zod';

import type { Condition } from '../base/conditions.js';
import type { ExpressionNode, NumericFormula } from '../base/formulas.js';
import type { ContentSchemaWarning } from '../errors.js';
import type { ParsedContentPack } from './schema.js';
import type {
  CrossReferenceContext,
  NormalizedAllowlistSpec,
  UpgradeEffect,
} from './types.js';
import { toMutablePath } from './utils.js';

type UpgradeEffectByKind<K extends UpgradeEffect['kind']> = Extract<
  UpgradeEffect,
  { kind: K }
>;
type ConditionByKind<K extends Condition['kind']> = Extract<Condition, { kind: K }>;
type RuntimeEventEmitter = ParsedContentPack['runtimeEvents'][number]['emits'][number];
type RuntimeEventEmitterBySource<K extends RuntimeEventEmitter['source']> =
  RuntimeEventEmitter & { source: K };
type UpgradeTarget = ParsedContentPack['upgrades'][number]['targets'][number];
type UpgradeTargetByKind<K extends UpgradeTarget['kind']> = Extract<
  UpgradeTarget,
  { kind: K }
>;
type AchievementTrack = ParsedContentPack['achievements'][number]['track'];
type AchievementTrackByKind<K extends AchievementTrack['kind']> = Extract<
  AchievementTrack,
  { kind: K }
>;
type AchievementReward = NonNullable<ParsedContentPack['achievements'][number]['reward']>;
type AchievementRewardByKind<K extends AchievementReward['kind']> = Extract<
  AchievementReward,
  { kind: K }
>;
type AutomationTrigger = ParsedContentPack['automations'][number]['trigger'];
type AutomationTriggerByKind<K extends AutomationTrigger['kind']> = Extract<
  AutomationTrigger,
  { kind: K }
>;
type TransformTrigger = ParsedContentPack['transforms'][number]['trigger'];
type TransformTriggerByKind<K extends TransformTrigger['kind']> = Extract<
  TransformTrigger,
  { kind: K }
>;

const assertAllowlisted = (
  spec: NormalizedAllowlistSpec | undefined,
  id: string,
  path: readonly (string | number)[],
  ctx: z.RefinementCtx,
  warningSink: (warning: ContentSchemaWarning) => void,
  warningCode: string,
  message: string,
) => {
  if (!spec) {
    return;
  }

  if (spec.required.has(id) || spec.soft.has(id)) {
    return;
  }

  if (spec.soft.size > 0 && !spec.required.size) {
    warningSink({
      code: warningCode,
      message,
      path: toMutablePath(path),
      severity: 'warning',
    });
    return;
  }

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: toMutablePath(path),
    message,
  });
};

const collectFormulaEntityReferences = (
  formula: NumericFormula,
  collector: (reference: { type: string; id: string }) => void,
) => {
  const visitFormula = (node: NumericFormula) => {
    switch (node.kind) {
      case 'constant':
      case 'linear':
      case 'exponential':
      case 'polynomial':
        return;
      case 'piecewise':
        node.pieces.forEach((piece) => visitFormula(piece.formula));
        return;
      case 'expression':
        visitExpression(node.expression);
        return;
      default:
        return;
    }
  };

  const visitExpression = (expression: unknown): void => {
    if (!expression || typeof expression !== 'object') {
      return;
    }
    const expr = expression as ExpressionNode;
    switch (expr.kind) {
      case 'literal':
        return;
      case 'ref':
        if (expr.target?.type && expr.target.type !== 'variable') {
          collector({
            type: expr.target.type,
            id: expr.target.id,
          });
        }
        return;
      case 'binary':
        visitExpression(expr.left);
        visitExpression(expr.right);
        return;
      case 'unary':
        visitExpression(expr.operand);
        return;
      case 'call':
        expr.args?.forEach((arg) => visitExpression(arg));
        return;
      default:
        return;
    }
  };

  visitFormula(formula);
};

const getIndexMap = <Value extends { readonly id: string }>(
  values: readonly Value[],
): Map<string, { readonly index: number; readonly value: Value }> => {
  const indexMap = new Map<string, { readonly index: number; readonly value: Value }>();
  values.forEach((value, index) => {
    indexMap.set(value.id, { index, value });
  });
  return indexMap;
};

const ensureFormulaReference = (
  reference: { readonly type: string; readonly id: string },
  path: readonly (string | number)[],
  ctx: z.RefinementCtx,
  resources: Map<string, { index: number }>,
  generators: Map<string, { index: number }>,
  upgrades: Map<string, { index: number }>,
  automations: Map<string, { index: number }>,
  prestigeLayers: Map<string, { index: number }>,
) => {
  switch (reference.type) {
    case 'resource':
      if (!resources.has(reference.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: toMutablePath(path),
          message: `Formula references unknown resource "${reference.id}".`,
        });
      }
      break;
    case 'generator':
      if (!generators.has(reference.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: toMutablePath(path),
          message: `Formula references unknown generator "${reference.id}".`,
        });
      }
      break;
    case 'upgrade':
      if (!upgrades.has(reference.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: toMutablePath(path),
          message: `Formula references unknown upgrade "${reference.id}".`,
        });
      }
      break;
    case 'automation':
      if (!automations.has(reference.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: toMutablePath(path),
          message: `Formula references unknown automation "${reference.id}".`,
        });
      }
      break;
    case 'prestigeLayer':
      if (!prestigeLayers.has(reference.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: toMutablePath(path),
          message: `Formula references unknown prestige layer "${reference.id}".`,
        });
      }
      break;
    default:
      break;
  }
};

const validateUpgradeEffect = (
  effect: UpgradeEffect,
  path: readonly (string | number)[],
  ctx: z.RefinementCtx,
  context: CrossReferenceContext,
  resources: Map<string, { index: number }>,
  generators: Map<string, { index: number }>,
  upgrades: Map<string, { index: number }>,
  automations: Map<string, { index: number }>,
  prestigeLayers: Map<string, { index: number }>,
  runtimeEvents: ReadonlySet<string>,
) => {
  const ensureReference = (
    map: Map<string, { index: number }>,
    id: string,
    message: string,
  ) => {
    if (!map.has(id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: toMutablePath(path),
        message,
      });
    }
  };

  const ensureFormulaReferences = (formula: NumericFormula) => {
    collectFormulaEntityReferences(formula, (reference) => {
      ensureFormulaReference(
        reference,
        path,
        ctx,
        resources,
        generators,
        upgrades,
        automations,
        prestigeLayers,
      );
    });
  };

  const handlers = {
    modifyResourceRate: (entry: UpgradeEffectByKind<'modifyResourceRate'>) => {
      ensureReference(
        resources,
        entry.resourceId,
        `Effect references unknown resource "${entry.resourceId}".`,
      );
      ensureFormulaReferences(entry.value);
    },
    modifyResourceCapacity: (entry: UpgradeEffectByKind<'modifyResourceCapacity'>) => {
      ensureReference(
        resources,
        entry.resourceId,
        `Effect references unknown resource "${entry.resourceId}".`,
      );
      ensureFormulaReferences(entry.value);
    },
    unlockResource: (entry: UpgradeEffectByKind<'unlockResource'>) => {
      ensureReference(
        resources,
        entry.resourceId,
        `Effect references unknown resource "${entry.resourceId}".`,
      );
    },
    alterDirtyTolerance: (entry: UpgradeEffectByKind<'alterDirtyTolerance'>) => {
      ensureReference(
        resources,
        entry.resourceId,
        `Effect references unknown resource "${entry.resourceId}".`,
      );
      ensureFormulaReferences(entry.value);
    },
    modifyGeneratorRate: (entry: UpgradeEffectByKind<'modifyGeneratorRate'>) => {
      ensureReference(
        generators,
        entry.generatorId,
        `Effect references unknown generator "${entry.generatorId}".`,
      );
      ensureFormulaReferences(entry.value);
    },
    modifyGeneratorCost: (entry: UpgradeEffectByKind<'modifyGeneratorCost'>) => {
      ensureReference(
        generators,
        entry.generatorId,
        `Effect references unknown generator "${entry.generatorId}".`,
      );
      ensureFormulaReferences(entry.value);
    },
    modifyGeneratorConsumption: (
      entry: UpgradeEffectByKind<'modifyGeneratorConsumption'>,
    ) => {
      ensureReference(
        generators,
        entry.generatorId,
        `Effect references unknown generator "${entry.generatorId}".`,
      );
      if (entry.resourceId !== undefined) {
        ensureReference(
          resources,
          entry.resourceId,
          `Effect references unknown resource "${entry.resourceId}".`,
        );
      }
      ensureFormulaReferences(entry.value);
    },
    unlockGenerator: (entry: UpgradeEffectByKind<'unlockGenerator'>) => {
      ensureReference(
        generators,
        entry.generatorId,
        `Effect references unknown generator "${entry.generatorId}".`,
      );
    },
    grantAutomation: (entry: UpgradeEffectByKind<'grantAutomation'>) => {
      ensureReference(
        automations,
        entry.automationId,
        `Effect references unknown automation "${entry.automationId}".`,
      );
    },
    grantFlag: (entry: UpgradeEffectByKind<'grantFlag'>) => {
      assertAllowlisted(
        context.allowlists.flags,
        entry.flagId,
        [...path, 'flagId'] as const,
        ctx,
        context.warningSink,
        'allowlist.flag.missing',
        `Effect references flag "${entry.flagId}" that is not in the flags allowlist.`,
      );
    },
    emitEvent: (entry: UpgradeEffectByKind<'emitEvent'>) => {
      if (!runtimeEvents.has(entry.eventId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: toMutablePath(path),
          message: `Effect references unknown runtime event "${entry.eventId}".`,
        });
      }
    },
  } satisfies {
    [K in UpgradeEffect['kind']]: (entry: UpgradeEffectByKind<K>) => void;
  };

  const handler = handlers[effect.kind] as (entry: UpgradeEffect) => void;
  handler(effect);
};

const validateConditionNode = (
  condition: Condition | undefined,
  path: readonly (string | number)[],
  ctx: z.RefinementCtx,
  context: CrossReferenceContext,
  resources: Map<string, { index: number }>,
  generators: Map<string, { index: number }>,
  upgrades: Map<string, { index: number }>,
  prestigeLayers: Map<string, { index: number }>,
) => {
  if (!condition) {
    return;
  }

  const emptyAutomationIndex = new Map<string, { index: number }>();

  const ensureConditionFormulaReferences = (
    formula: NumericFormula,
    currentPath: readonly (string | number)[],
  ) => {
    collectFormulaEntityReferences(formula, (reference) => {
      ensureFormulaReference(
        reference,
        currentPath,
        ctx,
        resources,
        generators,
        upgrades,
        emptyAutomationIndex,
        prestigeLayers,
      );
    });
  };

  const handlers = {
    always: () => undefined,
    never: () => undefined,
    resourceThreshold: (
      node: ConditionByKind<'resourceThreshold'>,
      currentPath: readonly (string | number)[],
    ) => {
      if (!resources.has(node.resourceId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: toMutablePath([...currentPath, 'resourceId'] as const),
          message: `Condition references unknown resource "${node.resourceId}".`,
        });
      }
      ensureConditionFormulaReferences(node.amount, currentPath);
    },
    generatorLevel: (
      node: ConditionByKind<'generatorLevel'>,
      currentPath: readonly (string | number)[],
    ) => {
      if (!generators.has(node.generatorId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: toMutablePath([...currentPath, 'generatorId'] as const),
          message: `Condition references unknown generator "${node.generatorId}".`,
        });
      }
      ensureConditionFormulaReferences(node.level, currentPath);
    },
    upgradeOwned: (
      node: ConditionByKind<'upgradeOwned'>,
      currentPath: readonly (string | number)[],
    ) => {
      if (!upgrades.has(node.upgradeId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: toMutablePath([...currentPath, 'upgradeId'] as const),
          message: `Condition references unknown upgrade "${node.upgradeId}".`,
        });
      }
    },
    prestigeCountThreshold: (
      node: ConditionByKind<'prestigeCountThreshold'>,
      currentPath: readonly (string | number)[],
    ) => {
      if (!prestigeLayers.has(node.prestigeLayerId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: toMutablePath([...currentPath, 'prestigeLayerId'] as const),
          message: `Condition references unknown prestige layer "${node.prestigeLayerId}".`,
        });
      }
    },
    prestigeCompleted: (
      node: ConditionByKind<'prestigeCompleted'>,
      currentPath: readonly (string | number)[],
    ) => {
      if (!prestigeLayers.has(node.prestigeLayerId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: toMutablePath([...currentPath, 'prestigeLayerId'] as const),
          message: `Condition references unknown prestige layer "${node.prestigeLayerId}".`,
        });
      }
    },
    prestigeUnlocked: (
      node: ConditionByKind<'prestigeUnlocked'>,
      currentPath: readonly (string | number)[],
    ) => {
      if (!prestigeLayers.has(node.prestigeLayerId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: toMutablePath([...currentPath, 'prestigeLayerId'] as const),
          message: `Condition references unknown prestige layer "${node.prestigeLayerId}".`,
        });
      }
    },
    flag: (
      node: ConditionByKind<'flag'>,
      currentPath: readonly (string | number)[],
    ) => {
      assertAllowlisted(
        context.allowlists.flags,
        node.flagId,
        [...currentPath, 'flagId'],
        ctx,
        context.warningSink,
        'allowlist.flag.missing',
        `Condition references flag "${node.flagId}" that is not in the flags allowlist.`,
      );
    },
    script: (
      node: ConditionByKind<'script'>,
      currentPath: readonly (string | number)[],
    ) => {
      assertAllowlisted(
        context.allowlists.scripts,
        node.scriptId,
        [...currentPath, 'scriptId'],
        ctx,
        context.warningSink,
        'allowlist.script.missing',
        `Condition references script "${node.scriptId}" that is not in the scripts allowlist.`,
      );
    },
    allOf: (
      node: ConditionByKind<'allOf'>,
      currentPath: readonly (string | number)[],
    ) => {
      node.conditions.forEach((child, childIndex) =>
        visit(child, [...currentPath, 'conditions', childIndex]),
      );
    },
    anyOf: (
      node: ConditionByKind<'anyOf'>,
      currentPath: readonly (string | number)[],
    ) => {
      node.conditions.forEach((child, childIndex) =>
        visit(child, [...currentPath, 'conditions', childIndex]),
      );
    },
    not: (
      node: ConditionByKind<'not'>,
      currentPath: readonly (string | number)[],
    ) => {
      visit(node.condition, [...currentPath, 'condition']);
    },
  } satisfies {
    [K in Condition['kind']]: (
      node: ConditionByKind<K>,
      currentPath: readonly (string | number)[],
    ) => void;
  };

  const visit = (
    node: Condition,
    currentPath: readonly (string | number)[],
  ) => {
    const handler = handlers[node.kind] as (
      entry: Condition,
      path: readonly (string | number)[],
    ) => void;
    handler(node, currentPath);
  };

  visit(condition, path);
};

export const validateCrossReferences = (
  pack: ParsedContentPack,
  ctx: z.RefinementCtx,
  context: CrossReferenceContext,
) => {
  const resourceIndex = getIndexMap(pack.resources);
  const entityIndex = getIndexMap(pack.entities);
  const generatorIndex = getIndexMap(pack.generators);
  const upgradeIndex = getIndexMap(pack.upgrades);
  const metricIndex = getIndexMap(pack.metrics);
  const achievementIndex = getIndexMap(pack.achievements);
  const automationIndex = getIndexMap(pack.automations);
  const transformIndex = getIndexMap(pack.transforms);
  const prestigeIndex = getIndexMap(pack.prestigeLayers);
  const knownRuntimeEvents = new Set<string>(context.runtimeEventCatalogue);
  pack.runtimeEvents.forEach((event) => {
    knownRuntimeEvents.add(event.id);
  });

  const warn = context.warningSink;

  const ensureRuntimeEventKnown = (
    id: string,
    path: readonly (string | number)[],
    severity: 'error' | 'warning',
  ) => {
    if (knownRuntimeEvents.has(id)) {
      return;
    }
    if (severity === 'warning') {
      warn({
        code: 'runtimeEvent.unknown',
        message: `Runtime event "${id}" is not present in the known catalogue.`,
        path: toMutablePath(path),
        severity,
      });
      return;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: toMutablePath(path),
      message: `Runtime event "${id}" must exist in the known event catalogue.`,
    });
  };

  const ensureContentReference = (
    map: Map<string, { index: number }>,
    id: string,
    path: readonly (string | number)[],
    message: string,
  ) => {
    if (map.has(id)) {
      return;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: toMutablePath(path),
      message,
    });
  };

  const runtimeEventSeverity: 'error' | 'warning' =
    context.runtimeEventCatalogue.size > 0 ? 'error' : 'warning';

  const runtimeEventEmitterHandlers = {
    achievement: (
      emitter: RuntimeEventEmitterBySource<'achievement'>,
      path: readonly (string | number)[],
    ) => {
      ensureContentReference(
        achievementIndex,
        emitter.id,
        path,
        `Runtime event emitter references unknown achievement "${emitter.id}".`,
      );
    },
    upgrade: (
      emitter: RuntimeEventEmitterBySource<'upgrade'>,
      path: readonly (string | number)[],
    ) => {
      ensureContentReference(
        upgradeIndex,
        emitter.id,
        path,
        `Runtime event emitter references unknown upgrade "${emitter.id}".`,
      );
    },
    transform: (
      emitter: RuntimeEventEmitterBySource<'transform'>,
      path: readonly (string | number)[],
    ) => {
      ensureContentReference(
        transformIndex,
        emitter.id,
        path,
        `Runtime event emitter references unknown transform "${emitter.id}".`,
      );
    },
    script: (
      emitter: RuntimeEventEmitterBySource<'script'>,
      path: readonly (string | number)[],
    ) => {
      assertAllowlisted(
        context.allowlists.scripts,
        emitter.id,
        path,
        ctx,
        warn,
        'allowlist.script.missing',
        `Script "${emitter.id}" is not declared in the scripts allowlist.`,
      );
    },
  } satisfies {
    [K in RuntimeEventEmitter['source']]: (
      emitter: RuntimeEventEmitterBySource<K>,
      path: readonly (string | number)[],
    ) => void;
  };

  const handleRuntimeEventEmitter = (
    emitter: RuntimeEventEmitter,
    path: readonly (string | number)[],
  ) => {
    const handler = runtimeEventEmitterHandlers[emitter.source] as (
      entry: RuntimeEventEmitter,
      currentPath: readonly (string | number)[],
    ) => void;
    handler(emitter, path);
  };

  pack.resources.forEach((resource, index) => {
    if (resource.unlockCondition) {
      validateConditionNode(
        resource.unlockCondition,
        ['resources', index, 'unlockCondition'],
        ctx,
        context,
        resourceIndex,
        generatorIndex,
        upgradeIndex,
        prestigeIndex,
      );
    }

    if (resource.visibilityCondition) {
      validateConditionNode(
        resource.visibilityCondition,
        ['resources', index, 'visibilityCondition'],
        ctx,
        context,
        resourceIndex,
        generatorIndex,
        upgradeIndex,
        prestigeIndex,
      );
    }

    if (resource.prestige) {
      ensureContentReference(
        prestigeIndex,
        resource.prestige.layerId,
        ['resources', index, 'prestige', 'layerId'],
        `Resource "${resource.id}" references unknown prestige layer "${resource.prestige.layerId}".`,
      );

      if (resource.prestige.resetRetention) {
        collectFormulaEntityReferences(resource.prestige.resetRetention, (reference) => {
          ensureFormulaReference(
            reference,
            ['resources', index, 'prestige', 'resetRetention'],
            ctx,
            resourceIndex,
            generatorIndex,
            upgradeIndex,
            automationIndex,
            prestigeIndex,
          );
        });
      }
    }
  });

  pack.entities.forEach((entity, index) => {
    entity.stats.forEach((stat, statIndex) => {
      collectFormulaEntityReferences(stat.baseValue, (reference) => {
        ensureFormulaReference(
          reference,
          ['entities', index, 'stats', statIndex, 'baseValue'],
          ctx,
          resourceIndex,
          generatorIndex,
          upgradeIndex,
          automationIndex,
          prestigeIndex,
        );
      });
      if (stat.minValue) {
        collectFormulaEntityReferences(stat.minValue, (reference) => {
          ensureFormulaReference(
            reference,
            ['entities', index, 'stats', statIndex, 'minValue'],
            ctx,
            resourceIndex,
            generatorIndex,
            upgradeIndex,
            automationIndex,
            prestigeIndex,
          );
        });
      }
      if (stat.maxValue) {
        collectFormulaEntityReferences(stat.maxValue, (reference) => {
          ensureFormulaReference(
            reference,
            ['entities', index, 'stats', statIndex, 'maxValue'],
            ctx,
            resourceIndex,
            generatorIndex,
            upgradeIndex,
            automationIndex,
            prestigeIndex,
          );
        });
      }
    });

    if (entity.maxCount) {
      collectFormulaEntityReferences(entity.maxCount, (reference) => {
        ensureFormulaReference(
          reference,
          ['entities', index, 'maxCount'],
          ctx,
          resourceIndex,
          generatorIndex,
          upgradeIndex,
          automationIndex,
          prestigeIndex,
        );
      });
    }

    if (entity.progression) {
      if (entity.progression.experienceResource) {
        ensureContentReference(
          resourceIndex,
          entity.progression.experienceResource,
          ['entities', index, 'progression', 'experienceResource'],
          `Entity "${entity.id}" references unknown experience resource "${entity.progression.experienceResource}".`,
        );
      }

      collectFormulaEntityReferences(entity.progression.levelFormula, (reference) => {
        ensureFormulaReference(
          reference,
          ['entities', index, 'progression', 'levelFormula'],
          ctx,
          resourceIndex,
          generatorIndex,
          upgradeIndex,
          automationIndex,
          prestigeIndex,
        );
      });

      Object.entries(entity.progression.statGrowth).forEach(
        ([statId, formula]) => {
          if (!formula) {
            return;
          }
          collectFormulaEntityReferences(formula, (reference) => {
            ensureFormulaReference(
              reference,
              ['entities', index, 'progression', 'statGrowth', statId],
              ctx,
              resourceIndex,
              generatorIndex,
              upgradeIndex,
              automationIndex,
              prestigeIndex,
            );
          });
        },
      );
    }

    if (entity.unlockCondition) {
      validateConditionNode(
        entity.unlockCondition,
        ['entities', index, 'unlockCondition'],
        ctx,
        context,
        resourceIndex,
        generatorIndex,
        upgradeIndex,
        prestigeIndex,
      );
    }

    if (entity.visibilityCondition) {
      validateConditionNode(
        entity.visibilityCondition,
        ['entities', index, 'visibilityCondition'],
        ctx,
        context,
        resourceIndex,
        generatorIndex,
        upgradeIndex,
        prestigeIndex,
      );
    }
  });

  pack.runtimeEvents.forEach((event, index) => {
    if (context.runtimeEventCatalogue.has(event.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: toMutablePath(['runtimeEvents', index, 'id'] as const),
        message: `Runtime event "${event.id}" collides with an existing catalogue entry.`,
      });
    }

    event.emits.forEach((emitter, emitterIndex) => {
      handleRuntimeEventEmitter(
        emitter,
        ['runtimeEvents', index, 'emits', emitterIndex, 'id'],
      );
    });
  });

  pack.generators.forEach((generator, index) => {
    generator.produces.forEach((entry, produceIndex) => {
      ensureContentReference(
        resourceIndex,
        entry.resourceId,
        ['generators', index, 'produces', produceIndex, 'resourceId'],
        `Generator "${generator.id}" produces unknown resource "${entry.resourceId}".`,
      );
      collectFormulaEntityReferences(entry.rate, (reference) => {
        ensureFormulaReference(
          reference,
          ['generators', index, 'produces', produceIndex, 'rate'],
          ctx,
          resourceIndex,
          generatorIndex,
          upgradeIndex,
          automationIndex,
          prestigeIndex,
        );
      });
    });
    generator.consumes.forEach((entry, consumeIndex) => {
      ensureContentReference(
        resourceIndex,
        entry.resourceId,
        ['generators', index, 'consumes', consumeIndex, 'resourceId'],
        `Generator "${generator.id}" consumes unknown resource "${entry.resourceId}".`,
      );
      collectFormulaEntityReferences(entry.rate, (reference) => {
        ensureFormulaReference(
          reference,
          ['generators', index, 'consumes', consumeIndex, 'rate'],
          ctx,
          resourceIndex,
          generatorIndex,
          upgradeIndex,
          automationIndex,
          prestigeIndex,
        );
      });
    });
    if ('costs' in generator.purchase) {
      generator.purchase.costs.forEach((cost, costIndex) => {
        ensureContentReference(
          resourceIndex,
          cost.resourceId,
          ['generators', index, 'purchase', 'costs', costIndex, 'resourceId'],
          `Generator "${generator.id}" references unknown cost resource "${cost.resourceId}".`,
        );
        collectFormulaEntityReferences(cost.costCurve, (reference) => {
          ensureFormulaReference(
            reference,
            ['generators', index, 'purchase', 'costs', costIndex, 'costCurve'],
            ctx,
            resourceIndex,
            generatorIndex,
            upgradeIndex,
            automationIndex,
            prestigeIndex,
          );
        });
      });
    } else {
      ensureContentReference(
        resourceIndex,
        generator.purchase.currencyId,
        ['generators', index, 'purchase', 'currencyId'],
        `Generator "${generator.id}" references unknown currency "${generator.purchase.currencyId}".`,
      );
      collectFormulaEntityReferences(generator.purchase.costCurve, (reference) => {
        ensureFormulaReference(
          reference,
          ['generators', index, 'purchase', 'costCurve'],
          ctx,
          resourceIndex,
          generatorIndex,
          upgradeIndex,
          automationIndex,
          prestigeIndex,
        );
      });
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
      validateConditionNode(
        generator.baseUnlock,
        ['generators', index, 'baseUnlock'],
        ctx,
        context,
        resourceIndex,
        generatorIndex,
        upgradeIndex,
        prestigeIndex,
      );
    }
    if (generator.visibilityCondition) {
      validateConditionNode(
        generator.visibilityCondition,
        ['generators', index, 'visibilityCondition'],
        ctx,
        context,
        resourceIndex,
        generatorIndex,
        upgradeIndex,
        prestigeIndex,
      );
    }
    generator.effects.forEach((effect, effectIndex) => {
      validateUpgradeEffect(
        effect,
        ['generators', index, 'effects', effectIndex],
        ctx,
        context,
        resourceIndex,
        generatorIndex,
        upgradeIndex,
        automationIndex,
        prestigeIndex,
        knownRuntimeEvents,
      );
    });
  });

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
        collectFormulaEntityReferences(cost.costCurve, (reference) => {
          ensureFormulaReference(
            reference,
            ['upgrades', index, 'cost', 'costs', costIndex, 'costCurve'],
            ctx,
            resourceIndex,
            generatorIndex,
            upgradeIndex,
            automationIndex,
            prestigeIndex,
          );
        });
      });
    } else {
      ensureContentReference(
        resourceIndex,
        upgrade.cost.currencyId,
        ['upgrades', index, 'cost', 'currencyId'],
        `Upgrade "${upgrade.id}" references unknown currency "${upgrade.cost.currencyId}".`,
      );
      collectFormulaEntityReferences(upgrade.cost.costCurve, (reference) => {
        ensureFormulaReference(
          reference,
          ['upgrades', index, 'cost', 'costCurve'],
          ctx,
          resourceIndex,
          generatorIndex,
          upgradeIndex,
          automationIndex,
          prestigeIndex,
        );
      });
    }
    upgrade.effects.forEach((effect, effectIndex) => {
      validateUpgradeEffect(
        effect,
        ['upgrades', index, 'effects', effectIndex],
        ctx,
        context,
        resourceIndex,
        generatorIndex,
        upgradeIndex,
        automationIndex,
        prestigeIndex,
        knownRuntimeEvents,
      );
    });
    upgrade.prerequisites.forEach((prerequisite, prerequisiteIndex) => {
      validateConditionNode(
        prerequisite,
        ['upgrades', index, 'prerequisites', prerequisiteIndex],
        ctx,
        context,
        resourceIndex,
        generatorIndex,
        upgradeIndex,
        prestigeIndex,
      );
    });
    if (upgrade.unlockCondition) {
      validateConditionNode(
        upgrade.unlockCondition,
        ['upgrades', index, 'unlockCondition'],
        ctx,
        context,
        resourceIndex,
        generatorIndex,
        upgradeIndex,
        prestigeIndex,
      );
    }
    if (upgrade.visibilityCondition) {
      validateConditionNode(
        upgrade.visibilityCondition,
        ['upgrades', index, 'visibilityCondition'],
        ctx,
        context,
        resourceIndex,
        generatorIndex,
        upgradeIndex,
        prestigeIndex,
      );
    }
  });

  pack.metrics.forEach((metric, index) => {
    if (metric.source.kind === 'script') {
      assertAllowlisted(
        context.allowlists.scripts,
        metric.source.scriptId,
        ['metrics', index, 'source', 'scriptId'],
        ctx,
        warn,
        'allowlist.script.missing',
        `Metric "${metric.id}" references script "${metric.source.scriptId}" that is not in the scripts allowlist.`,
      );
    }
  });

  const ensureAchievementFormulaReferences = (
    formula: NumericFormula,
    path: readonly (string | number)[],
  ) => {
    collectFormulaEntityReferences(formula, (reference) => {
      ensureFormulaReference(
        reference,
        path,
        ctx,
        resourceIndex,
        generatorIndex,
        upgradeIndex,
        automationIndex,
        prestigeIndex,
      );
    });
  };

  const achievementTrackHandlers = {
    resource: (
      track: AchievementTrackByKind<'resource'>,
      trackPath: readonly (string | number)[],
      achievementId: string,
    ) => {
      ensureContentReference(
        resourceIndex,
        track.resourceId,
        [...trackPath, 'resourceId'],
        `Achievement "${achievementId}" references unknown resource "${track.resourceId}".`,
      );
      ensureAchievementFormulaReferences(track.threshold, [
        ...trackPath,
        'threshold',
      ]);
    },
    'generator-level': (
      track: AchievementTrackByKind<'generator-level'>,
      trackPath: readonly (string | number)[],
      achievementId: string,
    ) => {
      ensureContentReference(
        generatorIndex,
        track.generatorId,
        [...trackPath, 'generatorId'],
        `Achievement "${achievementId}" references unknown generator "${track.generatorId}".`,
      );
      ensureAchievementFormulaReferences(track.level, [
        ...trackPath,
        'level',
      ]);
    },
    'upgrade-owned': (
      track: AchievementTrackByKind<'upgrade-owned'>,
      trackPath: readonly (string | number)[],
      achievementId: string,
    ) => {
      ensureContentReference(
        upgradeIndex,
        track.upgradeId,
        [...trackPath, 'upgradeId'],
        `Achievement "${achievementId}" references unknown upgrade "${track.upgradeId}".`,
      );
      if (track.purchases) {
        ensureAchievementFormulaReferences(track.purchases, [
          ...trackPath,
          'purchases',
        ]);
      }
    },
    flag: (
      track: AchievementTrackByKind<'flag'>,
      trackPath: readonly (string | number)[],
      achievementId: string,
    ) => {
      assertAllowlisted(
        context.allowlists.flags,
        track.flagId,
        [...trackPath, 'flagId'],
        ctx,
        warn,
        'allowlist.flag.missing',
        `Achievement "${achievementId}" references flag "${track.flagId}" that is not in the flags allowlist.`,
      );
    },
    script: (
      track: AchievementTrackByKind<'script'>,
      trackPath: readonly (string | number)[],
      achievementId: string,
    ) => {
      assertAllowlisted(
        context.allowlists.scripts,
        track.scriptId,
        [...trackPath, 'scriptId'],
        ctx,
        warn,
        'allowlist.script.missing',
        `Achievement "${achievementId}" references script "${track.scriptId}" that is not in the scripts allowlist.`,
      );
    },
    'custom-metric': (
      track: AchievementTrackByKind<'custom-metric'>,
      trackPath: readonly (string | number)[],
      achievementId: string,
    ) => {
      ensureContentReference(
        metricIndex,
        track.metricId,
        [...trackPath, 'metricId'],
        `Achievement "${achievementId}" references unknown metric "${track.metricId}".`,
      );
      ensureAchievementFormulaReferences(track.threshold, [
        ...trackPath,
        'threshold',
      ]);
    },
  } satisfies {
    [K in AchievementTrack['kind']]: (
      track: AchievementTrackByKind<K>,
      trackPath: readonly (string | number)[],
      achievementId: string,
    ) => void;
  };

  const handleAchievementTrack = (
    track: AchievementTrack,
    trackPath: readonly (string | number)[],
    achievementId: string,
  ) => {
    const handler = achievementTrackHandlers[track.kind] as (
      entry: AchievementTrack,
      currentPath: readonly (string | number)[],
      currentAchievementId: string,
    ) => void;
    handler(track, trackPath, achievementId);
  };

  const achievementRewardHandlers = {
    grantResource: (
      reward: AchievementRewardByKind<'grantResource'>,
      rewardPath: readonly (string | number)[],
      achievementId: string,
    ) => {
      ensureContentReference(
        resourceIndex,
        reward.resourceId,
        [...rewardPath, 'resourceId'],
        `Achievement "${achievementId}" grants unknown resource "${reward.resourceId}".`,
      );
      ensureAchievementFormulaReferences(reward.amount, [
        ...rewardPath,
        'amount',
      ]);
    },
    grantUpgrade: (
      reward: AchievementRewardByKind<'grantUpgrade'>,
      rewardPath: readonly (string | number)[],
      achievementId: string,
    ) => {
      ensureContentReference(
        upgradeIndex,
        reward.upgradeId,
        [...rewardPath, 'upgradeId'],
        `Achievement "${achievementId}" grants unknown upgrade "${reward.upgradeId}".`,
      );
    },
    emitEvent: (
      reward: AchievementRewardByKind<'emitEvent'>,
      rewardPath: readonly (string | number)[],
    ) => {
      ensureRuntimeEventKnown(
        reward.eventId,
        [...rewardPath, 'eventId'],
        runtimeEventSeverity,
      );
    },
    unlockAutomation: (
      reward: AchievementRewardByKind<'unlockAutomation'>,
      rewardPath: readonly (string | number)[],
      achievementId: string,
    ) => {
      ensureContentReference(
        automationIndex,
        reward.automationId,
        [...rewardPath, 'automationId'],
        `Achievement "${achievementId}" unlocks unknown automation "${reward.automationId}".`,
      );
    },
    grantFlag: (
      reward: AchievementRewardByKind<'grantFlag'>,
      rewardPath: readonly (string | number)[],
      achievementId: string,
    ) => {
      assertAllowlisted(
        context.allowlists.flags,
        reward.flagId,
        [...rewardPath, 'flagId'],
        ctx,
        warn,
        'allowlist.flag.missing',
        `Achievement "${achievementId}" grants flag "${reward.flagId}" that is not in the flags allowlist.`,
      );
    },
  } satisfies {
    [K in AchievementReward['kind']]: (
      reward: AchievementRewardByKind<K>,
      rewardPath: readonly (string | number)[],
      achievementId: string,
    ) => void;
  };

  const handleAchievementReward = (
    reward: AchievementReward,
    rewardPath: readonly (string | number)[],
    achievementId: string,
  ) => {
    const handler = achievementRewardHandlers[reward.kind] as (
      entry: AchievementReward,
      currentPath: readonly (string | number)[],
      currentAchievementId: string,
    ) => void;
    handler(reward, rewardPath, achievementId);
  };

  pack.achievements.forEach((achievement, index) => {
    const trackPath = ['achievements', index, 'track'] as const;
    handleAchievementTrack(achievement.track, trackPath, achievement.id);
    if (achievement.reward) {
      const rewardPath = ['achievements', index, 'reward'] as const;
      handleAchievementReward(achievement.reward, rewardPath, achievement.id);
    }
    if (achievement.unlockCondition) {
      validateConditionNode(
        achievement.unlockCondition,
        ['achievements', index, 'unlockCondition'],
        ctx,
        context,
        resourceIndex,
        generatorIndex,
        upgradeIndex,
        prestigeIndex,
      );
    }
    if (achievement.visibilityCondition) {
      validateConditionNode(
        achievement.visibilityCondition,
        ['achievements', index, 'visibilityCondition'],
        ctx,
        context,
        resourceIndex,
        generatorIndex,
        upgradeIndex,
        prestigeIndex,
      );
    }
    achievement.onUnlockEvents.forEach((eventId, eventIndex) => {
      ensureRuntimeEventKnown(
        eventId,
        ['achievements', index, 'onUnlockEvents', eventIndex],
        runtimeEventSeverity,
      );
    });
  });

  pack.automations.forEach((automation, index) => {
    if (
      automation.targetType === 'generator' ||
      automation.targetType === 'purchaseGenerator'
    ) {
      if (automation.targetId) {
        ensureContentReference(
          generatorIndex,
          automation.targetId,
          ['automations', index, 'targetId'],
          `Automation "${automation.id}" references unknown generator "${automation.targetId}".`,
        );
      }
      if (automation.targetType === 'purchaseGenerator' && automation.targetCount) {
        collectFormulaEntityReferences(automation.targetCount, (reference) => {
          ensureFormulaReference(
            reference,
            ['automations', index, 'targetCount'],
            ctx,
            resourceIndex,
            generatorIndex,
            upgradeIndex,
            automationIndex,
            prestigeIndex,
          );
        });
      }
    } else if (automation.targetType === 'upgrade') {
      if (automation.targetId) {
        ensureContentReference(
          upgradeIndex,
          automation.targetId,
          ['automations', index, 'targetId'],
          `Automation "${automation.id}" references unknown upgrade "${automation.targetId}".`,
        );
      }
    } else if (automation.targetType === 'collectResource') {
      if (automation.targetId) {
        ensureContentReference(
          resourceIndex,
          automation.targetId,
          ['automations', index, 'targetId'],
          `Automation "${automation.id}" references unknown resource "${automation.targetId}".`,
        );
      }
      if (automation.targetAmount) {
        collectFormulaEntityReferences(automation.targetAmount, (reference) => {
          ensureFormulaReference(
            reference,
            ['automations', index, 'targetAmount'],
            ctx,
            resourceIndex,
            generatorIndex,
            upgradeIndex,
            automationIndex,
            prestigeIndex,
          );
        });
      }
    } else if (automation.targetType === 'system') {
      if (automation.systemTargetId) {
        assertAllowlisted(
          context.allowlists.systemAutomationTargets,
          automation.systemTargetId,
          ['automations', index, 'systemTargetId'],
          ctx,
          warn,
          'allowlist.systemAutomationTarget.missing',
          `Automation "${automation.id}" references system target "${automation.systemTargetId}" not present in the allowlist.`,
        );
      }
    }
    if (automation.resourceCost) {
      ensureContentReference(
        resourceIndex,
        automation.resourceCost.resourceId,
        ['automations', index, 'resourceCost', 'resourceId'],
        `Automation "${automation.id}" references unknown resource "${automation.resourceCost.resourceId}".`,
      );
      collectFormulaEntityReferences(automation.resourceCost.rate, (reference) => {
        ensureFormulaReference(
          reference,
          ['automations', index, 'resourceCost', 'rate'],
          ctx,
          resourceIndex,
          generatorIndex,
          upgradeIndex,
          automationIndex,
          prestigeIndex,
        );
      });
    }
    if (automation.cooldown) {
      collectFormulaEntityReferences(automation.cooldown, (reference) => {
        ensureFormulaReference(
          reference,
          ['automations', index, 'cooldown'],
          ctx,
          resourceIndex,
          generatorIndex,
          upgradeIndex,
          automationIndex,
          prestigeIndex,
        );
      });
    }
    const automationTriggerHandlers = {
      resourceThreshold: (
        trigger: AutomationTriggerByKind<'resourceThreshold'>,
        triggerPath: readonly (string | number)[],
        automationId: string,
      ) => {
        ensureContentReference(
          resourceIndex,
          trigger.resourceId,
          [...triggerPath, 'resourceId'],
          `Automation "${automationId}" trigger references unknown resource "${trigger.resourceId}".`,
        );
        collectFormulaEntityReferences(trigger.threshold, (reference) => {
          ensureFormulaReference(
            reference,
            [...triggerPath, 'threshold'],
            ctx,
            resourceIndex,
            generatorIndex,
            upgradeIndex,
            automationIndex,
            prestigeIndex,
          );
        });
      },
      event: (
        trigger: AutomationTriggerByKind<'event'>,
        triggerPath: readonly (string | number)[],
      ) => {
        ensureRuntimeEventKnown(
          trigger.eventId,
          [...triggerPath, 'eventId'],
          runtimeEventSeverity,
        );
      },
      interval: () => undefined,
      commandQueueEmpty: () => undefined,
    } satisfies {
      [K in AutomationTrigger['kind']]: (
        trigger: AutomationTriggerByKind<K>,
        triggerPath: readonly (string | number)[],
        automationId: string,
      ) => void;
    };

    const handleAutomationTrigger = (
      trigger: AutomationTrigger,
      triggerPath: readonly (string | number)[],
      automationId: string,
    ) => {
      const handler = automationTriggerHandlers[trigger.kind] as (
        entry: AutomationTrigger,
        currentPath: readonly (string | number)[],
        currentAutomationId: string,
      ) => void;
      handler(trigger, triggerPath, automationId);
    };

    handleAutomationTrigger(
      automation.trigger,
      ['automations', index, 'trigger'],
      automation.id,
    );
    if (automation.scriptId) {
      assertAllowlisted(
        context.allowlists.scripts,
        automation.scriptId,
        ['automations', index, 'scriptId'],
        ctx,
        warn,
        'allowlist.script.missing',
        `Automation "${automation.id}" references script "${automation.scriptId}" that is not in the scripts allowlist.`,
      );
    }
    validateConditionNode(
      automation.unlockCondition,
      ['automations', index, 'unlockCondition'],
      ctx,
      context,
      resourceIndex,
      generatorIndex,
      upgradeIndex,
      prestigeIndex,
    );
    if (automation.visibilityCondition) {
      validateConditionNode(
        automation.visibilityCondition,
        ['automations', index, 'visibilityCondition'],
        ctx,
        context,
        resourceIndex,
        generatorIndex,
        upgradeIndex,
        prestigeIndex,
      );
    }
  });

  pack.transforms.forEach((transform, index) => {
    transform.inputs.forEach((input, inputIndex) => {
      ensureContentReference(
        resourceIndex,
        input.resourceId,
        ['transforms', index, 'inputs', inputIndex, 'resourceId'],
        `Transform "${transform.id}" consumes unknown resource "${input.resourceId}".`,
      );
      collectFormulaEntityReferences(input.amount, (reference) => {
        ensureFormulaReference(
          reference,
          ['transforms', index, 'inputs', inputIndex, 'amount'],
          ctx,
          resourceIndex,
          generatorIndex,
          upgradeIndex,
          automationIndex,
          prestigeIndex,
        );
      });
    });
    transform.outputs.forEach((output, outputIndex) => {
      ensureContentReference(
        resourceIndex,
        output.resourceId,
        ['transforms', index, 'outputs', outputIndex, 'resourceId'],
        `Transform "${transform.id}" produces unknown resource "${output.resourceId}".`,
      );
      collectFormulaEntityReferences(output.amount, (reference) => {
        ensureFormulaReference(
          reference,
          ['transforms', index, 'outputs', outputIndex, 'amount'],
          ctx,
          resourceIndex,
          generatorIndex,
          upgradeIndex,
          automationIndex,
          prestigeIndex,
        );
      });
    });
    if (transform.duration) {
      collectFormulaEntityReferences(transform.duration, (reference) => {
        ensureFormulaReference(
          reference,
          ['transforms', index, 'duration'],
          ctx,
          resourceIndex,
          generatorIndex,
          upgradeIndex,
          automationIndex,
          prestigeIndex,
        );
      });
    }
    if (transform.cooldown) {
      collectFormulaEntityReferences(transform.cooldown, (reference) => {
        ensureFormulaReference(
          reference,
          ['transforms', index, 'cooldown'],
          ctx,
          resourceIndex,
          generatorIndex,
          upgradeIndex,
          automationIndex,
          prestigeIndex,
        );
      });
    }
    if (transform.successRate) {
      collectFormulaEntityReferences(transform.successRate.baseRate, (reference) => {
        ensureFormulaReference(
          reference,
          ['transforms', index, 'successRate', 'baseRate'],
          ctx,
          resourceIndex,
          generatorIndex,
          upgradeIndex,
          automationIndex,
          prestigeIndex,
        );
      });
      transform.successRate.statModifiers?.forEach((modifier, modifierIndex) => {
        collectFormulaEntityReferences(modifier.weight, (reference) => {
          ensureFormulaReference(
            reference,
            ['transforms', index, 'successRate', 'statModifiers', modifierIndex, 'weight'],
            ctx,
            resourceIndex,
            generatorIndex,
            upgradeIndex,
            automationIndex,
            prestigeIndex,
          );
        });
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
      condition: (
        trigger: TransformTriggerByKind<'condition'>,
        triggerPath: readonly (string | number)[],
      ) => {
        validateConditionNode(
          trigger.condition,
          [...triggerPath, 'condition'],
          ctx,
          context,
          resourceIndex,
          generatorIndex,
          upgradeIndex,
          prestigeIndex,
        );
      },
      event: (
        trigger: TransformTriggerByKind<'event'>,
        triggerPath: readonly (string | number)[],
      ) => {
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

    handleTransformTrigger(
      transform.trigger,
      ['transforms', index, 'trigger'],
      transform.id,
    );
    if (transform.automation) {
      ensureContentReference(
        automationIndex,
        transform.automation.automationId,
        ['transforms', index, 'automation', 'automationId'],
        `Transform "${transform.id}" references unknown automation "${transform.automation.automationId}".`,
      );
    }
    if (transform.unlockCondition) {
      validateConditionNode(
        transform.unlockCondition,
        ['transforms', index, 'unlockCondition'],
        ctx,
        context,
        resourceIndex,
        generatorIndex,
        upgradeIndex,
        prestigeIndex,
      );
    }
    if (transform.visibilityCondition) {
      validateConditionNode(
        transform.visibilityCondition,
        ['transforms', index, 'visibilityCondition'],
        ctx,
        context,
        resourceIndex,
        generatorIndex,
        upgradeIndex,
        prestigeIndex,
      );
    }

    if (transform.mode === 'mission' && transform.entityRequirements) {
      const availableStats = new Set<string>();
      transform.entityRequirements.forEach((requirement, requirementIndex) => {
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

        const statIds = new Set<string>(
          entry.value.stats.map((stat) => stat.id as string),
        );
        entry.value.stats.forEach((stat) => {
          availableStats.add(stat.id);
        });

        collectFormulaEntityReferences(requirement.count, (reference) => {
          ensureFormulaReference(
            reference,
            ['transforms', index, 'entityRequirements', requirementIndex, 'count'],
            ctx,
            resourceIndex,
            generatorIndex,
            upgradeIndex,
            automationIndex,
            prestigeIndex,
          );
        });

        if (requirement.minStats) {
          Object.entries(requirement.minStats).forEach(([statId, formula]) => {
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
              return;
            }
            collectFormulaEntityReferences(formula, (reference) => {
              ensureFormulaReference(
                reference,
                [
                  'transforms',
                  index,
                  'entityRequirements',
                  requirementIndex,
                  'minStats',
                  statId,
                ],
                ctx,
                resourceIndex,
                generatorIndex,
                upgradeIndex,
                automationIndex,
                prestigeIndex,
              );
            });
          });
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
      });

      if (transform.successRate?.statModifiers) {
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
      }

      const validateOutcome = (
        outcome:
          | {
              outputs: readonly { resourceId: string; amount: NumericFormula }[];
              entityExperience?: NumericFormula;
              entityDamage?: NumericFormula;
            }
          | undefined,
        outcomePath: readonly (string | number)[],
      ) => {
        if (!outcome) {
          return;
        }
        outcome.outputs.forEach((output, outputIndex) => {
          ensureContentReference(
            resourceIndex,
            output.resourceId,
            [...outcomePath, 'outputs', outputIndex, 'resourceId'],
            `Transform "${transform.id}" produces unknown resource "${output.resourceId}".`,
          );
          collectFormulaEntityReferences(output.amount, (reference) => {
            ensureFormulaReference(
              reference,
              [...outcomePath, 'outputs', outputIndex, 'amount'],
              ctx,
              resourceIndex,
              generatorIndex,
              upgradeIndex,
              automationIndex,
              prestigeIndex,
            );
          });
        });
        if (outcome.entityExperience) {
          collectFormulaEntityReferences(outcome.entityExperience, (reference) => {
            ensureFormulaReference(
              reference,
              [...outcomePath, 'entityExperience'],
              ctx,
              resourceIndex,
              generatorIndex,
              upgradeIndex,
              automationIndex,
              prestigeIndex,
            );
          });
        }
        if (outcome.entityDamage) {
          collectFormulaEntityReferences(outcome.entityDamage, (reference) => {
            ensureFormulaReference(
              reference,
              [...outcomePath, 'entityDamage'],
              ctx,
              resourceIndex,
              generatorIndex,
              upgradeIndex,
              automationIndex,
              prestigeIndex,
            );
          });
        }
      };

      if (transform.outcomes) {
        validateOutcome(transform.outcomes.success, [
          'transforms',
          index,
          'outcomes',
          'success',
        ]);
        validateOutcome(transform.outcomes.failure, [
          'transforms',
          index,
          'outcomes',
          'failure',
        ]);
        validateOutcome(transform.outcomes.critical, [
          'transforms',
          index,
          'outcomes',
          'critical',
        ]);
        if (transform.outcomes.critical?.chance) {
          collectFormulaEntityReferences(
            transform.outcomes.critical.chance,
            (reference) => {
              ensureFormulaReference(
                reference,
                ['transforms', index, 'outcomes', 'critical', 'chance'],
                ctx,
                resourceIndex,
                generatorIndex,
                upgradeIndex,
                automationIndex,
                prestigeIndex,
              );
            },
          );
        }
      }
    }
  });

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
    collectFormulaEntityReferences(layer.reward.baseReward, (reference) => {
      ensureFormulaReference(
        reference,
        ['prestigeLayers', index, 'reward', 'baseReward'],
        ctx,
        resourceIndex,
        generatorIndex,
        upgradeIndex,
        automationIndex,
        prestigeIndex,
      );
    });
    if (layer.reward.multiplierCurve) {
      collectFormulaEntityReferences(layer.reward.multiplierCurve, (reference) => {
        ensureFormulaReference(
          reference,
          ['prestigeLayers', index, 'reward', 'multiplierCurve'],
          ctx,
          resourceIndex,
          generatorIndex,
          upgradeIndex,
          automationIndex,
          prestigeIndex,
        );
      });
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
    validateConditionNode(
      layer.unlockCondition,
      ['prestigeLayers', index, 'unlockCondition'],
      ctx,
      context,
      resourceIndex,
      generatorIndex,
      upgradeIndex,
      prestigeIndex,
    );
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
