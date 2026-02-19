import { describe, expect, it } from 'vitest';

import { buildProgressionSnapshot, loadGameStateSaveFormat } from './runtime-harness.js';

describe('shell-desktop runtime harness', () => {
  it('re-exports core harness helpers', () => {
    expect(loadGameStateSaveFormat).toBeTypeOf('function');
    expect(buildProgressionSnapshot).toBeTypeOf('function');
  });

  it('loads saves without relying on core internals', () => {
    expect(() => loadGameStateSaveFormat({})).toThrow();
  });
});

