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
