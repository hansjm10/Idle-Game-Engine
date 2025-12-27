import { z } from 'zod';

import {
  contentIdSchema,
  flagIdSchema,
  packSlugSchema,
  scriptIdSchema,
  systemAutomationTargetIdSchema,
} from '../base/ids.js';
import { validateContentPackBalance } from '../balance.js';
import { BalanceValidationError, type ContentSchemaWarning } from '../errors.js';
import {
  resolveFeatureViolations,
  type FeatureGateMap,
} from '../runtime-compat.js';
import type { ParsedContentPack } from './schema.js';
import { contentPackSchema } from './schema.js';
import { normalizeContentPack } from './normalize.js';
import { validateCrossReferences } from './validate-cross-references.js';
import { validateDependencies } from './validate-dependencies.js';
import {
  validateTransformCycles,
  validateUnlockConditionCycles,
} from './validate-cycles.js';
import type {
  AllowlistEntries,
  AllowlistSpecInput,
  ContentPackSafeParseResult,
  ContentPackValidationResult,
  ContentPackValidator,
  ContentSchemaOptions,
  CrossReferenceContext,
  KnownPackEntry,
  NormalizedAllowlistSpec,
} from './types.js';
import { toMutablePath } from './utils.js';

export { contentPackSchema };

export type {
  ContentPackSafeParseFailure,
  ContentPackSafeParseSuccess,
  ContentPackSafeParseResult,
  ContentPackValidationResult,
  ContentPackValidator,
  ContentSchemaOptions,
  NormalizedContentPack,
  NormalizedMetadata,
  NormalizedResource,
  NormalizedGenerator,
  NormalizedUpgrade,
  NormalizedMetric,
  NormalizedAchievement,
  NormalizedAutomation,
  NormalizedTransform,
  NormalizedPrestigeLayer,
  NormalizedRuntimeEventContribution,
  NormalizationContext,
} from './types.js';

const toArray = (entries: AllowlistEntries | undefined): readonly string[] =>
  entries ? Array.from(entries) : [];

const runtimeEventIdSchema = contentIdSchema;

const normalizeAllowlistEntries = (
  entries: AllowlistEntries | undefined,
  severity: 'error' | 'warning',
  schema: z.ZodType<string>,
  warningSink: (warning: ContentSchemaWarning) => void,
  pathPrefix: readonly (string | number)[],
): ReadonlySet<string> => {
  const normalized = new Set<string>();
  const issues: z.ZodIssue[] = [];
  toArray(entries).forEach((value, index) => {
    const result = schema.safeParse(value);
    if (!result.success) {
      const entryPath = [...pathPrefix, index] as const;
      if (severity === 'error') {
        result.error.issues.forEach((issue) => {
          issues.push({
            ...issue,
            path: toMutablePath([...entryPath, ...issue.path] as const),
          });
        });
        return;
      }
      warningSink({
        code:
          severity === 'warning'
            ? 'allowlist.invalidSoftEntry'
            : 'allowlist.invalidEntry',
        message: `Allowlist entry "${value}" failed validation.`,
        path: toMutablePath(entryPath),
        severity,
        issues: result.error.issues,
      });
      return;
    }
    normalized.add(result.data);
  });

  if (severity === 'error' && issues.length > 0) {
    throw new z.ZodError(issues);
  }

  return normalized;
};

const normalizeAllowlistSpec = (
  spec: AllowlistSpecInput | undefined,
  schema: z.ZodType<string>,
  warningSink: (warning: ContentSchemaWarning) => void,
  pathPrefix: readonly (string | number)[],
): NormalizedAllowlistSpec => ({
  required: normalizeAllowlistEntries(
    spec?.required,
    'error',
    schema,
    warningSink,
    [...pathPrefix, 'required'],
  ),
  soft: normalizeAllowlistEntries(
    spec?.soft,
    'warning',
    schema,
    warningSink,
    [...pathPrefix, 'soft'],
  ),
});

const normalizeRuntimeEventCatalogue = (
  entries: AllowlistEntries | undefined,
): ReadonlySet<string> =>
  new Set(
    toArray(entries).map((eventType) => runtimeEventIdSchema.parse(eventType)),
  );

const normalizeActivePackIds = (
  entries: AllowlistEntries | undefined,
): ReadonlySet<z.infer<typeof packSlugSchema>> =>
  new Set(toArray(entries).map((packId) => packSlugSchema.parse(packId)));

const buildFeatureGateMap = (pack: ParsedContentPack): FeatureGateMap => ({
  automations: pack.automations.length > 0,
  transforms: pack.transforms.length > 0,
  runtimeEvents: pack.runtimeEvents.length > 0,
  prestigeLayers: pack.prestigeLayers.length > 0,
});

const validateFeatureGates = (
  pack: ParsedContentPack,
  ctx: z.RefinementCtx,
  runtimeVersion: string | undefined,
  warningSink: (warning: ContentSchemaWarning) => void,
) => {
  const featureGateViolations = resolveFeatureViolations(
    runtimeVersion,
    buildFeatureGateMap(pack),
  );
  featureGateViolations.forEach((violation) => {
    if (violation.severity === 'error') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: toMutablePath(['metadata', 'version'] as const),
        message: violation.message,
      });
    } else {
      warningSink({
        code: 'runtime.featureGate',
        message: violation.message,
        path: toMutablePath(['metadata', 'version'] as const),
        severity: 'warning',
      });
    }
  });
};

