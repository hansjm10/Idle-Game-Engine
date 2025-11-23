import { describe, it, expect } from 'vitest';

import { sampleContent } from '.';

describe('sample content pack', () => {
  it('includes generators and upgrades for progression UI', () => {
    const { modules } = sampleContent;
    expect(modules.generators.length).toBeGreaterThanOrEqual(5);
    expect(modules.upgrades.length).toBeGreaterThanOrEqual(10);

    const upgradeIds = modules.upgrades.map((u) => u.id);
    expect(upgradeIds).toContain('sample-pack.reactor-insulation');
    expect(upgradeIds).toContain('sample-pack.reactor-overclock');
    expect(upgradeIds).toContain('sample-pack.reactor-phase-cooling');
    expect(upgradeIds).toContain('sample-pack.harvester-efficiency');
    expect(upgradeIds).toContain('sample-pack.harvester-deep-core');
    expect(upgradeIds).toContain('sample-pack.harvester-quantum-sieve');
    expect(upgradeIds).toContain('sample-pack.forge-heat-shield');
    expect(upgradeIds).toContain('sample-pack.forge-auto-feed');
    expect(upgradeIds).toContain('sample-pack.lab-insight-boost');
    expect(upgradeIds).toContain('sample-pack.lab-simulation-stack');
    expect(upgradeIds).toContain('sample-pack.ascension-surge');
  });
});
