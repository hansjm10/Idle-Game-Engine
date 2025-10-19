import { z } from 'zod';

import { ContentSchemaError, ContentSchemaWarning } from './errors.js';

/**
 * Placeholder schema representing the top-level content pack contract.
 */
export const contentPackSchema = z.object({}).passthrough();

export type NormalizedContentPack = unknown;

export interface ContentPackValidationResult {
  readonly pack: NormalizedContentPack;
  readonly warnings: readonly ContentSchemaWarning[];
}

export interface ContentPackValidator {
  parse(input: unknown): ContentPackValidationResult;
}

export const createContentPackValidator = (): ContentPackValidator => ({
  parse(input) {
    const result = contentPackSchema.safeParse(input);
    if (!result.success) {
      throw new ContentSchemaError(result.error.message);
    }

    return {
      pack: result.data as NormalizedContentPack,
      warnings: [],
    };
  },
});

export const parseContentPack = (input: unknown): ContentPackValidationResult => {
  const validator = createContentPackValidator();
  return validator.parse(input);
};
