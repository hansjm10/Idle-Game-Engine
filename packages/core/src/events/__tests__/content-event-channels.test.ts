import { describe, it, expect } from 'vitest';
import {
  CONTENT_EVENT_CHANNELS,
  CONTENT_EVENT_DEFINITIONS,
  GENERATED_RUNTIME_EVENT_MANIFEST,
} from '../runtime-event-manifest.generated.js';

describe('Content Event Channels', () => {
  it('should include sample:reactor-primed in content event definitions', () => {
    const reactorPrimed = CONTENT_EVENT_DEFINITIONS.find(
      (def) => def.type === 'sample:reactor-primed'
    );
    expect(reactorPrimed).toBeDefined();
    expect(reactorPrimed?.packSlug).toBe('@idle-engine/sample-pack');
    expect(reactorPrimed?.version).toBeGreaterThanOrEqual(1);
    expect(reactorPrimed?.schema).toContain('reactor-primed.schema.json');
  });

  it('should include sample:reactor-primed in content event channels', () => {
    const reactorPrimedChannel = CONTENT_EVENT_CHANNELS.find(
      (channel) => channel.definition.type === 'sample:reactor-primed'
    );
    expect(reactorPrimedChannel).toBeDefined();
    expect(reactorPrimedChannel?.definition.version).toBeGreaterThanOrEqual(1);
  });

  it('should include sample:reactor-primed in generated manifest', () => {
    const reactorPrimedEntry = GENERATED_RUNTIME_EVENT_MANIFEST.entries.find(
      (entry) => entry.type === 'sample:reactor-primed'
    );
    expect(reactorPrimedEntry).toBeDefined();
    expect(reactorPrimedEntry?.version).toBeGreaterThanOrEqual(1);
    expect(reactorPrimedEntry?.channel).toBeGreaterThanOrEqual(0);
  });
});
