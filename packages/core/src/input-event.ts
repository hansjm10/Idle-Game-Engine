/**
 * Typed input event contracts for desktop shell interactions.
 *
 * These types define the canonical wire-level and runtime-command shapes for
 * pointer/wheel input events. They are shared between:
 * - Electron IPC (`ShellInputEventEnvelope.event`)
 * - Runtime command payloads (`InputEventCommandPayload.event`)
 *
 * @see docs/issue-850-design.md §3-4 for validation rules and derivation.
 */

/**
 * Modifier key state at the time of the input event.
 */
export interface InputEventModifiers {
  readonly alt: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
}

/**
 * Pointer input event (mouse-down, mouse-up, mouse-move).
 *
 * Coordinates `x/y` are derived in **CSS pixels** as:
 * `clientX/Y - canvas.getBoundingClientRect().left/top`
 */
export interface PointerInputEvent {
  readonly kind: 'pointer';
  readonly intent: 'mouse-down' | 'mouse-up' | 'mouse-move';
  readonly phase: 'start' | 'repeat' | 'end';
  readonly x: number;
  readonly y: number;
  readonly button: number;
  readonly buttons: number;
  readonly pointerType: 'mouse' | 'pen' | 'touch';
  readonly modifiers: InputEventModifiers;
}

/**
 * Wheel input event (mouse-wheel).
 *
 * Coordinates `x/y` are derived in **CSS pixels** as:
 * `clientX/Y - canvas.getBoundingClientRect().left/top`
 */
export interface WheelInputEvent {
  readonly kind: 'wheel';
  readonly intent: 'mouse-wheel';
  readonly phase: 'repeat';
  readonly x: number;
  readonly y: number;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaZ: number;
  readonly deltaMode: 0 | 1 | 2;
  readonly modifiers: InputEventModifiers;
}

/**
 * Discriminated union of all typed input events.
 *
 * Use `InputEvent['kind']` to narrow to a specific variant.
 */
export type InputEvent = PointerInputEvent | WheelInputEvent;

/**
 * Runtime command payload for INPUT_EVENT commands.
 *
 * The `schemaVersion` field gates compatibility for replays/snapshots:
 * - Version 1 is the initial release (issue #850).
 * - Unknown versions crash the sim worker (fail-fast).
 */
export interface InputEventCommandPayload {
  readonly schemaVersion: 1;
  readonly event: InputEvent;
}
