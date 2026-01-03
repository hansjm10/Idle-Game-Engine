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

  switch (effect.kind) {
    case 'modifyResourceRate':
    case 'modifyResourceCapacity':
    case 'unlockResource':
    case 'alterDirtyTolerance':
      ensureReference(
        resources,
        effect.resourceId,
        `Effect references unknown resource "${effect.resourceId}".`,
      );
      if ('value' in effect) {
        collectFormulaEntityReferences(effect.value, (reference) => {
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
      }
      break;
    case 'modifyGeneratorRate':
    case 'modifyGeneratorCost':
    case 'modifyGeneratorConsumption':
    case 'unlockGenerator':
      ensureReference(
        generators,
        effect.generatorId,
        `Effect references unknown generator "${effect.generatorId}".`,
      );
      if ('resourceId' in effect && effect.resourceId !== undefined) {
        ensureReference(
          resources,
          effect.resourceId,
          `Effect references unknown resource "${effect.resourceId}".`,
        );
      }
      if ('value' in effect) {
        collectFormulaEntityReferences(effect.value, (reference) => {
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
      }
      break;
    case 'grantAutomation':
      ensureReference(
        automations,
        effect.automationId,
        `Effect references unknown automation "${effect.automationId}".`,
      );
      break;
    case 'grantFlag':
      assertAllowlisted(
        context.allowlists.flags,
        effect.flagId,
        [...path, 'flagId'] as const,
        ctx,
        context.warningSink,
        'allowlist.flag.missing',
        `Effect references flag "${effect.flagId}" that is not in the flags allowlist.`,
      );
      break;
    case 'emitEvent':
      if (!runtimeEvents.has(effect.eventId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: toMutablePath(path),
          message: `Effect references unknown runtime event "${effect.eventId}".`,
        });
      }
      break;
    default:
      break;
  }
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

  const visit = (node: Condition, currentPath: readonly (string | number)[]) => {
    switch (node.kind) {
      case 'resourceThreshold':
        if (!resources.has(node.resourceId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: toMutablePath([...currentPath, 'resourceId'] as const),
            message: `Condition references unknown resource "${node.resourceId}".`,
          });
        }
        collectFormulaEntityReferences(node.amount, (reference) => {
          ensureFormulaReference(
            reference,
            currentPath,
            ctx,
            resources,
            generators,
            upgrades,
            new Map(),
            prestigeLayers,
          );
        });
        break;
      case 'generatorLevel':
        if (!generators.has(node.generatorId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: toMutablePath([...currentPath, 'generatorId'] as const),
            message: `Condition references unknown generator "${node.generatorId}".`,
          });
        }
        collectFormulaEntityReferences(node.level, (reference) => {
          ensureFormulaReference(
            reference,
            currentPath,
            ctx,
            resources,
            generators,
            upgrades,
            new Map(),
            prestigeLayers,
          );
        });
        break;
      case 'upgradeOwned':
        if (!upgrades.has(node.upgradeId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: toMutablePath([...currentPath, 'upgradeId'] as const),
            message: `Condition references unknown upgrade "${node.upgradeId}".`,
          });
        }
        break;
      case 'prestigeCountThreshold':
        if (!prestigeLayers.has(node.prestigeLayerId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: toMutablePath([...currentPath, 'prestigeLayerId'] as const),
            message: `Condition references unknown prestige layer "${node.prestigeLayerId}".`,
          });
        }
        break;
      case 'prestigeCompleted':
        if (!prestigeLayers.has(node.prestigeLayerId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: toMutablePath([...currentPath, 'prestigeLayerId'] as const),
            message: `Condition references unknown prestige layer "${node.prestigeLayerId}".`,
          });
        }
        break;
      case 'prestigeUnlocked':
        if (!prestigeLayers.has(node.prestigeLayerId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: toMutablePath([...currentPath, 'prestigeLayerId'] as const),
            message: `Condition references unknown prestige layer "${node.prestigeLayerId}".`,
          });
        }
        break;
      case 'flag':
        assertAllowlisted(
          context.allowlists.flags,
          node.flagId,
          [...currentPath, 'flagId'],
          ctx,
          context.warningSink,
          'allowlist.flag.missing',
          `Condition references flag "${node.flagId}" that is not in the flags allowlist.`,
        );
        break;
      case 'script':
        assertAllowlisted(
          context.allowlists.scripts,
          node.scriptId,
          [...currentPath, 'scriptId'],
          ctx,
          context.warningSink,
          'allowlist.script.missing',
          `Condition references script "${node.scriptId}" that is not in the scripts allowlist.`,
        );
        break;
      case 'allOf':
      case 'anyOf':
        node.conditions.forEach((child, childIndex) =>
          visit(child, [...currentPath, 'conditions', childIndex]),
        );
        break;
      case 'not':
        visit(node.condition, [...currentPath, 'condition']);
        break;
      default:
        break;
    }
  };

  visit(condition, path);
};

