import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseContentPack,
  type NormalizedContentPack,
  type NormalizedGenerator,
  type NormalizedResource,
} from '@idle-engine/content-schema';
import {
  GENERATED_RUNTIME_EVENT_DEFINITIONS,
  type ContentRuntimeEventType,
} from '@idle-engine/core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PACK_PATH = path.resolve(__dirname, '../content/pack.json');

const document = JSON.parse(readFileSync(SAMPLE_PACK_PATH, 'utf8'));
const { pack: samplePack, warnings } = parseContentPack(document, {
  runtimeEventCatalogue: GENERATED_RUNTIME_EVENT_DEFINITIONS.map(
    (definition) => definition.type,
  ),
});

if (warnings.length > 0) {
  throw new Error(
    `Sample content pack emitted schema warnings: ${JSON.stringify(
      warnings,
    )}`,
  );
}

export type ResourceDefinition = NormalizedResource;
export type GeneratorDefinition = NormalizedGenerator;
export type ContentPack = NormalizedContentPack;

export const sampleContent: ContentPack = samplePack;

const SAMPLE_PACK_SLUG = sampleContent.metadata.id;

export const sampleEventDefinitions = GENERATED_RUNTIME_EVENT_DEFINITIONS.filter(
  (definition) => definition.packSlug === SAMPLE_PACK_SLUG,
);

export const sampleEventTypes = Object.freeze(
  sampleEventDefinitions.map(
    (definition) => definition.type as ContentRuntimeEventType,
  ),
);
