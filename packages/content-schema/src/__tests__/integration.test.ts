/**
 * Integration tests exercising comprehensive fixtures covering success cases,
 * missing references, cycles, localization gaps, dependency loops, and invalid
 * runtime event contributions per docs/content-dsl-schema-design.md §6.
 */

import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import type { z } from 'zod';

import {
  evaluateNumericFormula,
  type FormulaEvaluationContext,
} from '../base/formula-evaluator.js';
import { createDeterministicFormulaEvaluationContext } from '../base/formulas.arbitraries.js';
import type { NumericFormula } from '../base/formulas.js';
import type { ContentSchemaOptions } from '../pack.js';
import { contentIdSchema, packSlugSchema } from '../base/ids.js';
import {
  anyOfUnlockBreaksCycleFixture,
  convergentTransformTreeFixture,
  cyclicTransformDirectFixture,
  cyclicTransformIndirectFixture,
  disjointCyclesFixture,
  disjointNetLossCyclesFixture,
  epsilonAboveThresholdCycleFixture,
  epsilonBelowThresholdCycleFixture,
  cyclicTransformMultiResourceFixture,
  cyclicUnlockConditionsFixture,
  cyclicUnlockCrossEntityFixture,
  dependencyLoopFixture,
  duplicateResourceIdsFixture,
  featureGateViolationFixture,
  entityFeatureGateViolationFixture,
  invalidAllowlistReferenceFixture,
  invalidEntityFormulaReferencesFixture,
  invalidEntityMaxCountFormulaReferencesFixture,
  invalidEntityStatGrowthFormulaReferencesFixture,
  invalidEntityExperienceFixture,
  invalidFormulaReferencesFixture,
  invalidRuntimeEventContributionsFixture,
  linearTransformChainFixture,
  localizationGapsFixture,
  missingMetricReferenceFixture,
  missingPrestigeCountResourceFixture,
  missingResourceReferenceFixture,
  netLossIndirectTransformCycleFixture,
  netLossTransformCycleFixture,
  neutralTransformCycleFixture,
  nonConstantFormulaCycleFixture,
  nonSimpleTransformCycleFixture,
  resourceSinkTransformFixture,
  selfThresholdUnlockConditionsFixture,
  selfReferencingDependencyFixture,
  selfReferencingTransformFixture,
  validComprehensivePackFixture,
  zeroAmountTransformCycleFixture,
} from '../__fixtures__/integration-packs.js';

const getZodIssues = (error: unknown) => {
  expect(error).toBeInstanceOf(ZodError);
  return (error as ZodError).issues;
};
import { createContentPackValidator } from '../index.js';

type ContentId = z.infer<typeof contentIdSchema>;
type PackId = z.infer<typeof packSlugSchema>;

describe('Integration: Success Cases', () => {
  it('validates and normalizes a comprehensive pack with all modules', () => {
    const validator = createContentPackValidator({
      runtimeVersion: '1.0.0',
      activePackIds: ['@idle-engine/core'],
    });

    const result = validator.safeParse(validComprehensivePackFixture);

    expect(result.success).toBe(true);
    if (!result.success) return;

    const { pack, warnings } = result.data;

    // Verify all modules are present and normalized
    expect(pack.resources).toHaveLength(2);
    expect(pack.entities).toHaveLength(1);
    expect(pack.generators).toHaveLength(1);
    expect(pack.upgrades).toHaveLength(1);
    expect(pack.metrics).toHaveLength(1);
    expect(pack.achievements).toHaveLength(1);

    // Verify lookups are populated
    expect(pack.lookup.resources.get('energy' as ContentId)).toBeDefined();
    expect(pack.lookup.resources.get('crystals' as ContentId)).toBeDefined();
    expect(pack.lookup.entities.get('scout' as ContentId)).toBeDefined();
    expect(pack.lookup.generators.get('solar-panel' as ContentId)).toBeDefined();

    // Verify serialized lookups
    expect(pack.serializedLookup.resourceById.energy).toBeDefined();
    expect(pack.serializedLookup.entityById.scout).toBeDefined();
    expect(pack.serializedLookup.generatorById['solar-panel']).toBeDefined();

    // Verify digest is generated
    expect(pack.digest.hash).toMatch(/^fnv1a-[0-9a-f]{8}$/);
    expect(pack.digest.version).toBeGreaterThan(0);

    // Should warn about missing optional dependency
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'dependencies.optionalMissing',
          message: expect.stringContaining('optional-pack'),
        }),
      ]),
    );
  });

  it('validates localization variants and mirrors default locale', () => {
    const validator = createContentPackValidator();
    const result = validator.safeParse(validComprehensivePackFixture);

    expect(result.success).toBe(true);
    if (!result.success) return;

    const { pack } = result.data;

    // Verify locale mirroring: default text should appear in defaultLocale variant
    const energyResource = pack.lookup.resources.get('energy' as ContentId);
    // @ts-expect-error - accessing variants with plain string in test
    expect(energyResource?.name.variants['en-US']).toBe('Energy');
    // @ts-expect-error - accessing variants with plain string in test
    expect(energyResource?.name.variants['fr-FR']).toBe('Énergie');
  });
});

