import { z } from 'zod';

import {
  localeCodeSchema,
  packSlugSchema,
  semverRangeSchema,
  semverSchema,
} from '../base/ids.js';
import {
  localizedSummarySchema,
  localizedTextSchema,
  normalizeLocalizedText,
  type LocalizedSummary,
  type LocalizedText,
} from '../base/localization.js';
import { dependencyCollectionSchema } from './dependencies.js';

const AUTHOR_MAX_LENGTH = 64;
const TAG_MAX_LENGTH = 24;
const LINK_LABEL_MAX_LENGTH = 48;
const LINK_KIND_MAX_LENGTH = 32;

const authorSchema = z
  .string()
  .trim()
  .min(1, { message: 'Author names must contain at least one character.' })
  .max(AUTHOR_MAX_LENGTH, {
    message: `Author names must contain at most ${AUTHOR_MAX_LENGTH} characters.`,
  });

const tagSchema = z
  .string()
  .trim()
  .min(1, { message: 'Tags must contain at least one character.' })
  .max(TAG_MAX_LENGTH, {
    message: `Tags must contain at most ${TAG_MAX_LENGTH} characters.`,
  })
  .regex(/^[a-z0-9][a-z0-9/_:-]*$/i, {
    message:
      'Tags must start with an alphanumeric character and may include "-", "_", ":", or "/" thereafter.',
  })
  .transform((value) => value.toLowerCase());

const isoDateSchema = z
  .string()
  .trim()
  .min(1, { message: 'ISO date fields must not be empty.' })
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'Date must follow ISO-8601 format.',
  });

const linkKindSchema = z
  .string()
  .trim()
  .min(1, { message: 'Link kind must contain at least one character.' })
  .max(LINK_KIND_MAX_LENGTH, {
    message: `Link kind must contain at most ${LINK_KIND_MAX_LENGTH} characters.`,
  })
  .regex(/^[a-z][a-z0-9-]*$/i, {
    message: 'Link kind must be a slug (letters, numbers, and "-").',
  })
  .transform((value) => value.toLowerCase());

const linkLabelSchema = z
  .string()
  .trim()
  .min(1, { message: 'Link label must contain at least one character.' })
  .max(LINK_LABEL_MAX_LENGTH, {
    message: `Link label must contain at most ${LINK_LABEL_MAX_LENGTH} characters.`,
  });

const linkSchema = z
  .object({
    kind: linkKindSchema,
    label: linkLabelSchema,
    href: z.string().trim().url({
      message: 'Links must provide a valid URL.',
    }),
  })
  .strict();

const offlineProgressionPreconditionsSchema = z
  .object({
    constantRates: z.boolean(),
    noUnlocks: z.boolean(),
    noAchievements: z.boolean(),
    noAutomation: z.boolean(),
    modeledResourceBounds: z.boolean(),
  })
  .strict();

const offlineProgressionSchema = z
  .object({
    mode: z.literal('constant-rates').optional(),
    preconditions: offlineProgressionPreconditionsSchema,
  })
  .strict();

const sortCaseInsensitive = (values: readonly string[]): string[] =>
  [...values].sort((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: 'base' }),
  );

const dedupeByKey = <Value>(
  values: readonly Value[],
  key: (value: Value) => string,
): Value[] => {
  const seen = new Set<string>();
  const result: Value[] = [];
  for (const value of values) {
    const identifier = key(value);
    if (seen.has(identifier)) {
      continue;
    }
    seen.add(identifier);
    result.push(value);
  }
  return result;
};

const sortLocales = (locales: readonly string[]): string[] =>
  [...locales].sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true }),
  );

const normalizeAuthors = (authors: readonly string[]): readonly string[] =>
  Object.freeze(sortCaseInsensitive(dedupeByKey(authors, (value) => value.toLowerCase())));

const normalizeTags = (tags: readonly string[]): readonly string[] =>
  Object.freeze(dedupeByKey(tags, (value) => value).sort((left, right) =>
    left.localeCompare(right),
  ));

const normalizeLocales = (locales: readonly string[]): readonly string[] =>
  Object.freeze(sortLocales(dedupeByKey(locales, (value) => value)));

