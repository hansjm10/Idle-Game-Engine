import { describe, expect, it } from 'vitest';

import { CommandPriority, RUNTIME_COMMAND_TYPES } from '@idle-engine/core';
import { createSimRuntime } from './sim-runtime.js';
import { SHELL_CONTROL_EVENT_COMMAND_TYPE } from '../ipc.js';
import type { Command, InputEventCommandPayload, PointerInputEvent } from '@idle-engine/core';

describe('shell-desktop sim runtime', () => {
  it('emits per-step frames with deterministic timing', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });

    const result = sim.tick(35);
    expect(result.frames).toHaveLength(3);
    expect(result.frames[0]?.frame.step).toBe(0);
    expect(result.frames[0]?.frame.simTimeMs).toBe(0);
    expect(result.frames[2]?.frame.step).toBe(2);
    expect(result.frames[2]?.frame.simTimeMs).toBe(20);
    expect(result.nextStep).toBe(3);
    expect(sim.getNextStep()).toBe(3);
    expect(sim.getStepSizeMs()).toBe(10);
  });

  it('executes commands and reflects them in the next frame', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });

    const command: Command = {
      type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
      priority: CommandPriority.PLAYER,
      payload: { resourceId: 'demo', amount: 1 },
      timestamp: 0,
      step: sim.getNextStep(),
    };

    sim.enqueueCommands([command]);

    const result = sim.tick(10);
    expect(result.frames).toHaveLength(1);

    const frame = result.frames[0];
    expect(frame?.frame.step).toBe(0);

    const fillRect = frame?.draws.find(
      (draw) =>
        draw.kind === 'rect' &&
        draw.passId === 'ui' &&
        draw.sortKey.sortKeyHi === 0 &&
        draw.sortKey.sortKeyLo === 2,
    );

    expect(fillRect).toMatchObject({
      kind: 'rect',
      passId: 'ui',
      width: 14,
      colorRgba: 0x8a_2a_4f_ff,
    });
  });

  it('ignores collect resource commands for unknown resource ids', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });

    const command: Command = {
      type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
      priority: CommandPriority.PLAYER,
      payload: { resourceId: 'other', amount: 1 },
      timestamp: 0,
      step: sim.getNextStep(),
    };

    sim.enqueueCommands([command]);

    const result = sim.tick(10);
    const frame = result.frames[0];

    const fillRect = frame?.draws.find(
      (draw) =>
        draw.kind === 'rect' &&
        draw.passId === 'ui' &&
        draw.sortKey.sortKeyHi === 0 &&
        draw.sortKey.sortKeyLo === 2,
    );

    expect(fillRect).toMatchObject({
      kind: 'rect',
      passId: 'ui',
      width: 0,
      colorRgba: 0x2a_4f_8a_ff,
    });
  });

  it('drops invalid commands from the queue', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });

    sim.enqueueCommands([{} as unknown as Command]);

    const result = sim.tick(10);
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]?.frame.step).toBe(0);
  });

  it('drops commands with invalid fields', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });

    sim.enqueueCommands([
      null as unknown as Command,
      {
        type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
        priority: Number.NaN,
        payload: { resourceId: 'demo', amount: 1 },
        timestamp: 0,
        step: 0,
      },
      {
        type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
        priority: CommandPriority.PLAYER,
        payload: { resourceId: 'demo', amount: 1 },
        timestamp: 0,
        step: Number.NaN,
      },
      {
        type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
        priority: CommandPriority.PLAYER,
        payload: { resourceId: 'demo', amount: 1 },
        timestamp: Number.NaN,
        step: 0,
      },
    ]);

    const result = sim.tick(10);
    const frame = result.frames[0];

    const fillRect = frame?.draws.find(
      (draw) =>
        draw.kind === 'rect' &&
        draw.passId === 'ui' &&
        draw.sortKey.sortKeyHi === 0 &&
        draw.sortKey.sortKeyLo === 2,
    );

    expect(fillRect).toMatchObject({
      kind: 'rect',
      passId: 'ui',
      width: 0,
      colorRgba: 0x2a_4f_8a_ff,
    });
  });

  it('normalizes commands scheduled before the next step', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });

    const command: Command = {
      type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
      priority: CommandPriority.PLAYER,
      payload: { resourceId: 'demo', amount: 1 },
      timestamp: 999,
      step: -5,
    };

    sim.enqueueCommands([command]);

    const result = sim.tick(10);
    const frame = result.frames[0];

    const fillRect = frame?.draws.find(
      (draw) =>
        draw.kind === 'rect' &&
        draw.passId === 'ui' &&
        draw.sortKey.sortKeyHi === 0 &&
        draw.sortKey.sortKeyLo === 2,
    );

    expect(fillRect).toMatchObject({
      kind: 'rect',
      passId: 'ui',
      width: 14,
      colorRgba: 0x8a_2a_4f_ff,
    });
  });

  it('registers a handler for passthrough control event commands', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });

    expect(sim.hasCommandHandler(SHELL_CONTROL_EVENT_COMMAND_TYPE)).toBe(true);
  });

  it('registers a handler for INPUT_EVENT commands', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });

    expect(sim.hasCommandHandler(RUNTIME_COMMAND_TYPES.INPUT_EVENT)).toBe(true);
  });

  it('triggers resource increase for in-bounds INPUT_EVENT (mouse-down at x=20,y=20)', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });

    const pointerEvent: PointerInputEvent = {
      kind: 'pointer',
      intent: 'mouse-down',
      phase: 'start',
      x: 20,
      y: 20,
      button: 0,
      buttons: 1,
      pointerType: 'mouse',
      modifiers: { alt: false, ctrl: false, meta: false, shift: false },
    };

    const payload: InputEventCommandPayload = {
      schemaVersion: 1,
      event: pointerEvent,
    };

    const command: Command = {
      type: RUNTIME_COMMAND_TYPES.INPUT_EVENT,
      priority: CommandPriority.PLAYER,
      payload,
      timestamp: 0,
      step: sim.getNextStep(),
    };

    sim.enqueueCommands([command]);

    const result = sim.tick(10);
    expect(result.frames).toHaveLength(1);

    const frame = result.frames[0];

    // Verify the same UI effect as COLLECT_RESOURCE: fill width increases and color changes
    const fillRect = frame?.draws.find(
      (draw) =>
        draw.kind === 'rect' &&
        draw.passId === 'ui' &&
        draw.sortKey.sortKeyHi === 0 &&
        draw.sortKey.sortKeyLo === 2,
    );

    expect(fillRect).toMatchObject({
      kind: 'rect',
      passId: 'ui',
      width: 14, // Same as COLLECT_RESOURCE with amount=1
      colorRgba: 0x8a_2a_4f_ff, // Highlight color for lastCollectedStep === step
    });
  });

  it('does not trigger resource increase for out-of-bounds INPUT_EVENT (mouse-down at x=0,y=0)', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });

    const pointerEvent: PointerInputEvent = {
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

    const payload: InputEventCommandPayload = {
      schemaVersion: 1,
      event: pointerEvent,
    };

    const command: Command = {
      type: RUNTIME_COMMAND_TYPES.INPUT_EVENT,
      priority: CommandPriority.PLAYER,
      payload,
      timestamp: 0,
      step: sim.getNextStep(),
    };

    sim.enqueueCommands([command]);

    const result = sim.tick(10);
    expect(result.frames).toHaveLength(1);

    const frame = result.frames[0];

    // Verify no resource increase: fill width is 0 and color is default (not highlight)
    const fillRect = frame?.draws.find(
      (draw) =>
        draw.kind === 'rect' &&
        draw.passId === 'ui' &&
        draw.sortKey.sortKeyHi === 0 &&
        draw.sortKey.sortKeyLo === 2,
    );

    expect(fillRect).toMatchObject({
      kind: 'rect',
      passId: 'ui',
      width: 0,
      colorRgba: 0x2a_4f_8a_ff, // Default color (no collection this step)
    });
  });

  it('INPUT_EVENT handler throws on schemaVersion mismatch (schemaVersion: 2)', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });

    const pointerEvent: PointerInputEvent = {
      kind: 'pointer',
      intent: 'mouse-down',
      phase: 'start',
      x: 20, // In-bounds coords that would trigger collection if handler didn't throw
      y: 20,
      button: 0,
      buttons: 1,
      pointerType: 'mouse',
      modifiers: { alt: false, ctrl: false, meta: false, shift: false },
    };

    // Enqueue INPUT_EVENT with schemaVersion: 2 (mismatch - should cause handler to throw)
    const invalidPayload = {
      schemaVersion: 2,
      event: pointerEvent,
    } as unknown as InputEventCommandPayload;

    const command: Command = {
      type: RUNTIME_COMMAND_TYPES.INPUT_EVENT,
      priority: CommandPriority.PLAYER,
      payload: invalidPayload,
      timestamp: 0,
      step: sim.getNextStep(),
    };

    sim.enqueueCommands([command]);

    // Tick to process the command - the INPUT_EVENT handler throws on schemaVersion !== 1
    // The error is rethrown from tick() to crash the worker (fatal error)
    expect(() => sim.tick(10)).toThrow('Unsupported InputEventCommandPayload schemaVersion: 2');
  });

  it('does not expose serialize on the demo runtime', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });

    expect(sim.serialize).toBeUndefined();
  });

  it('does not expose hydrate on the demo runtime', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });

    expect(sim.hydrate).toBeUndefined();
  });

  it('INPUT_EVENT with schemaVersion mismatch does not trigger resource collection (handler throws before hit-test)', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });

    // First, verify that a valid in-bounds click DOES increase the resource count
    const validPointerEvent: PointerInputEvent = {
      kind: 'pointer',
      intent: 'mouse-down',
      phase: 'start',
      x: 20,
      y: 20,
      button: 0,
      buttons: 1,
      pointerType: 'mouse',
      modifiers: { alt: false, ctrl: false, meta: false, shift: false },
    };

    const validPayload: InputEventCommandPayload = {
      schemaVersion: 1,
      event: validPointerEvent,
    };

    const validCommand: Command = {
      type: RUNTIME_COMMAND_TYPES.INPUT_EVENT,
      priority: CommandPriority.PLAYER,
      payload: validPayload,
      timestamp: 0,
      step: sim.getNextStep(),
    };

    sim.enqueueCommands([validCommand]);
    const resultAfterValid = sim.tick(10);

    // With schemaVersion 1, in-bounds click triggers resource collection
    const fillRectAfterValid = resultAfterValid.frames[0]?.draws.find(
      (draw) =>
        draw.kind === 'rect' &&
        draw.passId === 'ui' &&
        draw.sortKey.sortKeyHi === 0 &&
        draw.sortKey.sortKeyLo === 2,
    );
    expect(fillRectAfterValid).toMatchObject({
      width: 14, // Resource count increased
    });

    // Now create a new runtime and test schemaVersion mismatch
    const sim2 = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });

    // Use schemaVersion 2 to simulate a mismatch (incompatible replay/snapshot)
    // The same in-bounds coords that would normally trigger collection
    const invalidPayload = {
      schemaVersion: 2,
      event: validPointerEvent,
    } as unknown as InputEventCommandPayload;

    const invalidCommand: Command = {
      type: RUNTIME_COMMAND_TYPES.INPUT_EVENT,
      priority: CommandPriority.PLAYER,
      payload: invalidPayload,
      timestamp: 0,
      step: sim2.getNextStep(),
    };

    sim2.enqueueCommands([invalidCommand]);

    // Tick to process the command - the handler throws before hit-testing
    // The error is now fatal and rethrown from tick() to crash the worker
    expect(() => sim2.tick(10)).toThrow('Unsupported InputEventCommandPayload schemaVersion: 2');
  });

});