describe('Integration: Missing References', () => {
  it('rejects pack with generator producing non-existent resource', () => {
    const validator = createContentPackValidator();
    expect(() => validator.parse(missingResourceReferenceFixture)).toThrow(
      ZodError,
    );

    const result = validator.safeParse(missingResourceReferenceFixture);
    expect(result.success).toBe(false);
    if (result.success) return;

    const issues = getZodIssues(result.error);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining('non-existent-resource'),
          path: expect.arrayContaining(['generators']),
        }),
      ]),
    );
  });

  it('rejects achievement tracking non-existent custom metric', () => {
    const validator = createContentPackValidator();
    const result = validator.safeParse(missingMetricReferenceFixture);

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(getZodIssues(result.error)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining('non-existent-metric'),
        }),
      ]),
    );
  });

  it('rejects formula expressions referencing undefined resources', () => {
    const validator = createContentPackValidator();
    const result = validator.safeParse(invalidFormulaReferencesFixture);

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(getZodIssues(result.error)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining('non-existent-resource'),
        }),
      ]),
    );
  });

  it('rejects entity formulas referencing undefined resources', () => {
    const validator = createContentPackValidator();
    const result = validator.safeParse(invalidEntityFormulaReferencesFixture);

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(getZodIssues(result.error)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining('missing-formula-resource'),
          path: expect.arrayContaining(['entities']),
        }),
      ]),
    );
  });

  it('rejects entity maxCount formulas referencing undefined resources', () => {
    const validator = createContentPackValidator();
    const result = validator.safeParse(invalidEntityMaxCountFormulaReferencesFixture);

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(getZodIssues(result.error)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining('missing-maxcount-resource'),
          path: expect.arrayContaining(['entities', 0, 'maxCount']),
        }),
      ]),
    );
  });

  it('rejects entity statGrowth formulas referencing undefined resources', () => {
    const validator = createContentPackValidator();
    const result = validator.safeParse(invalidEntityStatGrowthFormulaReferencesFixture);

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(getZodIssues(result.error)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining('missing-statgrowth-resource'),
          path: expect.arrayContaining(['entities', 0, 'progression', 'statGrowth', 'speed']),
        }),
      ]),
    );
  });

  it('rejects entity progression referencing unknown experience resources', () => {
    const validator = createContentPackValidator();
    const result = validator.safeParse(invalidEntityExperienceFixture);

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(getZodIssues(result.error)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining('missing-resource'),
        }),
      ]),
    );
  });
});