export const validateCrossReferences = (
  pack: ParsedContentPack,
  ctx: z.RefinementCtx,
  context: CrossReferenceContext,
) => {
  const resourceIndex = getIndexMap(pack.resources);
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
      switch (emitter.source) {
        case 'achievement':
          ensureContentReference(
            achievementIndex,
            emitter.id,
            toMutablePath(['runtimeEvents', index, 'emits', emitterIndex, 'id'] as const),
            `Runtime event emitter references unknown achievement "${emitter.id}".`,
          );
          break;
        case 'upgrade':
          ensureContentReference(
            upgradeIndex,
            emitter.id,
            toMutablePath(['runtimeEvents', index, 'emits', emitterIndex, 'id'] as const),
            `Runtime event emitter references unknown upgrade "${emitter.id}".`,
          );
          break;
        case 'transform':
          ensureContentReference(
            transformIndex,
            emitter.id,
            toMutablePath(['runtimeEvents', index, 'emits', emitterIndex, 'id'] as const),
            `Runtime event emitter references unknown transform "${emitter.id}".`,
          );
          break;
        case 'script':
          assertAllowlisted(
            context.allowlists.scripts,
            emitter.id,
            toMutablePath(['runtimeEvents', index, 'emits', emitterIndex, 'id'] as const),
            ctx,
            warn,
            'allowlist.script.missing',
            `Script "${emitter.id}" is not declared in the scripts allowlist.`,
          );
          break;
        default:
          break;
      }
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

  pack.upgrades.forEach((upgrade, index) => {
    upgrade.targets.forEach((target, targetIndex) => {
      switch (target.kind) {
        case 'resource':
          ensureContentReference(
            resourceIndex,
            target.id,
            ['upgrades', index, 'targets', targetIndex, 'id'],
            `Upgrade "${upgrade.id}" targets unknown resource "${target.id}".`,
          );
          break;
        case 'generator':
          ensureContentReference(
            generatorIndex,
            target.id,
            ['upgrades', index, 'targets', targetIndex, 'id'],
            `Upgrade "${upgrade.id}" targets unknown generator "${target.id}".`,
          );
          break;
        case 'automation':
          ensureContentReference(
            automationIndex,
            target.id,
            ['upgrades', index, 'targets', targetIndex, 'id'],
            `Upgrade "${upgrade.id}" targets unknown automation "${target.id}".`,
          );
          break;
        case 'prestigeLayer':
          ensureContentReference(
            prestigeIndex,
            target.id,
            ['upgrades', index, 'targets', targetIndex, 'id'],
            `Upgrade "${upgrade.id}" targets unknown prestige layer "${target.id}".`,
          );
          break;
        default:
          break;
      }
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

  pack.achievements.forEach((achievement, index) => {
    switch (achievement.track.kind) {
      case 'resource':
        ensureContentReference(
          resourceIndex,
          achievement.track.resourceId,
          ['achievements', index, 'track', 'resourceId'],
          `Achievement "${achievement.id}" references unknown resource "${achievement.track.resourceId}".`,
        );
        collectFormulaEntityReferences(achievement.track.threshold, (reference) => {
          ensureFormulaReference(
            reference,
            ['achievements', index, 'track', 'threshold'],
            ctx,
            resourceIndex,
            generatorIndex,
            upgradeIndex,
            automationIndex,
            prestigeIndex,
          );
        });
        break;
      case 'generator-level':
        ensureContentReference(
          generatorIndex,
          achievement.track.generatorId,
          ['achievements', index, 'track', 'generatorId'],
          `Achievement "${achievement.id}" references unknown generator "${achievement.track.generatorId}".`,
        );
        collectFormulaEntityReferences(achievement.track.level, (reference) => {
          ensureFormulaReference(
            reference,
            ['achievements', index, 'track', 'level'],
            ctx,
            resourceIndex,
            generatorIndex,
            upgradeIndex,
            automationIndex,
            prestigeIndex,
          );
        });
        break;
      case 'upgrade-owned':
        ensureContentReference(
          upgradeIndex,
          achievement.track.upgradeId,
          ['achievements', index, 'track', 'upgradeId'],
          `Achievement "${achievement.id}" references unknown upgrade "${achievement.track.upgradeId}".`,
        );
        if (achievement.track.purchases) {
          collectFormulaEntityReferences(achievement.track.purchases, (reference) => {
            ensureFormulaReference(
              reference,
              ['achievements', index, 'track', 'purchases'],
              ctx,
              resourceIndex,
              generatorIndex,
              upgradeIndex,
              automationIndex,
              prestigeIndex,
            );
          });
        }
        break;
      case 'flag':
        assertAllowlisted(
          context.allowlists.flags,
          achievement.track.flagId,
          ['achievements', index, 'track', 'flagId'],
          ctx,
          warn,
          'allowlist.flag.missing',
          `Achievement "${achievement.id}" references flag "${achievement.track.flagId}" that is not in the flags allowlist.`,
        );
        break;
      case 'script':
        assertAllowlisted(
          context.allowlists.scripts,
          achievement.track.scriptId,
          ['achievements', index, 'track', 'scriptId'],
          ctx,
          warn,
          'allowlist.script.missing',
          `Achievement "${achievement.id}" references script "${achievement.track.scriptId}" that is not in the scripts allowlist.`,
        );
        break;
      case 'custom-metric':
        ensureContentReference(
          metricIndex,
          achievement.track.metricId,
          ['achievements', index, 'track', 'metricId'],
          `Achievement "${achievement.id}" references unknown metric "${achievement.track.metricId}".`,
        );
        collectFormulaEntityReferences(achievement.track.threshold, (reference) => {
          ensureFormulaReference(
            reference,
            ['achievements', index, 'track', 'threshold'],
            ctx,
            resourceIndex,
            generatorIndex,
            upgradeIndex,
            automationIndex,
            prestigeIndex,
          );
        });
        break;
      default:
        break;
    }
    if (achievement.reward) {
      switch (achievement.reward.kind) {
        case 'grantResource':
          ensureContentReference(
            resourceIndex,
            achievement.reward.resourceId,
            ['achievements', index, 'reward', 'resourceId'],
            `Achievement "${achievement.id}" grants unknown resource "${achievement.reward.resourceId}".`,
          );
          collectFormulaEntityReferences(achievement.reward.amount, (reference) => {
            ensureFormulaReference(
              reference,
              ['achievements', index, 'reward', 'amount'],
              ctx,
              resourceIndex,
              generatorIndex,
              upgradeIndex,
              automationIndex,
              prestigeIndex,
            );
          });
          break;
        case 'grantUpgrade':
          ensureContentReference(
            upgradeIndex,
            achievement.reward.upgradeId,
            ['achievements', index, 'reward', 'upgradeId'],
            `Achievement "${achievement.id}" grants unknown upgrade "${achievement.reward.upgradeId}".`,
          );
          break;
        case 'emitEvent':
          ensureRuntimeEventKnown(
            achievement.reward.eventId,
            ['achievements', index, 'reward', 'eventId'],
            context.runtimeEventCatalogue.size > 0 ? 'error' : 'warning',
          );
          break;
        case 'unlockAutomation':
          ensureContentReference(
            automationIndex,
            achievement.reward.automationId,
            ['achievements', index, 'reward', 'automationId'],
            `Achievement "${achievement.id}" unlocks unknown automation "${achievement.reward.automationId}".`,
          );
          break;
        case 'grantFlag':
          assertAllowlisted(
            context.allowlists.flags,
            achievement.reward.flagId,
            ['achievements', index, 'reward', 'flagId'],
            ctx,
            warn,
            'allowlist.flag.missing',
            `Achievement "${achievement.id}" grants flag "${achievement.reward.flagId}" that is not in the flags allowlist.`,
          );
          break;
        default:
          break;
      }
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
        context.runtimeEventCatalogue.size > 0 ? 'error' : 'warning',
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
    switch (automation.trigger.kind) {
      case 'resourceThreshold':
        ensureContentReference(
          resourceIndex,
          automation.trigger.resourceId,
          ['automations', index, 'trigger', 'resourceId'],
          `Automation "${automation.id}" trigger references unknown resource "${automation.trigger.resourceId}".`,
        );
        collectFormulaEntityReferences(automation.trigger.threshold, (reference) => {
          ensureFormulaReference(
            reference,
            ['automations', index, 'trigger', 'threshold'],
            ctx,
            resourceIndex,
            generatorIndex,
            upgradeIndex,
            automationIndex,
            prestigeIndex,
          );
        });
        break;
      case 'event':
        ensureRuntimeEventKnown(
          automation.trigger.eventId,
          ['automations', index, 'trigger', 'eventId'],
          context.runtimeEventCatalogue.size > 0 ? 'error' : 'warning',
        );
        break;
      default:
        break;
    }
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
    switch (transform.trigger.kind) {
      case 'automation':
        ensureContentReference(
          automationIndex,
          transform.trigger.automationId,
          ['transforms', index, 'trigger', 'automationId'],
          `Transform "${transform.id}" references unknown automation "${transform.trigger.automationId}".`,
        );
        break;
      case 'condition':
        validateConditionNode(
          transform.trigger.condition,
          ['transforms', index, 'trigger', 'condition'],
          ctx,
          context,
          resourceIndex,
          generatorIndex,
          upgradeIndex,
          prestigeIndex,
        );
        break;
      case 'event':
        ensureRuntimeEventKnown(
          transform.trigger.eventId,
          ['transforms', index, 'trigger', 'eventId'],
          context.runtimeEventCatalogue.size > 0 ? 'error' : 'warning',
        );
        break;
      default:
        break;
    }
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
