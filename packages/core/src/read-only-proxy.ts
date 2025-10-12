const MUTATION_ERROR_PREFIX =
  'Systems must not mutate state directly. Use commandQueue.enqueue() instead.';

type NodeLikeProcess = {
  readonly env?: Record<string, string | undefined>;
};

type NodeLikeGlobal = {
  readonly process?: NodeLikeProcess;
};

function getNodeEnv(): string | undefined {
  const globalObject = globalThis as NodeLikeGlobal;
  return globalObject.process?.env?.NODE_ENV;
}

function isGuardEnabled(): boolean {
  return getNodeEnv() !== 'production';
}

function isObjectLike(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function formatKeySegment(key: unknown): string {
  if (typeof key === 'string') {
    return `[${JSON.stringify(key)}]`;
  }

  if (typeof key === 'number' || typeof key === 'bigint' || typeof key === 'boolean') {
    return `[${String(key)}]`;
  }

  if (typeof key === 'symbol') {
    return `[${String(key)}]`;
  }

  return '[object]';
}

function formatMapEntryPath(path: string, key: unknown): string {
  return `${path}${formatKeySegment(key)}`;
}

function formatCollectionValuePath(path: string): string {
  return `${path}[value]`;
}

function wrapIterator<T>(
  iterator: Iterator<T>,
  wrapValue: (value: T) => T,
): Iterator<T> {
  return {
    next() {
      const result = iterator.next();
      if (result.done) {
        return result;
      }

      return {
        done: false,
        value: wrapValue(result.value),
      };
    },
    return(value?: unknown) {
      if (typeof iterator.return === 'function') {
        return iterator.return(value as T);
      }

      return {
        done: true,
        value: value as T,
      };
    },
    throw(error?: unknown) {
      if (typeof iterator.throw === 'function') {
        return iterator.throw(error);
      }

      throw error;
    },
    [Symbol.iterator]() {
      return this;
    },
  };
}

function wrapIfObject<T>(value: T, path: string): T {
  if (!isObjectLike(value)) {
    return value;
  }

  return createReadOnlyProxy(value, path);
}

function wrapMapMethod(
  map: Map<unknown, unknown>,
  prop: PropertyKey,
  original: (...args: unknown[]) => unknown,
  path: string,
  receiver: object,
): unknown {
  if (prop === 'get') {
    return (...args: unknown[]) => {
      const [key] = args;
      const result = Reflect.apply(original, map, args);
      return wrapIfObject(result, formatMapEntryPath(path, key));
    };
  }

  if (prop === 'forEach') {
    return (
      callback: (value: unknown, key: unknown, mapRef: Map<unknown, unknown>) => void,
      thisArg?: unknown,
    ) => {
      return Reflect.apply(original, map, [
        (value: unknown, key: unknown) => {
          const proxiedValue = wrapIfObject(value, formatMapEntryPath(path, key));
          return callback.call(thisArg, proxiedValue, key, receiver as Map<unknown, unknown>);
        },
        thisArg,
      ]);
    };
  }

  if (prop === 'values') {
    return (...args: unknown[]) => {
      const iterator = Reflect.apply(original, map, args) as Iterator<unknown>;
      return wrapIterator(iterator, (value) => wrapIfObject(value, formatCollectionValuePath(path)));
    };
  }

  if (prop === 'entries' || prop === Symbol.iterator) {
    return (...args: unknown[]) => {
      const iterator = Reflect.apply(original, map, args) as Iterator<[unknown, unknown]>;
      return wrapIterator(iterator, ([key, value]) => {
        const proxiedValue = wrapIfObject(value, formatMapEntryPath(path, key));
        return [key, proxiedValue] as [unknown, unknown];
      });
    };
  }

  return original.bind(map);
}

function wrapSetMethod(
  set: Set<unknown>,
  prop: PropertyKey,
  original: (...args: unknown[]) => unknown,
  path: string,
  receiver: object,
): unknown {
  if (prop === 'forEach') {
    return (
      callback: (value: unknown, valueAgain: unknown, setRef: Set<unknown>) => void,
      thisArg?: unknown,
    ) => {
      return Reflect.apply(original, set, [
        (value: unknown) => {
          const proxiedValue = wrapIfObject(value, formatCollectionValuePath(path));
          return callback.call(thisArg, proxiedValue, proxiedValue, receiver as Set<unknown>);
        },
        thisArg,
      ]);
    };
  }

  if (prop === 'values' || prop === 'keys' || prop === Symbol.iterator) {
    return (...args: unknown[]) => {
      const iterator = Reflect.apply(original, set, args) as Iterator<unknown>;
      return wrapIterator(iterator, (value) => wrapIfObject(value, formatCollectionValuePath(path)));
    };
  }

  if (prop === 'entries') {
    return (...args: unknown[]) => {
      const iterator = Reflect.apply(original, set, args) as Iterator<[unknown, unknown]>;
      return wrapIterator(iterator, ([first]) => {
        const proxiedValue = wrapIfObject(first, formatCollectionValuePath(path));
        return [proxiedValue, proxiedValue] as [unknown, unknown];
      });
    };
  }

  return original.bind(set);
}

const proxyCache = new WeakMap<object, unknown>();

export function createReadOnlyProxy<T>(target: T, path = 'state'): T {
  if (!isGuardEnabled() || !target || typeof target !== 'object') {
    return target;
  }

  const cached = proxyCache.get(target as object);
  if (cached) {
    return cached as T;
  }

  const proxy = new Proxy(target as Record<PropertyKey, unknown>, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);

      if (
        typeof value === 'function' &&
        (obj instanceof Map || obj instanceof Set)
      ) {
        if (obj instanceof Map) {
          return wrapMapMethod(obj, prop, value, path, receiver);
        }

        return wrapSetMethod(obj, prop, value, path, receiver);
      }

      if (value && typeof value === 'object') {
        return createReadOnlyProxy(value, `${path}.${String(prop)}`);
      }

      return value;
    },
    set(_obj, prop, value) {
      throw new Error(
        `${MUTATION_ERROR_PREFIX} Attempted to set ${path}.${String(prop)} = ${String(value)}.`,
      );
    },
    deleteProperty(_obj, prop) {
      throw new Error(
        `${MUTATION_ERROR_PREFIX} Attempted to delete ${path}.${String(prop)}.`,
      );
    },
    defineProperty() {
      throw new Error(
        `${MUTATION_ERROR_PREFIX} Attempted to define a property via proxy trap.`,
      );
    },
  });

  proxyCache.set(target as object, proxy);
  return proxy as T;
}