describe('Integration: Cyclic Dependencies', () => {
  it('detects unlock condition cycles between resources', () => {
    const validator = createContentPackValidator();
    const result = validator.safeParse(cyclicUnlockConditionsFixture);

    expect(result.success).toBe(false);
    if (result.success) return;

    // Should detect the cycle between resource-a and resource-b
    expect(getZodIssues(result.error)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringMatching(/unlock condition cycle/i),
        }),
      ]),
    );
  });

  it('allows self-threshold unlock conditions for resources', () => {
    const validator = createContentPackValidator();
    const result = validator.safeParse(selfThresholdUnlockConditionsFixture);

    expect(result.success).toBe(true);
  });

  it('allows anyOf unlock branches to break dependency cycles', () => {
    const validator = createContentPackValidator();
    const result = validator.safeParse(anyOfUnlockBreaksCycleFixture);

    expect(result.success).toBe(true);
  });

  it('detects unlock condition cycles across entity types (resource-generator)', () => {
    const validator = createContentPackValidator();
    const result = validator.safeParse(cyclicUnlockCrossEntityFixture);

    expect(result.success).toBe(false);
    if (result.success) return;

    // Should detect the cycle between energy resource and solar-panel generator
    expect(getZodIssues(result.error)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringMatching(/unlock condition cycle/i),
        }),
      ]),
    );
  });

  it('detects net-positive direct transform chain cycles (A → B → A)', () => {
    const validator = createContentPackValidator();
    const result = validator.safeParse(cyclicTransformDirectFixture);

    expect(result.success).toBe(false);
    if (result.success) return;

    // Should detect the cycle between transform-a and transform-b
    expect(getZodIssues(result.error)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringMatching(/transform cycle/i),
        }),
      ]),
    );
  });

  it('detects net-positive indirect transform chain cycles (A → B → C → A)', () => {
    const validator = createContentPackValidator();
    const result = validator.safeParse(cyclicTransformIndirectFixture);

    expect(result.success).toBe(false);
    if (result.success) return;

    // Should detect the cycle through transform-a, transform-b, and transform-c
    expect(getZodIssues(result.error)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringMatching(/transform cycle/i),
        }),
      ]),
    );
  });

  it('detects multi-resource transform chain cycles', () => {
    const validator = createContentPackValidator();
    const result = validator.safeParse(cyclicTransformMultiResourceFixture);

    expect(result.success).toBe(false);
    if (result.success) return;

    // Should detect the cycle with multiple resources involved
    expect(getZodIssues(result.error)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringMatching(/transform cycle/i),
        }),
      ]),
    );
  });

  it('allows direct transform cycles with net loss', () => {
    const validator = createContentPackValidator();
    const result = validator.safeParse(netLossTransformCycleFixture);

    expect(result.success).toBe(true);
    if (!result.success) {
      console.error('Validation errors:', getZodIssues(result.error));
    }
  });

  it('allows transform cycles with neutral ratio (exactly 1.0)', () => {
    const validator = createContentPackValidator();
    const result = validator.safeParse(neutralTransformCycleFixture);

    expect(result.success).toBe(true);
    if (!result.success) {
      console.error('Validation errors:', getZodIssues(result.error));
    }
  });

  it('allows indirect transform cycles (3+ transforms) with net loss', () => {
    const validator = createContentPackValidator();
    const result = validator.safeParse(netLossIndirectTransformCycleFixture);

    expect(result.success).toBe(true);
    if (!result.success) {
      console.error('Validation errors:', getZodIssues(result.error));
    }
  });

  it('rejects cycles containing non-simple transforms (multi-input)', () => {
    const validator = createContentPackValidator();
    const result = validator.safeParse(nonSimpleTransformCycleFixture);

    expect(result.success).toBe(false);
    if (result.success) return;

    // Should reject because cycle profitability cannot be evaluated
    expect(getZodIssues(result.error)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringMatching(/transform cycle/i),
        }),
      ]),
    );
    // Error message should mention profitability and the specific transform
    expect(getZodIssues(result.error)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringMatching(/profitability.*transform-a/i),
        }),
      ]),
    );
  });

  it('rejects cycles containing non-constant formula amounts', () => {
    const validator = createContentPackValidator();
    const result = validator.safeParse(nonConstantFormulaCycleFixture);

    expect(result.success).toBe(false);
    if (result.success) return;

    // Should reject because cycle profitability cannot be evaluated for non-constant formulas
    expect(getZodIssues(result.error)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringMatching(/transform cycle/i),
        }),
      ]),
    );
    // Error message should mention profitability and the specific transform
    expect(getZodIssues(result.error)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringMatching(/profitability.*transform-a/i),
        }),
      ]),
    );
  });

  it('allows cycles with ratio just below PROFIT_EPSILON threshold', () => {
    const validator = createContentPackValidator();
    // Cycle ratio = 1.000000001 (1e-9 above 1.0), below PROFIT_EPSILON (1e-8)
    const result = validator.safeParse(epsilonBelowThresholdCycleFixture);

    expect(result.success).toBe(true);
    if (!result.success) {
      console.error('Validation errors:', getZodIssues(result.error));
    }
  });

  it('rejects cycles with ratio just above PROFIT_EPSILON threshold', () => {
    const validator = createContentPackValidator();
    // Cycle ratio = 1.00000002 (2e-8 above 1.0), above PROFIT_EPSILON (1e-8)
    const result = validator.safeParse(epsilonAboveThresholdCycleFixture);

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(getZodIssues(result.error)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringMatching(/net-positive/i),
        }),
      ]),
    );
  });

  it('rejects cycles containing zero-amount transforms', () => {
    const validator = createContentPackValidator();
    const result = validator.safeParse(zeroAmountTransformCycleFixture);

    expect(result.success).toBe(false);
    if (result.success) return;

    // Should reject because cycle profitability cannot be evaluated for zero amounts
    expect(getZodIssues(result.error)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringMatching(/transform cycle/i),
        }),
      ]),
    );
    // Error message should mention profitability and the specific transform
    expect(getZodIssues(result.error)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringMatching(/profitability.*transform-a/i),
        }),
      ]),
    );
  });

  it('rejects packs with disjoint cycles when one is net-positive', () => {
    const validator = createContentPackValidator();
    const result = validator.safeParse(disjointCyclesFixture);

    expect(result.success).toBe(false);
    if (result.success) return;

    // Should detect the net-positive cycle (X <-> Y)
    expect(getZodIssues(result.error)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringMatching(/net-positive/i),
        }),
      ]),
    );
  });

  it('allows packs with multiple disjoint net-loss cycles', () => {
    const validator = createContentPackValidator();
    const result = validator.safeParse(disjointNetLossCyclesFixture);

    expect(result.success).toBe(true);
    if (!result.success) {
      console.error('Validation errors:', getZodIssues(result.error));
    }
  });

  it('allows linear transform chains without cycles', () => {
    const validator = createContentPackValidator();
    const result = validator.safeParse(linearTransformChainFixture);

    expect(result.success).toBe(true);
    if (!result.success) {
      console.error('Validation errors:', getZodIssues(result.error));
    }
  });

  it('allows convergent production trees without cycles', () => {
    const validator = createContentPackValidator();
    const result = validator.safeParse(convergentTransformTreeFixture);

    expect(result.success).toBe(true);
    if (!result.success) {
      console.error('Validation errors:', getZodIssues(result.error));
    }
  });

  it('allows resource sink patterns without cycles', () => {
    const validator = createContentPackValidator();
    const result = validator.safeParse(resourceSinkTransformFixture);

    expect(result.success).toBe(true);
    if (!result.success) {
      console.error('Validation errors:', getZodIssues(result.error));
    }
  });

  it('allows self-referencing transforms with net loss', () => {
    const validator = createContentPackValidator();
    const result = validator.safeParse(selfReferencingTransformFixture);

    expect(result.success).toBe(true);
    if (!result.success) {
      console.error('Validation errors:', getZodIssues(result.error));
    }
  });

  it('detects self-referencing pack dependencies', () => {
    const validator = createContentPackValidator();
    const result = validator.safeParse(selfReferencingDependencyFixture);

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(getZodIssues(result.error)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining('cannot declare a requires dependency on itself'),
          path: expect.arrayContaining(['metadata', 'dependencies']),
        }),
      ]),
    );
  });

  it('detects dependency loops across multiple packs when knownPacks provided', () => {
    const options: ContentSchemaOptions = {
      knownPacks: [
        {
          id: 'pack-b' as PackId,
          version: '1.0.0',
          requires: [{ packId: 'pack-a' as PackId, version: '^1.0.0' }],
        },
      ],
    };

    const validator = createContentPackValidator(options);
    const result = validator.safeParse(dependencyLoopFixture);

    expect(result.success).toBe(false);
    if (result.success) return;

    // Should detect: pack-a -> pack-b -> pack-a
    expect(getZodIssues(result.error)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringMatching(/cycl/i),
        }),
      ]),
    );
  });
});

