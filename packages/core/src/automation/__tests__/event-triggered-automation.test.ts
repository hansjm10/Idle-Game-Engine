import { describe, it, expect } from 'vitest';
import { EventBus } from '../../events/event-bus.js';
import { RUNTIME_EVENT_CHANNELS } from '../../events/runtime-event-catalog.js';

describe('Event-Triggered Automation Setup', () => {
  it('should register event listener for sample:reactor-primed without error', () => {
    const eventBus = new EventBus({
      channels: RUNTIME_EVENT_CHANNELS,
    });

    // This should not throw "Unknown runtime event type"
    expect(() => {
      eventBus.on('sample:reactor-primed', () => {
        // Automation callback
      });
    }).not.toThrow();
  });

  it('should include sample:reactor-primed in runtime event channels', () => {
    const channel = RUNTIME_EVENT_CHANNELS.find(
      (ch) => ch.definition.type === 'sample:reactor-primed'
    );
    expect(channel).toBeDefined();
  });
});
