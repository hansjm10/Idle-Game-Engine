import semver from 'semver';
import { describe, expect, it } from 'vitest';

import {
  contentIdSchema,
  flagIdSchema,
  localeCodeSchema,
  packSlugSchema,
  scriptIdSchema,
  semverRangeSchema,
  semverSchema,
  systemAutomationTargetIdSchema,
} from './ids.js';

describe('ids', () => {
  it('normalizes content ids to lowercase and enforces grammar', () => {
    const parsed = contentIdSchema.parse(' Player/Level-1 ');
    expect(parsed).toBe('player/level-1');
    expect(contentIdSchema.safeParse(' invalid id ').success).toBe(false);
  });

  it('accepts scoped pack slugs and collapses duplicate separators', () => {
    const parsed = packSlugSchema.parse(' @Idle-Engine//Core ');
    expect(parsed).toBe('@idle-engine/core');
    expect(packSlugSchema.safeParse('no spaces allowed!').success).toBe(false);
  });

  it('canonicalizes locale codes using Intl canonicalization', () => {
    const parsed = localeCodeSchema.parse('en-us');
    expect(parsed).toBe('en-US');
    expect(localeCodeSchema.safeParse('invalid_locale').success).toBe(false);
  });

  it('brands flag and script identifiers separately', () => {
    const flagId = flagIdSchema.parse('Flag-Value');
    const scriptId = scriptIdSchema.parse('Script/Alpha');
    expect(flagId).toBe('flag-value');
    expect(scriptId).toBe('script/alpha');
  });

  it('validates system automation target ids against the curated set', () => {
    expect(systemAutomationTargetIdSchema.parse('offline-catchup')).toBe(
      'offline-catchup',
    );
    expect(
      systemAutomationTargetIdSchema.safeParse('unknown-target').success,
    ).toBe(false);
  });

  it('normalizes semantic versions and ranges', () => {
    const version = semverSchema.parse('  v1.2.3  ');
    expect(version).toBe('1.2.3');

    const range = semverRangeSchema.parse(' ^1.2.3 || >=2.0.0 ');
    expect(range).toBe(
      semver.validRange(' ^1.2.3 || >=2.0.0 ', { includePrerelease: true }),
    );
    expect(range.startsWith('>=')).toBe(true);
  });
});
