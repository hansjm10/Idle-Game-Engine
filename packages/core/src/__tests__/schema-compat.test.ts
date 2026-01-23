import { describe, expect, it } from 'vitest';

import {
  FEATURE_GATES,
  createAutomation,
  createContentPackValidator,
  createEntity,
  createPrestigeLayer,
  createResource,
  createTransform,
  resolveFeatureViolations,
  type FeatureGateMap,
  type FeatureGateModule,
} from '@idle-engine/content-schema';

import { RUNTIME_VERSION } from '../version.js';

describe('schema compatibility', () => {
  it('requires RUNTIME_VERSION to satisfy all FEATURE_GATES', () => {
    const allEnabled = FEATURE_GATES.reduce<Record<FeatureGateModule, boolean>>(
      (acc, gate) => {
        acc[gate.module] = true;
        return acc;
      },
      {} as Record<FeatureGateModule, boolean>,
    );

    const violations = resolveFeatureViolations(
      RUNTIME_VERSION,
      allEnabled as FeatureGateMap,
    );

    expect(violations).toEqual([]);
  });

  it('validates a compat pack with all gated modules enabled', () => {
    const pack = {
      metadata: {
        id: 'schema-compat',
        title: { default: 'Schema compatibility check pack' },
        version: '0.0.0',
        engine: `>=${RUNTIME_VERSION}`,
        defaultLocale: 'en-US',
        supportedLocales: ['en-US'],
      },
      resources: [
        createResource({
          id: 'schema-compat.energy',
          name: { default: 'Energy' },
          category: 'currency',
          tier: 1,
        }),
        createResource({
          id: 'schema-compat.prestige',
          name: { default: 'Prestige' },
          category: 'prestige',
          tier: 1,
        }),
        createResource({
          id: 'schema-compat.rebirth-prestige-count',
          name: { default: 'Rebirth Count' },
          category: 'prestige',
          tier: 1,
        }),
      ],
      entities: [
        createEntity({
          id: 'schema-compat.entity',
          name: { default: 'Schema Entity' },
          description: { default: 'Minimal entity for schema-compat validation.' },
          stats: [
            {
              id: 'schema-compat.health',
              name: { default: 'Health' },
              baseValue: { kind: 'constant', value: 1 },
            },
          ],
        }),
      ],
      generators: [],
      upgrades: [],
      metrics: [],
      achievements: [],
      automations: [
        createAutomation({
          id: 'schema-compat.automation',
          name: { default: 'Schema Automation' },
          description: { default: 'Minimal system automation for schema-compat validation.' },
          targetType: 'system',
          systemTargetId: 'offline-catchup',
          trigger: { kind: 'interval', interval: { kind: 'constant', value: 1 } },
          unlockCondition: { kind: 'always' },
        }),
      ],
      transforms: [
        createTransform({
          id: 'schema-compat.transform',
          name: { default: 'Schema Transform' },
          description: { default: 'Minimal transform for schema-compat validation.' },
          mode: 'instant',
          trigger: { kind: 'manual' },
          inputs: [{ resourceId: 'schema-compat.energy', amount: { kind: 'constant', value: 1 } }],
          outputs: [{ resourceId: 'schema-compat.energy', amount: { kind: 'constant', value: 1 } }],
        }),
      ],
      prestigeLayers: [
        createPrestigeLayer({
          id: 'schema-compat.rebirth',
          name: { default: 'Rebirth' },
          summary: { default: 'Reset for prestige.' },
          unlockCondition: { kind: 'always' },
          reward: {
            resourceId: 'schema-compat.prestige',
            baseReward: { kind: 'constant', value: 1 },
          },
          resetTargets: ['schema-compat.energy'],
        }),
      ],
      runtimeEvents: [
        {
          namespace: 'schema-compat',
          name: 'runtime-event',
          version: 1,
          payload: { kind: 'zod', schemaPath: 'schemas/runtime-event.ts' },
        },
      ],
    } as const;

    const result = createContentPackValidator({ runtimeVersion: RUNTIME_VERSION }).parse(pack);

    expect(result.warnings).toEqual([]);
    expect(result.balanceWarnings).toEqual([]);
    expect(result.balanceErrors).toEqual([]);
  });
});

