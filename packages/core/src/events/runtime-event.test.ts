import { describe, expect, it } from 'vitest';

import {
  createRuntimeEventManifest,
  createRuntimeEventSnapshot,
  ensureRuntimeEventPayload,
  type RuntimeEventDraft,
} from './runtime-event.js';

declare module './runtime-event.js' {
  interface RuntimeEventPayloadMap {
    readonly 'resource.threshold': {
      readonly resourceId: string;
      readonly threshold: number;
    };
    readonly 'automation.toggle': {
      readonly automationId: string;
      readonly enabled: boolean;
    };
  }
}

describe('createRuntimeEventManifest', () => {
  it('sorts event types and produces a stable hash', () => {
    const manifest = createRuntimeEventManifest([
      'resource.threshold',
      'automation.toggle',
    ]);

    expect(manifest.types).toEqual([
      'automation.toggle',
      'resource.threshold',
    ]);
    expect(manifest.hash).toBe('fnv1a-ad5208d1');
    expect(manifest.version).toBe(2);
  });
});

describe('ensureRuntimeEventPayload', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('creates an immutable payload when NODE_ENV is not production', () => {
    delete process.env.NODE_ENV;
    const payload = { resourceId: 'gold', threshold: 10 };
    const immutable = ensureRuntimeEventPayload(payload);

    expect(immutable).not.toBe(payload);
    expect(() => {
      (immutable as { threshold: number }).threshold = 20;
    }).toThrow();
  });

  it('returns the original payload reference in production mode', () => {
    process.env.NODE_ENV = 'production';
    const payload = { resourceId: 'iron', threshold: 5 };
    const immutable = ensureRuntimeEventPayload(payload);

    expect(immutable).toBe(payload);
  });
});

describe('createRuntimeEventSnapshot', () => {
  it('wraps event metadata with an immutable payload snapshot', () => {
    const draft: RuntimeEventDraft<'resource.threshold'> = {
      type: 'resource.threshold',
      tick: 42,
      issuedAt: 1_234,
      dispatchOrder: 7,
      payload: {
        resourceId: 'iron',
        threshold: 11,
      },
    };

    const event = createRuntimeEventSnapshot(draft);

    expect(event.type).toBe('resource.threshold');
    expect(event.tick).toBe(42);
    expect(event.issuedAt).toBe(1_234);
    expect(event.dispatchOrder).toBe(7);
    expect(() => {
      (event.payload as { threshold: number }).threshold = 9;
    }).toThrow();
  });
});
