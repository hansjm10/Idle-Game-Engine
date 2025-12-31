import { CommandPriority } from '@idle-engine/core';
const shouldMatchPhase = (binding, phase) => {
    const phases = binding.phases;
    if (!phases) {
        return true;
    }
    if (phases.length === 0) {
        return false;
    }
    return phases.includes(phase);
};
const buildActionLookup = (actions) => {
    const lookup = new Map();
    for (const action of actions) {
        if (!lookup.has(action.id)) {
            lookup.set(action.id, action);
        }
    }
    return lookup;
};
export const resolveControlActions = (scheme, event) => {
    const actionsById = buildActionLookup(scheme.actions);
    const resolved = [];
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
export const createControlCommand = (action, context) => ({
    type: action.commandType,
    payload: action.payload,
    priority: action.priority ?? context.priority ?? CommandPriority.PLAYER,
    timestamp: context.timestamp,
    step: context.step,
    requestId: context.requestId,
});
export const createControlCommands = (scheme, event, context) => {
    const actionsById = buildActionLookup(scheme.actions);
    const commands = [];
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
//# sourceMappingURL=index.js.map