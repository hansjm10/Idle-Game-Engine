import type { z } from 'zod';

import type { ContentSchemaWarning } from '../../errors.js';
import type { ParsedContentPack } from '../schema.js';
import type { CrossReferenceContext } from '../types.js';

export type IndexEntry<Value> = { readonly index: number; readonly value: Value };
export type IndexMap<Value> = Map<string, IndexEntry<Value>>;

export type FormulaReferenceMaps = {
  resources: IndexMap<ParsedContentPack['resources'][number]>;
  generators: IndexMap<ParsedContentPack['generators'][number]>;
  upgrades: IndexMap<ParsedContentPack['upgrades'][number]>;
  automations: IndexMap<ParsedContentPack['automations'][number]>;
  prestigeLayers: IndexMap<ParsedContentPack['prestigeLayers'][number]>;
};

export type ReferenceIndexes = {
  resources: IndexMap<ParsedContentPack['resources'][number]>;
  entities: IndexMap<ParsedContentPack['entities'][number]>;
  generators: IndexMap<ParsedContentPack['generators'][number]>;
  upgrades: IndexMap<ParsedContentPack['upgrades'][number]>;
  metrics: IndexMap<ParsedContentPack['metrics'][number]>;
  achievements: IndexMap<ParsedContentPack['achievements'][number]>;
  automations: IndexMap<ParsedContentPack['automations'][number]>;
  transforms: IndexMap<ParsedContentPack['transforms'][number]>;
  prestigeLayers: IndexMap<ParsedContentPack['prestigeLayers'][number]>;
};

export type CrossReferenceState = {
  pack: ParsedContentPack;
  ctx: z.RefinementCtx;
  context: CrossReferenceContext;
  indexes: ReferenceIndexes;
  formulaMaps: FormulaReferenceMaps;
  knownRuntimeEvents: Set<string>;
  runtimeEventSeverity: 'error' | 'warning';
  warn: (warning: ContentSchemaWarning) => void;
  ensureContentReference: (
    map: IndexMap<unknown>,
    id: string,
    path: readonly (string | number)[],
    message: string,
  ) => void;
  ensureRuntimeEventKnown: (
    id: string,
    path: readonly (string | number)[],
    severity: 'error' | 'warning',
  ) => void;
};

export const getIndexMap = <Value extends { readonly id: string }>(
  values: readonly Value[],
): IndexMap<Value> => {
  const indexMap: IndexMap<Value> = new Map();
  values.forEach((value, index) => {
    indexMap.set(value.id, { index, value });
  });
  return indexMap;
};

