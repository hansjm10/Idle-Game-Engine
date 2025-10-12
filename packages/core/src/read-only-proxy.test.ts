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

  it('wraps Map#get results to prevent mutations through collection accessors', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const entity = { health: 10 };
    const state = {
      entities: new Map([['e1', entity]]),
    };

    const proxy = createReadOnlyProxy(state);

    const proxyEntity = proxy.entities.get('e1');
    if (!proxyEntity) {
      throw new Error('Expected proxied entity');
    }
    expect(proxyEntity).not.toBe(entity);

    const proxyEntityAgain = proxy.entities.get('e1');
    expect(proxyEntityAgain).toBe(proxyEntity);

    expect(() => {
      proxyEntity.health = 20;
    }).toThrow(/state\.entities\["e1"\]\.health/);
  });

  it('wraps Map iteration helpers so callbacks receive immutable values', () => {
    vi.stubEnv('NODE_ENV', 'test');
    const entity = { level: 1 };
    const state = {
      entities: new Map([['e1', entity]]),
    };

    const proxy = createReadOnlyProxy(state);
    let captured: { level: number } | undefined;
    let capturedMap: Map<string, { level: number }> | undefined;

    proxy.entities.forEach((value, key, mapRef) => {
      captured = value as { level: number };
      capturedMap = mapRef;
      expect(key).toBe('e1');
      expect(mapRef).toBe(proxy.entities);
    });

    expect(captured).toBeDefined();
    expect(capturedMap).toBe(proxy.entities);

    expect(() => {
      if (!captured) {
        throw new Error('Expected captured value');
      }
      captured.level = 2;
    }).toThrow(/state\.entities\["e1"\]\.level/);
  });

  it('wraps Set iterators to enforce immutability on contained values', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const node = { stage: 1 };
    const state = {
      nodes: new Set([node]),
    };

    const proxy = createReadOnlyProxy(state);
    const iterator = proxy.nodes.values();
    const nextResult = iterator.next();

    expect(nextResult.done).toBe(false);

    const proxiedNode = nextResult.value as { stage: number };
    expect(proxiedNode).not.toBe(node);

    expect(() => {
      proxiedNode.stage = 2;
    }).toThrow(/state\.nodes\[value\]\.stage/);
  });
});
