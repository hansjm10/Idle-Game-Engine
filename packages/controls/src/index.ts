import { CommandPriority } from '@idle-engine/core';
import type {
  RuntimeCommand,
  RuntimeCommandPayloads,
  RuntimeCommandType,
} from '@idle-engine/core';

// Semantic aliases for external callers.
export type ControlActionId = string; // NOSONAR
export type ControlBindingId = string; // NOSONAR
export type ControlIntent = string; // NOSONAR
export type ControlSchemeId = string; // NOSONAR

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

/**
 * Input provided to payload resolvers for dynamic payload generation.
 */
export type ControlPayloadResolverInput = Readonly<{
  event: ControlEvent;
  context: ControlContext;
}>;

/**
 * Function that computes a payload dynamically from event and context.
 * Must return the correct payload type for the action's command type.
 *
 * IMPORTANT: For deterministic simulation, resolvers must not use Date.now(),
 * Math.random(), or other non-deterministic sources. Use values from the
 * provided event and context only.
 */
export type ControlPayloadResolver<
  TType extends RuntimeCommandType = RuntimeCommandType,
> = (input: ControlPayloadResolverInput) => RuntimeCommandPayloads[TType];

/**
 * Base properties shared by all control actions.
 */
type ControlActionBase<TType extends RuntimeCommandType = RuntimeCommandType> =
  Readonly<{
    id: ControlActionId;
    commandType: TType;
    priority?: CommandPriority;
    metadata?: Readonly<Record<string, unknown>>;
  }>;

/**
 * Control action with a static payload defined at authoring time.
 */
export type ControlActionWithPayload<
  TType extends RuntimeCommandType = RuntimeCommandType,
> = ControlActionBase<TType> &
  Readonly<{
    payload: RuntimeCommandPayloads[TType];
    payloadResolver?: never;
  }>;

/**
 * Control action with a dynamic payload resolver called at command creation.
 */
export type ControlActionWithResolver<
  TType extends RuntimeCommandType = RuntimeCommandType,
> = ControlActionBase<TType> &
  Readonly<{
    payload?: never;
    payloadResolver: ControlPayloadResolver<TType>;
  }>;

/**
 * A control action that produces a runtime command.
 * Must have either a static `payload` or a dynamic `payloadResolver`, but not both.
 */
export type ControlAction<
  TType extends RuntimeCommandType = RuntimeCommandType,
> = ControlActionWithPayload<TType> | ControlActionWithResolver<TType>;

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
  MISSING_PAYLOAD_OR_RESOLVER: 'controls.scheme.missingPayloadOrResolver',
  BOTH_PAYLOAD_AND_RESOLVER: 'controls.scheme.bothPayloadAndResolver',
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

const compareStrings = (left: string, right: string): number =>
  left.localeCompare(right, 'en');

const sortById = <T extends { id: string }>(
  values: readonly T[],
): T[] =>
  values
    .map((value, index) => ({ value, index }))
    .sort((left, right) => {
      const result = compareStrings(left.value.id, right.value.id);
      return result !== 0 ? result : left.index - right.index;
    })
    .map(({ value }) => value);

const normalizePhases = (
  phases: readonly ControlEventPhase[],
): readonly ControlEventPhase[] =>
  Array.from(new Set(phases)).sort(compareStrings);

const normalizeBindingPhases = (binding: ControlBinding): ControlBinding => {
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
};

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
  return {
    ...scheme,
    bindings: scheme.bindings.map(normalizeBindingPhases),
  };
};

/**
 * Sorts actions and bindings by id for deterministic storage/diffing.
 * Do not use this to determine execution order when binding sequence matters.
 */
export const canonicalizeControlScheme = (
  scheme: ControlScheme,
): ControlScheme => {
  const actions = sortById(scheme.actions);
  const bindings = sortById(scheme.bindings).map(normalizeBindingPhases);

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

    // Validate payload/payloadResolver mutual exclusivity
    // Capture id before narrowing since TypeScript will narrow to never for invalid states
    const actionId = action.id;
    const hasPayload = 'payload' in action && action.payload !== undefined;
    const hasResolver =
      'payloadResolver' in action && action.payloadResolver !== undefined;

    if (!hasPayload && !hasResolver) {
      issues.push(
        createValidationIssue(
          CONTROL_SCHEME_VALIDATION_CODES.MISSING_PAYLOAD_OR_RESOLVER,
          `Control action "${actionId}" must have either a payload or a payloadResolver.`,
          ['actions', index],
        ),
      );
    } else if (hasPayload && hasResolver) {
      issues.push(
        createValidationIssue(
          CONTROL_SCHEME_VALIDATION_CODES.BOTH_PAYLOAD_AND_RESOLVER,
          `Control action "${actionId}" cannot have both payload and payloadResolver.`,
          ['actions', index],
        ),
      );
    }
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

/**
 * Resolves actions in the order bindings are declared in the scheme.
 * Binding order is meaningful for execution sequencing.
 */
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

/**
 * Resolves the payload for a control action.
 * For static payloads, returns the payload directly.
 * For dynamic resolvers, calls the resolver with event and context.
 */
const resolvePayload = <TType extends RuntimeCommandType>(
  action: ControlAction<TType>,
  event: ControlEvent | undefined,
  context: ControlContext,
): RuntimeCommandPayloads[TType] => {
  if ('payloadResolver' in action && action.payloadResolver) {
    if (!event) {
      throw new Error(
        `Control action "${action.id}" has a payloadResolver but no event was provided.`,
      );
    }
    return action.payloadResolver({ event, context });
  }
  // TypeScript cannot narrow after the if-block; the assertion is safe because
  // the discriminated union ensures exactly one of payload/payloadResolver exists
  return (action as ControlActionWithPayload<TType>).payload;
};

/**
 * Creates a runtime command from a control action.
 * For actions with a payloadResolver, the event parameter is required.
 */
export const createControlCommand = <
  TType extends RuntimeCommandType = RuntimeCommandType,
>(
  action: ControlAction<TType>,
  context: ControlContext,
  event?: ControlEvent,
): RuntimeCommand<TType> => ({
  type: action.commandType,
  payload: resolvePayload(action, event, context),
  priority: action.priority ?? context.priority ?? CommandPriority.PLAYER,
  timestamp: context.timestamp,
  step: context.step,
  requestId: context.requestId,
});

/**
 * Creates commands in the order bindings are declared in the scheme.
 * Binding order is meaningful for execution sequencing.
 */
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
    commands.push(createControlCommand(action, context, event));
  }

  return commands;
};
