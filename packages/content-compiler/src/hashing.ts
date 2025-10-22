import { createHash } from 'crypto';

import type { NormalizedMetadata } from '@idle-engine/content-schema';

import { MODULE_NAMES, type NormalizedContentPack, type SerializedContentDigest, type SerializedNormalizedContentPack, type SerializedNormalizedModules } from './types.js';

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

const CONTENT_DIGEST_VERSION = 1;

type DigestInput =
  | Pick<SerializedNormalizedContentPack, 'metadata' | 'modules'>
  | NormalizedContentPack;

interface DigestSource {
  readonly metadata: NormalizedMetadata;
  readonly modules: SerializedNormalizedModules;
}

function fnv1aFromString(input: string): string {
  let hash = FNV_OFFSET_BASIS;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
    hash >>>= 0;
  }

  return `fnv1a-${hash.toString(16).padStart(8, '0')}`;
}

function toDigestSource(input: DigestInput): DigestSource {
  const metadata = input.metadata;
  const modules = input.modules;

  return {
    metadata,
    modules,
  };
}

function collectModuleIds(modules: SerializedNormalizedModules): Record<string, readonly string[]> {
  const result: Record<string, readonly string[]> = Object.create(null);

  for (const name of MODULE_NAMES) {
    const entries = modules[name];
    result[name] = entries.map((entry) => (entry as { id: string }).id);
  }

  return Object.freeze(result);
}

export function computeContentDigest(input: DigestInput): SerializedContentDigest {
  const { metadata, modules } = toDigestSource(input);

  const digestPayload = {
    id: metadata.id,
    version: metadata.version,
    modules: collectModuleIds(modules),
  };

  return Object.freeze({
    version: CONTENT_DIGEST_VERSION,
    hash: fnv1aFromString(JSON.stringify(digestPayload)),
  });
}

export function computeArtifactHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
