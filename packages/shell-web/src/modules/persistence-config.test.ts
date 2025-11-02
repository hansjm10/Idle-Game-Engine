import { describe, it, expect, afterEach, vi } from 'vitest';
import { isPersistenceUIEnabled } from './persistence-config.js';

describe('persistence-config', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllEnvs();
  });

  describe('isPersistenceUIEnabled', () => {
    it('returns true when VITE_ENABLE_PERSISTENCE_UI is "true"', () => {
      vi.stubEnv('VITE_ENABLE_PERSISTENCE_UI', 'true');
      // Note: In actual Vite environment, this would be import.meta.env.VITE_ENABLE_PERSISTENCE_UI
      // For tests, we can't easily mock import.meta, so we rely on the fallback logic
      expect(isPersistenceUIEnabled()).toBe(true);
    });

    it('returns true when ENABLE_PERSISTENCE_UI is "true"', () => {
      process.env.ENABLE_PERSISTENCE_UI = 'true';
      expect(isPersistenceUIEnabled()).toBe(true);
    });

    it('returns true when ENABLE_PERSISTENCE_UI is "1"', () => {
      process.env.ENABLE_PERSISTENCE_UI = '1';
      expect(isPersistenceUIEnabled()).toBe(true);
    });

    it('returns false when ENABLE_PERSISTENCE_UI is "false"', () => {
      process.env.ENABLE_PERSISTENCE_UI = 'false';
      expect(isPersistenceUIEnabled()).toBe(false);
    });

    it('returns false when ENABLE_PERSISTENCE_UI is "0"', () => {
      process.env.ENABLE_PERSISTENCE_UI = '0';
      expect(isPersistenceUIEnabled()).toBe(false);
    });

    it('defaults to true in test environment', () => {
      delete process.env.ENABLE_PERSISTENCE_UI;
      delete process.env.VITE_ENABLE_PERSISTENCE_UI;
      process.env.NODE_ENV = 'test';
      expect(isPersistenceUIEnabled()).toBe(true);
    });

    it('defaults to true in development environment', () => {
      delete process.env.ENABLE_PERSISTENCE_UI;
      delete process.env.VITE_ENABLE_PERSISTENCE_UI;
      process.env.NODE_ENV = 'development';
      expect(isPersistenceUIEnabled()).toBe(true);
    });

    it('defaults to false in production environment', () => {
      delete process.env.ENABLE_PERSISTENCE_UI;
      delete process.env.VITE_ENABLE_PERSISTENCE_UI;
      process.env.NODE_ENV = 'production';
      expect(isPersistenceUIEnabled()).toBe(false);
    });

    it('handles case-insensitive NODE_ENV values', () => {
      delete process.env.ENABLE_PERSISTENCE_UI;
      delete process.env.VITE_ENABLE_PERSISTENCE_UI;
      process.env.NODE_ENV = 'PRODUCTION';
      expect(isPersistenceUIEnabled()).toBe(false);
    });

    describe('precedence ordering', () => {
      it('ENABLE_PERSISTENCE_UI overrides NODE_ENV', () => {
        process.env.ENABLE_PERSISTENCE_UI = 'false';
        process.env.NODE_ENV = 'development';
        expect(isPersistenceUIEnabled()).toBe(false);
      });

      it('ENABLE_PERSISTENCE_UI true overrides NODE_ENV production', () => {
        process.env.ENABLE_PERSISTENCE_UI = 'true';
        process.env.NODE_ENV = 'production';
        expect(isPersistenceUIEnabled()).toBe(true);
      });

      it('NODE_ENV takes effect when explicit overrides are not set', () => {
        delete process.env.ENABLE_PERSISTENCE_UI;
        delete process.env.VITE_ENABLE_PERSISTENCE_UI;
        process.env.NODE_ENV = 'test';
        expect(isPersistenceUIEnabled()).toBe(true);
      });
    });

    describe('edge cases', () => {
      it('handles empty string NODE_ENV as truthy (non-production)', () => {
        delete process.env.ENABLE_PERSISTENCE_UI;
        delete process.env.VITE_ENABLE_PERSISTENCE_UI;
        process.env.NODE_ENV = '';
        expect(isPersistenceUIEnabled()).toBe(true);
      });

      it('handles undefined NODE_ENV by falling back to default', () => {
        delete process.env.ENABLE_PERSISTENCE_UI;
        delete process.env.VITE_ENABLE_PERSISTENCE_UI;
        delete process.env.NODE_ENV;
        // Without NODE_ENV, falls back to import.meta.env (test environment defaults to true)
        expect(isPersistenceUIEnabled()).toBe(true);
      });

      it('ignores non-string ENABLE_PERSISTENCE_UI values', () => {
        delete process.env.VITE_ENABLE_PERSISTENCE_UI;
        // @ts-expect-error - testing runtime behavior with non-string value
        process.env.ENABLE_PERSISTENCE_UI = 1;
        process.env.NODE_ENV = 'production';
        // In test environment, non-string assignment doesn't set the env var, falls back to NODE_ENV
        expect(isPersistenceUIEnabled()).toBe(false);
      });
    });
  });
});
