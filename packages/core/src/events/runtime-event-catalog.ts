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

export interface PrestigeResetEventPayload {
  readonly layer: number;
}

export interface TaskCompletedEventPayload {
  readonly taskId: string;
  readonly completedAtStep: number;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export type SocialIntentPayload =
  | string
  | number
  | boolean
  | null
  | SocialIntentPayload[]
  | {
      readonly [key: string]: SocialIntentPayload;
    };

export interface SocialIntentQueuedEventPayload {
  readonly intentId: string;
  readonly type: string;
  readonly issuedAt: number;
  readonly payload?: SocialIntentPayload;
}

export interface SocialIntentResolvedEventPayload {
  readonly intentId: string;
  readonly type: string;
  readonly confirmedAt: number;
  readonly payload?: SocialIntentPayload;
}

declare module './runtime-event.js' {
  interface RuntimeEventPayloadMap {
    'resource:threshold-reached': ResourceThresholdReachedEventPayload;
    'automation:toggled': AutomationToggledEventPayload;
    'prestige:reset': PrestigeResetEventPayload;
    'task:completed': TaskCompletedEventPayload;
    'social:intent-queued': SocialIntentQueuedEventPayload;
    'social:intent-confirmed': SocialIntentResolvedEventPayload;
    'social:intent-rejected': SocialIntentResolvedEventPayload;
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

function validatePrestigeReset(payload: PrestigeResetEventPayload): void {
  if (!Number.isInteger(payload.layer) || payload.layer < 0) {
    throw new Error('layer must be a non-negative integer.');
  }
}

function validateTaskCompleted(payload: TaskCompletedEventPayload): void {
  if (typeof payload.taskId !== 'string' || payload.taskId.length === 0) {
    throw new Error('taskId must be a non-empty string.');
  }
  if (!Number.isInteger(payload.completedAtStep) || payload.completedAtStep < 0) {
    throw new Error('completedAtStep must be a non-negative integer.');
  }
}

function validateSocialIntentQueued(payload: SocialIntentQueuedEventPayload): void {
  if (typeof payload.intentId !== 'string' || payload.intentId.length === 0) {
    throw new Error('intentId must be a non-empty string.');
  }
  if (typeof payload.type !== 'string' || payload.type.length === 0) {
    throw new Error('type must be a non-empty string.');
  }
  if (!Number.isFinite(payload.issuedAt)) {
    throw new Error('issuedAt must be a finite number.');
  }
}

function validateSocialIntentResolved(payload: SocialIntentResolvedEventPayload): void {
  if (typeof payload.intentId !== 'string' || payload.intentId.length === 0) {
    throw new Error('intentId must be a non-empty string.');
  }
  if (typeof payload.type !== 'string' || payload.type.length === 0) {
    throw new Error('type must be a non-empty string.');
  }
  if (!Number.isFinite(payload.confirmedAt)) {
    throw new Error('confirmedAt must be a finite number.');
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
  {
    definition: {
      type: 'prestige:reset',
      version: 1,
      validator: validatePrestigeReset,
    },
  } as EventChannelConfiguration,
  {
    definition: {
      type: 'task:completed',
      version: 1,
      validator: validateTaskCompleted,
    },
  } as EventChannelConfiguration,
  {
    definition: {
      type: 'social:intent-queued',
      version: 1,
      validator: validateSocialIntentQueued,
    },
  } as EventChannelConfiguration,
  {
    definition: {
      type: 'social:intent-confirmed',
      version: 1,
      validator: validateSocialIntentResolved,
    },
  } as EventChannelConfiguration,
  {
    definition: {
      type: 'social:intent-rejected',
      version: 1,
      validator: validateSocialIntentResolved,
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
