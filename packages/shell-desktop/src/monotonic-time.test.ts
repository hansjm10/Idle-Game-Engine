import { describe, expect, it } from 'vitest';

import { monotonicNowMs } from './monotonic-time.js';

describe('monotonicNowMs', () => {
  it('returns a finite, non-decreasing millisecond timestamp', () => {
    const first = monotonicNowMs();
    const second = monotonicNowMs();

    expect(Number.isFinite(first)).toBe(true);
    expect(Number.isFinite(second)).toBe(true);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThanOrEqual(first);
  });
});
