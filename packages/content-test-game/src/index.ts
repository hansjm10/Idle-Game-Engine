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
  PACK__U40_IDLE_U2D_ENGINE_U2F_TEST_U2D_GAME_U2D_PACK as TEST_GAME_PACK,
  PACK__U40_IDLE_U2D_ENGINE_U2F_TEST_U2D_GAME_U2D_PACK_DIGEST as TEST_GAME_PACK_DIGEST,
  PACK__U40_IDLE_U2D_ENGINE_U2F_TEST_U2D_GAME_U2D_PACK_ARTIFACT_HASH as TEST_GAME_PACK_ARTIFACT_HASH,
  PACK__U40_IDLE_U2D_ENGINE_U2F_TEST_U2D_GAME_U2D_PACK_INDICES as TEST_GAME_PACK_INDICES,
  PACK__U40_IDLE_U2D_ENGINE_U2F_TEST_U2D_GAME_U2D_PACK_SUMMARY as TEST_GAME_PACK_SUMMARY,
} from './generated/@idle-engine/test-game-pack.generated.js';

export type ResourceDefinition = NormalizedResource;
export type GeneratorDefinition = NormalizedGenerator;
export type ContentPack = NormalizedContentPack;

export const testGameContent: ContentPack = TEST_GAME_PACK;
export const testGameContentDigest = TEST_GAME_PACK_DIGEST;
export const testGameContentArtifactHash = TEST_GAME_PACK_ARTIFACT_HASH;
export const testGameContentIndices = TEST_GAME_PACK_INDICES;
export const testGameContentSummary = TEST_GAME_PACK_SUMMARY;

const TEST_GAME_PACK_SLUG = testGameContentSummary.slug;

export const testGameEventDefinitions = GENERATED_RUNTIME_EVENT_DEFINITIONS.filter(
  (definition) => definition.packSlug === TEST_GAME_PACK_SLUG,
);

export const testGameEventTypes = Object.freeze(
  testGameEventDefinitions.map(
    (definition) => definition.type as ContentRuntimeEventType,
  ),
);

