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
export type ControlAction<TType extends RuntimeCommandType = RuntimeCommandType> = Readonly<{
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
export declare const CONTROL_SCHEME_VALIDATION_CODES: {
    readonly DUPLICATE_ACTION_ID: "controls.scheme.duplicateActionId";
    readonly DUPLICATE_BINDING_ID: "controls.scheme.duplicateBindingId";
    readonly MISSING_ACTION_REFERENCE: "controls.scheme.missingActionReference";
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
export declare const createControlCommand: <TType extends RuntimeCommandType = RuntimeCommandType>(action: ControlAction<TType>, context: ControlContext) => RuntimeCommand<TType>;
/**
 * Creates commands in the order bindings are declared in the scheme.
 * Binding order is meaningful for execution sequencing.
 */
export declare const createControlCommands: (scheme: ControlScheme, event: ControlEvent, context: ControlContext) => readonly RuntimeCommand[];
//# sourceMappingURL=index.d.ts.map