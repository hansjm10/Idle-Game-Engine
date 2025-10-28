import { afterEach, describe, expect, it } from 'vitest';

import {
  getSocialConfig,
  isSocialCommandsEnabled,
  setSocialConfigOverrideForTesting,
} from './social-config.js';

describe('social-config', () => {
  afterEach(() => {
    setSocialConfigOverrideForTesting(null);
    delete (process.env as Record<string, string | undefined>)[
      'VITE_ENABLE_SOCIAL_COMMANDS'
    ];
    delete (process.env as Record<string, string | undefined>)[
      'VITE_SOCIAL_SERVICE_BASE_URL'
    ];
  });

  it('returns disabled configuration by default', () => {
    const config = getSocialConfig();
    expect(config.enabled).toBe(false);
    expect(config.baseUrl).toBe('http://localhost:4000');
    expect(isSocialCommandsEnabled()).toBe(false);
  });

  it('honours explicit overrides for tests', () => {
    setSocialConfigOverrideForTesting({
      enabled: true,
      baseUrl: 'https://example.social',
    });

    const config = getSocialConfig();
    expect(config.enabled).toBe(true);
    expect(config.baseUrl).toBe('https://example.social');
    expect(isSocialCommandsEnabled()).toBe(true);
  });

  it('reads values from environment variables when present', () => {
    process.env.VITE_ENABLE_SOCIAL_COMMANDS = '1';
    process.env.VITE_SOCIAL_SERVICE_BASE_URL = 'https://env.social';

    const config = getSocialConfig();
    expect(config.enabled).toBe(true);
    expect(config.baseUrl).toBe('https://env.social');
  });
});