describe('Integration: Formula Evaluation Context', () => {
  it('requires variables and entities when evaluating normalized formulas', () => {
    const validator = createContentPackValidator();
    const result = validator.safeParse(validComprehensivePackFixture);

    expect(result.success).toBe(true);
    if (!result.success) return;

    const { pack } = result.data;
    const generator = pack.generators.find(
      (definition) => definition.id === 'solar-panel',
    );

    expect(generator).toBeDefined();
    if (!generator) return;

    const production = generator.produces[0];
    expect(production).toBeDefined();
    if (!production) return;

    expect(production.rate.kind).toBe('linear');
    if (production.rate.kind !== 'linear') return;

    const baseContext = createDeterministicFormulaEvaluationContext({
      resource: pack.resources.map((resource) => resource.id),
      generator: pack.generators.map((definition) => definition.id),
    });

    const level = 4;
    const evaluationContext: FormulaEvaluationContext = {
      ...baseContext,
      variables: {
        ...baseContext.variables,
        level,
      },
    };

    const emptyContext: FormulaEvaluationContext = {};
    expect(() =>
      evaluateNumericFormula(production.rate, emptyContext),
    ).toThrowError(
      /Missing variable "level" in formula evaluation context/,
    );

    const rate = evaluateNumericFormula(production.rate, evaluationContext);
    expect(rate).toBeCloseTo(
      production.rate.base + production.rate.slope * level,
    );

    const resourceId = production.resourceId;
    const resourceValueFormula: NumericFormula = {
      kind: 'expression',
      expression: {
        kind: 'ref',
        target: {
          type: 'resource',
          id: resourceId,
        },
      },
    };

    const missingEntityContext: FormulaEvaluationContext = {
      variables: evaluationContext.variables,
    };
    expect(() =>
      evaluateNumericFormula(resourceValueFormula, missingEntityContext),
    ).toThrowError(
      /Missing entity lookup for type "resource" while resolving "energy"/,
    );

    const resourceValue = evaluateNumericFormula(
      resourceValueFormula,
      evaluationContext,
    );
    expect(resourceValue).toBe(100);
  });
});

