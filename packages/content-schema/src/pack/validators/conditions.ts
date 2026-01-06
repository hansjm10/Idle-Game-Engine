import { z } from 'zod';

import type { Condition } from '../../base/conditions.js';
import type { NumericFormula } from '../../base/formulas.js';
import { toMutablePath } from '../utils.js';
import { assertAllowlisted } from './allowlists.js';
import {
  collectFormulaEntityReferences,
  ensureFormulaReference,
} from './formulas.js';
import type { CrossReferenceState, IndexMap } from './state.js';

type ConditionByKind<K extends Condition['kind']> = Extract<Condition, { kind: K }>;

export const validateConditionNode = (
  state: Pick<CrossReferenceState, 'ctx' | 'context' | 'indexes'>,
  condition: Condition | undefined,
  path: readonly (string | number)[],
) => {
  const { ctx, context, indexes } = state;
  const {
    resources: resourceIndex,
    generators: generatorIndex,
    upgrades: upgradeIndex,
    prestigeLayers: prestigeIndex,
  } = indexes;

  if (!condition) {
    return;
  }

  const emptyAutomationIndex: IndexMap<unknown> = new Map();

  const ensureConditionFormulaReferences = (
    formula: NumericFormula,
    currentPath: readonly (string | number)[],
  ) => {
    collectFormulaEntityReferences(formula, (reference) => {
      ensureFormulaReference(reference, currentPath, ctx, {
        resources: resourceIndex,
        generators: generatorIndex,
        upgrades: upgradeIndex,
        automations: emptyAutomationIndex,
        prestigeLayers: prestigeIndex,
      });
    });
  };

  const handlers = {
    always: () => undefined,
    never: () => undefined,
    resourceThreshold: (
      node: ConditionByKind<'resourceThreshold'>,
      currentPath: readonly (string | number)[],
    ) => {
      if (!resourceIndex.has(node.resourceId)) {
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
      if (!generatorIndex.has(node.generatorId)) {
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
      if (!upgradeIndex.has(node.upgradeId)) {
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
      if (!prestigeIndex.has(node.prestigeLayerId)) {
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
      if (!prestigeIndex.has(node.prestigeLayerId)) {
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
      if (!prestigeIndex.has(node.prestigeLayerId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: toMutablePath([...currentPath, 'prestigeLayerId'] as const),
          message: `Condition references unknown prestige layer "${node.prestigeLayerId}".`,
        });
      }
    },
    flag: (node: ConditionByKind<'flag'>, currentPath: readonly (string | number)[]) => {
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
    allOf: (node: ConditionByKind<'allOf'>, currentPath: readonly (string | number)[]) => {
      node.conditions.forEach((child, childIndex) =>
        visit(child, [...currentPath, 'conditions', childIndex]),
      );
    },
    anyOf: (node: ConditionByKind<'anyOf'>, currentPath: readonly (string | number)[]) => {
      node.conditions.forEach((child, childIndex) =>
        visit(child, [...currentPath, 'conditions', childIndex]),
      );
    },
    not: (node: ConditionByKind<'not'>, currentPath: readonly (string | number)[]) => {
      visit(node.condition, [...currentPath, 'condition']);
    },
  } satisfies {
    [K in Condition['kind']]: (
      node: ConditionByKind<K>,
      currentPath: readonly (string | number)[],
    ) => void;
  };

  const visit = (node: Condition, currentPath: readonly (string | number)[]) => {
    const handler = handlers[node.kind] as (
      entry: Condition,
      currentHandlerPath: readonly (string | number)[],
    ) => void;
    handler(node, currentPath);
  };

  visit(condition, path);
};
