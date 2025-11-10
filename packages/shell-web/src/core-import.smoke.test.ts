import { describe, it, expect } from 'vitest';

// Smoke test to ensure the Vite alias for @idle-engine/core remains linkable.
describe('core alias import', () => {
  it('loads the core entry via Vite alias without throwing', async () => {
    const coreModule = await import('@idle-engine/core');

    expect(coreModule).toBeTruthy();
  });
});
