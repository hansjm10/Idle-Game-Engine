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
