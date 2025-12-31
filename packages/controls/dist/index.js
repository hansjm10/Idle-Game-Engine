import { CommandPriority } from '@idle-engine/core';
export const CONTROL_SCHEME_VALIDATION_CODES = {
    DUPLICATE_ACTION_ID: 'controls.scheme.duplicateActionId',
    DUPLICATE_BINDING_ID: 'controls.scheme.duplicateBindingId',
    MISSING_ACTION_REFERENCE: 'controls.scheme.missingActionReference',
};
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
        if (lookup.has(action.id)) {
            throw new Error(`Control action with id "${action.id}" is duplicated.`);
        }
        lookup.set(action.id, action);
    }
    return lookup;
};
const compareStrings = (left, right) => left.localeCompare(right, 'en');
const sortById = (values) => values
    .map((value, index) => ({ value, index }))
    .sort((left, right) => {
    const result = compareStrings(left.value.id, right.value.id);
    return result !== 0 ? result : left.index - right.index;
})
    .map(({ value }) => value);
const normalizePhases = (phases) => Array.from(new Set(phases)).sort(compareStrings);
const createValidationIssue = (code, message, path) => ({
    code,
    message,
    path,
    severity: 'error',
});
export const normalizeControlScheme = (scheme) => {
    const actions = sortById(scheme.actions);
    const bindings = sortById(scheme.bindings).map((binding) => {
        const phases = binding.phases;
        if (!phases) {
            return binding;
        }
        const normalizedPhases = normalizePhases(phases);
        if (normalizedPhases.length === phases.length &&
            normalizedPhases.every((phase, index) => phase === phases[index])) {
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
export const validateControlScheme = (scheme) => {
    const issues = [];
    const actionIds = new Map();
    scheme.actions.forEach((action, index) => {
        const existing = actionIds.get(action.id);
        if (existing !== undefined) {
            issues.push(createValidationIssue(CONTROL_SCHEME_VALIDATION_CODES.DUPLICATE_ACTION_ID, `Duplicate control action id "${action.id}" also defined at index ${existing}.`, ['actions', index, 'id']));
            return;
        }
        actionIds.set(action.id, index);
    });
    const bindingIds = new Map();
    scheme.bindings.forEach((binding, index) => {
        const existing = bindingIds.get(binding.id);
        if (existing !== undefined) {
            issues.push(createValidationIssue(CONTROL_SCHEME_VALIDATION_CODES.DUPLICATE_BINDING_ID, `Duplicate control binding id "${binding.id}" also defined at index ${existing}.`, ['bindings', index, 'id']));
            return;
        }
        bindingIds.set(binding.id, index);
    });
    const actionIdSet = new Set(actionIds.keys());
    scheme.bindings.forEach((binding, index) => {
        if (!actionIdSet.has(binding.actionId)) {
            issues.push(createValidationIssue(CONTROL_SCHEME_VALIDATION_CODES.MISSING_ACTION_REFERENCE, `Control binding "${binding.id}" references missing action id "${binding.actionId}".`, ['bindings', index, 'actionId']));
        }
    });
    return issues;
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