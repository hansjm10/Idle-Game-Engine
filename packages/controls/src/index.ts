import { CommandPriority } from '@idle-engine/core';
import type {
  RuntimeCommand,
  RuntimeCommandPayloads,
  RuntimeCommandType,
} from '@idle-engine/core';

export type ControlActionId = string;
export type ControlBindingId = string;
export type ControlIntent = string;
export type ControlSchemeId = string;

export type ControlEventPhase = 'start' | 'repeat' | 'end';

export type ControlEvent = Readonly<{
  intent: ControlIntent;
  phase: ControlEventPhase;
  value?: number;
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type ControlContext = Readonly<{
  step: number;
  timestamp: number;
  priority?: CommandPriority;
  requestId?: string;
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type ControlAction<
  TType extends RuntimeCommandType = RuntimeCommandType,
> = Readonly<{
  id: ControlActionId;
  commandType: TType;
  payload: RuntimeCommandPayloads[TType];
  priority?: CommandPriority;
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type ControlBinding = Readonly<{
  id: ControlBindingId;
  intent: ControlIntent;
  actionId: ControlActionId;
  phases?: readonly ControlEventPhase[];
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type ControlScheme = Readonly<{
  id: ControlSchemeId;
  version: string;
  actions: readonly ControlAction[];
  bindings: readonly ControlBinding[];
  metadata?: Readonly<Record<string, unknown>>;
}>;

export const CONTROL_SCHEME_VALIDATION_CODES = {
  DUPLICATE_ACTION_ID: 'controls.scheme.duplicateActionId',
  DUPLICATE_BINDING_ID: 'controls.scheme.duplicateBindingId',
  MISSING_ACTION_REFERENCE: 'controls.scheme.missingActionReference',
} as const;

export type ControlSchemeValidationCode =
  (typeof CONTROL_SCHEME_VALIDATION_CODES)[keyof typeof CONTROL_SCHEME_VALIDATION_CODES];

export type ControlSchemeValidationIssueSeverity = 'error' | 'warning' | 'info';

export type ControlSchemeValidationIssue = Readonly<{
  code: ControlSchemeValidationCode;
  message: string;
  path: readonly (string | number)[];
  severity: ControlSchemeValidationIssueSeverity;
  suggestion?: string;
}>;

const shouldMatchPhase = (
  binding: ControlBinding,
  phase: ControlEventPhase,
): boolean => {
  const phases = binding.phases;
  if (!phases) {
    return true;
  }
  if (phases.length === 0) {
    return false;
  }
  return phases.includes(phase);
};

const buildActionLookup = (
  actions: readonly ControlAction[],
): Map<ControlActionId, ControlAction> => {
  const lookup = new Map<ControlActionId, ControlAction>();
  for (const action of actions) {
    if (lookup.has(action.id)) {
      throw new Error(`Control action with id "${action.id}" is duplicated.`);
    }
    lookup.set(action.id, action);
  }
  return lookup;
};

const sortById = <T extends { id: string }>(
  values: readonly T[],
): T[] =>
  values
    .map((value, index) => ({ value, index }))
    .sort((left, right) => {
      const result = left.value.id.localeCompare(right.value.id);
      return result !== 0 ? result : left.index - right.index;
    })
    .map(({ value }) => value);

const normalizePhases = (
  phases: readonly ControlEventPhase[],
): readonly ControlEventPhase[] =>
  Array.from(new Set(phases)).sort((left, right) =>
    left.localeCompare(right),
  );

const createValidationIssue = (
  code: ControlSchemeValidationCode,
  message: string,
  path: readonly (string | number)[],
): ControlSchemeValidationIssue => ({
  code,
  message,
  path,
  severity: 'error',
});

export const normalizeControlScheme = (scheme: ControlScheme): ControlScheme => {
  const actions = sortById(scheme.actions);
  const bindings = sortById(scheme.bindings).map((binding) => {
    const phases = binding.phases;
    if (!phases) {
      return binding;
    }
    const normalizedPhases = normalizePhases(phases);
    if (
      normalizedPhases.length === phases.length &&
      normalizedPhases.every((phase, index) => phase === phases[index])
    ) {
      return binding;
    }
    return {
      ...binding,
      phases: normalizedPhases,
    };
  });

  return {
    ...scheme,
    actions,
    bindings,
  };
};

export const validateControlScheme = (
  scheme: ControlScheme,
): readonly ControlSchemeValidationIssue[] => {
  const issues: ControlSchemeValidationIssue[] = [];

  const actionIds = new Map<ControlActionId, number>();
  scheme.actions.forEach((action, index) => {
    const existing = actionIds.get(action.id);
    if (existing !== undefined) {
      issues.push(
        createValidationIssue(
          CONTROL_SCHEME_VALIDATION_CODES.DUPLICATE_ACTION_ID,
          `Duplicate control action id "${action.id}" also defined at index ${existing}.`,
          ['actions', index, 'id'],
        ),
      );
      return;
    }
    actionIds.set(action.id, index);
  });

  const bindingIds = new Map<ControlBindingId, number>();
  scheme.bindings.forEach((binding, index) => {
    const existing = bindingIds.get(binding.id);
    if (existing !== undefined) {
      issues.push(
        createValidationIssue(
          CONTROL_SCHEME_VALIDATION_CODES.DUPLICATE_BINDING_ID,
          `Duplicate control binding id "${binding.id}" also defined at index ${existing}.`,
          ['bindings', index, 'id'],
        ),
      );
      return;
    }
    bindingIds.set(binding.id, index);
  });

  const actionIdSet = new Set(actionIds.keys());
  scheme.bindings.forEach((binding, index) => {
    if (!actionIdSet.has(binding.actionId)) {
      issues.push(
        createValidationIssue(
          CONTROL_SCHEME_VALIDATION_CODES.MISSING_ACTION_REFERENCE,
          `Control binding "${binding.id}" references missing action id "${binding.actionId}".`,
          ['bindings', index, 'actionId'],
        ),
      );
    }
  });

  return issues;
};

export const resolveControlActions = (
  scheme: ControlScheme,
  event: ControlEvent,
): readonly ControlAction[] => {
  const actionsById = buildActionLookup(scheme.actions);
  const resolved: ControlAction[] = [];

  for (const binding of scheme.bindings) {
    if (binding.intent !== event.intent) {
      continue;
    }
    if (!shouldMatchPhase(binding, event.phase)) {
      continue;
    }
    const action = actionsById.get(binding.actionId);
    if (!action) {
      continue;
    }
    resolved.push(action);
  }

  return resolved;
};

export const createControlCommand = <
  TType extends RuntimeCommandType = RuntimeCommandType,
>(
  action: ControlAction<TType>,
  context: ControlContext,
): RuntimeCommand<TType> => ({
  type: action.commandType,
  payload: action.payload,
  priority: action.priority ?? context.priority ?? CommandPriority.PLAYER,
  timestamp: context.timestamp,
  step: context.step,
  requestId: context.requestId,
});

export const createControlCommands = (
  scheme: ControlScheme,
  event: ControlEvent,
  context: ControlContext,
): readonly RuntimeCommand[] => {
  const actionsById = buildActionLookup(scheme.actions);
  const commands: RuntimeCommand[] = [];

  for (const binding of scheme.bindings) {
    if (binding.intent !== event.intent) {
      continue;
    }
    if (!shouldMatchPhase(binding, event.phase)) {
      continue;
    }
    const action = actionsById.get(binding.actionId);
    if (!action) {
      continue;
    }
    commands.push(createControlCommand(action, context));
  }

  return commands;
};
