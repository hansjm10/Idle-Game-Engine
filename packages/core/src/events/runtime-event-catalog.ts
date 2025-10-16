import type {
  EventBusOptions,
  EventChannelConfiguration,
} from './event-bus.js';
import { CONTENT_EVENT_CHANNELS } from './runtime-event-manifest.generated.js';

export interface ResourceThresholdReachedEventPayload {
  readonly resourceId: string;
  readonly threshold: number;
}

export interface AutomationToggledEventPayload {
  readonly automationId: string;
  readonly enabled: boolean;
}

declare module './runtime-event.js' {
  interface RuntimeEventPayloadMap {
    'resource:threshold-reached': ResourceThresholdReachedEventPayload;
    'automation:toggled': AutomationToggledEventPayload;
  }
}

function validateResourceThresholdReached(
  payload: ResourceThresholdReachedEventPayload,
): void {
  if (typeof payload.resourceId !== 'string' || payload.resourceId.length === 0) {
    throw new Error('resourceId must be a non-empty string.');
  }
  if (!Number.isFinite(payload.threshold)) {
    throw new Error('threshold must be a finite number.');
  }
}

function validateAutomationToggled(payload: AutomationToggledEventPayload): void {
  if (typeof payload.automationId !== 'string' || payload.automationId.length === 0) {
    throw new Error('automationId must be a non-empty string.');
  }
  if (typeof payload.enabled !== 'boolean') {
    throw new Error('enabled must be a boolean.');
  }
}

const CORE_EVENT_CHANNELS: ReadonlyArray<EventChannelConfiguration> = [
  {
    definition: {
      type: 'resource:threshold-reached',
      version: 1,
      validator: validateResourceThresholdReached,
    },
  } as EventChannelConfiguration,
  {
    definition: {
      type: 'automation:toggled',
      version: 1,
      validator: validateAutomationToggled,
    },
  } as EventChannelConfiguration,
];

export const RUNTIME_EVENT_CHANNELS: ReadonlyArray<EventChannelConfiguration> = [
  ...CORE_EVENT_CHANNELS,
  ...CONTENT_EVENT_CHANNELS,
];

export const DEFAULT_EVENT_BUS_OPTIONS: EventBusOptions = {
  channels: RUNTIME_EVENT_CHANNELS,
  slowHandlerThresholdMs: 2,
};
