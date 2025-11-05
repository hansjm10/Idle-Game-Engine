import semver from 'semver';
import { z } from 'zod';

const CONTENT_ID_PATTERN = /^[A-Za-z0-9][-./:\w]{0,63}$/;
const PACK_SLUG_PATTERN = /^(?:@[a-z0-9][a-z0-9\-._]*\/)?[a-z0-9][a-z0-9\-._]*$/;
const PACK_SLUG_SEPARATOR_PATTERN = /\/{2,}/g;
// IMPORTANT: Keep this list in sync with packages/core/src/system-automation-target-mapping.ts
// Synchronization is validated by system-automation-target-mapping.test.ts
const SYSTEM_AUTOMATION_TARGET_IDS = new Set<string>([
  'offline-catchup',
  'research-daemon',
]);

const normalizeContentId = (value: string): string =>
  value.trim().toLowerCase();

const normalizePackSlug = (value: string): string =>
  value
    .trim()
    .replace(PACK_SLUG_SEPARATOR_PATTERN, '/')
    .toLowerCase();

const canonicalizeLocale = (value: string, ctx: z.RefinementCtx): string => {
  try {
    const [canonical] = Intl.getCanonicalLocales(value);
    if (!canonical) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Unable to canonicalize locale code.',
      });
      return z.NEVER;
    }

    return canonical;
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        error instanceof RangeError
          ? 'Locale code must follow BCP-47 syntax.'
          : 'Invalid locale code.',
    });
    return z.NEVER;
  }
};

const validateSystemAutomationTarget = (
  value: string,
  ctx: z.RefinementCtx,
): string => {
  const canonical = normalizeContentId(value);
  if (SYSTEM_AUTOMATION_TARGET_IDS.has(canonical)) {
    return canonical;
  }

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: `Unknown system automation target id "${value}".`,
  });
  return z.NEVER;
};

const validateSemver = (value: string, ctx: z.RefinementCtx): string => {
  const cleaned = semver.clean(value.trim());
  if (cleaned) {
    return cleaned;
  }

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'Invalid semantic version.',
  });
  return z.NEVER;
};

const validateSemverRange = (value: string, ctx: z.RefinementCtx): string => {
  const normalized = value.trim();
  const range = semver.validRange(normalized, { includePrerelease: true });
  if (range) {
    return range;
  }

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'Invalid semantic version range.',
  });
  return z.NEVER;
};

export const packSlugSchema = z
  .string()
  .trim()
  .min(1, { message: 'Pack slug must contain at least one character.' })
  .max(64, { message: 'Pack slug must contain at most 64 characters.' })
  .transform(normalizePackSlug)
  .refine((value) => PACK_SLUG_PATTERN.test(value), {
    message:
      'Pack slug must match npm-style package syntax (optionally "@scope/name").',
  })
  .pipe(z.string().brand<'PackId'>());

export const localeCodeSchema = z
  .string()
  .trim()
  .min(2, { message: 'Locale code must contain at least two characters.' })
  .transform((value, ctx) => canonicalizeLocale(value, ctx))
  .pipe(z.string().brand<'LocaleCode'>());

const createContentSlugSchema = <Brand extends string>(label: string) =>
  z
    .string()
    .trim()
    .min(1, { message: `${label} must contain at least one character.` })
    .max(64, { message: `${label} must contain at most 64 characters.` })
    .regex(CONTENT_ID_PATTERN, {
      message: `${label} must start with an alphanumeric character and may include "-", "_", ".", "/", or ":" thereafter.`,
    })
    .transform(normalizeContentId)
    .pipe(z.string().brand<Brand>());

export const contentIdSchema =
  createContentSlugSchema<'ContentId'>('Content id');

export const flagIdSchema = createContentSlugSchema<'FlagId'>('Flag id');

export const scriptIdSchema = createContentSlugSchema<'ScriptId'>('Script id');

export const systemAutomationTargetIdSchema = z
  .string()
  .trim()
  .min(1, {
    message: 'System automation target id must contain at least one character.',
  })
  .transform((value, ctx) => validateSystemAutomationTarget(value, ctx))
  .pipe(z.string().brand<'SystemAutomationTargetId'>());

export const semverSchema = z
  .string()
  .trim()
  .min(1, { message: 'Semantic versions must not be empty.' })
  .transform((value, ctx) => validateSemver(value, ctx))
  .pipe(z.string().brand<'SemanticVersion'>());

export const semverRangeSchema = z
  .string()
  .trim()
  .min(1, { message: 'Semantic version ranges must not be empty.' })
  .transform((value, ctx) => validateSemverRange(value, ctx))
  .pipe(z.string().brand<'SemanticVersionRange'>());

export { SYSTEM_AUTOMATION_TARGET_IDS };
