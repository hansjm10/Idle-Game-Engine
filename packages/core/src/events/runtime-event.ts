import type { ImmutablePayload } from '../command.js';
import { deepFreezeInPlace } from '../command-queue.js';

export interface RuntimeEventPayloadMap {
  readonly __runtimeEventInternalBrand__?: never;
}

type RuntimeEventKey = Exclude<
  keyof RuntimeEventPayloadMap,
  '__runtimeEventInternalBrand__'
>;

export type RuntimeEventType = RuntimeEventKey extends string
  ? RuntimeEventKey
  : never;

type RuntimeEventPayloadValue<TType extends RuntimeEventType> =
  RuntimeEventPayloadMap[TType];

export type RuntimeEventPayload<TType extends RuntimeEventType> =
  RuntimeEventPayloadValue<TType> extends never
    ? never
    : ImmutablePayload<RuntimeEventPayloadValue<TType>>;

export type RuntimeEventPayloadInput<TType extends RuntimeEventType> =
  RuntimeEventPayloadValue<TType>;

export interface RuntimeEvent<TType extends RuntimeEventType = RuntimeEventType> {
  readonly type: TType;
  readonly tick: number;
  readonly issuedAt: number;
  readonly dispatchOrder: number;
  readonly payload: RuntimeEventPayload<TType>;
}

export interface RuntimeEventManifest {
  readonly version: number;
  readonly hash: string;
  readonly types: readonly RuntimeEventType[];
}

export function createRuntimeEventManifest(
  types: readonly RuntimeEventType[],
): RuntimeEventManifest {
  const sorted = [...types].sort();
  return {
    version: sorted.length,
    hash: computeStableDigest(sorted),
    types: sorted,
  };
}

export interface RuntimeEventDraft<TType extends RuntimeEventType> {
  readonly type: TType;
  readonly tick: number;
  readonly issuedAt: number;
  readonly dispatchOrder: number;
  readonly payload: RuntimeEventPayloadInput<TType>;
}

export function createRuntimeEventSnapshot<TType extends RuntimeEventType>(
  draft: RuntimeEventDraft<TType>,
): RuntimeEvent<TType> {
  const frozenPayload = ensureRuntimeEventPayload(draft.payload);
  const snapshot: RuntimeEvent<TType> = {
    type: draft.type,
    tick: draft.tick,
    issuedAt: draft.issuedAt,
    dispatchOrder: draft.dispatchOrder,
    payload: frozenPayload,
  };

  return areRuntimeEventGuardsEnabled()
    ? Object.freeze(snapshot)
    : snapshot;
}

export type RuntimeEventPayloadValidator<TType extends RuntimeEventType> = (
  payload: RuntimeEventPayloadInput<TType>,
) => void;

export function ensureRuntimeEventPayload<TType extends RuntimeEventType>(
  payload: RuntimeEventPayloadInput<TType>,
): RuntimeEventPayload<TType> {
  if (!areRuntimeEventGuardsEnabled()) {
    return payload as RuntimeEventPayload<TType>;
  }
  return deepFreezeInPlace(
    payload,
  ) as RuntimeEventPayload<TType>;
}

export function areRuntimeEventGuardsEnabled(): boolean {
  const processEnv = (globalThis as {
    readonly process?: { readonly env?: Record<string, string | undefined> };
  }).process?.env;
  return processEnv?.NODE_ENV !== 'production';
}

function computeStableDigest(values: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const value of values) {
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
      hash >>>= 0;
    }
    hash ^= 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash >>>= 0;
  }
  return `fnv1a-${hash.toString(16).padStart(8, '0')}`;
}
