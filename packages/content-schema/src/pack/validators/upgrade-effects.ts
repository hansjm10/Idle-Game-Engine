import { z } from 'zod';

import type { UpgradeEffect } from '../types.js';
import { toMutablePath } from '../utils.js';
import { assertAllowlisted } from './allowlists.js';
import { ensureFormulaReferencesAtPath } from './formulas.js';
import type { CrossReferenceState } from './state.js';

type UpgradeEffectByKind<K extends UpgradeEffect['kind']> = Extract<
  UpgradeEffect,
  { kind: K }
>;

export const validateUpgradeEffect = (
  state: Pick<
    CrossReferenceState,
    'ctx' | 'context' | 'indexes' | 'formulaMaps' | 'knownRuntimeEvents'
  >,
  effect: UpgradeEffect,
  path: readonly (string | number)[],
) => {
  const { ctx, context, indexes, formulaMaps, knownRuntimeEvents } = state;

  const ensureReference = (
    id: string,
    map: ReadonlyMap<string, unknown>,
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

  const handlers = {
    modifyResourceRate: (entry: UpgradeEffectByKind<'modifyResourceRate'>) => {
      ensureReference(
        entry.resourceId,
        indexes.resources,
        `Effect references unknown resource "${entry.resourceId}".`,
      );
      ensureFormulaReferencesAtPath(entry.value, path, ctx, formulaMaps);
    },
    modifyResourceCapacity: (entry: UpgradeEffectByKind<'modifyResourceCapacity'>) => {
      ensureReference(
        entry.resourceId,
        indexes.resources,
        `Effect references unknown resource "${entry.resourceId}".`,
      );
      ensureFormulaReferencesAtPath(entry.value, path, ctx, formulaMaps);
    },
    unlockResource: (entry: UpgradeEffectByKind<'unlockResource'>) => {
      ensureReference(
        entry.resourceId,
        indexes.resources,
        `Effect references unknown resource "${entry.resourceId}".`,
      );
    },
    alterDirtyTolerance: (entry: UpgradeEffectByKind<'alterDirtyTolerance'>) => {
      ensureReference(
        entry.resourceId,
        indexes.resources,
        `Effect references unknown resource "${entry.resourceId}".`,
      );
      ensureFormulaReferencesAtPath(entry.value, path, ctx, formulaMaps);
    },
    modifyGeneratorRate: (entry: UpgradeEffectByKind<'modifyGeneratorRate'>) => {
      ensureReference(
        entry.generatorId,
        indexes.generators,
        `Effect references unknown generator "${entry.generatorId}".`,
      );
      ensureFormulaReferencesAtPath(entry.value, path, ctx, formulaMaps);
    },
    modifyGeneratorCost: (entry: UpgradeEffectByKind<'modifyGeneratorCost'>) => {
      ensureReference(
        entry.generatorId,
        indexes.generators,
        `Effect references unknown generator "${entry.generatorId}".`,
      );
      ensureFormulaReferencesAtPath(entry.value, path, ctx, formulaMaps);
    },
    modifyGeneratorConsumption: (
      entry: UpgradeEffectByKind<'modifyGeneratorConsumption'>,
    ) => {
      ensureReference(
        entry.generatorId,
        indexes.generators,
        `Effect references unknown generator "${entry.generatorId}".`,
      );
      if (entry.resourceId !== undefined) {
        ensureReference(
          entry.resourceId,
          indexes.resources,
          `Effect references unknown resource "${entry.resourceId}".`,
        );
      }
      ensureFormulaReferencesAtPath(entry.value, path, ctx, formulaMaps);
    },
    unlockGenerator: (entry: UpgradeEffectByKind<'unlockGenerator'>) => {
      ensureReference(
        entry.generatorId,
        indexes.generators,
        `Effect references unknown generator "${entry.generatorId}".`,
      );
    },
    grantAutomation: (entry: UpgradeEffectByKind<'grantAutomation'>) => {
      ensureReference(
        entry.automationId,
        indexes.automations,
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
      if (!knownRuntimeEvents.has(entry.eventId)) {
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
