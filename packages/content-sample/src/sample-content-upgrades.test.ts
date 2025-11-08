import { describe, it, expect } from 'vitest';

import { sampleContent } from '.';

describe('sample content pack', () => {
  it('includes generators and upgrades for progression UI', () => {
    const { modules } = sampleContent;
    expect(modules.generators.length).toBeGreaterThanOrEqual(2);
    expect(modules.upgrades.length).toBeGreaterThanOrEqual(3);

    const upgradeIds = modules.upgrades.map((u) => u.id);
    expect(upgradeIds).toContain('sample-pack.reactor-insulation');
    expect(upgradeIds).toContain('sample-pack.reactor-overclock');
    expect(upgradeIds).toContain('sample-pack.harvester-efficiency');
  });
});

