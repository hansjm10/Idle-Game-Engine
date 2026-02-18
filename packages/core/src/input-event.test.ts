import { describe, expect, it } from 'vitest';

import type {
  InputEvent,
  InputEventCommandPayload,
  InputEventModifiers,
  PointerInputEvent,
  WheelInputEvent,
} from './input-event.js';

describe('input-event', () => {
  describe('InputEventModifiers', () => {
    it('accepts valid modifier state', () => {
      const modifiers: InputEventModifiers = {
        alt: false,
        ctrl: true,
        meta: false,
        shift: true,
      };
      expect(modifiers.alt).toBe(false);
      expect(modifiers.ctrl).toBe(true);
      expect(modifiers.meta).toBe(false);
      expect(modifiers.shift).toBe(true);
    });
  });

  describe('PointerInputEvent', () => {
    it('accepts valid mouse-down event', () => {
      const event: PointerInputEvent = {
        kind: 'pointer',
        intent: 'mouse-down',
        phase: 'start',
        x: 100,
        y: 200,
        button: 0,
        buttons: 1,
        pointerType: 'mouse',
        modifiers: { alt: false, ctrl: false, meta: false, shift: false },
      };
      expect(event.kind).toBe('pointer');
      expect(event.intent).toBe('mouse-down');
      expect(event.phase).toBe('start');
      expect(event.x).toBe(100);
      expect(event.y).toBe(200);
      expect(event.button).toBe(0);
      expect(event.buttons).toBe(1);
      expect(event.pointerType).toBe('mouse');
    });

    it('accepts valid mouse-move event', () => {
      const event: PointerInputEvent = {
        kind: 'pointer',
        intent: 'mouse-move',
        phase: 'repeat',
        x: 150,
        y: 250,
        button: -1,
        buttons: 0,
        pointerType: 'mouse',
        modifiers: { alt: false, ctrl: false, meta: false, shift: false },
      };
      expect(event.kind).toBe('pointer');
      expect(event.intent).toBe('mouse-move');
      expect(event.phase).toBe('repeat');
    });

    it('accepts valid mouse-up event', () => {
      const event: PointerInputEvent = {
        kind: 'pointer',
        intent: 'mouse-up',
        phase: 'end',
        x: 120,
        y: 220,
        button: 0,
        buttons: 0,
        pointerType: 'mouse',
        modifiers: { alt: false, ctrl: false, meta: false, shift: false },
      };
      expect(event.kind).toBe('pointer');
      expect(event.intent).toBe('mouse-up');
      expect(event.phase).toBe('end');
    });

    it('accepts pen and touch pointer types', () => {
      const penEvent: PointerInputEvent = {
        kind: 'pointer',
        intent: 'mouse-down',
        phase: 'start',
        x: 0,
        y: 0,
        button: 0,
        buttons: 1,
        pointerType: 'pen',
        modifiers: { alt: false, ctrl: false, meta: false, shift: false },
      };
      const touchEvent: PointerInputEvent = {
        kind: 'pointer',
        intent: 'mouse-down',
        phase: 'start',
        x: 0,
        y: 0,
        button: 0,
        buttons: 1,
        pointerType: 'touch',
        modifiers: { alt: false, ctrl: false, meta: false, shift: false },
      };
      expect(penEvent.pointerType).toBe('pen');
      expect(touchEvent.pointerType).toBe('touch');
    });
  });

  describe('WheelInputEvent', () => {
    it('accepts valid wheel event', () => {
      const event: WheelInputEvent = {
        kind: 'wheel',
        intent: 'mouse-wheel',
        phase: 'repeat',
        x: 100,
        y: 200,
        deltaX: 0,
        deltaY: 120,
        deltaZ: 0,
        deltaMode: 0,
        modifiers: { alt: false, ctrl: false, meta: false, shift: false },
      };
      expect(event.kind).toBe('wheel');
      expect(event.intent).toBe('mouse-wheel');
      expect(event.phase).toBe('repeat');
      expect(event.deltaY).toBe(120);
      expect(event.deltaMode).toBe(0);
    });

    it('accepts all deltaMode values (0, 1, 2)', () => {
      const baseEvent = {
        kind: 'wheel' as const,
        intent: 'mouse-wheel' as const,
        phase: 'repeat' as const,
        x: 0,
        y: 0,
        deltaX: 0,
        deltaY: 0,
        deltaZ: 0,
        modifiers: { alt: false, ctrl: false, meta: false, shift: false },
      };

      const pixelMode: WheelInputEvent = { ...baseEvent, deltaMode: 0 };
      const lineMode: WheelInputEvent = { ...baseEvent, deltaMode: 1 };
      const pageMode: WheelInputEvent = { ...baseEvent, deltaMode: 2 };

      expect(pixelMode.deltaMode).toBe(0);
      expect(lineMode.deltaMode).toBe(1);
      expect(pageMode.deltaMode).toBe(2);
    });
  });

  describe('InputEvent (discriminated union)', () => {
    it('narrows to PointerInputEvent via kind', () => {
      const event: InputEvent = {
        kind: 'pointer',
        intent: 'mouse-down',
        phase: 'start',
        x: 0,
        y: 0,
        button: 0,
        buttons: 1,
        pointerType: 'mouse',
        modifiers: { alt: false, ctrl: false, meta: false, shift: false },
      };

      if (event.kind === 'pointer') {
        // TypeScript narrows to PointerInputEvent
        expect(event.intent).toBe('mouse-down');
        expect(event.button).toBe(0);
        expect(event.pointerType).toBe('mouse');
      } else {
        throw new Error('Expected pointer event');
      }
    });

    it('narrows to WheelInputEvent via kind', () => {
      const event: InputEvent = {
        kind: 'wheel',
        intent: 'mouse-wheel',
        phase: 'repeat',
        x: 0,
        y: 0,
        deltaX: 0,
        deltaY: 100,
        deltaZ: 0,
        deltaMode: 0,
        modifiers: { alt: false, ctrl: false, meta: false, shift: false },
      };

      if (event.kind === 'wheel') {
        // TypeScript narrows to WheelInputEvent
        expect(event.intent).toBe('mouse-wheel');
        expect(event.deltaY).toBe(100);
        expect(event.deltaMode).toBe(0);
      } else {
        throw new Error('Expected wheel event');
      }
    });
  });

  describe('InputEventCommandPayload', () => {
    it('accepts valid payload with schemaVersion 1', () => {
      const payload: InputEventCommandPayload = {
        schemaVersion: 1,
        event: {
          kind: 'pointer',
          intent: 'mouse-down',
          phase: 'start',
          x: 50,
          y: 60,
          button: 0,
          buttons: 1,
          pointerType: 'mouse',
          modifiers: { alt: false, ctrl: false, meta: false, shift: false },
        },
      };
      expect(payload.schemaVersion).toBe(1);
      expect(payload.event.kind).toBe('pointer');
    });

    it('accepts payload with wheel event', () => {
      const payload: InputEventCommandPayload = {
        schemaVersion: 1,
        event: {
          kind: 'wheel',
          intent: 'mouse-wheel',
          phase: 'repeat',
          x: 100,
          y: 200,
          deltaX: 0,
          deltaY: -120,
          deltaZ: 0,
          deltaMode: 0,
          modifiers: { alt: true, ctrl: false, meta: false, shift: false },
        },
      };
      expect(payload.schemaVersion).toBe(1);
      expect(payload.event.kind).toBe('wheel');
      expect(payload.event.modifiers.alt).toBe(true);
    });
  });
});
