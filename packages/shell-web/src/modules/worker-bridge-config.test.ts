import { afterEach, describe, expect, it } from 'vitest';

import {
  getWorkerBridgeConfig,
  isWorkerBridgeEnabled,
  setWorkerBridgeConfigOverrideForTesting,
} from './worker-bridge-config.js';

const originalEnv = { ...process.env };

function resetEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe('worker-bridge-config', () => {
  afterEach(() => {
    resetEnv();
    setWorkerBridgeConfigOverrideForTesting(null);
  });

  it('defaults to the legacy bridge (flag disabled)', () => {
    expect(isWorkerBridgeEnabled()).toBe(false);
  });

  it('reads boolean-like environment variables', () => {
    process.env.VITE_ENABLE_WORKER_BRIDGE = '1';
    expect(isWorkerBridgeEnabled()).toBe(true);

    process.env.VITE_ENABLE_WORKER_BRIDGE = 'false';
    expect(isWorkerBridgeEnabled()).toBe(false);
  });

  it('supports overrides for targeted testing', () => {
    setWorkerBridgeConfigOverrideForTesting({ enabled: true });
    expect(getWorkerBridgeConfig()).toEqual({ enabled: true });
    expect(isWorkerBridgeEnabled()).toBe(true);
  });
});
