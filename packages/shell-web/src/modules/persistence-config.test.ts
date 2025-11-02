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
  });
});
