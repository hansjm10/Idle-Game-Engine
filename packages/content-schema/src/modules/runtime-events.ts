import { z } from 'zod';

import { contentIdSchema } from '../base/ids.js';
import { positiveIntSchema } from '../base/numbers.js';

type ContentId = z.infer<typeof contentIdSchema>;

const normalizeTag = (value: string): string =>
  value
    .trim()
    .toLowerCase();

const tagSchema = z
  .string()
  .trim()
  .min(1, { message: 'Tags must contain at least one character.' })
  .max(32, { message: 'Tags must contain at most 32 characters.' })
  .regex(/^[a-z0-9][a-z0-9/_:-]*$/i, {
    message:
      'Tags must start with an alphanumeric character and may include "-", "_", ":", or "/" thereafter.',
  })
  .transform((value) => normalizeTag(value));

const namespaceSchema = z
  .string()
  .trim()
  .min(1, { message: 'Namespace must contain at least one character.' })
  .max(32, { message: 'Namespace must contain at most 32 characters.' })
  .regex(/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/i, {
    message:
      'Namespace must start and end with an alphanumeric character and may include "-", "_" in between.',
  })
  .transform((value) => value.toLowerCase());

const nameSchema = z
  .string()
  .trim()
  .min(1, { message: 'Name must contain at least one character.' })
  .max(48, { message: 'Name must contain at most 48 characters.' })
  .regex(/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/i, {
    message:
      'Name must start and end with an alphanumeric character and may include "-", "_" in between.',
  })
  .transform((value) => value.toLowerCase());

const normalizeRelativePath = (value: string): string =>
  value.replace(/\\/g, '/').replace(/\/{2,}/g, '/');

const schemaPathSchema = z
  .string()
  .trim()
  .min(1, { message: 'Schema path must not be empty.' })
  .max(256, { message: 'Schema path must contain at most 256 characters.' })
  .transform((value) => normalizeRelativePath(value))
  .superRefine((value, ctx) => {
    if (
      value.startsWith('/') ||
      value.startsWith('~') ||
      (value.startsWith('./') && value === './') ||
      value === '.'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Schema path must be pack-relative and must not be absolute.',
      });
      return;
    }

    if (/^[a-zA-Z]:/.test(value) || value.startsWith('\\\\')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Schema path must not use absolute drive references.',
      });
      return;
    }

    const segments = value.split('/');
    if (segments.some((segment) => segment === '..')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Schema path must not traverse parent directories.',
      });
    }
  });

const payloadSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('zod'),
      schemaPath: schemaPathSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('json-schema'),
      schemaPath: schemaPathSchema,
    })
    .strict(),
]);

const emitterReferenceSchema = z
  .object({
    source: z.enum(['achievement', 'upgrade', 'transform', 'script'] as const),
    id: contentIdSchema,
  })
  .strict();

const dedupeAndSortTags = (values: readonly string[]): readonly string[] => {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const entry of values) {
    if (!seen.has(entry)) {
      seen.add(entry);
      deduped.push(entry);
    }
  }

  deduped.sort((left, right) => left.localeCompare(right));
  return Object.freeze(deduped);
};

const toCanonicalRuntimeEventId = (
  input: { namespace: string; name: string },
  ctx: z.RefinementCtx,
): ContentId | null => {
  const candidateId = `${input.namespace}:${input.name}`;
  const parsed = contentIdSchema.safeParse(candidateId);
  if (!parsed.success) {
    parsed.error.issues.forEach((issue) => {
      ctx.addIssue({
        ...issue,
        path: ['namespace'],
      });
    });
    return null;
  }

  return parsed.data;
};

type RuntimeEventContributionPayload = z.infer<typeof payloadSchema>;
type RuntimeEventContributionPayloadInput = z.input<typeof payloadSchema>;
type RuntimeEventEmitterReference = z.infer<typeof emitterReferenceSchema>;
type RuntimeEventEmitterReferenceInput = z.input<typeof emitterReferenceSchema>;

type RuntimeEventContributionModel = {
  readonly id: ContentId;
  readonly namespace: string;
  readonly name: string;
  readonly version: number;
  readonly payload: RuntimeEventContributionPayload;
  readonly emits: readonly RuntimeEventEmitterReference[];
  readonly tags: readonly string[];
};

type RuntimeEventContributionInput = {
  readonly id?: string;
  readonly namespace: string;
  readonly name: string;
  readonly version: number;
  readonly payload: RuntimeEventContributionPayloadInput;
  readonly emits?: readonly RuntimeEventEmitterReferenceInput[];
  readonly tags?: readonly z.input<typeof tagSchema>[];
};

export const runtimeEventContributionSchema: z.ZodType<
  RuntimeEventContributionModel,
  z.ZodTypeDef,
  RuntimeEventContributionInput
> = z
  .object({
    id: z
      .string()
      .trim()
      .min(1, { message: 'Id must contain at least one character.' })
      .max(128, { message: 'Id must contain at most 128 characters.' })
      .optional(),
    namespace: namespaceSchema,
    name: nameSchema,
    version: positiveIntSchema,
    payload: payloadSchema,
    emits: z.array(emitterReferenceSchema).optional(),
    tags: z.array(tagSchema).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const canonicalId = toCanonicalRuntimeEventId(value, ctx);
    if (!canonicalId) {
      return;
    }

    if (value.id !== undefined) {
      const providedId = value.id.trim().toLowerCase();
      if (providedId !== canonicalId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Runtime event id must match the canonical namespace:name form "${canonicalId}".`,
          path: ['id'],
        });
      }
    }
  })
  .transform((value) => {
    const canonicalId = contentIdSchema.parse(
      `${value.namespace}:${value.name}`,
    );

    const emits = value.emits
      ? Object.freeze(
          value.emits.map((emitter) =>
            Object.freeze({
              source: emitter.source,
              id: emitter.id,
            } as const),
          ),
        )
      : Object.freeze<RuntimeEventContributionModel['emits']>([]);
    const tags = value.tags
      ? dedupeAndSortTags(value.tags.map((tag) => normalizeTag(tag)))
      : Object.freeze<string[]>([]);

    const normalizedPayload =
      value.payload.kind === 'zod'
        ? Object.freeze({
            kind: value.payload.kind,
            schemaPath: value.payload.schemaPath,
          } as const)
        : Object.freeze({
            kind: value.payload.kind,
            schemaPath: value.payload.schemaPath,
          } as const);

    return Object.freeze({
      id: canonicalId,
      namespace: value.namespace,
      name: value.name,
      version: value.version,
      payload: normalizedPayload,
      emits,
      tags,
    });
  });

export type RuntimeEventContribution = z.infer<
  typeof runtimeEventContributionSchema
>;

export const runtimeEventContributionCollectionSchema = z
  .array(runtimeEventContributionSchema)
  .superRefine((contributions, ctx) => {
    const seen = new Map<ContentId, number>();
    contributions.forEach((contribution, index) => {
      const existing = seen.get(contribution.id);
      if (existing !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'id'],
          message: `Duplicate runtime event id "${contribution.id}" also defined at index ${existing}.`,
        });
        return;
      }
      seen.set(contribution.id, index);
    });
  })
  .transform((contributions) =>
    Object.freeze(
      [...contributions].sort((left, right) => left.id.localeCompare(right.id)),
    ),
  );

export type RuntimeEventContributionCollection = z.infer<
  typeof runtimeEventContributionCollectionSchema
>;
