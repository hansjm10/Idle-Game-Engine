import type { AutomationDefinition } from '@idle-engine/content-schema';
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

export type AutomationFiredTriggerKind = AutomationDefinition['trigger']['kind'];

export interface AutomationFiredEventPayload {
  readonly automationId: string;
  readonly triggerKind: AutomationFiredTriggerKind;
  readonly step: number;
}

export interface MissionStartedEventPayload {
  readonly transformId: string;
  readonly batchId: string;
  readonly startedAtStep: number;
  readonly completeAtStep: number;
  readonly entityInstanceIds: readonly string[];
}

export type MissionOutcomeKind = 'success' | 'failure' | 'critical';

export interface MissionCompletedEventPayload {
  readonly transformId: string;
  readonly batchId: string;
  readonly completedAtStep: number;
  readonly outcomeKind: MissionOutcomeKind;
  readonly success: boolean;
  readonly critical: boolean;
  readonly outputs: readonly { resourceId: string; amount: number }[];
  readonly entityExperience: number;
  readonly entityInstanceIds: readonly string[];
}

declare module './runtime-event.js' {
  interface RuntimeEventPayloadMap {
    'resource:threshold-reached': ResourceThresholdReachedEventPayload;
    'automation:toggled': AutomationToggledEventPayload;
    'automation:fired': AutomationFiredEventPayload;
    'mission:started': MissionStartedEventPayload;
    'mission:completed': MissionCompletedEventPayload;
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

function validateAutomationFired(payload: AutomationFiredEventPayload): void {
  if (typeof payload.automationId !== 'string' || payload.automationId.length === 0) {
    throw new Error('automationId must be a non-empty string.');
  }
  if (typeof payload.triggerKind !== 'string' || payload.triggerKind.length === 0) {
    throw new Error('triggerKind must be a non-empty string.');
  }
  if (!Number.isInteger(payload.step) || payload.step < 0) {
    throw new Error('step must be a non-negative integer.');
  }
}

function validateStringArray(arr: unknown, fieldName: string): void {
  if (!Array.isArray(arr)) {
    throw new TypeError(`${fieldName} must be an array.`);
  }
  for (const id of arr) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError(`${fieldName} must contain non-empty strings.`);
    }
  }
}

function validateOutcomeConsistency(
  outcomeKind: MissionOutcomeKind,
  success: boolean,
  critical: boolean,
): void {
  const expectedFlags: Record<MissionOutcomeKind, { success: boolean; critical: boolean }> = {
    critical: { success: true, critical: true },
    success: { success: true, critical: false },
    failure: { success: false, critical: false },
  };
  const expected = expectedFlags[outcomeKind];
  if (success !== expected.success || critical !== expected.critical) {
    throw new Error(
      `outcomeKind "${outcomeKind}" requires success=${expected.success} and critical=${expected.critical}.`,
    );
  }
}

function validateMissionOutputs(outputs: unknown): void {
  if (!Array.isArray(outputs)) {
    throw new TypeError('outputs must be an array.');
  }
  for (const output of outputs) {
    if (!output || typeof output !== 'object') {
      throw new Error('outputs must contain objects.');
    }
    const record = output as Record<string, unknown>;
    if (typeof record.resourceId !== 'string' || record.resourceId.length === 0) {
      throw new Error('output.resourceId must be a non-empty string.');
    }
    if (typeof record.amount !== 'number' || !Number.isFinite(record.amount)) {
      throw new TypeError('output.amount must be a finite number.');
    }
  }
}

function validateMissionStarted(payload: MissionStartedEventPayload): void {
  if (typeof payload.transformId !== 'string' || payload.transformId.length === 0) {
    throw new Error('transformId must be a non-empty string.');
  }
  if (typeof payload.batchId !== 'string' || payload.batchId.length === 0) {
    throw new Error('batchId must be a non-empty string.');
  }
  if (!Number.isInteger(payload.startedAtStep) || payload.startedAtStep < 0) {
    throw new Error('startedAtStep must be a non-negative integer.');
  }
  if (!Number.isInteger(payload.completeAtStep) || payload.completeAtStep < 0) {
    throw new Error('completeAtStep must be a non-negative integer.');
  }
  validateStringArray(payload.entityInstanceIds, 'entityInstanceIds');
}

function validateMissionCompleted(payload: MissionCompletedEventPayload): void {
  if (typeof payload.transformId !== 'string' || payload.transformId.length === 0) {
    throw new Error('transformId must be a non-empty string.');
  }
  if (typeof payload.batchId !== 'string' || payload.batchId.length === 0) {
    throw new Error('batchId must be a non-empty string.');
  }
  if (!Number.isInteger(payload.completedAtStep) || payload.completedAtStep < 0) {
    throw new Error('completedAtStep must be a non-negative integer.');
  }
  if (
    payload.outcomeKind !== 'success' &&
    payload.outcomeKind !== 'failure' &&
    payload.outcomeKind !== 'critical'
  ) {
    throw new Error('outcomeKind must be "success", "failure", or "critical".');
  }
  if (typeof payload.success !== 'boolean') {
    throw new TypeError('success must be a boolean.');
  }
  if (typeof payload.critical !== 'boolean') {
    throw new TypeError('critical must be a boolean.');
  }
  validateOutcomeConsistency(payload.outcomeKind, payload.success, payload.critical);
  validateMissionOutputs(payload.outputs);
  if (typeof payload.entityExperience !== 'number' || !Number.isFinite(payload.entityExperience)) {
    throw new TypeError('entityExperience must be a finite number.');
  }
  validateStringArray(payload.entityInstanceIds, 'entityInstanceIds');
}

const CORE_EVENT_CHANNELS: readonly EventChannelConfiguration[] = [
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
      type: 'automation:fired',
      version: 1,
      validator: validateAutomationFired,
    },
  } as EventChannelConfiguration,
  {
    definition: {
      type: 'mission:started',
      version: 1,
      validator: validateMissionStarted,
    },
  } as EventChannelConfiguration,
  {
    definition: {
      type: 'mission:completed',
      version: 1,
      validator: validateMissionCompleted,
    },
  } as EventChannelConfiguration,
];

export const RUNTIME_EVENT_CHANNELS: readonly EventChannelConfiguration[] = [
  ...CORE_EVENT_CHANNELS,
  ...CONTENT_EVENT_CHANNELS,
];

export const DEFAULT_EVENT_BUS_OPTIONS: EventBusOptions = {
  channels: RUNTIME_EVENT_CHANNELS,
  slowHandlerThresholdMs: 2,
};
