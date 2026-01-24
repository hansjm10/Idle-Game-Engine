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

  it('formats non-string Map keys in mutation errors', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const entity = { health: 10 };
    const state = {
      entities: new Map([[true, entity]]),
    };

    const proxy = createReadOnlyProxy(state);
    const proxyEntity = proxy.entities.get(true);
    if (!proxyEntity) {
      throw new Error('Expected proxied entity');
    }

    expect(() => {
      proxyEntity.health = 20;
    }).toThrow(/state\.entities\[true\]\.health/);
  });

  it('wraps Map.values() iterators and supports iterator helpers', () => {
    vi.stubEnv('NODE_ENV', 'test');
    const entity = { health: 10 };
    const state = {
      entities: new Map([['e1', entity]]),
    };

    const proxy = createReadOnlyProxy(state);
    const iterator = proxy.entities.values();
    const result = iterator.next();

    expect(result.done).toBe(false);

    const proxyEntity = result.value as { health: number };
    expect(proxyEntity).not.toBe(entity);

    expect(() => {
      proxyEntity.health = 20;
    }).toThrow(/state\.entities\[value\]\.health/);

    expect(iterator.return?.().done).toBe(true);
    expect(() => {
      iterator.throw!(new Error('boom'));
    }).toThrow('boom');
  });

  it('wraps Map.entries() and Symbol.iterator values to prevent nested mutations', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const objectKey = {};
    const symbolKey = Symbol('k');

    const state = {
      entities: new Map<any, any>([
        [1, { health: 10 }],
        [symbolKey, { health: 5 }],
        [objectKey, { health: 1 }],
      ]),
    };

    const proxy = createReadOnlyProxy(state);

    expect(proxy.entities.has(1)).toBe(true);

    const entryResult = proxy.entities.entries().next();
    expect(entryResult.done).toBe(false);

    const [key, value] = entryResult.value as [unknown, { health: number }];
    expect(key).toBe(1);

    expect(() => {
      value.health = 20;
    }).toThrow(/state\.entities\[1\]\.health/);

    for (const [iterKey, iterValue] of proxy.entities) {
      if (iterKey === symbolKey) {
        expect(() => {
          (iterValue as { health: number }).health = 0;
        }).toThrow(/state\.entities\[Symbol\(k\)\]\.health/);
      }

      if (iterKey === objectKey) {
        expect(() => {
          (iterValue as { health: number }).health = 0;
        }).toThrow(/state\.entities\[object\]\.health/);
      }
    }
  });

  it('wraps Set.forEach(), keys(), and entries()', () => {
    vi.stubEnv('NODE_ENV', 'test');
    const node = { stage: 1 };
    const state = {
      nodes: new Set([node]),
    };

    const proxy = createReadOnlyProxy(state);

    let capturedValue: { stage: number } | undefined;
    let capturedValueAgain: { stage: number } | undefined;
    let capturedSet: Set<{ stage: number }> | undefined;

    proxy.nodes.forEach((value, valueAgain, setRef) => {
      capturedValue = value as { stage: number };
      capturedValueAgain = valueAgain as { stage: number };
      capturedSet = setRef;
    });

    expect(capturedSet).toBe(proxy.nodes);
    expect(capturedValue).toBeDefined();
    expect(capturedValueAgain).toBeDefined();
    expect(capturedValue).toBe(capturedValueAgain);

    expect(() => {
      if (!capturedValue) {
        throw new Error('Expected captured value');
      }
      capturedValue.stage = 2;
    }).toThrow(/state\.nodes\[value\]\.stage/);

    expect(proxy.nodes.has(node)).toBe(true);

    const keyResult = proxy.nodes.keys().next();
    expect(keyResult.done).toBe(false);

    const proxiedNodeFromKeys = keyResult.value as { stage: number };
    expect(proxiedNodeFromKeys).not.toBe(node);

    expect(() => {
      proxiedNodeFromKeys.stage = 3;
    }).toThrow(/state\.nodes\[value\]\.stage/);

    const entriesResult = proxy.nodes.entries().next();
    expect(entriesResult.done).toBe(false);

    const [entryValue, entryValueAgain] = entriesResult.value as [
      { stage: number },
      { stage: number },
    ];
    expect(entryValue).toBe(entryValueAgain);

    expect(() => {
      entryValue.stage = 4;
    }).toThrow(/state\.nodes\[value\]\.stage/);
  });

  it('throws when deleting or defining properties', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const state = { config: { theme: 'dark' } };
    const proxy = createReadOnlyProxy(state);

    expect(() => {
      delete (proxy as any).config;
    }).toThrow(/Attempted to delete state\.config/);

    expect(() => {
      Object.defineProperty(proxy, 'newProp', { value: 42 });
    }).toThrow(/Attempted to define a property via proxy trap/);
  });
});
