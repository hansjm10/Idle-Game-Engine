import type {
  NormalizedContentPack,
  NormalizedGenerator,
  NormalizedResource,
} from '@idle-engine/content-schema';
import {
  GENERATED_RUNTIME_EVENT_DEFINITIONS,
  type ContentRuntimeEventType,
} from '@idle-engine/core';

import {
  PACK__U40_IDLE_U2D_ENGINE_U2F_SAMPLE_U2D_PACK as SAMPLE_PACK,
  PACK__U40_IDLE_U2D_ENGINE_U2F_SAMPLE_U2D_PACK_DIGEST as SAMPLE_PACK_DIGEST,
  PACK__U40_IDLE_U2D_ENGINE_U2F_SAMPLE_U2D_PACK_ARTIFACT_HASH as SAMPLE_PACK_ARTIFACT_HASH,
  PACK__U40_IDLE_U2D_ENGINE_U2F_SAMPLE_U2D_PACK_INDICES as SAMPLE_PACK_INDICES,
  PACK__U40_IDLE_U2D_ENGINE_U2F_SAMPLE_U2D_PACK_SUMMARY as SAMPLE_PACK_SUMMARY,
} from './generated/@idle-engine/sample-pack.generated.js';

export type ResourceDefinition = NormalizedResource;
export type GeneratorDefinition = NormalizedGenerator;
export type ContentPack = NormalizedContentPack;

export const sampleContent: ContentPack = SAMPLE_PACK;
export const sampleContentDigest = SAMPLE_PACK_DIGEST;
export const sampleContentArtifactHash = SAMPLE_PACK_ARTIFACT_HASH;
export const sampleContentIndices = SAMPLE_PACK_INDICES;
export const sampleContentSummary = SAMPLE_PACK_SUMMARY;

if (sampleContentSummary.warningCount > 0) {
  throw new Error(
    `Sample content pack emitted ${sampleContentSummary.warningCount} compiler warning(s).`,
  );
}

const SAMPLE_PACK_SLUG = sampleContentSummary.slug;

export const sampleEventDefinitions = GENERATED_RUNTIME_EVENT_DEFINITIONS.filter(
  (definition) => definition.packSlug === SAMPLE_PACK_SLUG,
);

export const sampleEventTypes = Object.freeze(
  sampleEventDefinitions.map(
    (definition) => definition.type as ContentRuntimeEventType,
  ),
);
