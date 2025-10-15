type Primitive =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined;

type Builtin =
  | Primitive
  | Date
  | RegExp
  | ((...args: never[]) => unknown)
  | { readonly [Symbol.iterator]?: (...args: never[]) => Iterable<unknown> };

export type DeepReadonly<T> = T extends Builtin
  ? T
  : T extends Array<infer U>
    ? ReadonlyArray<DeepReadonly<U>>
    : T extends Map<infer K, infer V>
      ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
      : T extends Set<infer U>
        ? ReadonlySet<DeepReadonly<U>>
        : { readonly [K in keyof T]: DeepReadonly<T[K]> };

export interface RuntimeEventPayloadMap {
  readonly __placeholder__?: never;
}

type PlaceholderKey = '__placeholder__';
type PayloadKeys = Exclude<keyof RuntimeEventPayloadMap, PlaceholderKey> & string;

export type RuntimeEventType = [PayloadKeys] extends [never] ? string : PayloadKeys;

type PayloadLookup<TType extends string> = TType extends keyof RuntimeEventPayloadMap
  ? RuntimeEventPayloadMap[TType]
  : unknown;

export type RuntimeEventPayload<TType extends RuntimeEventType> = DeepReadonly<PayloadLookup<TType>>;

export interface RuntimeEvent<TType extends RuntimeEventType = RuntimeEventType> {
  readonly type: TType;
  readonly tick: number;
  readonly issuedAt: number;
  readonly payload: RuntimeEventPayload<TType>;
}

export interface RuntimeEventDefinition<TType extends RuntimeEventType> {
  readonly type: TType;
  readonly version: number;
  readonly validator?: (payload: RuntimeEventPayload<TType>) => void;
}

export interface RuntimeEventManifestEntry<TType extends RuntimeEventType = RuntimeEventType> {
  readonly type: TType;
  readonly channel: number;
  readonly version: number;
}

export interface RuntimeEventManifest {
  readonly entries: readonly RuntimeEventManifestEntry[];
}

export type RuntimeEventManifestHash = string & { readonly brand: unique symbol };

export interface CreateRuntimeEventOptions<TType extends RuntimeEventType> {
  readonly type: TType;
  readonly tick: number;
  readonly issuedAt: number;
  readonly payload: RuntimeEventPayload<TType>;
}

export function createRuntimeEvent<TType extends RuntimeEventType>(
  options: CreateRuntimeEventOptions<TType>,
): RuntimeEvent<TType> {
  const event: RuntimeEvent<TType> = {
    type: options.type,
    tick: options.tick,
    issuedAt: options.issuedAt,
    payload: options.payload,
  };

  if (isDevelopmentMode()) {
    return freezeEvent(event);
  }

  return event;
}

export function computeRuntimeEventManifestHash(manifest: RuntimeEventManifest): RuntimeEventManifestHash {
  const entries = [...manifest.entries].sort((left, right) => {
    if (left.channel !== right.channel) {
      return left.channel - right.channel;
    }
    if (left.type !== right.type) {
      return left.type < right.type ? -1 : 1;
    }
    return left.version - right.version;
  });

  const serialized = entries
    .map((entry) => `${entry.channel}:${entry.type}:${entry.version}`)
    .join('|');

  const hash = fnv1a(serialized);
  return `${hash.toString(16).padStart(8, '0')}` as RuntimeEventManifestHash;
}

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
    hash >>>= 0;
  }

  return hash;
}

function freezeEvent<TType extends RuntimeEventType>(event: RuntimeEvent<TType>): RuntimeEvent<TType> {
  if (typeof event.payload === 'object' && event.payload !== null) {
    deepFreeze(event.payload);
  }

  return Object.freeze(event);
}

function deepFreeze(value: unknown): void {
  if (typeof value !== 'object' || value === null) {
    return;
  }

  if (Object.isFrozen(value)) {
    return;
  }

  Object.freeze(value);

  if (Array.isArray(value)) {
    for (const element of value) {
      deepFreeze(element);
    }
    return;
  }

  const propertyNames = Object.getOwnPropertyNames(value);
  for (const property of propertyNames) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- recursion over object entries
    deepFreeze((value as Record<string, any>)[property]);
  }

  const symbols = Object.getOwnPropertySymbols(value);
  for (const symbol of symbols) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- recursion over object entries
    deepFreeze((value as Record<PropertyKey, any>)[symbol]);
  }
}

function isDevelopmentMode(): boolean {
  const globalObject = globalThis as {
    readonly process?: {
      readonly env?: Record<string, string | undefined>;
    };
  };

  const nodeEnv = globalObject.process?.env?.NODE_ENV;
  return nodeEnv !== 'production';
}
