import { describe, expect, it } from 'vitest';
import { RUNTIME_VERSION, PERSISTENCE_SCHEMA_VERSION } from './version.js';

describe('version constants', () => {
  describe('RUNTIME_VERSION', () => {
    it('is defined and follows semver format', () => {
      expect(RUNTIME_VERSION).toBeDefined();
      expect(typeof RUNTIME_VERSION).toBe('string');
      expect(RUNTIME_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('matches the expected version for current release', () => {
      // This test documents the current version and will need updating
      // when the package version is bumped
      expect(RUNTIME_VERSION).toBe('0.1.0');
    });
  });

  describe('PERSISTENCE_SCHEMA_VERSION', () => {
    it('is defined as a positive integer', () => {
      expect(PERSISTENCE_SCHEMA_VERSION).toBeDefined();
      expect(typeof PERSISTENCE_SCHEMA_VERSION).toBe('number');
      expect(PERSISTENCE_SCHEMA_VERSION).toBeGreaterThan(0);
      expect(Number.isInteger(PERSISTENCE_SCHEMA_VERSION)).toBe(true);
    });

    it('is currently at version 1', () => {
      // This test documents the current schema version and will need updating
      // when the persistence format changes in a backwards-incompatible way
      expect(PERSISTENCE_SCHEMA_VERSION).toBe(1);
    });
  });
});
