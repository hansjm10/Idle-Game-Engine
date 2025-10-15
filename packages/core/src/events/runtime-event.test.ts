import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  computeRuntimeEventManifestHash,
  createRuntimeEvent,
  type RuntimeEventManifest,
  type RuntimeEventPayload,
} from './runtime-event.js';

describe('createRuntimeEvent', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('freezes the event payload in development mode', () => {
    vi.stubEnv('NODE_ENV', 'development');

    const event = createRuntimeEvent({
      type: 'resource:threshold-reached',
      tick: 42,
      issuedAt: 12,
      payload: {
        resourceId: 'energy',
        threshold: 10,
      } as const,
    });

    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.payload)).toBe(true);

    expect(event.type).toBe('resource:threshold-reached');
    expect(event.tick).toBe(42);
    expect(event.issuedAt).toBe(12);
    expect(event.payload.threshold).toBe(10);

    expect(() => {
      (event.payload as { threshold: number }).threshold = 20;
    }).toThrow(TypeError);
  });

  it('skips freezing the event payload in production mode', () => {
    vi.stubEnv('NODE_ENV', 'production');

    const event = createRuntimeEvent({
      type: 'automation:toggled',
      tick: 99,
      issuedAt: 512,
      payload: {
        automationId: 'auto:1',
        enabled: true,
      } as unknown as RuntimeEventPayload<'automation:toggled'>,
    });

    expect(Object.isFrozen(event)).toBe(false);
    expect(Object.isFrozen(event.payload)).toBe(false);

    const mutablePayload = event.payload as { enabled: boolean };
    mutablePayload.enabled = false;
    expect(mutablePayload.enabled).toBe(false);
  });
});

describe('computeRuntimeEventManifestHash', () => {
  it('produces a deterministic hash regardless of entry ordering', () => {
    const manifestA: RuntimeEventManifest = {
      entries: [
        {
          type: 'resource:threshold-reached',
          channel: 1,
          version: 1,
        },
        {
          type: 'automation:toggled',
          channel: 2,
          version: 3,
        },
      ],
    };

    const manifestB: RuntimeEventManifest = {
      entries: [
        {
          type: 'automation:toggled',
          channel: 2,
          version: 3,
        },
        {
          type: 'resource:threshold-reached',
          channel: 1,
          version: 1,
        },
      ],
    };

    const hashA = computeRuntimeEventManifestHash(manifestA);
    const hashB = computeRuntimeEventManifestHash(manifestB);

    expect(hashA).toBe(hashB);
  });

  it('changes the hash when manifest contents differ', () => {
    const baseManifest: RuntimeEventManifest = {
      entries: [
        {
          type: 'resource:threshold-reached',
          channel: 1,
          version: 1,
        },
      ],
    };

    const updatedManifest: RuntimeEventManifest = {
      entries: [
        {
          type: 'resource:threshold-reached',
          channel: 1,
          version: 2,
        },
      ],
    };

    const originalHash = computeRuntimeEventManifestHash(baseManifest);
    const updatedHash = computeRuntimeEventManifestHash(updatedManifest);

    expect(originalHash).not.toBe(updatedHash);
  });
});
