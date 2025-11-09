import { describe, it, expect } from 'vitest';

import { sampleContent } from '.';
import { automationCollectionSchema } from '@idle-engine/content-schema';

describe('sample content pack automations', () => {
  it('includes 4+ automations and all trigger kinds', () => {
    const automations = sampleContent.modules.automations;
    expect(Array.isArray(automations)).toBe(true);
    expect(automations.length).toBeGreaterThanOrEqual(4);

    const kinds = new Set(automations.map((a) => a.trigger.kind));
    expect(kinds.has('interval')).toBe(true);
    expect(kinds.has('resourceThreshold')).toBe(true);
    expect(kinds.has('commandQueueEmpty')).toBe(true);
    expect(kinds.has('event')).toBe(true);
  });

  it('validates automations against the schema', () => {
    const automations = sampleContent.modules.automations;
    const result = automationCollectionSchema.safeParse(automations);
    expect(result.success).toBe(true);
  });

  it('includes resourceCost on specific sample automations now that engine support has landed', () => {
    const automations = sampleContent.modules.automations;
    const byId = new Map(automations.map((a) => [a.id, a]));

    const burst = byId.get('sample-pack.auto-reactor-burst');
    const autobuy = byId.get('sample-pack.autobuy-reactor-insulation');

    expect(burst).toBeDefined();
    expect(autobuy).toBeDefined();

    // Validate presence and basic shape of resourceCost
    expect(burst?.resourceCost).toBeDefined();
    expect(burst?.resourceCost?.resourceId).toBe('sample-pack.energy');
    expect((burst?.resourceCost as any).rate?.kind).toBe('constant');

    expect(autobuy?.resourceCost).toBeDefined();
    expect(autobuy?.resourceCost?.resourceId).toBe('sample-pack.energy');
    expect((autobuy?.resourceCost as any).rate?.kind).toBe('constant');
  });
});
