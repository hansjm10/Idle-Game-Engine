import { describe, expect, it } from 'vitest';

import { IdleEngineRuntime } from './internals.browser.js';

describe('internals.browser', () => {
  describe('IdleEngineRuntime', () => {
    it.each([
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      0,
    ])('creditTime ignores invalid deltaMs (%s)', (deltaMs) => {
      const runtime = new IdleEngineRuntime({ stepSizeMs: 10 });
      runtime.creditTime(deltaMs);

      expect(runtime.fastForward(10)).toBe(1);
      expect(runtime.getCurrentStep()).toBe(1);
    });

    it.each([
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      0,
    ])('fastForward ignores invalid deltaMs (%s)', (deltaMs) => {
      const runtime = new IdleEngineRuntime({ stepSizeMs: 10 });

      expect(runtime.fastForward(deltaMs)).toBe(0);
      expect(runtime.getCurrentStep()).toBe(0);
    });
  });
});

