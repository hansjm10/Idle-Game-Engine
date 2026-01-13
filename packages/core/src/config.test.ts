import { describe, expect, it } from 'vitest';

import { DEFAULT_ENGINE_CONFIG, resolveEngineConfig } from './config.js';

describe('resolveEngineConfig', () => {
  it('falls back to defaults for invalid precision overrides', () => {
    const config = resolveEngineConfig({
      precision: {
        dirtyEpsilonAbsolute: -1,
        dirtyEpsilonRelative: Number.NaN,
        dirtyEpsilonCeiling: Number.POSITIVE_INFINITY,
        dirtyEpsilonOverrideMax: -0.5,
      },
    });

    expect(config.precision).toEqual(DEFAULT_ENGINE_CONFIG.precision);
  });

  it('normalizes precision ordering (absolute <= ceiling <= overrideMax)', () => {
    const config = resolveEngineConfig({
      precision: {
        dirtyEpsilonAbsolute: 1e-2,
        dirtyEpsilonCeiling: 1e-4,
        dirtyEpsilonOverrideMax: 1e-3,
      },
    });

    expect(config.precision.dirtyEpsilonAbsolute).toBe(1e-2);
    expect(config.precision.dirtyEpsilonCeiling).toBe(1e-2);
    expect(config.precision.dirtyEpsilonOverrideMax).toBe(1e-2);
  });

  it('accepts zero precision values', () => {
    const config = resolveEngineConfig({
      precision: {
        dirtyEpsilonAbsolute: 0,
        dirtyEpsilonRelative: 0,
        dirtyEpsilonCeiling: 0,
        dirtyEpsilonOverrideMax: 0,
      },
    });

    expect(config.precision).toEqual({
      dirtyEpsilonAbsolute: 0,
      dirtyEpsilonRelative: 0,
      dirtyEpsilonCeiling: 0,
      dirtyEpsilonOverrideMax: 0,
    });
  });
});

