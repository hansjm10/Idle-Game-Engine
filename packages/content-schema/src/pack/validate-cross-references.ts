import { z } from 'zod';

import type { ParsedContentPack } from './schema.js';
import type { CrossReferenceContext } from './types.js';
import { toMutablePath } from './utils.js';
import {
  getIndexMap,
  type CrossReferenceState,
  type FormulaReferenceMaps,
  type IndexMap,
  type ReferenceIndexes,
  validateAchievements,
  validateAutomations,
  validateEntities,
  validateGenerators,
  validateMetrics,
  validatePrestigeLayers,
  validateResources,
  validateRuntimeEvents,
  validateTransforms,
  validateUpgrades,
} from './validators/index.js';

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
    map: IndexMap<unknown>,
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

  const indexes: ReferenceIndexes = {
    resources: resourceIndex,
    entities: entityIndex,
    generators: generatorIndex,
    upgrades: upgradeIndex,
    metrics: metricIndex,
    achievements: achievementIndex,
    automations: automationIndex,
    transforms: transformIndex,
    prestigeLayers: prestigeIndex,
  };

  const formulaMaps: FormulaReferenceMaps = {
    resources: resourceIndex,
    generators: generatorIndex,
    upgrades: upgradeIndex,
    automations: automationIndex,
    prestigeLayers: prestigeIndex,
  };

  const state: CrossReferenceState = {
    pack,
    ctx,
    context,
    indexes,
    formulaMaps,
    knownRuntimeEvents,
    runtimeEventSeverity,
    warn,
    ensureContentReference,
    ensureRuntimeEventKnown,
  };

  validateResources(state);
  validateEntities(state);
  validateRuntimeEvents(state);
  validateGenerators(state);
  validateUpgrades(state);
  validateMetrics(state);
  validateAchievements(state);
  validateAutomations(state);
  validateTransforms(state);
  validatePrestigeLayers(state);
};
