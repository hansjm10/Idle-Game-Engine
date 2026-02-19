import { describe, expect, it, vi } from 'vitest';
import { CommandPriority } from '@idle-engine/core';
import { registerSimTools, type SimMcpController } from './sim-tools.js';
import type { Command } from '@idle-engine/core';

type ToolHandler = (args: unknown) => Promise<unknown>;

const parseToolJson = (result: unknown): unknown => {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new Error('Expected tool result to be an object');
  }

  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error('Expected tool result to have content');
  }

  const first = content[0] as { type?: unknown; text?: unknown };
  if (first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error('Expected tool result content[0] to be text');
  }

  return JSON.parse(first.text) as unknown;
};

describe('shell-desktop MCP sim tools', () => {
  it('registers the sim tool surface', () => {
    const tools = new Map<string, ToolHandler>();

    const server = {
      registerTool: vi.fn((name: string, _definition: unknown, handler: ToolHandler) => {
        tools.set(name, handler);
      }),
    };

    registerSimTools(server, {
      getStatus: () => ({ state: 'stopped', stepSizeMs: 16, nextStep: 0 }),
      start: () => ({ state: 'running', stepSizeMs: 16, nextStep: 0 }),
      stop: () => ({ state: 'stopped', stepSizeMs: 16, nextStep: 0 }),
      pause: () => ({ state: 'paused', stepSizeMs: 16, nextStep: 0 }),
      resume: () => ({ state: 'running', stepSizeMs: 16, nextStep: 0 }),
      step: () => ({ state: 'paused', stepSizeMs: 16, nextStep: 1 }),
      enqueue: () => ({ enqueued: 0 }),
    });

    expect(Array.from(tools.keys()).sort()).toEqual([
      'sim.enqueue',
      'sim.pause',
      'sim.resume',
      'sim.start',
      'sim.status',
      'sim.step',
      'sim.stop',
    ]);
  });

  it('bridges lifecycle calls to the sim controller', async () => {
    const tools = new Map<string, ToolHandler>();

    const sim = {
      getStatus: vi.fn(() => ({ state: 'paused', stepSizeMs: 16, nextStep: 0 })),
      start: vi.fn(() => ({ state: 'running', stepSizeMs: 16, nextStep: 0 })),
      stop: vi.fn(() => ({ state: 'stopped', stepSizeMs: 16, nextStep: 0 })),
      pause: vi.fn(() => ({ state: 'paused', stepSizeMs: 16, nextStep: 0 })),
      resume: vi.fn(() => ({ state: 'running', stepSizeMs: 16, nextStep: 0 })),
      step: vi.fn((_steps: number) => ({ state: 'paused', stepSizeMs: 16, nextStep: 1 })),
      enqueue: vi.fn((_commands: readonly Command[]) => ({ enqueued: 0 })),
    };

    const server = {
      registerTool: vi.fn((name: string, _definition: unknown, handler: ToolHandler) => {
        tools.set(name, handler);
      }),
    };

    registerSimTools(server, sim as unknown as SimMcpController);

    const statusHandler = tools.get('sim.status');
    await expect(statusHandler?.({})).resolves.toBeDefined();
    expect(sim.getStatus).toHaveBeenCalledTimes(1);

    const startHandler = tools.get('sim.start');
    await expect(startHandler?.({})).resolves.toBeDefined();
    expect(sim.start).toHaveBeenCalledTimes(1);

    const pauseHandler = tools.get('sim.pause');
    await expect(pauseHandler?.({})).resolves.toBeDefined();
    expect(sim.pause).toHaveBeenCalledTimes(1);

    const resumeHandler = tools.get('sim.resume');
    await expect(resumeHandler?.({})).resolves.toBeDefined();
    expect(sim.resume).toHaveBeenCalledTimes(1);

    const stepHandler = tools.get('sim.step');
    await expect(stepHandler?.({ steps: 2 })).resolves.toBeDefined();
    expect(sim.step).toHaveBeenCalledWith(2);

    const stopHandler = tools.get('sim.stop');
    await expect(stopHandler?.({})).resolves.toBeDefined();
    expect(sim.stop).toHaveBeenCalledTimes(1);
  });

  it('normalizes sim.enqueue commands deterministically', async () => {
    const tools = new Map<string, ToolHandler>();

    const enqueue = vi.fn((_commands: readonly Command[]) => ({ enqueued: 0 }));

    const server = {
      registerTool: vi.fn((name: string, _definition: unknown, handler: ToolHandler) => {
        tools.set(name, handler);
      }),
    };

    registerSimTools(server, {
      getStatus: () => ({ state: 'running', stepSizeMs: 20, nextStep: 10 }),
      start: () => ({ state: 'running', stepSizeMs: 20, nextStep: 10 }),
      stop: () => ({ state: 'stopped', stepSizeMs: 20, nextStep: 10 }),
      pause: () => ({ state: 'paused', stepSizeMs: 20, nextStep: 10 }),
      resume: () => ({ state: 'running', stepSizeMs: 20, nextStep: 10 }),
      step: () => ({ state: 'paused', stepSizeMs: 20, nextStep: 11 }),
      enqueue,
    });

    const handler = tools.get('sim.enqueue');
    const rawResult = await handler?.({
      commands: [
        { type: 'A', payload: { ok: true } },
        { type: 'B', payload: { ok: true }, step: 5, priority: 2, timestamp: 999 },
        { type: 'C', payload: { ok: true }, step: 12 },
      ],
    });

    const normalized = enqueue.mock.calls[0]?.[0];
    expect(normalized).toEqual([
      {
        type: 'A',
        payload: { ok: true },
        priority: CommandPriority.PLAYER,
        step: 10,
        timestamp: 200,
      },
      {
        type: 'B',
        payload: { ok: true },
        priority: 2,
        step: 10,
        timestamp: 200,
      },
      {
        type: 'C',
        payload: { ok: true },
        priority: CommandPriority.PLAYER,
        step: 12,
        timestamp: 240,
      },
    ]);

    const parsedResult = parseToolJson(rawResult);
    expect(parsedResult).toEqual(expect.objectContaining({ ok: true, enqueued: 3 }));
  });

  it('rejects invalid sim.step and sim.enqueue payloads', async () => {
    const tools = new Map<string, ToolHandler>();

    const server = {
      registerTool: vi.fn((name: string, _definition: unknown, handler: ToolHandler) => {
        tools.set(name, handler);
      }),
    };

    registerSimTools(server, {
      getStatus: () => ({ state: 'running', stepSizeMs: 20, nextStep: 10 }),
      start: () => ({ state: 'running', stepSizeMs: 20, nextStep: 10 }),
      stop: () => ({ state: 'stopped', stepSizeMs: 20, nextStep: 10 }),
      pause: () => ({ state: 'paused', stepSizeMs: 20, nextStep: 10 }),
      resume: () => ({ state: 'running', stepSizeMs: 20, nextStep: 10 }),
      step: () => ({ state: 'paused', stepSizeMs: 20, nextStep: 11 }),
      enqueue: () => ({ enqueued: 0 }),
    });

    const enqueueHandler = tools.get('sim.enqueue');
    await expect(enqueueHandler?.({})).rejects.toThrow(/commands/);
    await expect(enqueueHandler?.({ commands: [{}] })).rejects.toThrow(/type/);
    await expect(enqueueHandler?.({ commands: [{ type: 'ok', step: 'nope' }] })).rejects.toThrow(/step/);
    await expect(enqueueHandler?.({ commands: [{ type: 'ok', priority: 'nope' }] })).rejects.toThrow(/priority/);
    await expect(enqueueHandler?.({ commands: [{ type: 'ok', priority: 99 }] })).rejects.toThrow(/priority/);

    const stepHandler = tools.get('sim.step');
    await expect(stepHandler?.({ steps: 0 })).rejects.toThrow(/steps/);
    await expect(stepHandler?.({ steps: 1.5 })).rejects.toThrow(/steps/);
  });
});
