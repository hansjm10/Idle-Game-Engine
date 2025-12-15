import { describe, expect, it } from 'vitest';

import {
  automationCollectionSchema,
  automationDefinitionSchema,
} from '../automations.js';

describe('automationDefinitionSchema', () => {
  const baseAutomation = {
    id: 'auto-reactor',
    name: { default: 'Reactor Toggle', variants: {} },
    description: { default: 'Keeps the reactor running.', variants: {} },
    targetType: 'generator',
    targetId: 'reactor',
    trigger: {
      kind: 'interval',
      interval: { kind: 'constant', value: 1_000 },
    },
    unlockCondition: { kind: 'always' },
  } as const;

  it('defaults enabledByDefault to false', () => {
    const automation = automationDefinitionSchema.parse({
      ...baseAutomation,
    });

    expect(automation.enabledByDefault).toBe(false);
  });

  it('requires systemTargetId for system automations', () => {
    expect(() =>
      automationDefinitionSchema.parse({
        ...baseAutomation,
        id: 'auto-system',
        targetType: 'system',
        targetId: undefined,
      }),
    ).toThrowError(/systemTargetId/i);
  });

  it('requires targetId when not targeting system features', () => {
    expect(() =>
      automationDefinitionSchema.parse({
        ...baseAutomation,
        targetId: undefined,
      }),
    ).toThrowError(/targetId/i);
  });

  it('accepts targetEnabled for generator automations', () => {
    const automation = automationDefinitionSchema.parse({
      ...baseAutomation,
      targetEnabled: false,
    });

    expect(automation.targetEnabled).toBe(false);
  });

  it('rejects targetEnabled for non-generator automations', () => {
    expect(() =>
      automationDefinitionSchema.parse({
        ...baseAutomation,
        targetType: 'upgrade',
        targetEnabled: true,
      }),
    ).toThrowError(/targetEnabled/i);
  });

  it('accepts purchaseGenerator automations with targetCount', () => {
    const automation = automationDefinitionSchema.parse({
      ...baseAutomation,
      targetType: 'purchaseGenerator',
      targetCount: { kind: 'constant', value: 3 },
    });

    expect(automation.targetType).toBe('purchaseGenerator');
    expect(automation.targetCount).toEqual({ kind: 'constant', value: 3 });
  });

  it('accepts collectResource automations with targetAmount', () => {
    const automation = automationDefinitionSchema.parse({
      ...baseAutomation,
      targetType: 'collectResource',
      targetAmount: { kind: 'constant', value: 2 },
    });

    expect(automation.targetType).toBe('collectResource');
    expect(automation.targetAmount).toEqual({ kind: 'constant', value: 2 });
  });
});

describe('automationCollectionSchema', () => {
  it('rejects duplicate automation ids', () => {
    expect(() =>
      automationCollectionSchema.parse([
        {
          id: 'auto-reactor',
          name: { default: 'Reactor Toggle', variants: {} },
          description: { default: 'Keeps the reactor running.', variants: {} },
          targetType: 'generator',
          targetId: 'reactor',
          trigger: {
            kind: 'interval',
            interval: { kind: 'constant', value: 1_000 },
          },
          unlockCondition: { kind: 'always' },
        },
        {
          id: 'auto-reactor',
          name: { default: 'Duplicate', variants: {} },
          description: { default: 'Duplicate automation.', variants: {} },
          targetType: 'generator',
          targetId: 'reactor',
          trigger: {
            kind: 'interval',
            interval: { kind: 'constant', value: 500 },
          },
          unlockCondition: { kind: 'always' },
        },
      ]),
    ).toThrowError(/duplicate automation id/i);
  });
});
