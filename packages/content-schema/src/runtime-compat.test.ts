import { describe, expect, it } from 'vitest';

import {
  FEATURE_GATES,
  resolveFeatureViolations,
  type FeatureGateMap,
  type FeatureGateModule,
} from './runtime-compat.js';

const buildFeatureGateMap = (overrides: Partial<FeatureGateMap>): FeatureGateMap => {
  const map: Record<FeatureGateModule, boolean> = {} as Record<FeatureGateModule, boolean>;

  FEATURE_GATES.forEach((gate) => {
    map[gate.module] = overrides[gate.module] ?? false;
  });

  return map;
};

describe('resolveFeatureViolations', () => {
  it('treats prerelease runtimes as older than required releases', () => {
    const gateMap = buildFeatureGateMap({ automations: true });

    const violations = resolveFeatureViolations('0.2.0-beta.1', gateMap);

    expect(violations).toEqual([
      expect.objectContaining({
        module: 'automations',
        severity: 'error',
      }),
    ]);
  });

  it('accepts clean release versions with a leading v prefix', () => {
    const gateMap = buildFeatureGateMap({ automations: true });

    const violations = resolveFeatureViolations('v0.2.0', gateMap);

    expect(violations).toHaveLength(0);
  });
});
