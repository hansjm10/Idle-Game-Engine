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
export declare const resolveControlActions: (scheme: ControlScheme, event: ControlEvent) => readonly ControlAction[];
export declare const createControlCommand: <TType extends RuntimeCommandType = RuntimeCommandType>(action: ControlAction<TType>, context: ControlContext) => RuntimeCommand<TType>;
export declare const createControlCommands: (scheme: ControlScheme, event: ControlEvent, context: ControlContext) => readonly RuntimeCommand[];
//# sourceMappingURL=index.d.ts.map