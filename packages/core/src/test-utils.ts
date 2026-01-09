import type { TickContext } from './index.js';
import type { EventPublisher } from './events/event-bus.js';

/**
 * Creates a mock EventPublisher for testing.
 */
export function createMockEventPublisher(): EventPublisher {
  return {
    publish: <TType>(eventType: TType) => ({
      accepted: true,
      state: 'accepted' as const,
      type: eventType,
      channel: 0,
      bufferSize: 0,
      remainingCapacity: 100,
      dispatchOrder: 0,
      softLimitActive: false,
    }),
  } as EventPublisher;
}

/**
 * Creates a TickContext for testing.
 */
export function createTickContext(deltaMs: number, step = 0): TickContext {
  return {
    deltaMs,
    step,
    events: createMockEventPublisher(),
  };
}
