import { describe, expect, it } from 'vitest';

import { CommandPriority, RUNTIME_COMMAND_TYPES } from '@idle-engine/core';
import { testGameContentArtifactHash } from '@idle-engine/content-test-game';
import { createSimRuntime } from './sim-runtime.js';
import { SHELL_CONTROL_EVENT_COMMAND_TYPE } from '../ipc.js';
import type { Command, InputEventCommandPayload, PointerInputEvent } from '@idle-engine/core';
import { RENDERER_CONTRACT_SCHEMA_VERSION } from '@idle-engine/renderer-contract';
import type { ShellControlEvent } from '../ipc.js';
import type { RenderCommandBuffer } from '@idle-engine/renderer-contract';

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

describe('shell-desktop sim runtime (test-game)', () => {
  it('boots and emits renderer frames', () => {
    const originalGameMode = process.env.IDLE_ENGINE_GAME;
    process.env.IDLE_ENGINE_GAME = 'test-game';

    try {
      const sim = createSimRuntime({ stepSizeMs: 20, maxStepsPerFrame: 1 });

      expect(sim.getStepSizeMs()).toBe(20);
      expect(sim.serialize).toBeTypeOf('function');
      expect(sim.hydrate).toBeTypeOf('function');
      expect(sim.hasCommandHandler(SHELL_CONTROL_EVENT_COMMAND_TYPE)).toBe(true);
      expect(sim.hasCommandHandler(RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE)).toBe(true);
      expect(sim.hasCommandHandler('UNKNOWN')).toBe(false);

      const result = sim.tick(20);
      expect(result.frames.length).toBeGreaterThan(0);

      const frame = result.frames.at(-1);
      expect(frame?.frame.schemaVersion).toBe(RENDERER_CONTRACT_SCHEMA_VERSION);
      expect(frame?.frame.contentHash).toBe(testGameContentArtifactHash);
    } finally {
      if (originalGameMode === undefined) {
        delete process.env.IDLE_ENGINE_GAME;
      } else {
        process.env.IDLE_ENGINE_GAME = originalGameMode;
      }
    }
  });

  it('formats large gold values with deterministic suffixes', () => {
    const originalGameMode = process.env.IDLE_ENGINE_GAME;
    process.env.IDLE_ENGINE_GAME = 'test-game';

    const findGoldLine = (frame: { draws: ReadonlyArray<{ kind?: string; text?: string }> }): string => {
      const gold = frame.draws.find((draw) => draw.kind === 'text' && typeof draw.text === 'string' && draw.text.startsWith('Gold:'));
      expect(gold).toBeDefined();
      return (gold as { text: string }).text;
    };

    try {
      const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });

      sim.enqueueCommands([
        {
          type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
          priority: CommandPriority.PLAYER,
          payload: { resourceId: 'test-game.gold', amount: 1234 },
          timestamp: 0,
          step: sim.getNextStep(),
        },
      ]);

      const first = sim.tick(10).frames.at(-1);
      expect(first).toBeDefined();
      expect(findGoldLine(first!)).toContain('1.23k');

      sim.enqueueCommands([
        {
          type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
          priority: CommandPriority.PLAYER,
          payload: { resourceId: 'test-game.gold', amount: 1_998_766 },
          timestamp: 0,
          step: sim.getNextStep(),
        },
      ]);

      const second = sim.tick(10).frames.at(-1);
      expect(second).toBeDefined();
      expect(findGoldLine(second!)).toContain('2.00m');

      sim.enqueueCommands([
        {
          type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
          priority: CommandPriority.PLAYER,
          payload: { resourceId: 'test-game.gold', amount: 2_998_000_000 },
          timestamp: 0,
          step: sim.getNextStep(),
        },
      ]);

      const third = sim.tick(10).frames.at(-1);
      expect(third).toBeDefined();
      expect(findGoldLine(third!)).toContain('3.00b');
    } finally {
      if (originalGameMode === undefined) {
        delete process.env.IDLE_ENGINE_GAME;
      } else {
        process.env.IDLE_ENGINE_GAME = originalGameMode;
      }
    }
  });

  it('handles UI click hit-testing via passthrough control events', () => {
    const originalGameMode = process.env.IDLE_ENGINE_GAME;
    process.env.IDLE_ENGINE_GAME = 'test-game';

    const findCollectGoldButton = (frame: RenderCommandBuffer) => {
      const draw = frame.draws.find(
        (candidate) =>
          candidate.kind === 'rect' &&
          candidate.passId === 'ui' &&
          candidate.width === 180 &&
          candidate.height === 20,
      );
      expect(draw).toBeDefined();
      return draw as Extract<RenderCommandBuffer['draws'][number], { kind: 'rect' }>;
    };

    const findGoldLine = (frame: RenderCommandBuffer): string => {
      const gold = frame.draws.find((draw) => draw.kind === 'text' && draw.text.startsWith('Gold:'));
      expect(gold).toBeDefined();
      return (gold as { text: string }).text;
    };

    const enqueueControlEvent = (sim: ReturnType<typeof createSimRuntime>, event: ShellControlEvent): void => {
      sim.enqueueCommands([
        {
          type: SHELL_CONTROL_EVENT_COMMAND_TYPE,
          priority: CommandPriority.PLAYER,
          payload: { event },
          timestamp: 0,
          step: sim.getNextStep(),
        },
      ]);
    };

    try {
      const sim = createSimRuntime({ stepSizeMs: 16, maxStepsPerFrame: 50 });

      const initialFrame = sim.tick(16).frames.at(-1);
      expect(initialFrame).toBeDefined();
      const initialButton = findCollectGoldButton(initialFrame!);
      const insideX = initialButton.x + 1;
      const insideY = initialButton.y + 1;

      enqueueControlEvent(sim, { intent: 'mouse-down', phase: 'start', metadata: { x: insideX, y: insideY } });
      const pressedFrame = sim.tick(16).frames.at(-1);
      expect(pressedFrame).toBeDefined();
      expect(findCollectGoldButton(pressedFrame!).colorRgba).toBe(0x8a_2a_4f_ff);

      enqueueControlEvent(sim, { intent: 'mouse-up', phase: 'end', metadata: { x: 0, y: 0 } });
      const releasedOutsideFrame = sim.tick(16).frames.at(-1);
      expect(releasedOutsideFrame).toBeDefined();
      expect(findCollectGoldButton(releasedOutsideFrame!).colorRgba).toBe(0x18_2a_44_ff);
      expect(findGoldLine(releasedOutsideFrame!)).toContain('Gold: 0.00');

      enqueueControlEvent(sim, { intent: 'mouse-move', phase: 'repeat', metadata: { x: insideX, y: insideY } });
      const hoveredFrame = sim.tick(16).frames.at(-1);
      expect(hoveredFrame).toBeDefined();
      expect(findCollectGoldButton(hoveredFrame!).colorRgba).toBe(0x2a_4f_8a_ff);

      enqueueControlEvent(sim, { intent: 'mouse-down', phase: 'start', metadata: { x: insideX, y: insideY } });
      const pressedAgainFrame = sim.tick(16).frames.at(-1);
      expect(pressedAgainFrame).toBeDefined();
      expect(findCollectGoldButton(pressedAgainFrame!).colorRgba).toBe(0x8a_2a_4f_ff);

      enqueueControlEvent(sim, { intent: 'mouse-up', phase: 'end', metadata: { x: insideX, y: insideY } });
      const clickedFrame = sim.tick(16).frames.at(-1);
      expect(clickedFrame).toBeDefined();
      expect(findCollectGoldButton(clickedFrame!).colorRgba).toBe(0x2a_4f_8a_ff);
      expect(findGoldLine(clickedFrame!)).toContain('Gold: 1.00');

      enqueueControlEvent(sim, { intent: 'mouse-move', phase: 'repeat', metadata: { x: 0, y: 0 } });
      const clearedHoverFrame = sim.tick(16).frames.at(-1);
      expect(clearedHoverFrame).toBeDefined();
      expect(findCollectGoldButton(clearedHoverFrame!).colorRgba).toBe(0x18_2a_44_ff);
    } finally {
      if (originalGameMode === undefined) {
        delete process.env.IDLE_ENGINE_GAME;
      } else {
        process.env.IDLE_ENGINE_GAME = originalGameMode;
      }
    }
  });

  it('rejects hydrating saves that are behind the current step', () => {
    const originalGameMode = process.env.IDLE_ENGINE_GAME;
    process.env.IDLE_ENGINE_GAME = 'test-game';

    try {
      const sim = createSimRuntime({ stepSizeMs: 20, maxStepsPerFrame: 50 });
      const save = sim.serialize?.();
      expect(save).toBeDefined();

      sim.tick(60);

      expect(() => sim.hydrate?.(save)).toThrow(/Cannot hydrate a save from step/);
    } finally {
      if (originalGameMode === undefined) {
        delete process.env.IDLE_ENGINE_GAME;
      } else {
        process.env.IDLE_ENGINE_GAME = originalGameMode;
      }
    }
  });

  it('drops invalid commands from the queue', () => {
    const originalGameMode = process.env.IDLE_ENGINE_GAME;
    process.env.IDLE_ENGINE_GAME = 'test-game';

    try {
      const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });
      sim.enqueueCommands([{} as unknown as Command]);

      const result = sim.tick(10);
      expect(result.frames.length).toBeGreaterThan(0);
    } finally {
      if (originalGameMode === undefined) {
        delete process.env.IDLE_ENGINE_GAME;
      } else {
        process.env.IDLE_ENGINE_GAME = originalGameMode;
      }
    }
  });

  it('hydrates later-step saves by fast-forwarding and resets UI input state', () => {
    const originalGameMode = process.env.IDLE_ENGINE_GAME;
    process.env.IDLE_ENGINE_GAME = 'test-game';

    const findCollectGoldButton = (frame: RenderCommandBuffer) => {
      const draw = frame.draws.find(
        (candidate) =>
          candidate.kind === 'rect' &&
          candidate.passId === 'ui' &&
          candidate.width === 180 &&
          candidate.height === 20,
      );
      expect(draw).toBeDefined();
      return draw as Extract<RenderCommandBuffer['draws'][number], { kind: 'rect' }>;
    };

    const findGoldLine = (frame: RenderCommandBuffer): string => {
      const gold = frame.draws.find((draw) => draw.kind === 'text' && draw.text.startsWith('Gold:'));
      expect(gold).toBeDefined();
      return (gold as { text: string }).text;
    };

    const enqueueControlEvent = (sim: ReturnType<typeof createSimRuntime>, event: ShellControlEvent): void => {
      sim.enqueueCommands([
        {
          type: SHELL_CONTROL_EVENT_COMMAND_TYPE,
          priority: CommandPriority.PLAYER,
          payload: { event },
          timestamp: 0,
          step: sim.getNextStep(),
        },
      ]);
    };

    try {
      const source = createSimRuntime({ stepSizeMs: 20, maxStepsPerFrame: 50 });
      source.enqueueCommands([
        {
          type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
          priority: CommandPriority.PLAYER,
          payload: { resourceId: 'test-game.gold', amount: 42 },
          timestamp: 0,
          step: source.getNextStep(),
        },
      ]);
      source.tick(60);
      const save = source.serialize?.();
      expect(save).toBeDefined();

      const target = createSimRuntime({ stepSizeMs: 20, maxStepsPerFrame: 50 });
      const initialFrame = target.tick(20).frames.at(-1);
      expect(initialFrame).toBeDefined();
      const collectButton = findCollectGoldButton(initialFrame!);
      const insideX = collectButton.x + 1;
      const insideY = collectButton.y + 1;

      enqueueControlEvent(target, { intent: 'mouse-move', phase: 'repeat', metadata: { x: insideX, y: insideY } });
      const hoveredFrame = target.tick(20).frames.at(-1);
      expect(hoveredFrame).toBeDefined();
      expect(findCollectGoldButton(hoveredFrame!).colorRgba).toBe(0x2a_4f_8a_ff);

      target.hydrate?.(save);
      const hydratedFrame = target.tick(20).frames.at(-1);
      expect(hydratedFrame).toBeDefined();
      expect(findCollectGoldButton(hydratedFrame!).colorRgba).toBe(0x18_2a_44_ff);
      expect(findGoldLine(hydratedFrame!)).toContain('Gold: 42.0');
    } finally {
      if (originalGameMode === undefined) {
        delete process.env.IDLE_ENGINE_GAME;
      } else {
        process.env.IDLE_ENGINE_GAME = originalGameMode;
      }
    }
  });
});
