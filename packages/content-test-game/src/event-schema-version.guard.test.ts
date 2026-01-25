import { describe, expect, it } from 'vitest';

import { GENERATED_RUNTIME_EVENT_DEFINITIONS } from '@idle-engine/core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
    hash >>>= 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function canonicalSchemaHash(absolutePath: string): string {
  const raw = fs.readFileSync(absolutePath, 'utf8');
  const canonical = JSON.stringify(sortKeysDeep(JSON.parse(raw)));
  return fnv1a(canonical);
}

const EXPECTED: Record<string, Record<number, string>> = Object.freeze({
  'test-game:milestone-reached': {
    1: '2527780f',
  },
  'test-game:prestige-ready': {
    1: '5599fa0b',
  },
  'test-game:mission-complete': {
    1: '2dde007a',
  },
});

describe('runtime event schema/version guard', () => {
  it('schema changes require a version bump (test game runtime events)', () => {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(__dirname, '../../..');

    for (const eventType of Object.keys(EXPECTED)) {
      const def = GENERATED_RUNTIME_EVENT_DEFINITIONS.find(
        (definition) =>
          definition.type === eventType &&
          definition.packSlug === '@idle-engine/test-game-pack',
      );
      expect(def, `Missing event manifest entry for ${eventType}.`).toBeDefined();
      if (!def) {
        continue;
      }

      const schemaPath = def.schema;
      expect(schemaPath, `Missing schema path for ${eventType}.`).toBeTruthy();
      if (!schemaPath) {
        continue;
      }

      const hash = canonicalSchemaHash(path.resolve(repoRoot, schemaPath));

      const expectedForVersion = EXPECTED[eventType]?.[def.version];
      expect(
        expectedForVersion,
        [
          `Missing expected hash for ${eventType} v${def.version}.`,
          'If you just bumped the version, add the new hash to EXPECTED.',
        ].join('\n'),
      ).toBeDefined();

      expect(
        hash,
        [
          `Schema content changed without updating version for ${eventType}.`,
          `Current version: v${def.version}, expected hash: ${expectedForVersion}, actual hash: ${hash}`,
        ].join('\n'),
      ).toBe(expectedForVersion);
    }
  });
});

