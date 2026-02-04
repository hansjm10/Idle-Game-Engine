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

});
