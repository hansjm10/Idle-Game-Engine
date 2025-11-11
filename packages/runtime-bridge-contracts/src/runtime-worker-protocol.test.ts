import { describe, expect, it } from 'vitest';
import { WORKER_MESSAGE_SCHEMA_VERSION } from './runtime-worker-protocol.js';

describe('runtime bridge contracts', () => {
  it('guards the schema version to catch accidental bumps', () => {
    // Intentional guard: update when the schema changes.
    expect(WORKER_MESSAGE_SCHEMA_VERSION).toBe(3);
  });
});

