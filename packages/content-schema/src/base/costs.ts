import { z } from 'zod';

import { numericFormulaSchema } from './formulas.js';
import { contentIdSchema } from './ids.js';
import { nonNegativeNumberSchema } from './numbers.js';

export const costEntrySchema = z
  .object({
    resourceId: contentIdSchema,
    costMultiplier: nonNegativeNumberSchema,
    costCurve: numericFormulaSchema,
  })
  .strict();

export type CostEntry = z.infer<typeof costEntrySchema>;
export type CostEntryInput = z.input<typeof costEntrySchema>;

export const normalizeCostEntries = (
  entries: readonly CostEntry[],
): readonly CostEntry[] =>
  Object.freeze(
    [...entries].sort((left, right) =>
      left.resourceId.localeCompare(right.resourceId),
    ),
  );

export const ensureUniqueCostEntries = (
  entries: readonly CostEntry[],
  ctx: z.RefinementCtx,
  path: readonly (string | number)[],
): void => {
  const seen = new Map<string, number>();
  entries.forEach((entry, index) => {
    const existing = seen.get(entry.resourceId);
    if (existing !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, index, 'resourceId'],
        message: `Duplicate cost resource "${entry.resourceId}" also declared at index ${existing}.`,
      });
      return;
    }
    seen.set(entry.resourceId, index);
  });
};

