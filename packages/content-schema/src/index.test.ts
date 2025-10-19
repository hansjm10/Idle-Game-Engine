import { describe, expect, it } from 'vitest';

import {
  ContentSchemaError,
  contentPackSchema,
  createContentPackValidator,
  parseContentPack,
} from './index.js';

describe('content-schema scaffolding', () => {
  it('exposes a placeholder content pack schema', () => {
    expect(contentPackSchema.safeParse({ success: true }).success).toBe(true);
    expect(contentPackSchema.safeParse(null).success).toBe(false);
  });

  it('returns the parsed pack and warnings array', () => {
    const result = parseContentPack({ id: 'placeholder-pack' });
    expect(result.pack).toEqual({ id: 'placeholder-pack' });
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('throws ContentSchemaError on invalid input', () => {
    const validator = createContentPackValidator();
    expect(() => validator.parse(null)).toThrow(ContentSchemaError);
  });
});
