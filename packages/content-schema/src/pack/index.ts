import { z } from 'zod';

import {
  contentIdSchema,
  flagIdSchema,
  packSlugSchema,
  scriptIdSchema,
  systemAutomationTargetIdSchema,
} from '../base/ids.js';
import { validateContentPackBalance } from '../balance.js';
import {
  cachedResultToValidationResult,
  validationResultToCachedResult,
} from './cache.js';
import { computePackDigest, digestToCacheKey } from './digest.js';
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
export { createValidationCache } from './cache.js';
export type { ValidationCache, CachedValidationResult, ValidationCacheOptions } from './cache.js';
export { computePackDigest, digestToCacheKey } from './digest.js';
export type { ContentPackDigest } from './digest.js';

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

/**
 * Runs validation refinements on a parsed content pack.
 * This is separated from the Zod schema to enable caching.
 */
const runValidationRefinements = (
  pack: ParsedContentPack,
  context: CrossReferenceContext,
  options: ContentSchemaOptions,
  warningSink: (warning: ContentSchemaWarning) => void,
): void => {
  // Collect validation issues
  const issues: z.ZodIssue[] = [];
  const ctx: z.RefinementCtx = {
    addIssue: (issue) => {
      issues.push({
        code: issue.code ?? z.ZodIssueCode.custom,
        path: issue.path ?? [],
        message: issue.message,
      } as z.ZodIssue);
    },
    path: [],
  };

  // Run all validation refinements
  validateCrossReferences(pack, ctx, context);
  validateDependencies(pack, ctx, context);
  validateFeatureGates(pack, ctx, options.runtimeVersion, warningSink);
  validateTransformCycles(pack, ctx);
  validateUnlockConditionCycles(pack, ctx);

  // Throw if any validation errors occurred
  if (issues.length > 0) {
    throw new z.ZodError(issues);
  }
};

/**
 * Builds the cross-reference context from options.
 */
const buildCrossReferenceContext = (
  options: ContentSchemaOptions,
  warningSink: (warning: ContentSchemaWarning) => void,
): CrossReferenceContext => {
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

  return {
    allowlists,
    warningSink,
    runtimeEventCatalogue,
    runtimeVersion: options.runtimeVersion,
    activePackIds,
    knownPacks,
  };
};

/**
 * Core validation logic that can be cached.
 * Returns the full validation result.
 */
const runFullValidation = (
  parsedPack: ParsedContentPack,
  options: ContentSchemaOptions,
  warnings: ContentSchemaWarning[],
  warningSink: (warning: ContentSchemaWarning) => void,
): ContentPackValidationResult => {
  // Build context and run refinements
  const context = buildCrossReferenceContext(options, warningSink);
  runValidationRefinements(parsedPack, context, options, warningSink);

  // Normalize the pack
  const normalizedPack = normalizeContentPack(parsedPack, {
    runtimeVersion: options.runtimeVersion,
    warningSink,
  });

  // Run balance validation
  const balanceOptions = options.balance ?? {};
  const balanceResult =
    balanceOptions.enabled === false
      ? { warnings: Object.freeze([] as ContentSchemaWarning[]), errors: Object.freeze([] as ContentSchemaWarning[]) }
      : validateContentPackBalance(normalizedPack, balanceOptions, options.warningSink);

  if (balanceResult.errors.length > 0 && balanceOptions.warnOnly !== true) {
    throw new BalanceValidationError('Balance validation failed.', balanceResult.errors);
  }

  return {
    pack: normalizedPack,
    warnings,
    balanceWarnings: balanceResult.warnings,
    balanceErrors: balanceResult.errors,
  };
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

    // Phase 1: Structural validation with Zod
    const parsedPack = contentPackSchema.parse(input);

    // Phase 2: Check cache if available
    if (options.cache) {
      const digest = computePackDigest(parsedPack);
      const cacheKey = digestToCacheKey(digest);
      const cached = options.cache.get(cacheKey);

      if (cached) {
        // Cache hit - replay warnings to sink and return cached result
        cached.warnings.forEach((w) => options.warningSink?.(w));
        cached.balanceWarnings.forEach((w) => options.warningSink?.(w));
        return cachedResultToValidationResult(cached);
      }

      // Cache miss - run full validation and cache result
      const result = runFullValidation(parsedPack, options, warnings, sink);
      options.cache.set(cacheKey, validationResultToCachedResult(result));
      return result;
    }

    // No cache - run full validation directly
    return runFullValidation(parsedPack, options, warnings, sink);
  },

  safeParse(input: unknown): ContentPackSafeParseResult {
    const warnings: ContentSchemaWarning[] = [];
    const sink = (warning: ContentSchemaWarning) => {
      warnings.push(warning);
      options.warningSink?.(warning);
    };

    // Phase 1: Structural validation with Zod
    const parseResult = contentPackSchema.safeParse(input);
    if (!parseResult.success) {
      return { success: false, error: parseResult.error };
    }
    const parsedPack = parseResult.data;

    try {
      // Phase 2: Check cache if available
      if (options.cache) {
        const digest = computePackDigest(parsedPack);
        const cacheKey = digestToCacheKey(digest);
        const cached = options.cache.get(cacheKey);

        if (cached) {
          // Cache hit - replay warnings to sink and return cached result
          cached.warnings.forEach((w) => options.warningSink?.(w));
          cached.balanceWarnings.forEach((w) => options.warningSink?.(w));
          return { success: true, data: cachedResultToValidationResult(cached) };
        }

        // Cache miss - run full validation and cache result
        const result = runFullValidation(parsedPack, options, warnings, sink);
        options.cache.set(cacheKey, validationResultToCachedResult(result));
        return { success: true, data: result };
      }

      // No cache - run full validation directly
      const result = runFullValidation(parsedPack, options, warnings, sink);
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error };
    }
  },
});

export const parseContentPack = (
  input: unknown,
  options?: ContentSchemaOptions,
): ContentPackValidationResult => createContentPackValidator(options).parse(input);
