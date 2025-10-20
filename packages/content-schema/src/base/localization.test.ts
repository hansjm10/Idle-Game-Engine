import { describe, expect, it } from 'vitest';

import {
  LOCALIZATION_WARNING_CODES,
  localizedSummarySchema,
  localizedTextSchema,
  normalizeLocalizedText,
} from './localization.js';

describe('localization', () => {
  it('trims input and clones the variants map for localized text', () => {
    const first = localizedTextSchema.parse({
      default: ' Hello ',
    });
    expect(first.default).toBe('Hello');
    expect(first.variants).toEqual({});

    const second = localizedTextSchema.parse({
      default: 'Hello',
    });

    expect(first.variants).not.toBe(second.variants);
  });

  it('supports longer copy for summaries', () => {
    const longText = 'a'.repeat(300);
    const summary = localizedSummarySchema.parse({
      default: longText,
    });
    expect(summary.default).toBe(longText);
  });

  it('normalizes localized text and emits warnings for missing locales', () => {
    const warnings: { code: string }[] = [];
    const input = {
      default: 'Hello',
      variants: {},
    };

    const normalized = normalizeLocalizedText(input, {
      defaultLocale: 'en-US',
      supportedLocales: ['en-US', 'fr'],
      warningSink: (warning) => warnings.push(warning),
      path: ['title'],
    });

    expect(normalized.variants['en-US']).toBe('Hello');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe(LOCALIZATION_WARNING_CODES.missingVariant);
    expect(input.variants).toEqual({});
    expect(normalized.variants).not.toBe(input.variants);
  });

  it('emits a warning when the default locale variant diverges from the canonical default', () => {
    const warnings: { code: string }[] = [];
    normalizeLocalizedText(
      {
        default: 'Hello',
        variants: {
          'en-US': 'Different',
        },
      },
      {
        defaultLocale: 'en-US',
        warningSink: (warning) => warnings.push(warning),
      },
    );

    expect(warnings[0]?.code).toBe(
      LOCALIZATION_WARNING_CODES.defaultVariantMismatch,
    );
  });

  it('canonicalizes localization variant keys', () => {
    const warnings: { code: string }[] = [];
    const normalized = normalizeLocalizedText(
      {
        default: 'Howdy',
        variants: {
          'en-us': 'Howdy',
        },
      },
      {
        defaultLocale: 'en-US',
        supportedLocales: ['en-us'],
        warningSink: (warning) => warnings.push(warning),
      },
    );

    expect(Object.keys(normalized.variants)).toEqual(['en-US']);
    expect(normalized.variants['en-US']).toBe('Howdy');
    expect(warnings).toHaveLength(0);
  });
});