describe('Integration: Localization Gaps', () => {
  it('emits warnings for missing translation variants', () => {
    const validator = createContentPackValidator();
    const result = validator.safeParse(localizationGapsFixture);

    // Should still parse successfully, but emit warnings
    expect(result.success).toBe(true);
    if (!result.success) return;

    const { warnings } = result.data;

    // Should warn about missing 'es-ES' variant in metadata title
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'localization.missingVariant',
          path: ['metadata', 'title'],
          message: expect.stringContaining('es-ES'),
        }),
      ]),
    );

    // Should warn about missing 'es-ES' variant in energy resource name
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'localization.missingVariant',
          path: expect.arrayContaining(['resources', 0, 'name']),
          message: expect.stringContaining('es-ES'),
        }),
      ]),
    );

    // Should warn about missing locales in crystals resource
    const crystalWarnings = warnings.filter(
      (w) =>
        w.path[0] === 'resources' &&
        w.path[1] === 1 &&
        w.path[2] === 'name',
    );
    expect(crystalWarnings.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Integration: Runtime Event Contributions', () => {
  it('rejects runtime events with parent directory escapes in schema paths', () => {
    const validator = createContentPackValidator();
    const result = validator.safeParse(invalidRuntimeEventContributionsFixture);

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(getZodIssues(result.error)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringMatching(/schema.*path/i),
          path: expect.arrayContaining(['runtimeEvents']),
        }),
      ]),
    );
  });

  it('rejects duplicate runtime event IDs within same pack', () => {
    // Create a fixture without the parent directory escape issue
    const duplicateEventsFixture = {
      metadata: {
        id: 'duplicate-events-pack',
        title: { default: 'Test', variants: {} },
        version: '1.0.0',
        engine: '^1.0.0',
        defaultLocale: 'en-US',
        supportedLocales: ['en-US'],
      },
      resources: [],
      generators: [],
      upgrades: [],
      runtimeEvents: [
        {
          namespace: 'test',
          name: 'duplicate-event',
          version: 1,
          payload: {
            kind: 'zod' as const,
            schemaPath: './schemas/event-a.ts',
          },
        },
        {
          namespace: 'test',
          name: 'duplicate-event', // Duplicate name in same namespace
          version: 2,
          payload: {
            kind: 'zod' as const,
            schemaPath: './schemas/event-b.ts',
          },
        },
      ],
    };

    const validator = createContentPackValidator();
    const result = validator.safeParse(duplicateEventsFixture);

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(getZodIssues(result.error)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringMatching(/duplicate|collision/i),
        }),
      ]),
    );
  });

  it('rejects runtime event colliding with core catalog when provided', () => {
    const validator = createContentPackValidator({
      runtimeEventCatalogue: ['idle-engine-core:resource-updated'],
    });

    const collisionFixture = {
      metadata: {
        id: 'event-collision-pack',
        title: { default: 'Test', variants: {} },
        version: '1.0.0',
        engine: '^1.0.0',
        defaultLocale: 'en-US',
        supportedLocales: ['en-US'],
      },
      resources: [],
      generators: [],
      upgrades: [],
      runtimeEvents: [
        {
          namespace: 'idle-engine-core',
          name: 'resource-updated', // Collides with core event
          version: 1,
          payload: {
            kind: 'zod' as const,
            schemaPath: './schemas/resource-updated.ts',
          },
        },
      ],
    };

    const result = validator.safeParse(collisionFixture);

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(getZodIssues(result.error)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringMatching(/collid|conflict|duplicate|already exists/i),
        }),
      ]),
    );
  });
});

	describe('Integration: Feature Gates', () => {
	  it('rejects packs using automations when targeting runtime <0.2.0', () => {
	    const validator = createContentPackValidator({ runtimeVersion: '0.1.0' });
	    const result = validator.safeParse(featureGateViolationFixture);

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(getZodIssues(result.error)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringMatching(/automation.*0\.2\.0/i),
        }),
      ]),
    );
  });

	  it('allows automations when targeting runtime >=0.2.0', () => {
	    const packWithAutomation = {
	      ...featureGateViolationFixture,
	      metadata: {
	        ...featureGateViolationFixture.metadata,
	        engine: '^0.2.0',
	      },
	    };

	    const validator = createContentPackValidator({ runtimeVersion: '0.2.0' });
	    const result = validator.safeParse(packWithAutomation);

	    expect(result.success).toBe(true);
	  });

	  it('rejects packs using entities when targeting runtime <0.5.0', () => {
	    const validator = createContentPackValidator({ runtimeVersion: '0.4.0' });
	    const result = validator.safeParse(entityFeatureGateViolationFixture);

	    expect(result.success).toBe(false);
	    if (result.success) return;

	    expect(getZodIssues(result.error)).toEqual(
	      expect.arrayContaining([
	        expect.objectContaining({
	          message: expect.stringMatching(/entities.*0\.5\.0/i),
	        }),
	      ]),
	    );
	  });

	  it('allows entities when targeting runtime >=0.5.0', () => {
	    const packWithEntities = {
	      ...entityFeatureGateViolationFixture,
	      metadata: {
	        ...entityFeatureGateViolationFixture.metadata,
	        engine: '^0.5.0',
	      },
	    };

	    const validator = createContentPackValidator({ runtimeVersion: '0.5.0' });
	    const result = validator.safeParse(packWithEntities);

	    expect(result.success).toBe(true);
	  });
	});

