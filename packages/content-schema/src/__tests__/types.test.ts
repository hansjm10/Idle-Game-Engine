/**
 * Type-level assertions using expectTypeOf to verify branded types, inferred
 * types, and warning collection behavior per docs/content-dsl-schema-design.md §6.
 */

import { describe, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';

import type {
  ContentSchemaOptions,
  NormalizedContentPack,
} from '../pack.js';
import type { ContentSchemaWarning } from '../errors.js';
import {
  contentIdSchema,
  flagIdSchema,
  packSlugSchema,
  scriptIdSchema,
  systemAutomationTargetIdSchema,
} from '../base/ids.js';
import { contentPackSchema, createContentPackValidator } from '../index.js';
import type { NumericFormula } from '../base/formulas.js';
import type { Condition } from '../base/conditions.js';

describe('Type Assertions: Branded IDs', () => {
  it('ContentId is a branded string type', () => {
    type ContentId = z.infer<typeof contentIdSchema>;

    // ContentId should be a string brand
    expectTypeOf<ContentId>().toMatchTypeOf<string>();

    // Regular strings should not be assignable to ContentId without parsing
    expectTypeOf<string>().not.toMatchTypeOf<ContentId>();
  });

  it('PackId is a branded string type distinct from ContentId', () => {
    type PackId = z.infer<typeof packSlugSchema>;
    type ContentId = z.infer<typeof contentIdSchema>;

    // PackId should be a string brand
    expectTypeOf<PackId>().toMatchTypeOf<string>();

    // PackId and ContentId should not be interchangeable
    expectTypeOf<PackId>().not.toMatchTypeOf<ContentId>();
    expectTypeOf<ContentId>().not.toMatchTypeOf<PackId>();
  });

  it('FlagId is a branded string type', () => {
    type FlagId = z.infer<typeof flagIdSchema>;

    expectTypeOf<FlagId>().toMatchTypeOf<string>();
    expectTypeOf<string>().not.toMatchTypeOf<FlagId>();
  });

  it('ScriptId is a branded string type', () => {
    type ScriptId = z.infer<typeof scriptIdSchema>;

    expectTypeOf<ScriptId>().toMatchTypeOf<string>();
    expectTypeOf<string>().not.toMatchTypeOf<ScriptId>();
  });

  it('SystemAutomationTargetId is a branded string type', () => {
    type SystemAutomationTargetId = z.infer<
      typeof systemAutomationTargetIdSchema
    >;

    expectTypeOf<SystemAutomationTargetId>().toMatchTypeOf<string>();
    expectTypeOf<string>().not.toMatchTypeOf<SystemAutomationTargetId>();
  });
});

describe('Type Assertions: NormalizedContentPack', () => {
  it('NormalizedContentPack has correct structure with readonly fields', () => {
    expectTypeOf<NormalizedContentPack>().toHaveProperty('metadata');
    expectTypeOf<NormalizedContentPack>().toHaveProperty('resources');
    expectTypeOf<NormalizedContentPack>().toHaveProperty('generators');
    expectTypeOf<NormalizedContentPack>().toHaveProperty('upgrades');
    expectTypeOf<NormalizedContentPack>().toHaveProperty('metrics');
    expectTypeOf<NormalizedContentPack>().toHaveProperty('achievements');
    expectTypeOf<NormalizedContentPack>().toHaveProperty('automations');
    expectTypeOf<NormalizedContentPack>().toHaveProperty('transforms');
    expectTypeOf<NormalizedContentPack>().toHaveProperty('prestigeLayers');
    expectTypeOf<NormalizedContentPack>().toHaveProperty('guildPerks');
    expectTypeOf<NormalizedContentPack>().toHaveProperty('runtimeEvents');
    expectTypeOf<NormalizedContentPack>().toHaveProperty('lookup');
    expectTypeOf<NormalizedContentPack>().toHaveProperty('serializedLookup');
    expectTypeOf<NormalizedContentPack>().toHaveProperty('digest');

    // All top-level properties should be readonly
    expectTypeOf<NormalizedContentPack>().toMatchTypeOf<{
      readonly metadata: unknown;
      readonly resources: readonly unknown[];
      readonly generators: readonly unknown[];
      readonly upgrades: readonly unknown[];
    }>();
  });

  it('NormalizedContentPack.lookup uses branded ContentId keys', () => {
    type ContentId = z.infer<typeof contentIdSchema>;

    expectTypeOf<
      NormalizedContentPack['lookup']['resources']
    >().toEqualTypeOf<ReadonlyMap<ContentId, NormalizedContentPack['resources'][number]>>();

    expectTypeOf<
      NormalizedContentPack['lookup']['generators']
    >().toEqualTypeOf<ReadonlyMap<ContentId, NormalizedContentPack['generators'][number]>>();

    expectTypeOf<
      NormalizedContentPack['lookup']['upgrades']
    >().toEqualTypeOf<ReadonlyMap<ContentId, NormalizedContentPack['upgrades'][number]>>();
  });

  it('NormalizedContentPack.serializedLookup uses plain string keys', () => {
    expectTypeOf<
      NormalizedContentPack['serializedLookup']['resourceById']
    >().toEqualTypeOf<
      Readonly<Record<string, NormalizedContentPack['resources'][number]>>
    >();

    expectTypeOf<
      NormalizedContentPack['serializedLookup']['generatorById']
    >().toEqualTypeOf<
      Readonly<Record<string, NormalizedContentPack['generators'][number]>>
    >();
  });

  it('NormalizedContentPack.digest has version and hash fields', () => {
    expectTypeOf<NormalizedContentPack['digest']>().toEqualTypeOf<{
      readonly version: number;
      readonly hash: string;
    }>();
  });
});

describe('Type Assertions: Schema Warning', () => {
  it('ContentSchemaWarning has correct structure', () => {
    expectTypeOf<ContentSchemaWarning>().toHaveProperty('code');
    expectTypeOf<ContentSchemaWarning>().toHaveProperty('message');
    expectTypeOf<ContentSchemaWarning>().toHaveProperty('path');
    expectTypeOf<ContentSchemaWarning>().toHaveProperty('severity');

    expectTypeOf<ContentSchemaWarning>().toMatchTypeOf<{
      readonly code: string;
      readonly message: string;
      readonly path: readonly (string | number)[];
      readonly severity: 'error' | 'warning' | 'info';
      readonly suggestion?: string;
      readonly issues?: readonly unknown[];
    }>();
  });

  it('ContentSchemaWarning path is a readonly array of strings or numbers', () => {
    expectTypeOf<ContentSchemaWarning['path']>().toEqualTypeOf<
      readonly (string | number)[]
    >();

    // Should not be assignable to mutable array
    expectTypeOf<ContentSchemaWarning['path']>().not.toMatchTypeOf<
      (string | number)[]
    >();
  });

  it('ContentSchemaWarning severity is a discriminated union', () => {
    expectTypeOf<ContentSchemaWarning['severity']>().toEqualTypeOf<
      'error' | 'warning' | 'info'
    >();

    // Severity is a union of specific string literals
    type Severity = ContentSchemaWarning['severity'];
    expectTypeOf<Severity>().toMatchTypeOf<'error' | 'warning' | 'info'>();
  });
});

describe('Type Assertions: Validator Return Types', () => {
  it('createContentPackValidator().parse returns validation result', () => {
    const validator = createContentPackValidator();

    expectTypeOf(validator.parse).parameter(0).toMatchTypeOf<unknown>();

    expectTypeOf(validator.parse).returns.toMatchTypeOf<{
      pack: NormalizedContentPack;
      warnings: readonly ContentSchemaWarning[];
      balanceWarnings: readonly ContentSchemaWarning[];
      balanceErrors: readonly ContentSchemaWarning[];
    }>();
  });

  it('createContentPackValidator().safeParse returns discriminated union', () => {
    type SafeParseResult = ReturnType<
      ReturnType<typeof createContentPackValidator>['safeParse']
    >;

    expectTypeOf<SafeParseResult>().toMatchTypeOf<
      | {
          success: true;
          data: {
            pack: NormalizedContentPack;
            warnings: readonly ContentSchemaWarning[];
            balanceWarnings: readonly ContentSchemaWarning[];
            balanceErrors: readonly ContentSchemaWarning[];
          };
        }
      | { success: false; error: unknown }
    >();
  });
});

describe('Type Assertions: Content Schema Options', () => {
  it('ContentSchemaOptions has correct optional structure', () => {
    expectTypeOf<ContentSchemaOptions>().toMatchTypeOf<{
      allowlists?: unknown;
      runtimeVersion?: string;
      knownPacks?: readonly unknown[];
      runtimeEventCatalogue?: readonly string[] | ReadonlySet<string>;
      activePackIds?: readonly string[] | ReadonlySet<string>;
      warningSink?: (warning: ContentSchemaWarning) => void;
      balance?: unknown;
    }>();

    // All fields should be optional - empty options object should be valid
    expectTypeOf<Record<string, never>>().toMatchTypeOf<ContentSchemaOptions>();
  });

  it('warningSink accepts ContentSchemaWarning parameter', () => {
    type WarningSink = NonNullable<ContentSchemaOptions['warningSink']>;

    expectTypeOf<WarningSink>().parameter(0).toMatchTypeOf<ContentSchemaWarning>();
    expectTypeOf<WarningSink>().returns.toEqualTypeOf<void>();
  });
});

describe('Type Assertions: Base Schema Primitives', () => {
  it('NumericFormula is a discriminated union', () => {
    expectTypeOf<NumericFormula>().toMatchTypeOf<
      | { kind: 'constant'; value: number }
      | { kind: 'linear'; base: number; slope: number }
      | { kind: 'exponential'; base: number; growth: number; offset?: number }
      | { kind: 'polynomial'; coefficients: number[] }
      | { kind: 'piecewise'; pieces: readonly unknown[] }
      | { kind: 'expression'; expression: unknown }
    >();
  });

  it('Condition is a discriminated union by kind', () => {
    expectTypeOf<Condition>().toMatchTypeOf<
      | { kind: 'always' }
      | { kind: 'never' }
      | { kind: 'resourceThreshold'; resourceId: string }
      | { kind: 'generatorLevel'; generatorId: string }
      | { kind: 'upgradeOwned'; upgradeId: string }
      | { kind: 'prestigeCountThreshold'; prestigeLayerId: string }
      | { kind: 'prestigeCompleted'; prestigeLayerId: string }
      | { kind: 'prestigeUnlocked'; prestigeLayerId: string }
      | { kind: 'flag'; flagId: string }
      | { kind: 'script'; scriptId: string }
      | { kind: 'allOf'; conditions: readonly Condition[] }
      | { kind: 'anyOf'; conditions: readonly Condition[] }
      | { kind: 'not'; condition: Condition }
    >();
  });
});

describe('Type Assertions: Content Pack Schema Input vs Output', () => {
  it('contentPackSchema input allows less strict types', () => {
    type Input = z.input<typeof contentPackSchema>;
    type Output = z.output<typeof contentPackSchema>;

    // Verify that Input and Output types are defined (not never)
    expectTypeOf<Input>().not.toEqualTypeOf<never>();
    expectTypeOf<Output>().not.toEqualTypeOf<never>();
  });

  it('normalized pack has transformed IDs to lowercase', () => {
    // This is a runtime behavior, but we can verify the type structure
    type PackId = z.infer<typeof packSlugSchema>;

    const validator = createContentPackValidator();
    const result = validator.parse({
      metadata: {
        id: 'TEST-PACK',
        title: { default: 'Test' },
        version: '1.0.0',
        engine: '^1.0.0',
        defaultLocale: 'en-US',
        supportedLocales: ['en-US'],
      },
      resources: [],
      generators: [],
      upgrades: [],
    });

    expectTypeOf(result.pack.metadata.id).toMatchTypeOf<PackId>();
  });
});

describe('Type Assertions: Module Definition Types', () => {
  it('NormalizedResource has required branded ID field', () => {
    type ContentId = z.infer<typeof contentIdSchema>;
    type Resource = NormalizedContentPack['resources'][number];

    expectTypeOf<Resource>().toHaveProperty('id');
    expectTypeOf<Resource['id']>().toMatchTypeOf<ContentId>();
  });

  it('NormalizedGenerator has required branded ID field', () => {
    type ContentId = z.infer<typeof contentIdSchema>;
    type Generator = NormalizedContentPack['generators'][number];

    expectTypeOf<Generator>().toHaveProperty('id');
    expectTypeOf<Generator['id']>().toMatchTypeOf<ContentId>();
  });

  it('NormalizedUpgrade has required branded ID field', () => {
    type ContentId = z.infer<typeof contentIdSchema>;
    type Upgrade = NormalizedContentPack['upgrades'][number];

    expectTypeOf<Upgrade>().toHaveProperty('id');
    expectTypeOf<Upgrade['id']>().toMatchTypeOf<ContentId>();
  });

  it('NormalizedMetric has required fields', () => {
    type ContentId = z.infer<typeof contentIdSchema>;
    type Metric = NormalizedContentPack['metrics'][number];

    expectTypeOf<Metric>().toHaveProperty('id');
    expectTypeOf<Metric>().toHaveProperty('kind');
    expectTypeOf<Metric['id']>().toMatchTypeOf<ContentId>();
  });

  it('NormalizedAchievement has required fields', () => {
    type ContentId = z.infer<typeof contentIdSchema>;
    type Achievement = NormalizedContentPack['achievements'][number];

    expectTypeOf<Achievement>().toHaveProperty('id');
    expectTypeOf<Achievement>().toHaveProperty('track');
    expectTypeOf<Achievement>().toHaveProperty('tier');
    expectTypeOf<Achievement['id']>().toMatchTypeOf<ContentId>();
  });
});
