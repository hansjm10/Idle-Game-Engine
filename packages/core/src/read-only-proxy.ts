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
        return value.bind(obj);
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