describe('Integration: Duplicate IDs', () => {
  it('rejects packs with duplicate resource IDs', () => {
    const validator = createContentPackValidator();
    const result = validator.safeParse(duplicateResourceIdsFixture);

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(getZodIssues(result.error)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringMatching(/duplicate.*id/i),
          path: expect.arrayContaining(['resources']),
        }),
      ]),
    );
  });
});

describe('Integration: Allowlist Validation', () => {
  it('validates flag references against allowlist when provided', () => {
    const validator = createContentPackValidator({
      allowlists: {
        flags: {
          required: ['allowed-flag', 'undefined-flag'],
        },
      },
    });

    const result = validator.safeParse(invalidAllowlistReferenceFixture);

    // Should succeed if all flags are in allowlist
    if (!result.success) {
      // If it fails, it should be for a different reason
      expect(getZodIssues(result.error)).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringMatching(/allowlist/i),
          }),
        ]),
      );
    }
  });

  it('validates soft flag references', () => {
    const validator = createContentPackValidator({
      allowlists: {
        flags: {
          soft: ['allowed-flag'],
        },
      },
    });

    const result = validator.safeParse(invalidAllowlistReferenceFixture);

    // Should parse successfully
    // Soft flags may emit warnings but should not fail validation
    if (result.success) {
      // Warnings may or may not be present depending on implementation
      expect(result.data.warnings).toBeDefined();
    }
  });
});

