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

  it('includes a system-target automation and a resourceCost example', () => {
    const automations = sampleContent.modules.automations;
    const hasSystemTarget = automations.some(
      (a) => a.targetType === 'system' && typeof a.systemTargetId === 'string',
    );
    const hasResourceCost = automations.some((a) => a.resourceCost !== undefined);
    expect(hasSystemTarget).toBe(true);
    expect(hasResourceCost).toBe(true);
  });
});