const normalizeLinks = (
  links: readonly MetadataLink[],
): readonly MetadataLink[] =>
  Object.freeze(
    dedupeByKey(links, (link) => link.href).sort((left, right) => {
      const typeCompare = left.kind.localeCompare(right.kind);
      if (typeCompare !== 0) {
        return typeCompare;
      }
      return left.label.localeCompare(right.label);
    }),
  );

const normalizeTitle = (
  title: LocalizedText,
  defaultLocale: string,
  supportedLocales: readonly string[],
): LocalizedText =>
  normalizeLocalizedText(title, {
    defaultLocale,
    supportedLocales,
    path: ['title'],
  });

const normalizeSummary = (
  summary: LocalizedSummary | undefined,
  defaultLocale: string,
  supportedLocales: readonly string[],
): LocalizedSummary | undefined =>
  summary
    ? normalizeLocalizedText(summary, {
        defaultLocale,
        supportedLocales,
        path: ['summary'],
      })
    : undefined;

const ensureDefaultLocalePresent = (
  metadata: { readonly defaultLocale: string; readonly supportedLocales: readonly string[] },
  ctx: z.RefinementCtx,
) => {
  const supportedLocales = new Set(metadata.supportedLocales);
  const defaultLocale = metadata.defaultLocale;
  if (!supportedLocales.has(defaultLocale)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['supportedLocales'],
      message: `Supported locales must include default locale "${defaultLocale}".`,
    });
  }
};

const ensureDependenciesExcludeSelf = (
  metadata: { readonly id: string; readonly dependencies?: z.infer<typeof dependencyCollectionSchema> },
  ctx: z.RefinementCtx,
) => {
  const dependencies = metadata.dependencies;
  if (!dependencies) {
    return;
  }
  const packId = metadata.id;
  const { requires = [], optional = [], conflicts = [] } = dependencies;
  const collisions = [
    ...requires.filter((entry) => entry.packId === packId).map(() => 'requires'),
    ...optional.filter((entry) => entry.packId === packId).map(() => 'optional'),
    ...conflicts.filter((entry) => entry.packId === packId).map(() => 'conflicts'),
  ];
  collisions.forEach((kind) => {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['dependencies', kind],
      message: `Pack "${packId}" cannot declare a ${kind} dependency on itself.`,
    });
  });
};

type MetadataLink = z.infer<typeof linkSchema>;
const baseMetadataSchema = z
  .object({
    id: packSlugSchema,
    title: localizedTextSchema,
    summary: localizedSummarySchema.optional(),
    version: semverSchema,
    engine: semverRangeSchema,
    authors: z.array(authorSchema).default([]),
    defaultLocale: localeCodeSchema,
    supportedLocales: z
      .array(localeCodeSchema)
      .min(1, { message: 'Supported locales must include at least one locale.' }),
    tags: z.array(tagSchema).default([]),
    links: z.array(linkSchema).default([]),
    createdAt: isoDateSchema.optional(),
    updatedAt: isoDateSchema.optional(),
    visibility: z.enum(['public', 'private', 'experimental'] as const).optional(),
    offlineProgression: offlineProgressionSchema.optional(),
    dependencies: dependencyCollectionSchema.optional(),
  })
  .strict()
  .superRefine((metadata, ctx) => {
    ensureDefaultLocalePresent(metadata, ctx);
    ensureDependenciesExcludeSelf(metadata, ctx);
  });

type ParsedMetadata = z.infer<typeof baseMetadataSchema>;

export const metadataSchema = baseMetadataSchema.transform((metadata) => {
  const supportedLocales = normalizeLocales(metadata.supportedLocales);
  const normalizedTitle = normalizeTitle(
    metadata.title,
    metadata.defaultLocale,
    supportedLocales,
  );
  const normalizedSummary = normalizeSummary(
    metadata.summary,
    metadata.defaultLocale,
    supportedLocales,
  );
  const normalized = {
    ...metadata,
    title: normalizedTitle,
    summary: normalizedSummary,
    authors: normalizeAuthors(metadata.authors),
    supportedLocales,
    tags: normalizeTags(metadata.tags),
    links: normalizeLinks(metadata.links),
  } as ParsedMetadata;
  return normalized;
});

export type Metadata = z.infer<typeof metadataSchema>;
