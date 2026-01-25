import { describe, expect, it } from 'vitest';

import { testGameEventDefinitions, testGameEventTypes } from '.';

describe('test game runtime events', () => {
  it('includes test-game:milestone-reached in event manifest', () => {
    expect(testGameEventTypes).toContain('test-game:milestone-reached');

    const match = testGameEventDefinitions.find(
      (definition) =>
        definition.type === 'test-game:milestone-reached' && definition.version >= 1,
    );
    expect(match).toBeTruthy();
  });

  it('includes test-game:prestige-ready in event manifest', () => {
    expect(testGameEventTypes).toContain('test-game:prestige-ready');

    const match = testGameEventDefinitions.find(
      (definition) =>
        definition.type === 'test-game:prestige-ready' && definition.version >= 1,
    );
    expect(match).toBeTruthy();
  });

  it('includes test-game:mission-complete in event manifest', () => {
    expect(testGameEventTypes).toContain('test-game:mission-complete');

    const match = testGameEventDefinitions.find(
      (definition) =>
        definition.type === 'test-game:mission-complete' && definition.version >= 1,
    );
    expect(match).toBeTruthy();
  });
});

