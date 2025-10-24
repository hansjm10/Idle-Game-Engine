import { describe, expect, it } from 'vitest';

import { createResourceState } from './resource-state.js';
import { createGeneratorState } from './generator-state.js';
import { createUpgradeState } from './upgrade-state.js';
import { createRuntimeStateView } from './runtime-state-view.js';

describe('createRuntimeStateView', () => {
  it('exposes immutable aggregated runtime state views', () => {
    const resources = createResourceState([
      { id: 'energy', startAmount: 5, capacity: 10 },
    ]);
    const generators = createGeneratorState([
      { id: 'reactor', startLevel: 2 },
    ]);
    const upgrades = createUpgradeState([
      { id: 'automation-suite' },
    ]);

    const view = createRuntimeStateView({ resources, generators, upgrades });
    expect(view.resources?.ids).toEqual(['energy']);
    expect(view.generators?.ids).toEqual(['reactor']);
    expect(view.upgrades?.ids).toEqual(['automation-suite']);

    expect(() => {
      (view.resources?.amounts as unknown as Float64Array)[0] = 99;
    }).toThrowError(/must not mutate state/i);

    expect(() => {
      (view as { resources?: unknown }).resources = undefined;
    }).toThrowError(/must not mutate state/i);
  });
});
