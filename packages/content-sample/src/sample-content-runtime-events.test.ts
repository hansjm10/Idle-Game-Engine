import { describe, it, expect } from 'vitest';

import { sampleEventDefinitions, sampleEventTypes } from '.';

describe('sample runtime events', () => {
  it('includes sample:reactor-primed in event manifest', () => {
    // Type list should contain the event
    expect(sampleEventTypes).toContain('sample:reactor-primed');

    // Definitions should include an entry with matching type and pack slug
    const match = sampleEventDefinitions.find(
      (d) => d.type === 'sample:reactor-primed' && d.version >= 1,
    );
    expect(match).toBeTruthy();
  });
});

