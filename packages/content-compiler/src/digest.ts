import type { NormalizedMetadata } from '@idle-engine/content-schema';
import { createContentPackDigest } from '@idle-engine/content-schema/runtime-helpers';

import {
  type NormalizedContentPack,
  type SerializedContentDigest,
  type SerializedNormalizedContentPack,
  type SerializedNormalizedModules,
} from './types.js';

type DigestInput =
  | Pick<SerializedNormalizedContentPack, 'metadata' | 'modules'>
  | NormalizedContentPack;

interface DigestSource {
  readonly metadata: NormalizedMetadata;
  readonly modules: SerializedNormalizedModules;
}

function extractModules(input: DigestInput): SerializedNormalizedModules {
  if ('resources' in input) {
    return {
      resources: input.resources,
      entities: input.entities,
      generators: input.generators,
      upgrades: input.upgrades,
      metrics: input.metrics,
      achievements: input.achievements,
      automations: input.automations,
      transforms: input.transforms,
      prestigeLayers: input.prestigeLayers,
      runtimeEvents: input.runtimeEvents,
    };
  }

  if ('modules' in input && input.modules !== undefined) {
    return input.modules;
  }

  throw new Error('Serialized content pack is missing module data.');
}

function toDigestSource(input: DigestInput): DigestSource {
  return {
    metadata: input.metadata,
    modules: extractModules(input),
  };
}

export function computeContentDigest(input: DigestInput): SerializedContentDigest {
  const { metadata, modules } = toDigestSource(input);
  const digestInput = {
    metadata,
    resources: modules.resources,
    entities: modules.entities,
    generators: modules.generators,
    upgrades: modules.upgrades,
    metrics: modules.metrics,
    achievements: modules.achievements,
    automations: modules.automations,
    transforms: modules.transforms,
    prestigeLayers: modules.prestigeLayers,
    runtimeEvents: modules.runtimeEvents,
  } as const;

  const digest = createContentPackDigest(digestInput);

  if (digest.version === undefined || digest.hash === undefined) {
    throw new Error(
      `Failed to compute content digest for pack ${metadata.id ?? '<unknown>'}.`,
    );
  }

  return Object.freeze({
    version: digest.version,
    hash: digest.hash,
  });
}
