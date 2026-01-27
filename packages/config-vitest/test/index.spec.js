import { describe, it, expect } from 'vitest';
import { createVitestConfig, createBrowserVitestConfig } from '../index.js';

describe('createVitestConfig', () => {
  it('should return default config with node environment', () => {
    const config = createVitestConfig();
    expect(config.test.environment).toBe('node');
  });

  it('should merge overrides', () => {
    const config = createVitestConfig({ test: { timeout: 10000 } });
    expect(config.test.timeout).toBe(10000);
    expect(config.test.environment).toBe('node');
  });
});

describe('createBrowserVitestConfig', () => {
  it('should return config with jsdom environment', () => {
    const config = createBrowserVitestConfig();
    expect(config.test.environment).toBe('jsdom');
  });

  it('should merge overrides', () => {
    const config = createBrowserVitestConfig({ test: { timeout: 20000 } });
    expect(config.test.timeout).toBe(20000);
    expect(config.test.environment).toBe('jsdom');
  });
});
