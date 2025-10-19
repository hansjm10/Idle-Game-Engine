import { z } from 'zod';

import type { ContentSchemaWarning } from '../errors.js';
import { localeCodeSchema } from './ids.js';

const TEXT_MAX_LENGTH = 256;
const SUMMARY_MAX_LENGTH = 512;

export const LOCALIZATION_WARNING_CODES = {
  defaultVariantMismatch: 'localization.defaultLocaleMismatch',
  missingVariant: 'localization.missingVariant',
} as const;

const createLocalizedStringSchema = (maxLength: number) =>
  z
    .string()
    .trim()
    .min(1, { message: 'Localized text must contain at least one character.' })
    .max(maxLength, {
      message: `Localized text must contain at most ${maxLength} characters.`,
    });

const cloneVariants = (value: LocalizedVariants): LocalizedVariants => {
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value)) as LocalizedVariants;
};

const emitWarning = (
  warningSink: ((warning: ContentSchemaWarning) => void) | undefined,
  warning: ContentSchemaWarning,
) => {
  if (warningSink) {
    warningSink(warning);
  }
};

const localizedScalarSchema = createLocalizedStringSchema(TEXT_MAX_LENGTH);

export const localizedStringSchema = localizedScalarSchema;
export const localizationMapSchema = z.record(
  localeCodeSchema,
  localizedScalarSchema,
);

type LocaleCode = z.infer<typeof localeCodeSchema>;
type LocalizedVariants = Partial<Record<LocaleCode, string>>;

export const localizedTextSchema = z
  .object({
    default: localizedScalarSchema,
    variants: z
      .record(localeCodeSchema, localizedScalarSchema)
      .default({})
      .transform((value) => cloneVariants(value)),
  })
  .strict();

export const localizedSummarySchema = z
  .object({
    default: createLocalizedStringSchema(SUMMARY_MAX_LENGTH),
    variants: z
      .record(localeCodeSchema, createLocalizedStringSchema(SUMMARY_MAX_LENGTH))
      .default({})
      .transform((value) => cloneVariants(value)),
  })
  .strict();

export type LocalizedText = z.infer<typeof localizedTextSchema>;
export type LocalizedSummary = z.infer<typeof localizedSummarySchema>;

export interface NormalizeLocalizedTextOptions {
  readonly defaultLocale: string;
  readonly supportedLocales?: readonly string[];
  readonly path?: readonly (string | number)[];
  readonly warningSink?: (warning: ContentSchemaWarning) => void;
}

type LocalizedContent = {
  readonly default: string;
  variants: LocalizedVariants;
};

const withDefaultLocale = (
  localized: LocalizedContent,
  defaultLocale: LocaleCode,
  warningSink: ((warning: ContentSchemaWarning) => void) | undefined,
  path: readonly (string | number)[],
) => {
  const existing = localized.variants[defaultLocale];
  if (existing === undefined) {
    localized.variants[defaultLocale] = localized.default;
    return;
  }

  if (existing !== localized.default) {
    emitWarning(warningSink, {
      code: LOCALIZATION_WARNING_CODES.defaultVariantMismatch,
      message: `Default locale "${defaultLocale}" variant differs from the canonical default string.`,
      path,
      severity: 'warning',
      suggestion:
        'Align the default variant with the canonical default string or suppress the variant if differences are intentional.',
    });
  }
};

const warnMissingLocales = (
  localized: LocalizedContent,
  supportedLocales: readonly LocaleCode[],
  defaultLocale: LocaleCode,
  warningSink: ((warning: ContentSchemaWarning) => void) | undefined,
  path: readonly (string | number)[],
) => {
  const normalizedLocales = new Set(supportedLocales);
  normalizedLocales.delete(defaultLocale);

  for (const locale of normalizedLocales) {
    if (locale in localized.variants) {
      continue;
    }

    emitWarning(warningSink, {
      code: LOCALIZATION_WARNING_CODES.missingVariant,
      message: `Missing localized string for locale "${locale}".`,
      path,
      severity: 'warning',
      suggestion: 'Add a localized variant for the missing locale.',
    });
  }
};

export const normalizeLocalizedText = <
  Localized extends LocalizedContent = LocalizedText,
>(
  localized: Localized,
  options: NormalizeLocalizedTextOptions,
): Localized => {
  const { defaultLocale, supportedLocales = [], warningSink, path = [] } =
    options;

  const canonicalDefaultLocale = localeCodeSchema.parse(defaultLocale);
  const canonicalSupportedLocales = supportedLocales.map((locale) =>
    localeCodeSchema.parse(locale),
  );

  const variants = cloneVariants(localized.variants);
  const normalized: LocalizedContent = {
    ...localized,
    variants,
  };

  withDefaultLocale(normalized, canonicalDefaultLocale, warningSink, path);
  warnMissingLocales(
    normalized,
    canonicalSupportedLocales,
    canonicalDefaultLocale,
    warningSink,
    path,
  );

  return normalized as Localized;
};
