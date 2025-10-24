import type {
  EventHandler,
  EventPublisher,
  EventSubscription,
  EventSubscriptionOptions,
} from '../events/event-bus.js';
import type { RuntimeEventType } from '../events/runtime-event.js';

export interface TickContext {
  readonly deltaMs: number;
  readonly step: number;
  readonly events: EventPublisher;
}

export interface SystemRegistrationContext {
  readonly events: {
    on<TType extends RuntimeEventType>(
      eventType: TType,
      handler: EventHandler<TType>,
      options?: EventSubscriptionOptions,
    ): EventSubscription;
  };
}

export type System = {
  readonly id: string;
  readonly tick: (context: TickContext) => void;
  readonly setup?: (context: SystemRegistrationContext) => void;
};

export interface SystemDefinition extends System {
  readonly after?: readonly string[];
  readonly before?: readonly string[];
  readonly label?: string;
}

