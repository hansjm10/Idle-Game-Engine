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

export interface MissionStageCompletedEventPayload {
  readonly transformId: string;
  readonly batchId: string;
  readonly stageId: string;
  readonly checkpoint?: { outputs: readonly { resourceId: string; amount: number }[] };
}

export interface MissionDecisionRequiredEventPayload {
  readonly transformId: string;
  readonly batchId: string;
  readonly stageId: string;
  readonly prompt: string;
  readonly options: readonly { id: string; label: string; available: boolean }[];
  readonly expiresAtStep: number;
}

export interface MissionDecisionMadeEventPayload {
  readonly transformId: string;
  readonly batchId: string;
  readonly stageId: string;
  readonly optionId: string;
  readonly nextStageId: string | null;
}

declare module './runtime-event.js' {
  interface RuntimeEventPayloadMap {
    'resource:threshold-reached': ResourceThresholdReachedEventPayload;
    'automation:toggled': AutomationToggledEventPayload;
    'automation:fired': AutomationFiredEventPayload;
    'mission:started': MissionStartedEventPayload;
    'mission:completed': MissionCompletedEventPayload;
    'mission:stage-completed': MissionStageCompletedEventPayload;
    'mission:decision-required': MissionDecisionRequiredEventPayload;
    'mission:decision-made': MissionDecisionMadeEventPayload;
  }
}

function requireNonEmptyString(value: unknown, fieldName: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }
}

function requireFiniteNumber(value: unknown, fieldName: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${fieldName} must be a finite number.`);
  }
}

function requireBoolean(value: unknown, fieldName: string): void {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${fieldName} must be a boolean.`);
  }
}

function requireNonNegativeInteger(value: unknown, fieldName: string): void {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${fieldName} must be a non-negative integer.`);
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

function validateResourceThresholdReached(
  payload: ResourceThresholdReachedEventPayload,
): void {
  requireNonEmptyString(payload.resourceId, 'resourceId');
  requireFiniteNumber(payload.threshold, 'threshold');
}

function validateAutomationToggled(payload: AutomationToggledEventPayload): void {
  requireNonEmptyString(payload.automationId, 'automationId');
  requireBoolean(payload.enabled, 'enabled');
}

function validateAutomationFired(payload: AutomationFiredEventPayload): void {
  requireNonEmptyString(payload.automationId, 'automationId');
  requireNonEmptyString(payload.triggerKind, 'triggerKind');
  requireNonNegativeInteger(payload.step, 'step');
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
    requireNonEmptyString(record.resourceId, 'output.resourceId');
    requireFiniteNumber(record.amount, 'output.amount');
  }
}

function validateMissionStarted(payload: MissionStartedEventPayload): void {
  requireNonEmptyString(payload.transformId, 'transformId');
  requireNonEmptyString(payload.batchId, 'batchId');
  requireNonNegativeInteger(payload.startedAtStep, 'startedAtStep');
  requireNonNegativeInteger(payload.completeAtStep, 'completeAtStep');
  validateStringArray(payload.entityInstanceIds, 'entityInstanceIds');
}

function validateMissionCompleted(payload: MissionCompletedEventPayload): void {
  requireNonEmptyString(payload.transformId, 'transformId');
  requireNonEmptyString(payload.batchId, 'batchId');
  requireNonNegativeInteger(payload.completedAtStep, 'completedAtStep');
  if (
    payload.outcomeKind !== 'success' &&
    payload.outcomeKind !== 'failure' &&
    payload.outcomeKind !== 'critical'
  ) {
    throw new Error('outcomeKind must be "success", "failure", or "critical".');
  }
  requireBoolean(payload.success, 'success');
  requireBoolean(payload.critical, 'critical');
  validateOutcomeConsistency(payload.outcomeKind, payload.success, payload.critical);
  validateMissionOutputs(payload.outputs);
  requireFiniteNumber(payload.entityExperience, 'entityExperience');
  validateStringArray(payload.entityInstanceIds, 'entityInstanceIds');
}

function validateMissionStageCompleted(payload: MissionStageCompletedEventPayload): void {
  requireNonEmptyString(payload.transformId, 'transformId');
  requireNonEmptyString(payload.batchId, 'batchId');
  requireNonEmptyString(payload.stageId, 'stageId');
  if (payload.checkpoint !== undefined) {
    if (!payload.checkpoint || typeof payload.checkpoint !== 'object') {
      throw new Error('checkpoint must be an object.');
    }
    const record = payload.checkpoint as Record<string, unknown>;
    validateMissionOutputs(record.outputs);
  }
}

function validateMissionDecisionRequired(payload: MissionDecisionRequiredEventPayload): void {
  requireNonEmptyString(payload.transformId, 'transformId');
  requireNonEmptyString(payload.batchId, 'batchId');
  requireNonEmptyString(payload.stageId, 'stageId');
  requireNonEmptyString(payload.prompt, 'prompt');
  if (!Array.isArray(payload.options)) {
    throw new TypeError('options must be an array.');
  }
  for (const option of payload.options) {
    if (!option || typeof option !== 'object') {
      throw new Error('options must contain objects.');
    }
    const record = option as Record<string, unknown>;
    requireNonEmptyString(record.id, 'option.id');
    requireNonEmptyString(record.label, 'option.label');
    requireBoolean(record.available, 'option.available');
  }
  requireNonNegativeInteger(payload.expiresAtStep, 'expiresAtStep');
}

function validateMissionDecisionMade(payload: MissionDecisionMadeEventPayload): void {
  requireNonEmptyString(payload.transformId, 'transformId');
  requireNonEmptyString(payload.batchId, 'batchId');
  requireNonEmptyString(payload.stageId, 'stageId');
  requireNonEmptyString(payload.optionId, 'optionId');
  if (payload.nextStageId !== null) {
    if (typeof payload.nextStageId !== 'string' || payload.nextStageId.length === 0) {
      throw new Error('nextStageId must be a non-empty string or null.');
    }
  }
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
  {
    definition: {
      type: 'mission:stage-completed',
      version: 1,
      validator: validateMissionStageCompleted,
    },
  } as EventChannelConfiguration,
  {
    definition: {
      type: 'mission:decision-required',
      version: 1,
      validator: validateMissionDecisionRequired,
    },
  } as EventChannelConfiguration,
  {
    definition: {
      type: 'mission:decision-made',
      version: 1,
      validator: validateMissionDecisionMade,
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
