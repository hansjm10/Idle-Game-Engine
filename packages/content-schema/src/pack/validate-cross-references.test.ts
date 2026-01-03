import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { createContentPackValidator } from '../index.js';

const createBasePack = () => ({
  metadata: {
    id: 'cross-reference-pack',
    title: { default: 'Cross Reference Pack' },
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
  },
  resources: [],
  entities: [],
  generators: [],
  upgrades: [],
  metrics: [],
  achievements: [],
  automations: [],
  transforms: [],
  prestigeLayers: [],
  runtimeEvents: [],
});

const getZodIssues = (error: unknown) => {
  expect(error).toBeInstanceOf(ZodError);
  return (error as ZodError).issues;
};

const baseAchievement = {
  name: { default: 'Test Achievement' },
  description: { default: 'Test Description' },
  category: 'progression',
  tier: 'bronze',
};

describe('validateCrossReferences', () => {
  it('reports missing runtime event emitters and script allowlist violations', () => {
    const pack = {
      ...createBasePack(),
      runtimeEvents: [
        {
          namespace: 'test',
          name: 'emit-event',
          version: 1,
          payload: {
            kind: 'zod',
            schemaPath: './schemas/emit-event.ts',
          },
          emits: [
            { source: 'achievement', id: 'achievement:missing' },
            { source: 'upgrade', id: 'upgrade:missing' },
            { source: 'transform', id: 'transform:missing' },
            { source: 'script', id: 'script:missing' },
          ],
        },
      ],
    };
    const validator = createContentPackValidator({
      allowlists: {
        scripts: {
          required: ['script:allowed'],
        },
      },
    });
    const result = validator.safeParse(pack);
    expect(result.success).toBe(false);
    if (result.success) return;

    const issues = getZodIssues(result.error);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining(
            'unknown achievement "achievement:missing"',
          ),
        }),
        expect.objectContaining({
          message: expect.stringContaining(
            'unknown upgrade "upgrade:missing"',
          ),
        }),
        expect.objectContaining({
          message: expect.stringContaining(
            'unknown transform "transform:missing"',
          ),
        }),
        expect.objectContaining({
          message: expect.stringContaining('scripts allowlist'),
        }),
      ]),
    );
  });

  it('reports missing upgrade targets across modules', () => {
    const pack = {
      ...createBasePack(),
      resources: [
        {
          id: 'resource:energy',
          name: { default: 'Energy' },
          category: 'primary',
          tier: 1,
        },
      ],
      upgrades: [
        {
          id: 'upgrade:targets',
          name: { default: 'Targets' },
          category: 'global',
          targets: [
            { kind: 'resource', id: 'resource:missing' },
            { kind: 'generator', id: 'generator:missing' },
            { kind: 'automation', id: 'automation:missing' },
            { kind: 'prestigeLayer', id: 'prestige:missing' },
          ],
          cost: {
            currencyId: 'resource:energy',
            costMultiplier: 1,
            costCurve: { kind: 'constant', value: 1 },
          },
          effects: [
            {
              kind: 'unlockResource',
              resourceId: 'resource:energy',
            },
          ],
        },
      ],
    };
    const result = createContentPackValidator().safeParse(pack);
    expect(result.success).toBe(false);
    if (result.success) return;

    const issues = getZodIssues(result.error);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining(
            'targets unknown resource "resource:missing"',
          ),
        }),
        expect.objectContaining({
          message: expect.stringContaining(
            'targets unknown generator "generator:missing"',
          ),
        }),
        expect.objectContaining({
          message: expect.stringContaining(
            'targets unknown automation "automation:missing"',
          ),
        }),
        expect.objectContaining({
          message: expect.stringContaining(
            'targets unknown prestige layer "prestige:missing"',
          ),
        }),
      ]),
    );
  });

  it('reports missing achievement track references and allowlist violations', () => {
    const pack = {
      ...createBasePack(),
      achievements: [
        {
          id: 'achievement:resource-track',
          ...baseAchievement,
          track: {
            kind: 'resource',
            resourceId: 'resource:missing',
            threshold: { kind: 'constant', value: 1 },
            comparator: 'gte',
          },
        },
        {
          id: 'achievement:generator-track',
          ...baseAchievement,
          track: {
            kind: 'generator-level',
            generatorId: 'generator:missing',
            level: { kind: 'constant', value: 1 },
          },
        },
        {
          id: 'achievement:upgrade-track',
          ...baseAchievement,
          track: {
            kind: 'upgrade-owned',
            upgradeId: 'upgrade:missing',
            purchases: { kind: 'constant', value: 1 },
          },
        },
        {
          id: 'achievement:flag-track',
          ...baseAchievement,
          track: {
            kind: 'flag',
            flagId: 'flag:missing',
          },
        },
        {
          id: 'achievement:script-track',
          ...baseAchievement,
          track: {
            kind: 'script',
            scriptId: 'script:missing',
          },
        },
        {
          id: 'achievement:metric-track',
          ...baseAchievement,
          track: {
            kind: 'custom-metric',
            metricId: 'metric:missing',
            threshold: { kind: 'constant', value: 1 },
          },
        },
      ],
    };
    const validator = createContentPackValidator({
      allowlists: {
        flags: { required: ['flag:allowed'] },
        scripts: { required: ['script:allowed'] },
      },
    });
    const result = validator.safeParse(pack);
    expect(result.success).toBe(false);
    if (result.success) return;

    const issues = getZodIssues(result.error);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining(
            'unknown resource "resource:missing"',
          ),
        }),
        expect.objectContaining({
          message: expect.stringContaining(
            'unknown generator "generator:missing"',
          ),
        }),
        expect.objectContaining({
          message: expect.stringContaining(
            'unknown upgrade "upgrade:missing"',
          ),
        }),
        expect.objectContaining({
          message: expect.stringContaining('flags allowlist'),
        }),
        expect.objectContaining({
          message: expect.stringContaining('scripts allowlist'),
        }),
        expect.objectContaining({
          message: expect.stringContaining(
            'unknown metric "metric:missing"',
          ),
        }),
      ]),
    );
  });

  it('reports missing achievement reward references and runtime events', () => {
    const pack = {
      ...createBasePack(),
      resources: [
        {
          id: 'resource:energy',
          name: { default: 'Energy' },
          category: 'primary',
          tier: 1,
        },
      ],
      achievements: [
        {
          id: 'achievement:reward-resource',
          ...baseAchievement,
          track: {
            kind: 'resource',
            resourceId: 'resource:energy',
            threshold: { kind: 'constant', value: 1 },
            comparator: 'gte',
          },
          reward: {
            kind: 'grantResource',
            resourceId: 'resource:missing',
            amount: { kind: 'constant', value: 1 },
          },
        },
        {
          id: 'achievement:reward-upgrade',
          ...baseAchievement,
          track: {
            kind: 'resource',
            resourceId: 'resource:energy',
            threshold: { kind: 'constant', value: 1 },
            comparator: 'gte',
          },
          reward: {
            kind: 'grantUpgrade',
            upgradeId: 'upgrade:missing',
          },
        },
        {
          id: 'achievement:reward-event',
          ...baseAchievement,
          track: {
            kind: 'resource',
            resourceId: 'resource:energy',
            threshold: { kind: 'constant', value: 1 },
            comparator: 'gte',
          },
          reward: {
            kind: 'emitEvent',
            eventId: 'runtime:missing',
          },
          onUnlockEvents: ['runtime:missing-on-unlock'],
        },
        {
          id: 'achievement:reward-automation',
          ...baseAchievement,
          track: {
            kind: 'resource',
            resourceId: 'resource:energy',
            threshold: { kind: 'constant', value: 1 },
            comparator: 'gte',
          },
          reward: {
            kind: 'unlockAutomation',
            automationId: 'automation:missing',
          },
        },
        {
          id: 'achievement:reward-flag',
          ...baseAchievement,
          track: {
            kind: 'resource',
            resourceId: 'resource:energy',
            threshold: { kind: 'constant', value: 1 },
            comparator: 'gte',
          },
          reward: {
            kind: 'grantFlag',
            flagId: 'flag:missing',
          },
        },
      ],
    };
    const validator = createContentPackValidator({
      runtimeEventCatalogue: ['runtime:known'],
      allowlists: {
        flags: { required: ['flag:allowed'] },
      },
    });
    const result = validator.safeParse(pack);
    expect(result.success).toBe(false);
    if (result.success) return;

    const issues = getZodIssues(result.error);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining(
            'grants unknown resource "resource:missing"',
          ),
        }),
        expect.objectContaining({
          message: expect.stringContaining(
            'grants unknown upgrade "upgrade:missing"',
          ),
        }),
        expect.objectContaining({
          message: expect.stringContaining(
            'unlocks unknown automation "automation:missing"',
          ),
        }),
        expect.objectContaining({
          message: expect.stringContaining('flags allowlist'),
        }),
        expect.objectContaining({
          message: expect.stringContaining('Runtime event "runtime:missing"'),
        }),
        expect.objectContaining({
          message: expect.stringContaining(
            'Runtime event "runtime:missing-on-unlock"',
          ),
        }),
      ]),
    );
  });

  it('emits warnings for runtime events and soft allowlists', () => {
    const pack = {
      ...createBasePack(),
      resources: [
        {
          id: 'resource:energy',
          name: { default: 'Energy' },
          category: 'primary',
          tier: 1,
        },
      ],
      achievements: [
        {
          id: 'achievement:flag-track',
          ...baseAchievement,
          track: {
            kind: 'flag',
            flagId: 'flag:missing',
          },
          reward: {
            kind: 'emitEvent',
            eventId: 'runtime:missing',
          },
          onUnlockEvents: ['runtime:missing-on-unlock'],
        },
      ],
      automations: [
        {
          id: 'automation:system-event',
          name: { default: 'Automation' },
          description: { default: 'Automation' },
          targetType: 'system',
          systemTargetId: 'offline-catchup',
          trigger: {
            kind: 'event',
            eventId: 'runtime:missing',
          },
          unlockCondition: { kind: 'always' },
          scriptId: 'script:missing',
        },
      ],
      transforms: [
        {
          id: 'transform:event',
          name: { default: 'Transform' },
          description: { default: 'Transform' },
          mode: 'instant',
          inputs: [
            {
              resourceId: 'resource:energy',
              amount: { kind: 'constant', value: 1 },
            },
          ],
          outputs: [
            {
              resourceId: 'resource:energy',
              amount: { kind: 'constant', value: 1 },
            },
          ],
          trigger: {
            kind: 'event',
            eventId: 'runtime:missing',
          },
        },
      ],
    };
    const validator = createContentPackValidator({
      allowlists: {
        flags: { soft: ['flag:allowed'] },
        scripts: { soft: ['script:allowed'] },
        systemAutomationTargets: { soft: ['research-daemon'] },
      },
    });
    const result = validator.safeParse(pack);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'runtimeEvent.unknown' }),
        expect.objectContaining({ code: 'allowlist.flag.missing' }),
        expect.objectContaining({ code: 'allowlist.script.missing' }),
        expect.objectContaining({ code: 'allowlist.systemAutomationTarget.missing' }),
      ]),
    );
  });

  it('reports missing automation trigger resources and formula references', () => {
    const pack = {
      ...createBasePack(),
      resources: [
        {
          id: 'resource:energy',
          name: { default: 'Energy' },
          category: 'primary',
          tier: 1,
        },
      ],
      automations: [
        {
          id: 'automation:collect',
          name: { default: 'Collect' },
          description: { default: 'Collect' },
          targetType: 'collectResource',
          targetId: 'resource:energy',
          trigger: {
            kind: 'resourceThreshold',
            resourceId: 'resource:missing',
            comparator: 'gte',
            threshold: {
              kind: 'expression',
              expression: {
                kind: 'call',
                name: 'root',
                args: [
                  {
                    kind: 'binary',
                    op: 'add',
                    left: {
                      kind: 'ref',
                      target: { type: 'generator', id: 'generator:missing' },
                    },
                    right: {
                      kind: 'ref',
                      target: { type: 'upgrade', id: 'upgrade:missing' },
                    },
                  },
                  {
                    kind: 'unary',
                    op: 'abs',
                    operand: {
                      kind: 'binary',
                      op: 'sub',
                      left: {
                        kind: 'ref',
                        target: {
                          type: 'automation',
                          id: 'automation:missing',
                        },
                      },
                      right: {
                        kind: 'ref',
                        target: {
                          type: 'prestigeLayer',
                          id: 'prestige:missing',
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
          unlockCondition: { kind: 'always' },
        },
      ],
    };
    const result = createContentPackValidator().safeParse(pack);
    expect(result.success).toBe(false);
    if (result.success) return;

    const issues = getZodIssues(result.error);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining(
            'trigger references unknown resource "resource:missing"',
          ),
        }),
        expect.objectContaining({
          message: expect.stringContaining(
            'Formula references unknown generator "generator:missing"',
          ),
        }),
        expect.objectContaining({
          message: expect.stringContaining(
            'Formula references unknown upgrade "upgrade:missing"',
          ),
        }),
        expect.objectContaining({
          message: expect.stringContaining(
            'Formula references unknown automation "automation:missing"',
          ),
        }),
        expect.objectContaining({
          message: expect.stringContaining(
            'Formula references unknown prestige layer "prestige:missing"',
          ),
        }),
      ]),
    );
  });
});
