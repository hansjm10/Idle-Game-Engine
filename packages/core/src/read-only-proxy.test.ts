import { afterEach, describe, expect, it, vi } from 'vitest';

import { createReadOnlyProxy } from './read-only-proxy.js';

describe('createReadOnlyProxy', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('throws when mutating top-level properties in development mode', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const state = { resources: { energy: 1 } };
    const proxy = createReadOnlyProxy(state);

    expect(() => {
      proxy.resources = { energy: 2 };
    }).toThrow(/Systems must not mutate state directly/);
  });

  it('throws when mutating nested properties in test mode', () => {
    vi.stubEnv('NODE_ENV', 'test');
    const state = { config: { theme: 'dark' } };
    const proxy = createReadOnlyProxy(state);

    expect(() => {
      proxy.config.theme = 'light';
    }).toThrow(/Attempted to set state.config.theme/);
  });

  it('returns the original object when mutation guard is disabled', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const state = { value: 1 };
    const proxy = createReadOnlyProxy(state);

    proxy.value = 2;
    expect(state.value).toBe(2);
    expect(proxy).toBe(state);
  });

  it('maintains proxy identity for repeated lookups', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const state = { value: 1 };

    const proxyA = createReadOnlyProxy(state);
    const proxyB = createReadOnlyProxy(state);

    expect(proxyA).toBe(proxyB);
  });
});