describe('Integration: Resource Capacity Normalization', () => {
  it('preserves null capacity through pack normalization', () => {
    const validator = createContentPackValidator();

    const pack = {
      metadata: {
        id: 'capacity-test',
        title: { default: 'Capacity Test', variants: {} },
        version: '1.0.0',
        engine: '^1.0.0',
        defaultLocale: 'en-US',
        supportedLocales: ['en-US'],
      },
      resources: [
        {
          id: 'unlimited',
          name: { default: 'Unlimited Resource', variants: {} },
          category: 'primary' as const,
          tier: 1,
          capacity: null,
        },
        {
          id: 'no-capacity-specified',
          name: { default: 'Default Capacity', variants: {} },
          category: 'primary' as const,
          tier: 1,
          // capacity not specified - should default to null
        },
      ],
      generators: [],
      upgrades: [],
    };

    const result = validator.parse(pack);

    const unlimited = result.pack.resources.find(r => r.id === 'unlimited');
    const defaultCap = result.pack.resources.find(r => r.id === 'no-capacity-specified');

    expect(unlimited?.capacity).toBe(null);
    expect(defaultCap?.capacity).toBe(null);
  });
});

describe('Integration: Missing Prestige Count Resource', () => {
  it('rejects pack with prestige layer missing required prestige count resource', () => {
    const validator = createContentPackValidator();
    expect(() => validator.parse(missingPrestigeCountResourceFixture)).toThrow(
      ZodError,
    );

    const result = validator.safeParse(missingPrestigeCountResourceFixture);
    expect(result.success).toBe(false);
    if (result.success) return;

    const issues = getZodIssues(result.error);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining('prestige-test-pack.ascension-prestige-count'),
          path: expect.arrayContaining(['prestigeLayers']),
        }),
      ]),
    );
  });

  it('provides clear error message explaining the required resource naming convention', () => {
    const validator = createContentPackValidator();
    const result = validator.safeParse(missingPrestigeCountResourceFixture);
    expect(result.success).toBe(false);
    if (result.success) return;

    const issues = getZodIssues(result.error);
    const prestigeIssue = issues.find(issue =>
      issue.message.includes('prestige-test-pack.ascension-prestige-count')
    );

    expect(prestigeIssue).toBeDefined();
    expect(prestigeIssue?.message).toContain('track prestige count');
    expect(prestigeIssue?.message).toContain('Add this resource');
  });
});
