import { describe, expect, it } from 'vitest';

import {
  transformCollectionSchema,
  transformDefinitionSchema,
} from '../transforms.js';

describe('transformDefinitionSchema', () => {
  const baseTransform = {
    id: 'refinery',
    name: { default: 'Refinery', variants: {} },
    description: { default: 'Converts ore into bars.', variants: {} },
    mode: 'instant',
    inputs: [{ resourceId: 'raw-ore', amount: { kind: 'constant', value: 10 } }],
    outputs: [{ resourceId: 'bar', amount: { kind: 'constant', value: 1 } }],
    trigger: { kind: 'manual' },
  } as const;

  it('requires automation reference when trigger uses automation', () => {
    expect(() =>
      transformDefinitionSchema.parse({
        ...baseTransform,
        trigger: { kind: 'automation', automationId: 'auto-refinery' },
      }),
    ).toThrowError(/matching automation reference/i);
  });

  it('requires batch transforms to define a duration', () => {
    expect(() =>
      transformDefinitionSchema.parse({
        ...baseTransform,
        mode: 'batch',
      }),
    ).toThrowError(/declare a duration/i);
  });

  it('rejects non-mission transforms with empty outputs', () => {
    expect(() =>
      transformDefinitionSchema.parse({
        ...baseTransform,
        outputs: [],
      }),
    ).toThrowError(/produce at least one resource/i);
  });

  it('requires mission transforms to declare outcomes', () => {
    expect(() =>
      transformDefinitionSchema.parse({
        ...baseTransform,
        mode: 'mission',
        outputs: [],
        duration: { kind: 'constant', value: 60000 },
        entityRequirements: [
          { entityId: 'scout', count: { kind: 'constant', value: 1 } },
        ],
      }),
    ).toThrowError(/declare outcomes/i);
  });

  it('requires mission transforms to declare a duration', () => {
    const result = transformDefinitionSchema.safeParse({
      ...baseTransform,
      mode: 'mission',
      outputs: [],
      entityRequirements: [
        { entityId: 'scout', count: { kind: 'constant', value: 1 } },
      ],
      outcomes: {
        success: {
          outputs: [
            { resourceId: 'bar', amount: { kind: 'constant', value: 1 } },
          ],
        },
      },
    });

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining('declare a duration'),
        }),
      ]),
    );
  });

  it('requires mission transforms to declare entity requirements', () => {
    const result = transformDefinitionSchema.safeParse({
      ...baseTransform,
      mode: 'mission',
      outputs: [],
      duration: { kind: 'constant', value: 60000 },
      outcomes: {
        success: {
          outputs: [
            { resourceId: 'bar', amount: { kind: 'constant', value: 1 } },
          ],
        },
      },
    });

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining('declare entity requirements'),
        }),
      ]),
    );
  });

  it('accepts mission transforms with empty outputs', () => {
    const transform = transformDefinitionSchema.parse({
      ...baseTransform,
      mode: 'mission',
      outputs: [],
      duration: { kind: 'constant', value: 60000 },
      entityRequirements: [
        { entityId: 'scout', count: { kind: 'constant', value: 1 } },
      ],
      outcomes: {
        success: {
          outputs: [
            { resourceId: 'bar', amount: { kind: 'constant', value: 1 } },
          ],
          entityExperience: { kind: 'constant', value: 10 },
        },
      },
    });

    expect(transform.outputs).toEqual([]);
  });

  it('accepts non-constant mission success rate base rates', () => {
    const transform = transformDefinitionSchema.parse({
      ...baseTransform,
      mode: 'mission',
      outputs: [],
      duration: { kind: 'constant', value: 60000 },
      entityRequirements: [
        { entityId: 'scout', count: { kind: 'constant', value: 1 } },
      ],
      successRate: {
        baseRate: {
          kind: 'expression',
          expression: { kind: 'literal', value: 2 },
        },
      },
      outcomes: {
        success: {
          outputs: [
            { resourceId: 'bar', amount: { kind: 'constant', value: 1 } },
          ],
        },
      },
    });

    expect(transform.successRate?.baseRate.kind).toBe('expression');
  });

  it('defaults mission requirement and success rate fields', () => {
    const transform = transformDefinitionSchema.parse({
      ...baseTransform,
      mode: 'mission',
      outputs: [],
      duration: { kind: 'constant', value: 60000 },
      entityRequirements: [
        { entityId: 'scout', count: { kind: 'constant', value: 1 } },
      ],
      successRate: {
        baseRate: { kind: 'constant', value: 0.5 },
        statModifiers: [
          {
            stat: 'perception',
            weight: { kind: 'constant', value: 0.2 },
          },
        ],
      },
      outcomes: {
        success: {
          outputs: [
            { resourceId: 'bar', amount: { kind: 'constant', value: 1 } },
          ],
        },
      },
    });

    expect(transform.entityRequirements?.[0].returnOnComplete).toBe(true);
    expect(transform.successRate?.usePRD).toBe(false);
    expect(transform.successRate?.statModifiers?.[0].entityScope).toBe('average');
  });

  it('rejects mission success rates outside [0, 1]', () => {
    expect(() =>
      transformDefinitionSchema.parse({
        ...baseTransform,
        mode: 'mission',
        outputs: [],
        duration: { kind: 'constant', value: 5000 },
        entityRequirements: [
          { entityId: 'scout', count: { kind: 'constant', value: 1 } },
        ],
        successRate: {
          baseRate: { kind: 'constant', value: 1.5 },
        },
        outcomes: {
          success: {
            outputs: [
              { resourceId: 'bar', amount: { kind: 'constant', value: 1 } },
            ],
          },
        },
      }),
    ).toThrowError(/between 0 and 1/i);
  });

  it('requires critical outcomes to declare a chance', () => {
    const result = transformDefinitionSchema.safeParse({
      ...baseTransform,
      mode: 'mission',
      outputs: [],
      duration: { kind: 'constant', value: 60000 },
      entityRequirements: [
        { entityId: 'scout', count: { kind: 'constant', value: 1 } },
      ],
      outcomes: {
        success: {
          outputs: [
            { resourceId: 'bar', amount: { kind: 'constant', value: 1 } },
          ],
        },
        critical: {
          outputs: [
            { resourceId: 'bar', amount: { kind: 'constant', value: 2 } },
          ],
        },
      },
    });

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['outcomes', 'critical', 'chance'],
        }),
      ]),
    );
  });

  it('accepts numeric cooldown shorthand', () => {
    const transform = transformDefinitionSchema.parse({
      ...baseTransform,
      cooldown: 2500,
    });

    expect(transform.cooldown).toEqual({ kind: 'constant', value: 2500 });
  });

  it('normalizes tags', () => {
    const transform = transformDefinitionSchema.parse({
      ...baseTransform,
      tags: ['Production', 'production'],
    });

    expect(transform.tags).toEqual(['production']);
  });
});

describe('transformCollectionSchema', () => {
  it('rejects duplicate transform ids', () => {
    expect(() =>
      transformCollectionSchema.parse([
        {
          id: 'refinery',
          name: { default: 'Refinery', variants: {} },
          description: { default: 'Converts ore.', variants: {} },
          mode: 'instant',
          inputs: [
            { resourceId: 'raw-ore', amount: { kind: 'constant', value: 10 } },
          ],
          outputs: [
            { resourceId: 'bar', amount: { kind: 'constant', value: 1 } },
          ],
          trigger: { kind: 'manual' },
        },
        {
          id: 'refinery',
          name: { default: 'Refinery Copy', variants: {} },
          description: { default: 'Duplicate.', variants: {} },
          mode: 'instant',
          inputs: [
            { resourceId: 'raw-ore', amount: { kind: 'constant', value: 5 } },
          ],
          outputs: [
            { resourceId: 'bar', amount: { kind: 'constant', value: 1 } },
          ],
          trigger: { kind: 'manual' },
        },
      ]),
    ).toThrowError(/duplicate transform id/i);
  });
});
