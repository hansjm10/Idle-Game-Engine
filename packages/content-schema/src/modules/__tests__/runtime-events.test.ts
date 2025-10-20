import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import {
  runtimeEventContributionCollectionSchema,
  runtimeEventContributionSchema,
} from '../runtime-events.js';

describe('runtimeEventContributionSchema', () => {
  it('normalizes canonical id, tags, and schema paths', () => {
    const contribution = runtimeEventContributionSchema.parse({
      namespace: ' Sample ',
      name: ' Reactor-Primed ',
      version: 2,
      payload: {
        kind: 'json-schema',
        schemaPath: '.\\schemas/events/reactor-primed.schema.json',
      },
      tags: [' First ', 'second', 'first'],
      emits: [
        { source: 'achievement', id: 'sample:achievement.react' },
        { source: 'upgrade', id: 'sample:upgrade.reactor' },
      ],
    });

    expect(contribution.id).toBe('sample:reactor-primed');
    expect(contribution.namespace).toBe('sample');
    expect(contribution.name).toBe('reactor-primed');
    expect(contribution.payload.schemaPath).toBe(
      './schemas/events/reactor-primed.schema.json',
    );
    expect(contribution.tags).toEqual(['first', 'second']);
    expect(Object.isFrozen(contribution)).toBe(true);
    expect(Object.isFrozen(contribution.tags)).toBe(true);
    expect(Object.isFrozen(contribution.emits)).toBe(true);
    expect(Object.isFrozen(contribution.payload)).toBe(true);
  });

  it('defaults optional fields when omitted', () => {
    const contribution = runtimeEventContributionSchema.parse({
      namespace: 'core',
      name: 'tick-advanced',
      version: 1,
      payload: {
        kind: 'zod',
        schemaPath: 'schemas/events/tick-advanced.ts',
      },
    });

    expect(contribution.id).toBe('core:tick-advanced');
    expect(contribution.emits).toEqual([]);
    expect(contribution.tags).toEqual([]);
  });

  it('rejects mismatched canonical ids', () => {
    expect(() =>
      runtimeEventContributionSchema.parse({
        id: 'sample:another-event',
        namespace: 'sample',
        name: 'reactor-primed',
        version: 1,
        payload: {
          kind: 'json-schema',
          schemaPath: './schemas/events/reactor-primed.schema.json',
        },
      }),
    ).toThrowError(/canonical namespace:name form/);
  });

  it('rejects schema paths that walk above the pack root', () => {
    expect(() =>
      runtimeEventContributionSchema.parse({
        namespace: 'sample',
        name: 'invalid-path',
        version: 1,
        payload: {
          kind: 'json-schema',
          schemaPath: '../schemas/events/reactor-primed.schema.json',
        },
      }),
    ).toThrowError(/must not traverse parent directories/);
  });

  it('rejects schema paths that are absolute', () => {
    expect(() =>
      runtimeEventContributionSchema.parse({
        namespace: 'sample',
        name: 'absolute-path',
        version: 1,
        payload: {
          kind: 'zod',
          schemaPath: '/tmp/schema.ts',
        },
      }),
    ).toThrowError(/must not be absolute/);

    expect(() =>
      runtimeEventContributionSchema.parse({
        namespace: 'sample',
        name: 'absolute-drive',
        version: 1,
        payload: {
          kind: 'zod',
          schemaPath: 'C:\\schemas\\events\\reactor.ts',
        },
      }),
    ).toThrowError(/must not use absolute drive references/);
  });
});

describe('runtimeEventContributionCollectionSchema', () => {
  it('sorts contributions by canonical id', () => {
    const contributions = runtimeEventContributionCollectionSchema.parse([
      {
        namespace: 'beta',
        name: 'launch',
        version: 1,
        payload: { kind: 'zod', schemaPath: 'schemas/events/launch.ts' },
      },
      {
        namespace: 'alpha',
        name: 'ignite',
        version: 1,
        payload: { kind: 'zod', schemaPath: 'schemas/events/ignite.ts' },
      },
    ]);

    expect(contributions.map((entry) => entry.id)).toEqual([
      'alpha:ignite',
      'beta:launch',
    ]);
  });

  it('rejects duplicate runtime event ids', () => {
    expect.assertions(2);
    try {
      runtimeEventContributionCollectionSchema.parse([
        {
          namespace: 'dup',
          name: 'event',
          version: 1,
          payload: { kind: 'zod', schemaPath: 'schemas/events/dup.ts' },
        },
        {
          namespace: 'dup',
          name: 'event',
          version: 2,
          payload: { kind: 'zod', schemaPath: 'schemas/events/dup.v2.ts' },
        },
      ]);
    } catch (error) {
      expect(error).toBeInstanceOf(ZodError);
      if (error instanceof ZodError) {
        expect(error.issues[0]?.message).toContain(
          'Duplicate runtime event id "dup:event"',
        );
      }
    }
  });
});
