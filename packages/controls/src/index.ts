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