const buildContentPackEffectsSchema = (
  options: ContentSchemaOptions,
  warningSink: (warning: ContentSchemaWarning) => void,
) => {
  const allowlists: CrossReferenceContext['allowlists'] =
    options.allowlists === undefined
      ? {}
      : {
          ...(options.allowlists.flags
            ? {
                flags: normalizeAllowlistSpec(
                  options.allowlists.flags,
                  flagIdSchema,
                  warningSink,
                  ['options', 'allowlists', 'flags'],
                ),
              }
            : {}),
          ...(options.allowlists.scripts
            ? {
                scripts: normalizeAllowlistSpec(
                  options.allowlists.scripts,
                  scriptIdSchema,
                  warningSink,
                  ['options', 'allowlists', 'scripts'],
                ),
              }
            : {}),
          ...(options.allowlists.systemAutomationTargets
            ? {
                systemAutomationTargets: normalizeAllowlistSpec(
                  options.allowlists.systemAutomationTargets,
                  systemAutomationTargetIdSchema,
                  warningSink,
                  ['options', 'allowlists', 'systemAutomationTargets'],
                ),
              }
            : {}),
        };

  const runtimeEventCatalogue = normalizeRuntimeEventCatalogue(
    options.runtimeEventCatalogue,
  );
  const activePackIds = normalizeActivePackIds(options.activePackIds);
  const knownPacks = new Map<z.infer<typeof packSlugSchema>, KnownPackEntry>();
  options.knownPacks?.forEach((packEntry) => {
    knownPacks.set(packEntry.id, packEntry);
  });

  const context: CrossReferenceContext = {
    allowlists,
    warningSink,
    runtimeEventCatalogue,
    runtimeVersion: options.runtimeVersion,
    activePackIds,
    knownPacks,
  };

  return contentPackSchema
    .superRefine((pack, ctx) => {
      validateCrossReferences(pack, ctx, context);
      validateDependencies(pack, ctx, context);
      validateFeatureGates(pack, ctx, options.runtimeVersion, warningSink);
      // Validate transform chains for cycles
      validateTransformCycles(pack, ctx);
      // Validate unlock conditions for cycles
      validateUnlockConditionCycles(pack, ctx);
    })
    .transform((pack) =>
      normalizeContentPack(pack, {
        runtimeVersion: options.runtimeVersion,
        warningSink,
      }),
    );
};

export const createContentPackValidator = (
  options: ContentSchemaOptions = {},
): ContentPackValidator => ({
  parse(input: unknown): ContentPackValidationResult {
    const warnings: ContentSchemaWarning[] = [];
    const sink = (warning: ContentSchemaWarning) => {
      warnings.push(warning);
      options.warningSink?.(warning);
    };

    const schema = buildContentPackEffectsSchema(options, sink);
    const pack = schema.parse(input);

    const balanceOptions = options.balance ?? {};
    const balanceResult =
      balanceOptions.enabled === false
        ? { warnings: Object.freeze([] as ContentSchemaWarning[]), errors: Object.freeze([] as ContentSchemaWarning[]) }
        : validateContentPackBalance(pack, balanceOptions, options.warningSink);

    if (balanceResult.errors.length > 0 && balanceOptions.warnOnly !== true) {
      throw new BalanceValidationError('Balance validation failed.', balanceResult.errors);
    }

    return {
      pack,
      warnings,
      balanceWarnings: balanceResult.warnings,
      balanceErrors: balanceResult.errors,
    };
  },
  safeParse(input: unknown): ContentPackSafeParseResult {
    const warnings: ContentSchemaWarning[] = [];
    const sink = (warning: ContentSchemaWarning) => {
      warnings.push(warning);
      options.warningSink?.(warning);
    };
    const schema = buildContentPackEffectsSchema(options, sink);
    const result = schema.safeParse(input);
    if (result.success) {
      try {
        const balanceOptions = options.balance ?? {};
        const balanceResult =
          balanceOptions.enabled === false
            ? { warnings: Object.freeze([] as ContentSchemaWarning[]), errors: Object.freeze([] as ContentSchemaWarning[]) }
            : validateContentPackBalance(result.data, balanceOptions, options.warningSink);

        if (balanceResult.errors.length > 0 && balanceOptions.warnOnly !== true) {
          throw new BalanceValidationError('Balance validation failed.', balanceResult.errors);
        }

        return {
          success: true,
          data: {
            pack: result.data,
            warnings,
            balanceWarnings: balanceResult.warnings,
            balanceErrors: balanceResult.errors,
          },
        };
      } catch (error) {
        return { success: false, error };
      }
    }
    return { success: false, error: result.error };
  },
});

export const parseContentPack = (
  input: unknown,
  options?: ContentSchemaOptions,
): ContentPackValidationResult => createContentPackValidator(options).parse(input);
