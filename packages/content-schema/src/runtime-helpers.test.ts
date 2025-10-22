import { describe, expect, it } from 'vitest';

import {
  CONTENT_PACK_DIGEST_VERSION,
  createContentPackDigest,
  freezeArray,
  freezeMap,
  freezeObject,
  freezeRecord,
  type ContentPackDigestModules,
} from './runtime-helpers.js';

const createDigestInput = (
  overrides: Partial<ContentPackDigestModules> = {},
): ContentPackDigestModules => ({
  metadata: {
    id: 'sample-pack',
    version: '1.2.3',
    ...(overrides.metadata ?? {}),
  },
  resources: overrides.resources ?? freezeArray([{ id: 'resource.a' }]),
  generators: overrides.generators ?? freezeArray([{ id: 'generator.a' }]),
  upgrades: overrides.upgrades ?? freezeArray([{ id: 'upgrade.a' }]),
  metrics: overrides.metrics ?? freezeArray([{ id: 'metric.a' }]),
  achievements: overrides.achievements ?? freezeArray([{ id: 'achievement.a' }]),
  automations: overrides.automations ?? freezeArray([{ id: 'automation.a' }]),
  transforms: overrides.transforms ?? freezeArray([{ id: 'transform.a' }]),
  prestigeLayers: overrides.prestigeLayers ?? freezeArray([{ id: 'prestige.a' }]),
  guildPerks: overrides.guildPerks ?? freezeArray([{ id: 'guildPerk.a' }]),
  runtimeEvents: overrides.runtimeEvents ?? freezeArray([{ id: 'runtimeEvent.a' }]),
});

describe('runtime-helpers', () => {
  it('creates stable content pack digests', () => {
    const input = createDigestInput();

    const digest = createContentPackDigest(input);
    const repeatDigest = createContentPackDigest(input);

    expect(digest.version).toBe(CONTENT_PACK_DIGEST_VERSION);
    expect(digest.hash).toMatch(/^fnv1a-[0-9a-f]{8}$/);
    expect(repeatDigest).toStrictEqual(digest);
  });

  it('changes digest hash when referenced ids differ', () => {
    const baseInput = createDigestInput();
    const modifiedInput = createDigestInput({
      resources: freezeArray([{ id: 'resource.changed' }]),
    });

    const digest = createContentPackDigest(baseInput);
    const modifiedDigest = createContentPackDigest(modifiedInput);

    expect(modifiedDigest.hash).not.toBe(digest.hash);
  });

  it('freezes input collections to guard against mutation', () => {
    const entities = freezeArray([{ id: 'entity.a' }]);
    const frozenMap = freezeMap(entities);
    const frozenRecord = freezeRecord(entities);
    const frozenObject = freezeObject({ id: 'entity.a', name: 'Entity A' });

    expect(Object.isFrozen(entities)).toBe(true);
    expect(Object.isFrozen(frozenMap)).toBe(true);
    expect(Object.isFrozen(frozenRecord)).toBe(true);
    expect(Object.isFrozen(frozenObject)).toBe(true);
    expect(frozenMap.get('entity.a')).toBe(entities[0]);
    expect(frozenRecord['entity.a']?.id).toBe('entity.a');
  });
});
