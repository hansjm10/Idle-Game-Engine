const FNV1A_OFFSET_BASIS = 0x811c9dc5;
const FNV1A_PRIME = 0x01000193;

export const CONTENT_PACK_DIGEST_VERSION = 1;

export type IdentifiedEntity = { readonly id: string };

export interface ContentPackDigestModules {
  readonly metadata: {
    readonly id: string;
    readonly version: string;
  };
  readonly resources: readonly IdentifiedEntity[];
  readonly entities: readonly IdentifiedEntity[];
  readonly generators: readonly IdentifiedEntity[];
  readonly upgrades: readonly IdentifiedEntity[];
  readonly metrics: readonly IdentifiedEntity[];
  readonly achievements: readonly IdentifiedEntity[];
  readonly automations: readonly IdentifiedEntity[];
  readonly transforms: readonly IdentifiedEntity[];
  readonly prestigeLayers: readonly IdentifiedEntity[];
  readonly runtimeEvents: readonly IdentifiedEntity[];
}

export interface ContentPackDigest {
  readonly version: number;
  readonly hash: string;
}

const fnv1a = (input: string): number => {
  let hash = FNV1A_OFFSET_BASIS;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, FNV1A_PRIME);
    hash >>>= 0;
  }
  return hash >>> 0;
};

export const createContentPackDigest = <Modules extends ContentPackDigestModules>(
  pack: Modules,
): ContentPackDigest => {
  const digestPayload = {
    id: pack.metadata.id,
    version: pack.metadata.version,
    modules: {
      resources: pack.resources.map((resource) => resource.id),
      entities: pack.entities.map((entity) => entity.id),
      generators: pack.generators.map((generator) => generator.id),
      upgrades: pack.upgrades.map((upgrade) => upgrade.id),
      metrics: pack.metrics.map((metric) => metric.id),
      achievements: pack.achievements.map((achievement) => achievement.id),
      automations: pack.automations.map((automation) => automation.id),
      transforms: pack.transforms.map((transform) => transform.id),
      prestigeLayers: pack.prestigeLayers.map((layer) => layer.id),
      runtimeEvents: pack.runtimeEvents.map((event) => event.id),
    },
  };
  const serialized = JSON.stringify(digestPayload);
  const hash = fnv1a(serialized);
  return {
    version: CONTENT_PACK_DIGEST_VERSION,
    hash: `fnv1a-${hash.toString(16).padStart(8, '0')}`,
  };
};

export const freezeArray = <Value>(values: Value[]): readonly Value[] =>
  Object.freeze(values);

export const freezeObject = <Value extends object>(value: Value): Value =>
  Object.freeze(value);

export const freezeMap = <Value extends IdentifiedEntity>(
  values: readonly Value[],
): ReadonlyMap<Value['id'], Value> =>
  Object.freeze(new Map<Value['id'], Value>(values.map((value) => [value.id, value])));

export const freezeRecord = <Value extends IdentifiedEntity>(
  values: readonly Value[],
): Readonly<Record<string, Value>> =>
  Object.freeze(Object.fromEntries(values.map((value) => [value.id, value] as const)));
