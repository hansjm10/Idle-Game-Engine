import { z } from 'zod';

import { contentIdSchema, scriptIdSchema } from '../base/ids.js';
import {
  localizedSummarySchema,
  localizedTextSchema,
} from '../base/localization.js';
import { finiteNumberSchema } from '../base/numbers.js';

type MetricKind = 'counter' | 'gauge' | 'histogram' | 'upDownCounter';
type MetricAggregation = 'sum' | 'delta' | 'cumulative' | 'distribution';

const ATTRIBUTE_KEY_MAX_LENGTH = 16;
const ATTRIBUTE_WARNING_THRESHOLD = 3;
const UNIT_MAX_LENGTH = 32;

const ASCII_PRINTABLE_PATTERN = /^[\x20-\x7E]*$/;
const ATTRIBUTE_KEY_PATTERN = /^[a-z0-9][a-z0-9/_:-]*$/i;

const attributeKeySchema = z
  .string()
  .trim()
  .min(1, {
    message: 'Metric attribute keys must contain at least one character.',
  })
  .max(ATTRIBUTE_KEY_MAX_LENGTH, {
    message: `Metric attribute keys must contain at most ${ATTRIBUTE_KEY_MAX_LENGTH} characters.`,
  })
  .regex(ATTRIBUTE_KEY_PATTERN, {
    message:
      'Metric attribute keys must start with an alphanumeric character and may include "-", "_", ":", or "/" thereafter.',
  })
  .transform((value) => value.toLowerCase());

const metricSourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('runtime'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('script'),
      scriptId: scriptIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('content'),
    })
    .strict(),
]);

type MetricSource = z.infer<typeof metricSourceSchema>;
type MetricSourceInput = z.input<typeof metricSourceSchema>;

const unitSchema = z
  .string()
  .trim()
  .max(UNIT_MAX_LENGTH, {
    message: `Metric units must contain at most ${UNIT_MAX_LENGTH} characters.`,
  })
  .regex(ASCII_PRINTABLE_PATTERN, {
    message: 'Metric units must contain printable ASCII characters.',
  })
  .transform((unit) => (unit.length === 0 ? '1' : unit))
  .default('1');

type MetricDefinitionInput = {
  readonly id: z.input<typeof contentIdSchema>;
  readonly name: z.input<typeof localizedTextSchema>;
  readonly description?: z.input<typeof localizedSummarySchema>;
  readonly kind: MetricKind;
  readonly unit?: string;
  readonly aggregation?: MetricAggregation;
  readonly attributes?: readonly z.input<typeof attributeKeySchema>[];
  readonly source: MetricSourceInput;
  readonly order?: z.input<typeof finiteNumberSchema>;
};

type ContentId = z.infer<typeof contentIdSchema>;

type MetricDefinitionModel = {
  readonly id: ContentId;
  readonly name: z.infer<typeof localizedTextSchema>;
  readonly description?: z.infer<typeof localizedSummarySchema>;
  readonly kind: MetricKind;
  readonly unit: string;
  readonly aggregation?: MetricAggregation;
  readonly attributes: readonly string[];
  readonly source: MetricSource;
  readonly order?: number;
};

const normalizeAttributes = (attributes: readonly string[]): readonly string[] =>
  Object.freeze(
    [...new Set(attributes)].sort((left, right) => left.localeCompare(right)),
  );

const compareOrderable = (
  left: MetricDefinitionModel,
  right: MetricDefinitionModel,
) => {
  const leftOrder =
    left.order === undefined ? Number.POSITIVE_INFINITY : left.order;
  const rightOrder =
    right.order === undefined ? Number.POSITIVE_INFINITY : right.order;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return left.id.localeCompare(right.id);
};

export const metricDefinitionSchema: z.ZodType<
  MetricDefinitionModel,
  z.ZodTypeDef,
  MetricDefinitionInput
> = z
  .object({
    id: contentIdSchema,
    name: localizedTextSchema,
    description: localizedSummarySchema.optional(),
    kind: z.enum(['counter', 'gauge', 'histogram', 'upDownCounter'] as const),
    unit: unitSchema,
    aggregation: z
      .enum(['sum', 'delta', 'cumulative', 'distribution'] as const)
      .optional(),
    attributes: z.array(attributeKeySchema).default([]),
    source: metricSourceSchema,
    order: finiteNumberSchema.optional(),
  })
  .strict()
  .superRefine((metric, ctx) => {
    if (metric.kind === 'histogram' && metric.aggregation === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['aggregation'],
        message: 'Histogram metrics must declare an aggregation strategy.',
      });
    }

    if (metric.attributes.length > ATTRIBUTE_WARNING_THRESHOLD) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attributes'],
        message: `Metrics may declare at most ${ATTRIBUTE_WARNING_THRESHOLD} attribute keys to preserve low-cardinality instrumentation.`,
      });
    }
  })
  .transform((metric) => ({
    ...metric,
    attributes: normalizeAttributes(metric.attributes),
  }));

export const metricCollectionSchema = z
  .array(metricDefinitionSchema)
  .superRefine((metrics, ctx) => {
    const seen = new Map<string, number>();
    metrics.forEach((metric, index) => {
      const existingIndex = seen.get(metric.id);
      if (existingIndex !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'id'],
          message: `Duplicate metric id "${metric.id}" also defined at index ${existingIndex}.`,
        });
        return;
      }
      seen.set(metric.id, index);
    });
  })
  .transform((metrics) =>
    Object.freeze([...metrics].sort((left, right) => compareOrderable(left, right))),
  );

export type MetricDefinition = z.infer<typeof metricDefinitionSchema>;
