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

  it('accepts multi-stage missions without top-level duration and defaults initialStage', () => {
    const transform = transformDefinitionSchema.parse({
      ...baseTransform,
      mode: 'mission',
      outputs: [],
      entityRequirements: [
        { entityId: 'scout', count: { kind: 'constant', value: 1 } },
      ],
      outcomes: {
        success: {
          outputs: [],
        },
      },
      stages: [
        {
          id: 'entrance',
          duration: { kind: 'constant', value: 1000 },
          nextStage: null,
        },
      ],
    });

    expect(transform.initialStage).toBe('entrance');
  });

  it('enforces unique stage ids within a mission', () => {
    const result = transformDefinitionSchema.safeParse({
      ...baseTransform,
      mode: 'mission',
      outputs: [],
      entityRequirements: [
        { entityId: 'scout', count: { kind: 'constant', value: 1 } },
      ],
      outcomes: {
        success: {
          outputs: [],
        },
      },
      stages: [
        {
          id: 'loop',
          duration: { kind: 'constant', value: 1000 },
          nextStage: null,
        },
        {
          id: 'loop',
          duration: { kind: 'constant', value: 1000 },
          nextStage: null,
        },
      ],
    });

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['stages', 1, 'id'],
          message: expect.stringContaining('Duplicate stage id "loop"'),
        }),
      ]),
    );
  });

  it('requires nextStage references to resolve within stages', () => {
    const result = transformDefinitionSchema.safeParse({
      ...baseTransform,
      mode: 'mission',
      outputs: [],
      entityRequirements: [
        { entityId: 'scout', count: { kind: 'constant', value: 1 } },
      ],
      outcomes: {
        success: {
          outputs: [],
        },
      },
      stages: [
        {
          id: 'start',
          duration: { kind: 'constant', value: 1000 },
          nextStage: 'missing',
        },
      ],
    });

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['stages', 0, 'nextStage'],
        }),
      ]),
    );
  });

  it('requires decision option nextStage references to resolve within stages', () => {
    const result = transformDefinitionSchema.safeParse({
      ...baseTransform,
      mode: 'mission',
      outputs: [],
      entityRequirements: [
        { entityId: 'scout', count: { kind: 'constant', value: 1 } },
      ],
      outcomes: {
        success: {
          outputs: [],
        },
      },
      stages: [
        {
          id: 'start',
          duration: { kind: 'constant', value: 1000 },
          decision: {
            prompt: { default: 'Choose', variants: {} },
            defaultOption: 'left',
            options: [
              {
                id: 'left',
                label: { default: 'Left', variants: {} },
                nextStage: 'missing',
              },
              {
                id: 'right',
                label: { default: 'Right', variants: {} },
                nextStage: null,
              },
            ],
          },
        },
      ],
    });

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['stages', 0, 'decision', 'options', 0, 'nextStage'],
        }),
      ]),
    );
  });

  it('rejects stages that define both decision and nextStage', () => {
    const result = transformDefinitionSchema.safeParse({
      ...baseTransform,
      mode: 'mission',
      outputs: [],
      entityRequirements: [
        { entityId: 'scout', count: { kind: 'constant', value: 1 } },
      ],
      outcomes: {
        success: {
          outputs: [],
        },
      },
      stages: [
        {
          id: 'start',
          duration: { kind: 'constant', value: 1000 },
          decision: {
            prompt: { default: 'Choose', variants: {} },
            defaultOption: 'left',
            options: [
              {
                id: 'left',
                label: { default: 'Left', variants: {} },
                nextStage: null,
              },
              {
                id: 'right',
                label: { default: 'Right', variants: {} },
                nextStage: null,
              },
            ],
          },
          nextStage: null,
        },
      ],
    });

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['stages', 0, 'nextStage'],
          message: expect.stringContaining('must omit nextStage'),
        }),
      ]),
    );
  });

  it('rejects circular stage references', () => {
    expect(() =>
      transformDefinitionSchema.parse({
        ...baseTransform,
        mode: 'mission',
        outputs: [],
        entityRequirements: [
          { entityId: 'scout', count: { kind: 'constant', value: 1 } },
        ],
        outcomes: {
          success: {
            outputs: [],
          },
        },
        stages: [
          {
            id: 'a',
            duration: { kind: 'constant', value: 1000 },
            nextStage: 'b',
          },
          {
            id: 'b',
            duration: { kind: 'constant', value: 1000 },
            nextStage: 'a',
          },
        ],
      }),
    ).toThrowError(/circular stage references/i);
  });

  it('requires multi-stage missions to explicitly include a terminating nextStage: null path', () => {
    expect(() =>
      transformDefinitionSchema.parse({
        ...baseTransform,
        mode: 'mission',
        outputs: [],
        entityRequirements: [
          { entityId: 'scout', count: { kind: 'constant', value: 1 } },
        ],
        outcomes: {
          success: {
            outputs: [],
          },
        },
        stages: [
          {
            id: 'a',
            duration: { kind: 'constant', value: 1000 },
            nextStage: 'b',
          },
          {
            id: 'b',
            duration: { kind: 'constant', value: 1000 },
          },
        ],
        initialStage: 'a',
      }),
    ).toThrowError(/path that terminates/i);
  });

  it('requires decision defaultOption to reference an option id', () => {
    expect(() =>
      transformDefinitionSchema.parse({
        ...baseTransform,
        mode: 'mission',
        outputs: [],
        entityRequirements: [
          { entityId: 'scout', count: { kind: 'constant', value: 1 } },
        ],
        outcomes: {
          success: {
            outputs: [],
          },
        },
        stages: [
          {
            id: 'start',
            duration: { kind: 'constant', value: 1000 },
            decision: {
              prompt: { default: 'Choose', variants: {} },
              defaultOption: 'missing',
              options: [
                {
                  id: 'left',
                  label: { default: 'Left', variants: {} },
                  nextStage: null,
                },
                {
                  id: 'right',
                  label: { default: 'Right', variants: {} },
                  nextStage: null,
                },
              ],
            },
          },
        ],
      }),
    ).toThrowError(/defaultOption/i);
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

describe('multi-stage mission schema validation edge cases', () => {
  const baseTransform = {
    id: 'mission_test',
    name: { default: 'Mission', variants: {} },
    description: { default: 'Test mission.', variants: {} },
    mode: 'mission',
    inputs: [
      { resourceId: 'energy', amount: { kind: 'constant', value: 1 } },
    ],
    outputs: [],
    trigger: { kind: 'manual' },
    entityRequirements: [
      { entityId: 'scout', count: { kind: 'constant', value: 1 } },
    ],
    outcomes: {
      success: {
        outputs: [],
      },
    },
  } as const;

  it('rejects empty stages array', () => {
    const result = transformDefinitionSchema.safeParse({
      ...baseTransform,
      stages: [],
    });

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['stages'],
          message: expect.stringContaining('at least 1'),
        }),
      ]),
    );
  });

  it('rejects single-stage mission with nextStage pointing to itself', () => {
    expect(() =>
      transformDefinitionSchema.parse({
        ...baseTransform,
        stages: [
          {
            id: 'self_loop',
            duration: { kind: 'constant', value: 1000 },
            nextStage: 'self_loop',
          },
        ],
      }),
    ).toThrowError(/circular stage references/i);
  });

  it('rejects decision with single option (minimum 2 required)', () => {
    const result = transformDefinitionSchema.safeParse({
      ...baseTransform,
      stages: [
        {
          id: 'start',
          duration: { kind: 'constant', value: 1000 },
          decision: {
            prompt: { default: 'Choose', variants: {} },
            defaultOption: 'only',
            options: [
              {
                id: 'only',
                label: { default: 'Only Option', variants: {} },
                nextStage: null,
              },
            ],
          },
        },
      ],
    });

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: expect.arrayContaining(['stages', 0, 'decision', 'options']),
          message: expect.stringContaining('at least 2'),
        }),
      ]),
    );
  });

  it('rejects decision with more than 4 options (maximum 4 allowed)', () => {
    const result = transformDefinitionSchema.safeParse({
      ...baseTransform,
      stages: [
        {
          id: 'start',
          duration: { kind: 'constant', value: 1000 },
          decision: {
            prompt: { default: 'Choose', variants: {} },
            defaultOption: 'opt1',
            options: [
              { id: 'opt1', label: { default: 'Option 1', variants: {} }, nextStage: null },
              { id: 'opt2', label: { default: 'Option 2', variants: {} }, nextStage: null },
              { id: 'opt3', label: { default: 'Option 3', variants: {} }, nextStage: null },
              { id: 'opt4', label: { default: 'Option 4', variants: {} }, nextStage: null },
              { id: 'opt5', label: { default: 'Option 5', variants: {} }, nextStage: null },
            ],
          },
        },
      ],
    });

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: expect.arrayContaining(['stages', 0, 'decision', 'options']),
          message: expect.stringContaining('at most 4'),
        }),
      ]),
    );
  });

  it('accepts complex valid multi-path mission with branching decisions', () => {
    const transform = transformDefinitionSchema.parse({
      ...baseTransform,
      stages: [
        {
          id: 'entrance',
          duration: { kind: 'constant', value: 1000 },
          stageSuccessRate: { kind: 'constant', value: 0.9 },
          checkpoint: {
            outputs: [
              { resourceId: 'gold', amount: { kind: 'constant', value: 10 } },
            ],
            entityExperience: { kind: 'constant', value: 5 },
          },
          decision: {
            prompt: { default: 'Which path?', variants: {} },
            timeout: { kind: 'constant', value: 5000 },
            defaultOption: 'safe',
            options: [
              {
                id: 'safe',
                label: { default: 'Safe Path', variants: {} },
                nextStage: 'safe_room',
                modifiers: {
                  successRateBonus: { kind: 'constant', value: 0.1 },
                },
              },
              {
                id: 'risky',
                label: { default: 'Risky Path', variants: {} },
                nextStage: 'treasure_room',
                modifiers: {
                  outputMultiplier: { kind: 'constant', value: 2 },
                },
              },
              {
                id: 'retreat',
                label: { default: 'Retreat', variants: {} },
                nextStage: null,
              },
            ],
          },
        },
        {
          id: 'safe_room',
          duration: { kind: 'constant', value: 2000 },
          stageSuccessRate: { kind: 'constant', value: 0.95 },
          stageOutcomes: {
            success: {
              outputs: [
                { resourceId: 'gold', amount: { kind: 'constant', value: 20 } },
              ],
            },
          },
          nextStage: null,
        },
        {
          id: 'treasure_room',
          duration: { kind: 'constant', value: 3000 },
          stageSuccessRate: { kind: 'constant', value: 0.7 },
          stageOutcomes: {
            success: {
              outputs: [
                { resourceId: 'gold', amount: { kind: 'constant', value: 100 } },
              ],
              entityExperience: { kind: 'constant', value: 25 },
            },
            failure: {
              outputs: [
                { resourceId: 'gold', amount: { kind: 'constant', value: 5 } },
              ],
            },
          },
          nextStage: null,
        },
      ],
      initialStage: 'entrance',
    });

    // Verify the mission was parsed correctly
    expect(transform.stages).toHaveLength(3);
    expect(transform.initialStage).toBe('entrance');

    // Verify entrance stage has correct structure
    const entranceStage = transform.stages?.find((s) => s.id === 'entrance');
    expect(entranceStage?.decision?.options).toHaveLength(3);
    expect(entranceStage?.checkpoint?.entityExperience).toEqual({
      kind: 'constant',
      value: 5,
    });

    // Verify branching paths lead to correct destinations
    const safeOption = entranceStage?.decision?.options.find(
      (o) => o.id === 'safe',
    );
    expect(safeOption?.nextStage).toBe('safe_room');
    expect(safeOption?.modifiers?.successRateBonus).toEqual({
      kind: 'constant',
      value: 0.1,
    });

    const riskyOption = entranceStage?.decision?.options.find(
      (o) => o.id === 'risky',
    );
    expect(riskyOption?.nextStage).toBe('treasure_room');
    expect(riskyOption?.modifiers?.outputMultiplier).toEqual({
      kind: 'constant',
      value: 2,
    });

    // Verify terminal stages
    const safeRoom = transform.stages?.find((s) => s.id === 'safe_room');
    expect(safeRoom?.nextStage).toBeNull();
    expect(safeRoom?.stageOutcomes?.success).toBeDefined();

    const treasureRoom = transform.stages?.find((s) => s.id === 'treasure_room');
    expect(treasureRoom?.nextStage).toBeNull();
    expect(treasureRoom?.stageOutcomes?.failure).toBeDefined();
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
