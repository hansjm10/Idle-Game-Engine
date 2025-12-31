import { CommandPriority } from '@idle-engine/core';
import type { RuntimeCommand, RuntimeCommandPayloads, RuntimeCommandType } from '@idle-engine/core';
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
export type ControlPayloadResolver<TType extends RuntimeCommandType = RuntimeCommandType> = (input: ControlPayloadResolverInput) => RuntimeCommandPayloads[TType];
/**
 * Base properties shared by all control actions.
 */
type ControlActionBase<TType extends RuntimeCommandType = RuntimeCommandType> = Readonly<{
    id: ControlActionId;
    commandType: TType;
    priority?: CommandPriority;
    metadata?: Readonly<Record<string, unknown>>;
}>;
/**
 * Control action with a static payload defined at authoring time.
 */
export type ControlActionWithPayload<TType extends RuntimeCommandType = RuntimeCommandType> = ControlActionBase<TType> & Readonly<{
    payload: RuntimeCommandPayloads[TType];
    payloadResolver?: never;
}>;
/**
 * Control action with a dynamic payload resolver called at command creation.
 */
export type ControlActionWithResolver<TType extends RuntimeCommandType = RuntimeCommandType> = ControlActionBase<TType> & Readonly<{
    payload?: never;
    payloadResolver: ControlPayloadResolver<TType>;
}>;
/**
 * A control action that produces a runtime command.
 * Must have either a static `payload` or a dynamic `payloadResolver`, but not both.
 */
export type ControlAction<TType extends RuntimeCommandType = RuntimeCommandType> = ControlActionWithPayload<TType> | ControlActionWithResolver<TType>;
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
export declare const CONTROL_SCHEME_VALIDATION_CODES: {
    readonly DUPLICATE_ACTION_ID: "controls.scheme.duplicateActionId";
    readonly DUPLICATE_BINDING_ID: "controls.scheme.duplicateBindingId";
    readonly MISSING_ACTION_REFERENCE: "controls.scheme.missingActionReference";
    readonly MISSING_PAYLOAD_OR_RESOLVER: "controls.scheme.missingPayloadOrResolver";
    readonly BOTH_PAYLOAD_AND_RESOLVER: "controls.scheme.bothPayloadAndResolver";
};
export type ControlSchemeValidationCode = (typeof CONTROL_SCHEME_VALIDATION_CODES)[keyof typeof CONTROL_SCHEME_VALIDATION_CODES];
export type ControlSchemeValidationIssueSeverity = 'error' | 'warning' | 'info';
export type ControlSchemeValidationIssue = Readonly<{
    code: ControlSchemeValidationCode;
    message: string;
    path: readonly (string | number)[];
    severity: ControlSchemeValidationIssueSeverity;
    suggestion?: string;
}>;
export declare const normalizeControlScheme: (scheme: ControlScheme) => ControlScheme;
/**
 * Sorts actions and bindings by id for deterministic storage/diffing.
 * Do not use this to determine execution order when binding sequence matters.
 */
export declare const canonicalizeControlScheme: (scheme: ControlScheme) => ControlScheme;
export declare const validateControlScheme: (scheme: ControlScheme) => readonly ControlSchemeValidationIssue[];
/**
 * Resolves actions in the order bindings are declared in the scheme.
 * Binding order is meaningful for execution sequencing.
 */
export declare const resolveControlActions: (scheme: ControlScheme, event: ControlEvent) => readonly ControlAction[];
/**
 * Creates a runtime command from a control action.
 * For actions with a payloadResolver, the event parameter is required.
 */
export declare const createControlCommand: <TType extends RuntimeCommandType = RuntimeCommandType>(action: ControlAction<TType>, context: ControlContext, event?: ControlEvent) => RuntimeCommand<TType>;
/**
 * Creates commands in the order bindings are declared in the scheme.
 * Binding order is meaningful for execution sequencing.
 */
export declare const createControlCommands: (scheme: ControlScheme, event: ControlEvent, context: ControlContext) => readonly RuntimeCommand[];
export {};
//# sourceMappingURL=index.d.ts.map