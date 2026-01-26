import { z } from 'zod';

import { contentIdSchema } from '../base/ids.js';

export type FontTechnique = 'msdf';

export type CodePointRange = [number, number];

export interface FontAsset {
  readonly id: z.infer<typeof contentIdSchema>;
  readonly source: string;
  readonly baseSizePx: number;
  readonly codePointRanges: readonly CodePointRange[];
  readonly technique: FontTechnique;
  readonly msdf: {
    readonly pxRange: number;
  };
  readonly fallbackCodePoint?: number;
}

const MAX_UNICODE_CODE_POINT = 0x10ffff;

const codePointSchema = z
  .number()
  .int()
  .min(0, { message: 'Code points must be non-negative.' })
  .max(MAX_UNICODE_CODE_POINT, {
    message: `Code points must be <= 0x${MAX_UNICODE_CODE_POINT.toString(16)}.`,
  });

const surrogateRangeSchema = z
  .number()
  .int()
  .refine((value) => value < 0xd800 || value > 0xdfff, {
    message: 'Code points must not fall within the UTF-16 surrogate range.',
  });

const unicodeScalarSchema = codePointSchema.and(surrogateRangeSchema);

function isSafeRelativePosixPath(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  if (value.startsWith('/')) {
    return false;
  }
  if (value.includes('\\')) {
    return false;
  }
  if (/^[a-zA-Z]:\//.test(value)) {
    return false;
  }

  const segments = value.split('/');
  if (segments.includes('..')) {
    return false;
  }

  return true;
}

const fontSourceSchema = z
  .string()
  .trim()
  .min(1, { message: 'Font source must not be empty.' })
  .refine((value) => isSafeRelativePosixPath(value), {
    message:
      'Font source must be a safe relative POSIX path (no absolute paths, backslashes, or ".." segments).',
  })
  .refine((value) => /\.(ttf|otf|woff2?)$/i.test(value), {
    message: 'Font source must end with .ttf, .otf, .woff, or .woff2.',
  });

const baseSizePxSchema = z
  .number()
  .int()
  .min(1, { message: 'Font baseSizePx must be >= 1.' })
  .max(512, { message: 'Font baseSizePx must be <= 512.' });

const codePointRangeSchema: z.ZodType<CodePointRange, z.ZodTypeDef, unknown> = z
  .tuple([unicodeScalarSchema, unicodeScalarSchema])
  .superRefine(([start, end], ctx) => {
    if (start > end) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Code point range start must be <= end.',
      });
    }
    if (start <= 0xdfff && end >= 0xd800) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Code point ranges must not include the UTF-16 surrogate range.',
      });
    }
  });

const DEFAULT_CODE_POINT_RANGES: readonly CodePointRange[] = Object.freeze([[32, 126] as CodePointRange]);

function normalizeCodePointRanges(ranges: readonly CodePointRange[]): readonly CodePointRange[] {
  if (ranges.length === 0) {
    return DEFAULT_CODE_POINT_RANGES;
  }

  const sorted = [...ranges].sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged: CodePointRange[] = [];

  for (const range of sorted) {
    const [start, end] = range;
    const lastIndex = merged.length - 1;
    const last = merged.slice(-1)[0];
    if (!last) {
      merged.push([start, end]);
      continue;
    }

    const [lastStart, lastEnd] = last;
    if (start <= lastEnd + 1) {
      merged[lastIndex] = [lastStart, Math.max(lastEnd, end)];
      continue;
    }

    merged.push([start, end]);
  }

  return Object.freeze(merged);
}

const codePointRangesSchema = z
  .array(codePointRangeSchema)
  .optional()
  .default(() => [...DEFAULT_CODE_POINT_RANGES])
  .transform((ranges) => normalizeCodePointRanges(ranges));

const msdfConfigSchema = z
  .object({
    pxRange: z
      .number()
      .int()
      .min(1, { message: 'msdf.pxRange must be >= 1.' })
      .max(32, { message: 'msdf.pxRange must be <= 32.' })
      .default(3),
  })
  .strict()
  .default({ pxRange: 3 });

const fontAssetSchema: z.ZodType<FontAsset, z.ZodTypeDef, unknown> = z
  .object({
    id: contentIdSchema,
    source: fontSourceSchema,
    baseSizePx: baseSizePxSchema,
    codePointRanges: codePointRangesSchema,
    technique: z.literal('msdf').default('msdf'),
    msdf: msdfConfigSchema,
    fallbackCodePoint: unicodeScalarSchema.optional(),
  })
  .strict();

export const fontCollectionSchema = z
  .array(fontAssetSchema)
  .superRefine((fonts, ctx) => {
    const seen = new Map<string, number>();
    fonts.forEach((font, index) => {
      const existingIndex = seen.get(font.id);
      if (existingIndex === undefined) {
        seen.set(font.id, index);
        return;
      }

      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, 'id'],
        message: `Duplicate font id "${font.id}" also defined at index ${existingIndex}.`,
      });
    });
  })
  .transform((fonts) =>
    Object.freeze(
      [...fonts].sort((left, right) => left.id.localeCompare(right.id)),
    ),
  );
